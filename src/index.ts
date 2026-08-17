import { appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { EngineeringTrace, KnowledgeCard, KnowledgeType, KnowledgeWorkingSet } from './types.ts'
import { boundText, contentText, contentVersion } from './text.ts'
import { TraceBuilder, worthDistilling } from './trace-builder.ts'
import { WikiStore } from './wiki-store.ts'
import { learningProposal, retrievalPrefilter } from './decision-gate.ts'
import { FlashKnowledgeJudge } from './flash-judge.ts'

/**
 * Loop Engineering 的 Cordis 插件入口。
 *
 * 本文件做“编排”而不是保存知识细节：它把 Harness 提供的事件、工具注册表、命令注册表和
 * 系统提示词连接到 `TraceBuilder` 与 `WikiStore`。阅读顺序建议是：`apply()` → 两个事件钩子
 * → `registerTools()` → `registerCommands()` → 最后的格式化/校验辅助函数。
 */

// Cordis 用稳定名字识别插件实例，日志和插件来源消息也使用这个名字。
export const name = 'loop-engineering'
// 声明 apply() 启动前必须已经存在的 Cordis 服务；缺失时让加载器尽早报错。
export const inject = ['tools', 'commands', 'systemPrompt', 'llm']

/** 用户可通过 Cordis 配置调整的 MVP 部署选项。 */
export interface Config {
  /** 规范 Markdown 知识库目录。 */
  wikiDir: string
  /** trace、候选、Patch、反馈等派生状态目录。 */
  stateDir: string
  /** 是否在任务开始或出现强错误证据时自动检索。 */
  automaticRetrieval: boolean
  /** 单会话自动注入的硬上限，防止知识系统反复打扰主任务。 */
  maxAutomaticRetrievalsPerTask: number
  /** 一次检索最多返回多少张 L0 卡片。 */
  maxSearchResults: number
  /** Search Before Create 认定“已有相似知识”的相关度阈值。 */
  duplicateThreshold: number
  /** trace 自动升级成候选知识所需的最低解决置信度。 */
  autoCandidateThreshold: number
  /** 单张卡片和整次自动上下文的字符预算。 */
  maxCardChars: number
  maxContextChars: number
  /** 是否用轻量模型判断语义模糊的学习和检索触发。 */
  lightweightJudge: boolean
  /** 轻量判断模型的 Harness provider 和 model。 */
  judgeProvider: string
  judgeModel: string
  /** 单次判断的输出与等待上限。 */
  judgeMaxTokens: number
  judgeTimeoutMs: number
}

// Schemastery 同时提供默认值和 Cordis 可理解的运行时配置 schema。
export const Config: Schema<Config> = Schema.object({
  wikiDir: Schema.string().default('./loop-engineering-plugin/wiki'),
  stateDir: Schema.string().default('./loop-engineering-plugin/.loop-engineering'),
  automaticRetrieval: Schema.boolean().default(true),
  maxAutomaticRetrievalsPerTask: Schema.number().default(2),
  maxSearchResults: Schema.number().default(5),
  duplicateThreshold: Schema.number().default(0.58),
  autoCandidateThreshold: Schema.number().default(0.65),
  maxCardChars: Schema.number().default(520),
  maxContextChars: Schema.number().default(2400),
  lightweightJudge: Schema.boolean().default(true),
  judgeProvider: Schema.string().default('deepseek-official'),
  judgeModel: Schema.string().default('deepseek-v4-flash'),
  judgeMaxTokens: Schema.number().default(320),
  judgeTimeoutMs: Schema.number().default(12000),
})

/** 安装本地 Wiki、4 个模型工具、审查命令和自动循环钩子。 */
export function apply(ctx: Context, config: Config): void {
  // 所有路径和数值只在入口校验一次，后续模块可直接相信配置有效。
  const resolved = resolveConfig(config)
  const store = new WikiStore({
    wikiDir: resolved.wikiDir,
    stateDir: resolved.stateDir,
    duplicateThreshold: resolved.duplicateThreshold,
  })
  const traces = new TraceBuilder()
  const judge = new FlashKnowledgeJudge(ctx, {
    provider: resolved.judgeProvider,
    model: resolved.judgeModel,
    maxTokens: resolved.judgeMaxTokens,
    timeoutMs: resolved.judgeTimeoutMs,
    stateDir: resolved.stateDir,
  })
  // 工作集只活在当前 Web 进程内，按 session 隔离，负责自动检索去重。
  const workingSets = new Map<string, KnowledgeWorkingSet>()
  // 工具结果里的强错误片段会触发下一 step 的第二次检索。
  const strongEvidence = new Map<string, string>()
  // 会话事件可以并发到达；串行写队列避免候选/trace 同时改同一路径。
  let writeQueue = Promise.resolve()

  // apply() 是同步 Cordis 钩子，因此异步建目录在后台启动，并把失败写进插件日志。
  void store.initialize().catch((error: unknown) => {
    ctx.logger.error(`loop-engineering storage initialization failed: ${String(error)}`)
  })

  ctx.systemPrompt.section({
    name: 'tool:loop-engineering',
    order: 118,
    text: 'You have access to compiled team engineering knowledge. Search it when historical business rules, recurring problem patterns, or architecture decisions may affect the task. Search returns compact cards; read only the relevant page or section, and request evidence only when verification is needed. Treat stale knowledge as a lead, not a fact.',
  })

  registerTools(ctx, store, workingSets, resolved)
  registerCommands(ctx, store, traces)

  /**
   * 写入链：观察每个持久会话事件，turn 完成后保存 trace；只有高价值 trace 才继续生成候选。
   * `{ global: true }` 表示不局限于某个子 context，使所有 Web 会话都能被观察。
   */
  ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id)
    if (event.type === 'tool/result') {
      const evidence = contentText(event.data.message.content)
      // 只缓存首个短错误片段；它足以作为下一步检索 query，不需要注入整段工具日志。
      const match = /(?:error|exception|failed|cannot|undefined|错误|异常|失败)[^\n]{0,300}/iu.exec(evidence)
      if (match !== null) strongEvidence.set(sessionId, match[0])
    }
    const trace = traces.observe(session, event)
    // 只有 turn/end 会产出完整 trace，其他事件到这里直接结束。
    if (trace === undefined) return
    writeQueue = writeQueue.then(async () => {
      await store.writeTrace(trace)
      if (!worthDistilling(trace, resolved.autoCandidateThreshold)) return
      let explicit: string | undefined
      if (resolved.lightweightJudge) {
        try {
          const decision = await judge.learning(trace)
          if (decision.action === 'skip') {
            ctx.logger.info(`loop-engineering skipped learning for ${sessionId}:${trace.turn}: ${decision.reason}`)
            return
          }
          explicit = learningProposal(decision)
        } catch (error) {
          // 判断模型不可用时保留原有确定性行为，避免一次网络故障丢失高证据轨迹。
          ctx.logger.warn(`loop-engineering learning judge failed; using deterministic fallback: ${String(error)}`)
        }
      }
      // propose 内部会先搜索 Wiki，决定 CREATE 还是 UPDATE，并只写待审 JSON。
      const { candidate, patch } = await store.propose(trace, explicit)
      ctx.logger.info(`loop-engineering candidate ${candidate.candidateId}: ${patch.operation} ${patch.targets.join(', ')} (${patch.verification})`)
    }).catch((error: unknown) => {
      ctx.logger.warn(`loop-engineering write path failed: ${String(error)}`)
    })
  }, { global: true })

  /**
   * 读取链：在 agent 真正进入一个 step 前，按需附加一条来源为插件的 user/message。
   * 这条消息会成为 Session Event，因此后续可回放“何时注入了哪版知识”。
   */
  ctx.on('agent/pre-step', async (payload, next) => {
    // 先让下游钩子作决定；只有最终决定进入 step 时才注入，避免向被跳过的步骤写消息。
    const decision = await next()
    if (!resolved.automaticRetrieval || decision.kind !== 'enter') return decision
    const sessionId = String(payload.agent.session.id)
    const workingSet = workingSetFor(workingSets, sessionId)
    if (workingSet.automaticRetrievals >= resolved.maxAutomaticRetrievalsPerTask) return decision

    const directText = payload.messages
      // 自动检索只使用真实用户消息，不能把先前插件注入反过来当新查询造成反馈循环。
      .filter(message => message.source.kind === 'user')
      .map(message => contentText(message.content))
      .filter(Boolean)
      .join('\n')
    // 第一步用用户任务；后续步骤只有出现强错误证据才触发，普通对话不额外检索。
    let query = payload.step === 1 ? directText : strongEvidence.get(sessionId)
    if (query === undefined || !retrievalPrefilter(query)) return decision
    // 第二步的强错误片段本身就是高精度检索词；只有任务开始时的模糊意图才值得调用轻量模型。
    if (payload.step === 1 && resolved.lightweightJudge) {
      try {
        const judged = await judge.retrieval(query, sessionId)
        if (judged.action === 'skip') return decision
        query = judged.query
      } catch (error) {
        // 回退为预过滤后的原始任务，让模型故障只影响精度、不影响可用性。
        ctx.logger.warn(`loop-engineering retrieval judge failed; using deterministic fallback: ${String(error)}`)
      }
    }
    const queryKey = contentVersion(query.toLocaleLowerCase())
    // 同样的 query 在同一 session 只自动执行一次。
    if (workingSet.searches.includes(queryKey)) return decision
    workingSet.searches.push(queryKey)

    const cards = (await store.search(query, { limit: resolved.maxSearchResults }))
      // 已展开或被负面反馈否定的知识不再自动占用上下文；显式工具搜索仍然不受限制。
      .filter(card => !workingSet.loaded.has(card.id) && !workingSet.dismissed.has(card.id))
    if (cards.length === 0) return decision
    for (const card of cards) {
      workingSet.candidates.add(card.id)
      workingSet.summaries.set(card.id, card.summary)
    }
    workingSet.automaticRetrievals += 1
    strongEvidence.delete(sessionId)
    const text = boundText(renderAutomaticContext(cards, payload.step === 1 ? 'task-start' : 'strong-evidence'), resolved.maxContextChars)
    const knowledgeMessage = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'loop-engineering' },
    })
    return { ...decision, messages: [...decision.messages, knowledgeMessage] }
  }, { global: true })
}

function registerTools(
  ctx: Context,
  store: WikiStore,
  workingSets: Map<string, KnowledgeWorkingSet>,
  config: Config,
): void {
  // L0：只搜索卡片，不读取正文。工具执行后把返回 ID 放入当前会话工作集。
  ctx.tools.register(defineTool({
    name: 'knowledge_search',
    description: 'Search compiled team engineering knowledge. Returns L0 cards only; use knowledge_read to expand one relevant card.',
    parameters: {
      query: { type: 'string', required: true, description: 'Task symptom, exact identifier, business term, or architecture concept.' },
      type: { type: 'string', description: 'Optional: problem-pattern, business-rule, or architecture-decision.' },
      limit: { type: 'number', description: 'Optional result count up to the deployment maximum.' },
    },
    output: stringOutput(),
    async execute(args, exec) {
      // 工具 schema 只能表达基础类型，枚举值和上限在执行时再做严格校验。
      const type = optionalKnowledgeType(args.type)
      const limit = integerLimit(args.limit, config.maxSearchResults)
      const cards = await store.search(args.query, { ...(type === undefined ? {} : { type }), limit })
      const workingSet = exec.agent === undefined ? undefined : workingSetFor(workingSets, String(exec.agent.session.id))
      for (const card of cards) {
        workingSet?.candidates.add(card.id)
        workingSet?.summaries.set(card.id, card.summary)
      }
      return cards.length === 0 ? 'No relevant team knowledge found.' : cards.map(card => renderCard(card, config.maxCardChars)).join('\n\n')
    },
  }))

  // L1/L2：模型明确选中一个 ID 后，才能读取正文、单章节或证据。
  ctx.tools.register(defineTool({
    name: 'knowledge_read',
    description: 'Read one selected knowledge unit at L1 detail/section or L2 evidence. Do not read every search result.',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact knowledge id from a search card.' },
      section: { type: 'string', description: 'Optional exact section heading for a section-level L1 read.' },
      layer: { type: 'string', description: 'detail (default) or evidence.' },
    },
    output: stringOutput(),
    async execute(args, exec) {
      const layer = args.layer === undefined || args.layer === 'detail' ? 'detail' : args.layer === 'evidence' ? 'evidence' : undefined
      if (layer === undefined) throw new Error('layer must be "detail" or "evidence"')
      const value = await store.read(args.id, args.section, layer)
      // 标记为 loaded 后，自动检索不会在同一会话再次注入这个页面。
      if (exec.agent !== undefined) workingSetFor(workingSets, String(exec.agent.session.id)).loaded.add(args.id)
      return value
    },
  }))

  // 图导航：只沿 Markdown front matter 的 related ID 返回邻居卡片，不隐式加载正文。
  ctx.tools.register(defineTool({
    name: 'knowledge_related',
    description: 'Navigate explicit related-knowledge links and return L0 cards without loading page bodies.',
    parameters: { id: { type: 'string', required: true, description: 'Exact knowledge id.' } },
    output: stringOutput(),
    async execute(args) {
      const cards = await store.related(args.id)
      return cards.length === 0 ? 'No related knowledge links.' : cards.map(card => renderCard(card, config.maxCardChars)).join('\n\n')
    },
  }))

  // 反馈使用 JSONL 追加写入，便于保留完整历史而不是覆盖最后一次评价。
  ctx.tools.register(defineTool({
    name: 'knowledge_feedback',
    description: 'Record whether a knowledge unit was helpful, partially helpful, irrelevant, or misleading for the current task.',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact knowledge id.' },
      rating: { type: 'string', required: true, description: 'helpful, partially-helpful, irrelevant, or misleading.' },
      notes: { type: 'string', description: 'Optional concise evidence for the rating.' },
    },
    output: stringOutput(),
    async execute(args, exec) {
      const ratings = new Set(['helpful', 'partially-helpful', 'irrelevant', 'misleading'])
      if (!ratings.has(args.rating)) throw new Error('rating must be helpful, partially-helpful, irrelevant, or misleading')
      const record = {
        knowledgeId: args.id,
        rating: args.rating,
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        ...(exec.agent === undefined ? {} : { sessionId: String(exec.agent.session.id) }),
        createdAt: new Date().toISOString(),
      }
      await appendFile(join(store.stateDir, 'feedback', `${args.id.replace(/[^a-z0-9_.-]/giu, '_')}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8')
      if (exec.agent !== undefined) {
        const set = workingSetFor(workingSets, String(exec.agent.session.id))
        // 负面反馈抑制后续自动注入；正面反馈则记录为实际使用过。
        if (args.rating === 'irrelevant' || args.rating === 'misleading') set.dismissed.add(args.id)
        else set.used.add(args.id)
      }
      return `Recorded ${args.rating} feedback for ${args.id}.`
    },
  }))
}

/** 注册由人触发的写入/审查命令。它们与模型只读工具分开，保证发布动作显式可见。 */
function registerCommands(ctx: Context, store: WikiStore, traces: TraceBuilder): void {
  // 从当前会话最近完成的 trace 建候选；没有完成 trace 时仍允许用户显式记录一条待审知识。
  ctx.commands.register({
    name: 'save-knowledge',
    description: 'Create a governed knowledge candidate from the latest completed engineering trace.',
    input: { hint: '[type | title | summary | aliases | triggers]' },
    async handler(invocation: CommandInvocation) {
      const trace = traces.latest(String(invocation.agent.session.id)) ?? emptyExplicitTrace(String(invocation.agent.session.id), invocation.rawInput)
      const { candidate, patch } = await store.propose(trace, invocation.rawInput.trim() || undefined)
      return {
        kind: 'success',
        text: `Candidate ${candidate.candidateId}\n${patch.operation.toUpperCase()} ${patch.targets.join(', ')}\nVerification: ${patch.verification}\nUse /knowledge-review publish ${candidate.candidateId} after review.`,
      }
    },
  })

  ctx.commands.register({
    name: 'knowledge-candidates',
    description: 'List pending Loop Engineering knowledge patches awaiting review.',
    async handler() {
      // 列表把候选和对应 Patch 配对展示，审查者可以同时看到类型、目标、操作和证据等级。
      const pending = await store.pending()
      return {
        kind: 'success',
        text: pending.length === 0
          ? 'No pending knowledge candidates.'
          : pending.map(({ candidate, patch }) => `${candidate.candidateId}\n${candidate.type}: ${candidate.title}\n${patch.operation.toUpperCase()} ${patch.targets.join(', ')} · ${patch.verification}`).join('\n\n'),
      }
    },
  })

  ctx.commands.register({
    name: 'knowledge-review',
    description: 'Publish or dismiss one reviewed knowledge patch.',
    input: { hint: '<publish|dismiss|发布|驳回> <candidate-id>' },
    async handler(invocation: CommandInvocation) {
      const match = /^\s*(publish|dismiss|发布|驳回)\s+(\S+)\s*$/iu.exec(invocation.rawInput)
      if (match === null) return { kind: 'error', text: 'Usage: /knowledge-review <publish|dismiss|发布|驳回> <candidate-id>' }
      const action = match[1]?.toLocaleLowerCase()
      const candidateId = match[2]
      if (candidateId === undefined) return { kind: 'error', text: 'Candidate id is required.' }
      if (action === 'dismiss' || action === '驳回') {
        // dismiss 只更新候选状态，绝不触碰 wiki 目录。
        await store.dismiss(candidateId)
        return { kind: 'success', text: `Dismissed ${candidateId}; canonical wiki was not changed.` }
      }
      // publish 内部再次执行证据门禁和结构 lint，不信任命令层传来的 candidateId。
      const unit = await store.publish(candidateId)
      return { kind: 'success', text: `Published ${unit.metadata.id} (${unit.metadata.lifecycle}) to the Engineering Wiki.` }
    },
  })
}

/** 把相对路径转成绝对路径，并拒绝无效的整数、比例或字符预算。 */
function resolveConfig(config: Config): Config {
  const positiveInteger = (name: string, value: number): number => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`)
    return value
  }
  const ratio = (name: string, value: number): number => {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`)
    return value
  }
  const nonEmpty = (name: string, value: string): string => {
    const trimmed = value.trim()
    if (trimmed.length === 0) throw new Error(`${name} must be a non-empty string`)
    return trimmed
  }
  return {
    ...config,
    wikiDir: resolve(config.wikiDir),
    stateDir: resolve(config.stateDir),
    maxAutomaticRetrievalsPerTask: positiveInteger('maxAutomaticRetrievalsPerTask', config.maxAutomaticRetrievalsPerTask),
    maxSearchResults: positiveInteger('maxSearchResults', config.maxSearchResults),
    duplicateThreshold: ratio('duplicateThreshold', config.duplicateThreshold),
    autoCandidateThreshold: ratio('autoCandidateThreshold', config.autoCandidateThreshold),
    maxCardChars: positiveInteger('maxCardChars', config.maxCardChars),
    maxContextChars: positiveInteger('maxContextChars', config.maxContextChars),
    judgeProvider: nonEmpty('judgeProvider', config.judgeProvider),
    judgeModel: nonEmpty('judgeModel', config.judgeModel),
    judgeMaxTokens: positiveInteger('judgeMaxTokens', config.judgeMaxTokens),
    judgeTimeoutMs: positiveInteger('judgeTimeoutMs', config.judgeTimeoutMs),
  }
}

/** 获取一个会话的工作集；第一次访问时创建空集合。 */
function workingSetFor(sets: Map<string, KnowledgeWorkingSet>, sessionId: string): KnowledgeWorkingSet {
  const existing = sets.get(sessionId)
  if (existing !== undefined) return existing
  const created: KnowledgeWorkingSet = {
    searches: [],
    candidates: new Set(),
    loaded: new Set(),
    used: new Set(),
    dismissed: new Set(),
    summaries: new Map(),
    automaticRetrievals: 0,
  }
  sets.set(sessionId, created)
  return created
}

/**
 * dsh-tools 的字符串输出适配器：领域 execute 返回普通字符串，render 再把它变成 Harness 文本内容块。
 */
function stringOutput() {
  return {
    schema: { type: 'string' as const },
    render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
  }
}

/** 把可选字符串收窄为合法 KnowledgeType，并对模型拼错的枚举快速报错。 */
function optionalKnowledgeType(value: string | undefined): KnowledgeType | undefined {
  if (value === undefined) return undefined
  if (value === 'problem-pattern' || value === 'business-rule' || value === 'architecture-decision') return value
  throw new Error('type must be problem-pattern, business-rule, or architecture-decision')
}

/** 校验模型提供的 limit，并强制不超过部署配置上限。 */
function integerLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('limit must be a positive safe integer')
  return Math.min(value, maximum)
}

/** 把内部 KnowledgeCard 渲染成模型可读、长度受控的 L0 文本。 */
function renderCard(card: KnowledgeCard, maxChars: number): string {
  const scope = [...card.scope.repos, ...card.scope.domains, ...card.scope.modules].join(', ') || 'team-wide'
  return boundText([
    `[${card.id}] ${card.title}`,
    `${card.type} · ${card.lifecycle} · confidence ${Math.round(card.confidence * 100)}% · relevance ${Math.round(card.relevance * 100)}%`,
    card.summary,
    `Scope: ${scope}`,
    `Version: ${card.version}`,
  ].join('\n'), maxChars)
}

/** 组合自动注入消息，并明确提醒模型：历史知识是线索，不是当前运行时事实。 */
function renderAutomaticContext(cards: KnowledgeCard[], trigger: 'task-start' | 'strong-evidence'): string {
  return [
    `Team Knowledge (${trigger}; L0 cards only)`,
    'These are prior team claims, not current-runtime proof. Read a relevant id/section before relying on it.',
    ...cards.map(card => renderCard(card, 520)),
  ].join('\n\n')
}

/**
 * 用户在没有已完成 trace 时仍可 `/save-knowledge`。这个占位 trace 明确标为未解决，
 * 因而不会把显式输入误包装成“已经验证”的问题模式。
 */
function emptyExplicitTrace(sessionId: string, input: string): EngineeringTrace {
  return {
    sessionId,
    turn: 0,
    task: input.trim() || 'Explicit knowledge save',
    errors: [],
    filesRead: [],
    filesChanged: [],
    commands: [],
    tests: [],
    userConfirmations: [],
    finalOutcome: input.trim() || 'Explicitly requested knowledge candidate.',
    resolutionConfidence: 0.7,
    resolved: false,
  }
}
