import type { EngineeringTrace, KnowledgeCard, KnowledgeType } from './types.ts'

/** 轻量模型对“是否检索历史知识”的结构化判断。 */
export interface RetrievalDecision {
  action: 'retrieve' | 'skip'
  query: string
  reason: string
}

/** 轻量模型对“本轮是否值得沉淀”的结构化判断。 */
export interface LearningDecision {
  action: 'learn' | 'skip'
  type?: KnowledgeType
  title?: string
  summary?: string
  aliases?: string[]
  triggers?: string[]
  reason: string
}

export interface RerankDecision {
  ranking: Array<{ id: string; score: number; reason: string }>
}

/**
 * 在调用模型前排除明显不需要团队知识的输入。
 * 这里只做高精度的廉价排除；其余语义判断交给轻量模型，避免不断扩充脆弱的关键词表。
 */
export function retrievalPrefilter(query: string): boolean {
  const trimmed = query.trim()
  if (trimmed.length < 12) return false
  if (/^(?:format|格式化|翻译|translate|润色|改(?:一下)?(?:颜色|文案)|解释\s+(?:api|语法))/iu.test(trimmed)) return false
  return /error|exception|failed|bug|fix|debug|架构|业务|规则|状态|刷新|崩溃|失败|错误|异常|模块|依赖|修改|实现|测试|兼容|性能|权限|缓存|并发/iu.test(trimmed)
}

/** 把检索判断的未知 JSON 收窄为可执行结果；字段不完整时直接拒绝。 */
export function parseRetrievalDecision(source: string): RetrievalDecision {
  const value = jsonObject(source)
  const action = value.action
  if (action !== 'retrieve' && action !== 'skip') throw new Error('retrieval decision action must be retrieve or skip')
  const reason = requiredString(value.reason, 'reason', 300)
  const query = action === 'retrieve' ? requiredString(value.query, 'query', 600) : optionalString(value.query, 600) ?? ''
  return { action, query, reason }
}

/** 把学习判断的未知 JSON 收窄为可执行结果，防止模型自由文本进入候选文件。 */
export function parseLearningDecision(source: string): LearningDecision {
  const value = jsonObject(source)
  const action = value.action
  if (action !== 'learn' && action !== 'skip') throw new Error('learning decision action must be learn or skip')
  const reason = requiredString(value.reason, 'reason', 300)
  if (action === 'skip') return { action, reason }
  const type = value.type
  if (type !== 'problem-pattern' && type !== 'business-rule' && type !== 'architecture-decision') {
    throw new Error('learning decision type is invalid')
  }
  return {
    action,
    type,
    title: requiredString(value.title, 'title', 120),
    summary: requiredString(value.summary, 'summary', 500),
    aliases: stringArray(value.aliases, 6, 80),
    triggers: stringArray(value.triggers, 8, 120),
    reason,
  }
}

/** 校验重排序结果，并拒绝未知 ID、重复 ID 和越界分数。 */
export function parseRerankDecision(source: string, allowedIds: ReadonlySet<string>): RerankDecision {
  const value = jsonObject(source)
  if (!Array.isArray(value.ranking) || value.ranking.length === 0) throw new Error('rerank decision requires a non-empty ranking')
  const seen = new Set<string>()
  const ranking = value.ranking.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`ranking[${index}] must be an object`)
    const item = entry as Record<string, unknown>
    const id = requiredString(item.id, `ranking[${index}].id`, 240)
    if (!allowedIds.has(id) || seen.has(id)) throw new Error(`ranking contains unknown or duplicate id "${id}"`)
    if (typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score < 0 || item.score > 1) throw new Error(`ranking[${index}].score must be between 0 and 1`)
    seen.add(id)
    return { id, score: item.score, reason: requiredString(item.reason, `ranking[${index}].reason`, 240) }
  })
  return { ranking }
}

/** 把已校验的模型判断转换成 WikiStore 的确定性显式提炼格式。 */
export function learningProposal(decision: LearningDecision): string | undefined {
  if (decision.action === 'skip') return undefined
  return [
    decision.type,
    decision.title,
    decision.summary,
    decision.aliases?.join(',') ?? '',
    decision.triggers?.join(',') ?? '',
  ].join(' | ')
}

/** 为任务开始时的检索判断生成短提示，不包含完整会话历史。 */
export function retrievalPrompt(query: string): string {
  return [
    '你是工程知识检索门控器。判断当前任务是否需要查询团队过去沉淀的业务规则、架构决定或重复故障经验。',
    '只有历史经验可能实质影响方案时才 retrieve；普通实现、改文案、一次性操作或可直接从当前代码判断时 skip。',
    '若 retrieve，把用户输入改写成一条保留具体症状、模块、业务词和错误词的短检索句。',
    '只输出单行 JSON：{"action":"retrieve|skip","query":"...","reason":"..."}',
    `任务：${query.trim().slice(0, 1800)}`,
  ].join('\n')
}

/** 为已通过确定性证据门的轨迹生成学习判断提示。 */
export function learningPrompt(trace: EngineeringTrace): string {
  const facts = {
    task: trace.task.slice(0, 1200),
    errors: trace.errors.slice(0, 4),
    filesChanged: trace.filesChanged.slice(0, 8),
    tests: trace.tests.slice(0, 8),
    userConfirmed: trace.userConfirmations.length > 0,
    finalOutcome: trace.finalOutcome?.slice(0, 1200),
    resolutionConfidence: trace.resolutionConfidence,
  }
  return [
    '你是工程知识学习门控器。输入已经通过“任务完成且有工程证据”的廉价门禁。',
    '只有可跨任务复用的重复故障模式、明确业务规则或有长期约束力的架构决定才 learn；一次性改动、普通编码步骤、缺少根因或只是宣布完成时 skip。',
    'learn 时选择 problem-pattern、business-rule、architecture-decision 之一，并给出可脱离本次会话阅读的标题、摘要、别名和触发症状。不要虚构输入中没有的事实。',
    '只输出单行 JSON：{"action":"learn|skip","type":"problem-pattern|business-rule|architecture-decision","title":"...","summary":"...","aliases":["..."],"triggers":["..."],"reason":"..."}',
    `轨迹事实：${JSON.stringify(facts)}`,
  ].join('\n')
}

/** 只使用 L0 字段构造低成本重排序提示，不发送完整 Wiki 正文。 */
export function rerankPrompt(query: string, cards: KnowledgeCard[]): string {
  const candidates = cards.map(card => ({
    id: card.id,
    title: card.title,
    type: card.type,
    summary: card.summary,
    lifecycle: card.lifecycle,
    confidence: card.confidence,
  }))
  return [
    '你是工程知识检索重排序器。根据查询与候选的症状、业务语义和架构含义重新排序。不要添加候选列表之外的 ID。',
    '优先真正能指导当前任务的知识；仅共享宽泛词语但机制不同的候选应降级。',
    '只输出单行 JSON：{"ranking":[{"id":"...","score":0.0,"reason":"..."}]}，score 必须位于 0 到 1。',
    `查询：${query.trim().slice(0, 1000)}`,
    `候选：${JSON.stringify(candidates)}`,
  ].join('\n')
}

/** 接受纯 JSON 或 Markdown JSON 代码块，并拒绝其他前后缀。 */
function jsonObject(source: string): Record<string, unknown> {
  const trimmed = source.trim()
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed)
  const parsed: unknown = JSON.parse(match?.[1] ?? trimmed)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('decision must be a JSON object')
  return parsed as Record<string, unknown>
}

function requiredString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`)
  return value.trim().slice(0, maximum)
}

function optionalString(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, maximum) : undefined
}

function stringArray(value: unknown, maximumItems: number, maximumChars: number): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string')
    .map(item => item.trim().slice(0, maximumChars)).filter(Boolean))].slice(0, maximumItems)
}
