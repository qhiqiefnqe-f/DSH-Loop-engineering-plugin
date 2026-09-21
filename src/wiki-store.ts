import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { dump, load } from 'js-yaml'
import type {
  EngineeringTrace,
  KnowledgeCandidate,
  KnowledgeCard,
  KnowledgeLifecycle,
  KnowledgeMetadata,
  KnowledgePatch,
  KnowledgeScope,
  KnowledgeType,
  KnowledgeUnit,
  SearchOptions,
} from './types.ts'
import { contentVersion, slugify, tokenize } from './text.ts'
import { bm25fScores, reciprocalRankFusion, routeKnowledgeTypes, type Bm25fField } from './retrieval.ts'

/**
 * Git/Markdown Wiki 的领域存储实现。
 *
 * 规范知识使用普通 Markdown + YAML，派生审查状态使用 JSON。这样人可以直接阅读和 Git diff
 * `wiki/`，程序又能稳定处理 trace、候选和 Patch。本文件有三条主要路径：
 *
 * 1. 读取路径：`list → parseUnit → search/read/related`；
 * 2. 提议路径：`writeTrace → distill → Search Before Create → candidate + patch`；
 * 3. 发布路径：`publish → 证据门禁 → 结构 lint → 原子写入 Markdown`。
 */

// 一个知识文件必须且只能由 YAML front matter 和 Markdown 正文两部分组成。
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u
// Set 既用于运行时校验，也让 TypeScript 类型与磁盘允许值保持一致。
const KNOWLEDGE_TYPES = new Set<KnowledgeType>(['business-rule', 'problem-pattern', 'architecture-decision'])
const LIFECYCLES = new Set<KnowledgeLifecycle>(['draft', 'reviewed', 'verified', 'stale', 'superseded', 'archived'])

/** WikiStore 构造参数；路径会在构造时立即转成绝对路径。 */
interface StoreConfig {
  wikiDir: string
  stateDir: string
  duplicateThreshold: number
  rrfK: number
  exactRrfWeight: number
  bm25RrfWeight: number
  metadataRrfWeight: number
}

/** 为一次搜索临时编译的文档统计；不写磁盘，也不成为长期索引。 */
interface SearchDocument {
  unit: KnowledgeUnit
  fields: Record<string, Bm25fField>
  metadataTokens: Set<string>
}

/** Loop Engineering 知识能力的本地 Git/Markdown 提供方。 */
export class WikiStore {
  readonly wikiDir: string
  readonly stateDir: string
  private readonly duplicateThreshold: number
  private readonly retrieval: Pick<StoreConfig, 'rrfK' | 'exactRrfWeight' | 'bm25RrfWeight' | 'metadataRrfWeight'>

  constructor(config: StoreConfig) {
    // 统一成绝对路径，避免 Web 进程工作目录变化时读写到不同位置。
    this.wikiDir = resolve(config.wikiDir)
    this.stateDir = resolve(config.stateDir)
    this.duplicateThreshold = config.duplicateThreshold
    this.retrieval = config
  }

  /** 创建提供方拥有的全部目录；`recursive` 让重复初始化安全且幂等。 */
  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.wikiDir, { recursive: true }),
      mkdir(join(this.stateDir, 'traces'), { recursive: true }),
      mkdir(join(this.stateDir, 'candidates'), { recursive: true }),
      mkdir(join(this.stateDir, 'patches'), { recursive: true }),
      mkdir(join(this.stateDir, 'feedback'), { recursive: true }),
    ])
  }

  /**
   * 递归解析每个规范 Markdown 页。
   * 任一页面格式错误都会明确失败，而不是悄悄从搜索结果消失，防止团队误以为知识不存在。
   */
  async list(): Promise<KnowledgeUnit[]> {
    await this.initialize()
    const files = await markdownFiles(this.wikiDir)
    return Promise.all(files.map(async filePath => this.parseUnit(filePath, await readFile(filePath, 'utf8'))))
  }

  /**
   * BM25F 字段检索，再叠加类型软路由、scope、生命周期和置信度排序。
   *
   * MVP 每次搜索都从 Markdown 重新编译轻量索引：规模小、行为透明，并能立即看到手工编辑结果。
   * 未来若换向量库，`KnowledgeCard` 和上层工具接口仍可保持不变。
   */
  async search(query: string, options: SearchOptions = {}): Promise<KnowledgeCard[]> {
    const queryTokens = tokenize(query)
    // 全是停用词或标点时无需扫描 Wiki。
    if (queryTokens.length === 0) return []
    const documents = (await this.list())
      // 已归档/被替代知识默认退出主动召回，但文件仍保留用于审计。
      .filter(unit => unit.metadata.lifecycle !== 'archived' && unit.metadata.lifecycle !== 'superseded')
      .filter(unit => options.type === undefined || unit.metadata.type === options.type)
      .filter(unit => options.repo === undefined || unit.metadata.scope.repos.includes(options.repo))
      .filter(unit => options.domain === undefined || unit.metadata.scope.domains.includes(options.domain))
      .filter(unit => options.module === undefined || unit.metadata.scope.modules.includes(options.module))
      .map(unit => searchDocument(unit))
    if (documents.length === 0) return []

    const bm25 = bm25fScores(documents.map(document => ({
      id: document.unit.metadata.id,
      fields: document.fields,
    })), queryTokens)
    const exact = new Map(documents.map(document => [document.unit.metadata.id, exactFieldScore(document.unit, query)]))
    const metadata = new Map(documents.map(document => [document.unit.metadata.id, tokenCoverage(queryTokens, document.metadataTokens)]))
    const typeRoutes = options.type === undefined ? routeKnowledgeTypes(query) : undefined
    const ranked = (scores: Map<string, number>) => [...scores.entries()].filter(([, score]) => score > 0)
      .sort((left, right) => right[1] - left[1]).map(([id]) => id)
    const fused = reciprocalRankFusion([
      { channel: 'exact', weight: this.retrieval.exactRrfWeight, ids: ranked(exact) },
      { channel: 'bm25', weight: this.retrieval.bm25RrfWeight, ids: ranked(bm25) },
      { channel: 'metadata', weight: this.retrieval.metadataRrfWeight, ids: ranked(metadata) },
    ], this.retrieval.rrfK)
    const cards = documents.flatMap(document => {
      const signal = fused.get(document.unit.metadata.id)
      if (signal === undefined) return []
      const lifecycleWeight = document.unit.metadata.lifecycle === 'verified' ? 1 : document.unit.metadata.lifecycle === 'stale' ? 0.55 : 0.8
      // 查询类型只做软提升，绝不把未命中的文档类型过滤掉，避免路由误判造成召回损失。
      const typeWeight = typeRoutes?.[document.unit.metadata.type] ?? 1
      const score = signal.score * typeWeight * lifecycleWeight * (0.5 + document.unit.metadata.confidence / 2)
      return [cardOf(document.unit, score, signal.channels)]
    })
    const max = Math.max(...cards.map(card => card.relevance), Number.EPSILON)
    return cards
      // 归一化分数只用于当前结果展示；候选去重使用独立的绝对相似度，不再复用该值。
      .map(card => ({ ...card, relevance: Number((card.relevance / max).toFixed(4)) }))
      .sort((left, right) => right.relevance - left.relevance || right.confidence - left.confidence)
      .slice(0, options.limit ?? 5)
  }

  /** 按明确请求读取 L1 全文/章节或 L2 Evidence，自动检索永远不会走到这里。 */
  async read(id: string, section?: string, layer: 'detail' | 'evidence' = 'detail'): Promise<string> {
    const unit = await this.get(id)
    if (unit === undefined) throw new Error(`knowledge unit "${id}" was not found`)
    if (layer === 'evidence') return extractSection(unit.body, 'Evidence') ?? 'No evidence section is recorded.'
    if (section !== undefined) {
      const selected = extractSection(unit.body, section)
      if (selected === undefined) throw new Error(`knowledge unit "${id}" has no section "${section}"`)
      return selected
    }
    return unit.body.trim()
  }

  /** 根据 front matter 的 `related` ID 返回图邻居卡片，不加载邻居正文。 */
  async related(id: string): Promise<KnowledgeCard[]> {
    const unit = await this.get(id)
    if (unit === undefined) throw new Error(`knowledge unit "${id}" was not found`)
    const byId = new Map((await this.list()).map(candidate => [candidate.metadata.id, candidate]))
    return unit.metadata.related.flatMap(relatedId => {
      const related = byId.get(relatedId)
      return related === undefined ? [] : [cardOf(related, 1)]
    })
  }

  /** 把紧凑 trace 持久化为写入链证据；文件名由 session 与 turn 稳定组成。 */
  async writeTrace(trace: EngineeringTrace): Promise<string> {
    await this.initialize()
    const path = join(this.stateDir, 'traces', `${slugify(trace.sessionId)}-turn-${trace.turn}.json`)
    await atomicWrite(path, `${JSON.stringify(trace, null, 2)}\n`)
    return path
  }

  /**
   * 提炼 trace/显式输入并执行 Search Before Create。
   * 该方法只写 `.loop-engineering` 下的审查材料，绝不会直接修改规范 Wiki。
   */
  async propose(trace: EngineeringTrace, explicit?: string): Promise<{ candidate: KnowledgeCandidate; patch: KnowledgePatch }> {
    await this.initialize()
    const tracePath = await this.writeTrace(trace)
    const distilled = distill(trace, explicit)
    // 使用标题、摘要和 triggers 搜索已有知识；取第一条超过阈值的结果作为更新目标。
    const duplicate = (await this.list())
      .map(unit => ({ unit, score: duplicateScore(distilled, unit) }))
      .filter(match => match.score >= this.duplicateThreshold)
      .sort((left, right) => right.score - left.score)[0]?.unit
    const now = new Date().toISOString()
    const candidateId = `candidate-${slugify(distilled.title)}-${contentVersion(`${trace.sessionId}:${trace.turn}:${explicit ?? ''}`)}`
    const candidate: KnowledgeCandidate = {
      candidateId,
      ...distilled,
      tracePath: relative(this.stateDir, tracePath).replaceAll('\\', '/'),
      createdAt: now,
      status: 'pending-review',
    }
    const verification = verifyCandidate(candidate, trace)
    const targetId = duplicate?.metadata.id ?? canonicalId(candidate.type, candidate.title)
    const patch: KnowledgePatch = {
      patchId: `patch-${contentVersion(candidateId)}`,
      candidateId,
      // MVP 的 Search Before Create 只产生 create/update；其他 operation 为后续扩展预留。
      operation: duplicate === undefined ? 'create' : 'update',
      targets: [targetId],
      changes: patchChanges(candidate, duplicate !== undefined),
      evidence: [...candidate.evidence],
      confidence: candidate.confidence,
      verification,
      lintErrors: structuralLintCandidate(candidate),
      createdAt: now,
    }
    await Promise.all([
      // 候选与 Patch 分开保存：候选描述“声称什么”，Patch 描述“准备怎样改 Wiki”。
      atomicWrite(this.candidatePath(candidateId), `${JSON.stringify(candidate, null, 2)}\n`),
      atomicWrite(this.patchPath(patch.patchId), `${JSON.stringify(patch, null, 2)}\n`),
    ])
    return { candidate, patch }
  }

  /** 列出所有待审候选，并读取其确定性 Patch 组成审查对。 */
  async pending(): Promise<Array<{ candidate: KnowledgeCandidate; patch: KnowledgePatch }>> {
    await this.initialize()
    const candidateFiles = (await readdir(join(this.stateDir, 'candidates'), { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    const values = await Promise.all(candidateFiles.map(async entry => JSON.parse(
      await readFile(join(this.stateDir, 'candidates', entry.name), 'utf8'),
    ) as KnowledgeCandidate))
    const pending = values.filter(candidate => candidate.status === 'pending-review')
    return Promise.all(pending.map(async (candidate) => {
      const patchId = `patch-${contentVersion(candidate.candidateId)}`
      return {
        candidate,
        patch: JSON.parse(await readFile(this.patchPath(patchId), 'utf8')) as KnowledgePatch,
      }
    }))
  }

  /**
   * 确定性应用一个已审查 Patch；模型文本永远不能直接覆盖整页。
   * 发布前会重新读取磁盘状态并依次检查候选状态、证据等级、候选 lint 和最终知识页 lint。
   */
  async publish(candidateId: string): Promise<KnowledgeUnit> {
    const candidate = await this.readCandidate(candidateId)
    if (candidate.status !== 'pending-review') throw new Error(`candidate "${candidateId}" is ${candidate.status}`)
    const patch = JSON.parse(await readFile(this.patchPath(`patch-${contentVersion(candidateId)}`), 'utf8')) as KnowledgePatch
    if (patch.verification === 'UNSUPPORTED' || patch.verification === 'CONFLICTING') {
      throw new Error(`patch "${patch.patchId}" cannot publish with verification ${patch.verification}`)
    }
    if (patch.lintErrors.length > 0) throw new Error(`patch "${patch.patchId}" failed lint: ${patch.lintErrors.join('; ')}`)
    const target = patch.targets[0]
    if (target === undefined) throw new Error(`patch "${patch.patchId}" has no target`)
    const existing = await this.get(target)
    // 新知识从结构化章节创建；已有知识只合并别名、触发词、来源、出现记录和证据。
    const unit = existing === undefined
      ? unitFromCandidate(target, candidate)
      : updateUnit(existing, candidate)
    const lint = structuralLintUnit(unit)
    if (lint.length > 0) throw new Error(`knowledge unit "${target}" failed lint: ${lint.join('; ')}`)
    const path = existing?.filePath ?? join(this.wikiDir, candidate.type, `${target}.md`)
    await mkdir(dirname(path), { recursive: true })
    await atomicWrite(path, serializeUnit(unit))
    await this.setCandidateStatus(candidate, 'published')
    return this.parseUnit(path, await readFile(path, 'utf8'))
  }

  /** 驳回候选只改变 JSON 状态，不修改任何规范 Markdown。 */
  async dismiss(candidateId: string): Promise<void> {
    const candidate = await this.readCandidate(candidateId)
    if (candidate.status !== 'pending-review') throw new Error(`candidate "${candidateId}" is ${candidate.status}`)
    await this.setCandidateStatus(candidate, 'dismissed')
  }

  private async get(id: string): Promise<KnowledgeUnit | undefined> {
    // MVP 规模较小，直接扫描保证手工修改立即可见；不维护可能陈旧的进程内缓存。
    return (await this.list()).find(unit => unit.metadata.id === id)
  }

  /** 解析并校验单个 Markdown；version 对完整源文件计算，因此元数据或正文变化都会更新。 */
  private parseUnit(filePath: string, source: string): KnowledgeUnit {
    const match = FRONTMATTER.exec(source)
    if (match === null) throw new Error(`${filePath}: missing YAML frontmatter`)
    const metadata = normalizeMetadata(load(match[1] ?? ''))
    const body = match[2] ?? ''
    const unit = { metadata, body, filePath, version: contentVersion(source) }
    const errors = structuralLintUnit(unit)
    if (errors.length > 0) throw new Error(`${filePath}: ${errors.join('; ')}`)
    return unit
  }

  private candidatePath(candidateId: string): string {
    return join(this.stateDir, 'candidates', `${candidateId}.json`)
  }

  private patchPath(patchId: string): string {
    return join(this.stateDir, 'patches', `${patchId}.json`)
  }

  private async readCandidate(candidateId: string): Promise<KnowledgeCandidate> {
    return JSON.parse(await readFile(this.candidatePath(candidateId), 'utf8')) as KnowledgeCandidate
  }

  private async setCandidateStatus(candidate: KnowledgeCandidate, status: KnowledgeCandidate['status']): Promise<void> {
    // 状态更新仍使用原子写，避免进程异常留下半截 JSON。
    await atomicWrite(this.candidatePath(candidate.candidateId), `${JSON.stringify({ ...candidate, status }, null, 2)}\n`)
  }
}

/** 递归收集 Wiki 下所有 Markdown，并排序以保证测试和搜索结果在不同文件系统上一致。 */
async function markdownFiles(root: string): Promise<string[]> {
  const output: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      // temp 保存合并 Wiki 与评测集，不是运行时规范知识；否则 evaluate.md 会被当作知识页解析。
      if (entry.isDirectory() && entry.name !== 'temp') await visit(path)
      else if (entry.isFile() && entry.name.endsWith('.md')) output.push(path)
    }
  }
  await visit(root)
  return output.sort()
}

/**
 * 把 js-yaml 返回的 unknown 转成严格 KnowledgeMetadata。
 * 所有外部文件输入都在这一层清洗，后面的搜索和发布代码无需反复做空值判断。
 */
function normalizeMetadata(value: unknown): KnowledgeMetadata {
  if (typeof value !== 'object' || value === null) throw new TypeError('frontmatter must be an object')
  const raw = value as Record<string, unknown>
  const type = raw.type
  const lifecycle = raw.lifecycle
  if (typeof type !== 'string' || !KNOWLEDGE_TYPES.has(type as KnowledgeType)) throw new TypeError(`invalid knowledge type "${String(type)}"`)
  if (typeof lifecycle !== 'string' || !LIFECYCLES.has(lifecycle as KnowledgeLifecycle)) throw new TypeError(`invalid lifecycle "${String(lifecycle)}"`)
  return {
    id: requiredString(raw.id, 'id'),
    type: type as KnowledgeType,
    title: requiredString(raw.title, 'title'),
    summary: requiredString(raw.summary, 'summary'),
    aliases: stringArray(raw.aliases),
    triggers: stringArray(raw.triggers),
    scope: normalizeScope(raw.scope),
    confidence: boundedConfidence(raw.confidence),
    lifecycle: lifecycle as KnowledgeLifecycle,
    sources: stringArray(raw.sources),
    related: stringArray(raw.related),
    created_at: requiredString(raw.created_at, 'created_at'),
    updated_at: requiredString(raw.updated_at, 'updated_at'),
    ...(typeof raw.last_verified_at === 'string' ? { last_verified_at: raw.last_verified_at } : {}),
  }
}

/** scope 缺失时使用三个空数组，而不是让调用方处理 undefined。 */
function normalizeScope(value: unknown): KnowledgeScope {
  const raw = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  return { repos: stringArray(raw.repos), domains: stringArray(raw.domains), modules: stringArray(raw.modules) }
}

/** 读取必填非空字符串，并顺便去掉首尾空白。 */
function requiredString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${key} must be a non-empty string`)
  return value.trim()
}

/** 从未知 YAML 值中提取、清理并去重字符串数组。 */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()))] : []
}

/** 置信度只能是有限的 0..1 数字，拒绝字符串、NaN 和越界值。 */
function boundedConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new TypeError('confidence must be between 0 and 1')
  return value
}

/**
 * 把类型化知识页编译成 BM25F 搜索文档。
 * 每个字段独立统计长度和词频，权重直接表达“标题/症状/规则比普通正文更重要”。
 */
function searchDocument(unit: KnowledgeUnit): SearchDocument {
  const metadata = unit.metadata
  const scope = [metadata.scope.repos, metadata.scope.domains, metadata.scope.modules].flat().join(' ')
  const primarySections = metadata.type === 'problem-pattern'
    ? ['Symptoms', 'Trigger Conditions', 'Root Cause', 'Diagnosis', 'Solution Pattern']
    : metadata.type === 'business-rule'
      ? ['Rule', 'Exceptions', 'Reason']
      : ['Decision', 'Context', 'Rejected Alternatives', 'Trade-offs']
  const primary = primarySections.map(section => extractSection(unit.body, section) ?? '').join('\n')
  const fields: Record<string, Bm25fField> = {
    id: bm25fField(metadata.id, 5, 0),
    title: bm25fField(metadata.title, 3, 0.2),
    aliases: bm25fField(metadata.aliases.join(' '), 2.5, 0.3),
    triggers: bm25fField(metadata.triggers.join(' '), 2.5, 0.5),
    summary: bm25fField(metadata.summary, 2, 0.6),
    scope: bm25fField(scope, 1.8, 0.2),
    primary: bm25fField(primary, 1.7, 0.7),
    // 全文保底保证未被结构投影覆盖的细节仍能召回，但权重低于规范字段。
    body: bm25fField(unit.body, 0.65, 0.8),
  }
  const metadataTokens = new Set(tokenize([
    metadata.id, metadata.title, metadata.summary, metadata.aliases.join(' '), metadata.triggers.join(' '),
    metadata.scope.repos.join(' '), metadata.scope.domains.join(' '), metadata.scope.modules.join(' '),
  ].join(' ')))
  return { unit, fields, metadataTokens }
}

function bm25fField(value: string, weight: number, b: number): Bm25fField {
  const tokens = tokenize(value)
  const termCounts = new Map<string, number>()
  for (const token of tokens) termCounts.set(token, (termCounts.get(token) ?? 0) + 1)
  return { tokens, termCounts, weight, b }
}

/** 把完整知识页投影成不含正文的低成本 L0 卡片。 */
function cardOf(unit: KnowledgeUnit, relevance: number, retrievalChannels?: KnowledgeCard['retrievalChannels']): KnowledgeCard {
  return {
    id: unit.metadata.id,
    title: unit.metadata.title,
    type: unit.metadata.type,
    summary: unit.metadata.summary,
    scope: unit.metadata.scope,
    lifecycle: unit.metadata.lifecycle,
    confidence: unit.metadata.confidence,
    relevance,
    version: unit.version,
    ...(retrievalChannels === undefined ? {} : { retrievalChannels }),
  }
}

function exactFieldScore(unit: KnowledgeUnit, query: string): number {
  const normalized = query.trim().toLocaleLowerCase()
  const fields = [unit.metadata.id, unit.metadata.title, ...unit.metadata.aliases, ...unit.metadata.triggers]
    .map(value => value.trim().toLocaleLowerCase()).filter(Boolean)
  if (fields.includes(normalized)) return 1
  if (normalized.length >= 6 && fields.some(value => value.includes(normalized) || normalized.includes(value))) return 0.75
  return 0
}

function tokenCoverage(queryTokens: string[], documentTokens: ReadonlySet<string>): number {
  const query = [...new Set(queryTokens)]
  if (query.length === 0) return 0
  return query.filter(token => documentTokens.has(token)).length / query.length
}

/** 去重使用跨查询稳定的字段相似度，不使用结果集内归一化的展示相关度。 */
function duplicateScore(candidate: Pick<KnowledgeCandidate, 'type' | 'title' | 'summary' | 'aliases' | 'triggers'>, unit: KnowledgeUnit): number {
  if (candidate.type !== unit.metadata.type) return 0
  const title = candidate.title.trim().toLocaleLowerCase()
  const existingNames = [unit.metadata.title, ...unit.metadata.aliases].map(value => value.trim().toLocaleLowerCase())
  if (existingNames.includes(title)) return 1
  const candidateNames = [title, ...candidate.aliases.map(value => value.toLocaleLowerCase())]
  if (candidateNames.some(value => existingNames.includes(value))) return 0.95
  const similarity = (left: string, right: string): number => {
    const a = new Set(tokenize(left))
    const b = new Set(tokenize(right))
    const union = new Set([...a, ...b])
    return union.size === 0 ? 0 : [...a].filter(token => b.has(token)).length / union.size
  }
  const titleScore = similarity(candidate.title, unit.metadata.title)
  const summaryScore = similarity(candidate.summary, unit.metadata.summary)
  const triggerScore = similarity(candidate.triggers.join(' '), unit.metadata.triggers.join(' '))
  return 0.55 * titleScore + 0.3 * summaryScore + 0.15 * triggerScore
}

/**
 * 按二级标题精确提取一个 Markdown 章节。
 * 先转义标题中的正则字符，再读取到下一个 `##` 或文件结尾；标题匹配不区分大小写。
 */
function extractSection(body: string, requested: string): string | undefined {
  const escaped = requested.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`^##\\s+${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, 'imu').exec(body)
  return match?.[1]?.trim()
}

/**
 * 把 EngineeringTrace 和可选的 `/save-knowledge` 参数提炼成结构化候选。
 * 这是确定性模板提炼：同类知识有固定章节，不让模型自由生成整个 Markdown 文件。
 */
function distill(trace: EngineeringTrace, explicit?: string): Omit<KnowledgeCandidate, 'candidateId' | 'tracePath' | 'createdAt' | 'status'> {
  const parsed = parseExplicit(explicit)
  const type = parsed.type ?? inferType(explicit ?? trace.task)
  const firstError = trace.errors[0]
  const title = parsed.title ?? inferTitle(type, trace, firstError)
  const summary = parsed.summary ?? trace.finalOutcome ?? firstError ?? trace.task
  const evidence = [
    // session/turn 永远存在，错误和测试证据按实际 trace 追加。
    `session:${trace.sessionId}`,
    `turn:${trace.turn}`,
    ...trace.errors.map((_, index) => `trace:error:${index + 1}`),
    ...trace.tests.map(test => `test:${test.name}:${test.outcome}`),
  ]
  const structuredContent = type === 'problem-pattern'
    // 不同知识类型使用不同固定章节，正好对应 structuralLintUnit 的必填要求。
    ? {
        Problem: trace.task,
        Symptoms: trace.errors.length > 0 ? trace.errors : ['See task statement.'],
        'Trigger Conditions': parsed.triggers,
        'Root Cause': trace.finalOutcome ?? 'Requires reviewer confirmation.',
        Diagnosis: trace.commands.map(command => command.command),
        'Solution Pattern': parsed.summary ?? trace.finalOutcome ?? 'Requires reviewer confirmation.',
        Verification: trace.tests.map(test => `${test.name}: ${test.outcome}`),
        'Known Occurrences': [`session:${trace.sessionId} turn:${trace.turn}`],
        Evidence: evidence,
      }
    : type === 'business-rule'
      ? { Rule: summary, Exceptions: [], Reason: 'Requires reviewer confirmation.', Evidence: evidence }
      : { Decision: summary, Context: trace.task, 'Rejected Alternatives': [], 'Trade-offs': [], Evidence: evidence }
  return {
    type,
    title,
    summary,
    structuredContent,
    aliases: parsed.aliases,
    triggers: parsed.triggers.length > 0 ? parsed.triggers : tokenize(`${trace.task} ${firstError ?? ''}`).slice(0, 12),
    scope: { repos: [], domains: [], modules: modulesFrom(trace.filesRead.concat(trace.filesChanged)) },
    evidence,
    // 给显式但未解决的知识保留最低可审查置信度，同时不允许自动结果达到绝对 1.0。
    confidence: Math.min(0.98, Math.max(0.35, trace.resolutionConfidence)),
  }
}

/** 解析 `/save-knowledge` 的竖线协议：type | title | summary | aliases | triggers。 */
function parseExplicit(value?: string): { type?: KnowledgeType; title?: string; summary?: string; aliases: string[]; triggers: string[] } {
  if (value === undefined || value.trim().length === 0) return { aliases: [], triggers: [] }
  const pieces = value.split('|').map(piece => piece.trim())
  const first = pieces[0]
  const type = first !== undefined && KNOWLEDGE_TYPES.has(first as KnowledgeType) ? first as KnowledgeType : undefined
  const offset = type === undefined ? 0 : 1
  return {
    ...(type === undefined ? {} : { type }),
    ...(pieces[offset] ? { title: pieces[offset] } : {}),
    ...(pieces[offset + 1] ? { summary: pieces[offset + 1] } : {}),
    aliases: pieces[offset + 2]?.split(',').map(item => item.trim()).filter(Boolean) ?? [],
    triggers: pieces[offset + 3]?.split(',').map(item => item.trim()).filter(Boolean) ?? [],
  }
}

/** 没有显式 type 时，用少量中英文关键词推断；默认回落到最常见的 problem-pattern。 */
function inferType(text: string): KnowledgeType {
  if (/架构|architecture|模块边界|依赖方向|ownership|事实来源/iu.test(text)) return 'architecture-decision'
  if (/必须|禁止|不能|业务规则|entitlement|only|must|never/iu.test(text)) return 'business-rule'
  return 'problem-pattern'
}

/** 没有显式标题时，优先用第一条错误，否则用任务开头，并加上类型前缀。 */
function inferTitle(type: KnowledgeType, trace: EngineeringTrace, error?: string): string {
  const seed = error?.split(/\r?\n/u)[0]?.slice(0, 80) || trace.task.slice(0, 80)
  const prefix = type === 'problem-pattern' ? 'Problem Pattern' : type === 'business-rule' ? 'Business Rule' : 'Architecture Decision'
  return `${prefix}: ${seed}`
}

/** 从读写文件路径提取最多 12 个上级目录片段，形成初始 module scope。 */
function modulesFrom(files: string[]): string[] {
  return [...new Set(files.flatMap(file => file.replaceAll('\\', '/').split('/').slice(0, -1)).filter(part => part && part !== '.' && part !== 'src'))].slice(0, 12)
}

/**
 * 证据分级规则。
 * 未解决的问题模式只能 PARTIALLY_SUPPORTED；有通过测试的问题模式可 SUPPORTED；
 * 其他类型主要依赖审查和 trace 置信度。UNSUPPORTED/CONFLICTING 会在 publish 中被阻止。
 */
function verifyCandidate(candidate: KnowledgeCandidate, trace: EngineeringTrace): KnowledgePatch['verification'] {
  if (candidate.evidence.length < 2) return 'UNSUPPORTED'
  if (candidate.type === 'problem-pattern' && !trace.resolved) return 'PARTIALLY_SUPPORTED'
  if (candidate.type === 'problem-pattern' && trace.tests.some(test => test.outcome === 'pass')) return 'SUPPORTED'
  return candidate.confidence >= 0.75 ? 'SUPPORTED' : 'PARTIALLY_SUPPORTED'
}

/** 在生成 Patch 时先检查候选最基本的类型、长度、证据和置信度。 */
function structuralLintCandidate(candidate: KnowledgeCandidate): string[] {
  const errors: string[] = []
  if (!KNOWLEDGE_TYPES.has(candidate.type)) errors.push('unknown knowledge type')
  if (candidate.title.trim().length < 4) errors.push('title is too short')
  if (candidate.summary.trim().length < 8) errors.push('summary is too short')
  if (candidate.evidence.length === 0) errors.push('evidence is required')
  if (candidate.confidence < 0 || candidate.confidence > 1) errors.push('confidence is outside 0..1')
  return errors
}

/**
 * 检查最终知识页的 ID 前缀、来源和类型必需章节。
 * 这是发布前最后一道结构门，也是手工 Markdown 被 list() 加载时的健康检查。
 */
function structuralLintUnit(unit: KnowledgeUnit): string[] {
  const errors: string[] = []
  if (!unit.metadata.id.startsWith(`${typePrefix(unit.metadata.type)}.`)) errors.push('id prefix does not match type')
  if (unit.metadata.sources.length === 0) errors.push('sources are required')
  const required = unit.metadata.type === 'problem-pattern'
    ? ['Problem', 'Symptoms', 'Trigger Conditions', 'Root Cause', 'Diagnosis', 'Solution Pattern', 'Verification', 'Known Occurrences', 'Evidence']
    : unit.metadata.type === 'business-rule'
      ? ['Rule', 'Exceptions', 'Reason', 'Evidence']
      : ['Decision', 'Context', 'Rejected Alternatives', 'Trade-offs', 'Evidence']
  for (const section of required) if (extractSection(unit.body, section) === undefined) errors.push(`missing section ${section}`)
  return errors
}

/** 把结构化章节转换成 Patch changes；更新时只有出现记录和证据采用追加语义。 */
function patchChanges(candidate: KnowledgeCandidate, update: boolean): KnowledgePatch['changes'] {
  return Object.entries(candidate.structuredContent).map(([section, value]) => ({
    section,
    action: update && (section === 'Known Occurrences' || section === 'Evidence') ? 'append' as const : 'set' as const,
    value: Array.isArray(value) ? value.map(item => `- ${item}`).join('\n') : value,
  }))
}

/** 根据知识类型和标题生成规范 ID，例如 `problem.some-title`。 */
function canonicalId(type: KnowledgeType, title: string): string {
  return `${typePrefix(type)}.${slugify(title.replace(/^(Problem Pattern|Business Rule|Architecture Decision):\s*/iu, ''))}`
}

/** 知识类型到 ID 前缀的唯一映射。 */
function typePrefix(type: KnowledgeType): string {
  if (type === 'problem-pattern') return 'problem'
  if (type === 'business-rule') return 'rule'
  return 'decision'
}

/** 从一个新候选创建完整知识页；只有高置信问题模式直接进入 verified。 */
function unitFromCandidate(id: string, candidate: KnowledgeCandidate): KnowledgeUnit {
  const today = candidate.createdAt.slice(0, 10)
  const lifecycle: KnowledgeLifecycle = candidate.type === 'problem-pattern' && candidate.confidence >= 0.75 ? 'verified' : 'reviewed'
  const metadata: KnowledgeMetadata = {
    id,
    type: candidate.type,
    title: candidate.title,
    summary: candidate.summary,
    aliases: candidate.aliases,
    triggers: candidate.triggers,
    scope: candidate.scope,
    confidence: candidate.confidence,
    lifecycle,
    sources: candidate.evidence,
    related: [],
    created_at: today,
    updated_at: today,
    ...(lifecycle === 'verified' ? { last_verified_at: today } : {}),
  }
  const body = Object.entries(candidate.structuredContent).map(([section, value]) => {
    const rendered = Array.isArray(value) ? value.map(item => `- ${item}`).join('\n') : value
    return `## ${section}\n\n${rendered || '_None recorded._'}`
  }).join('\n\n')
  return { metadata, body: `${body}\n`, filePath: '', version: '' }
}

/**
 * 合并候选到已有知识。
 * MVP 不覆盖已有根因和方案，只合并可安全累积的别名、触发词、来源、出现记录和证据。
 */
function updateUnit(existing: KnowledgeUnit, candidate: KnowledgeCandidate): KnowledgeUnit {
  const today = candidate.createdAt.slice(0, 10)
  let body = existing.body.trimEnd()
  const occurrence = `session:${candidate.evidence.find(item => item.startsWith('session:'))?.slice(8) ?? 'unknown'} (${candidate.createdAt})`
  body = appendUniqueSectionItem(body, 'Known Occurrences', occurrence)
  for (const source of candidate.evidence) body = appendUniqueSectionItem(body, 'Evidence', source)
  const metadata: KnowledgeMetadata = {
    ...existing.metadata,
    aliases: [...new Set([...existing.metadata.aliases, ...candidate.aliases])],
    triggers: [...new Set([...existing.metadata.triggers, ...candidate.triggers])],
    sources: [...new Set([...existing.metadata.sources, ...candidate.evidence])],
    confidence: Math.min(0.99, Math.max(existing.metadata.confidence, candidate.confidence) + 0.02),
    updated_at: today,
    ...(candidate.confidence >= 0.75 ? { lifecycle: 'verified', last_verified_at: today } : {}),
  }
  return { ...existing, metadata, body: `${body}\n`, version: '' }
}

/** 向指定章节追加一个不重复的列表项；章节不存在时创建它。 */
function appendUniqueSectionItem(body: string, section: string, value: string): string {
  const current = extractSection(body, section)
  if (current?.includes(value)) return body
  const line = `- ${value}`
  if (current === undefined) return `${body}\n\n## ${section}\n\n${line}`
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return body.replace(
    new RegExp(`(^##\\s+${escaped}\\s*\\r?\\n[\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, 'imu'),
    match => `${match.trimEnd()}\n${line}\n\n`,
  )
}

/** 用固定 YAML 选项和单一换行风格序列化知识页，保证 Git diff 稳定。 */
function serializeUnit(unit: KnowledgeUnit): string {
  const yaml = dump(unit.metadata, { lineWidth: 100, noRefs: true, sortKeys: false }).trimEnd()
  return `---\n${yaml}\n---\n\n${unit.body.trim()}\n`
}

/**
 * 原子写文件：先在目标目录写临时文件，再 rename 覆盖正式文件。
 * 如果进程在 writeFile 中途退出，旧正式文件仍完整；不会留下半个 Markdown/JSON。
 */
async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}

/** 只回答路径是否存在，不把权限或不存在等文件系统异常暴露给调用方。 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
