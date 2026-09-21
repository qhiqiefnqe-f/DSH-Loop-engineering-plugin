import { dump, load } from 'js-yaml'
import type { KnowledgeCard, KnowledgeType, SearchOptions } from './types.ts'

/**
 * 检索评测的数据适配与指标计算层。
 *
 * 这里故意只依赖最小的 SearchProvider 接口：既可评测生产 WikiStore，也可在单元测试中注入
 * 可预测的假搜索器。解析器兼容网页复制后的 Markdown 和 JSONL，指标函数则保持无副作用，
 * 让数据清洗问题与检索质量问题能够分开定位。
 */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u
const TYPES = new Set<KnowledgeType>(['business-rule', 'problem-pattern', 'architecture-decision'])

export interface CombinedWikiDocument {
  id: string
  type: KnowledgeType
  source: string
}

export interface RetrievalEvaluationCase {
  caseId: string
  query: string
  relevant: Map<string, number>
  noAnswer: boolean
  split?: string
  category?: string
}

export interface RetrievalEvaluationResult {
  k: number
  cases: number
  answerableCases: number
  noAnswerCases: number
  recallAtK: number
  primaryRecallAtK: number
  hitRateAtK: number
  noAnswerFalsePositiveRate: number
  misses: Array<{ caseId: string; query: string; expected: string[]; retrieved: string[] }>
}

interface SearchProvider {
  search(query: string, options?: SearchOptions): Promise<KnowledgeCard[]>
}

/** 解析 GPT 生成的合并 Wiki；优先支持 FILE/END FILE 标记，也兼容多个 frontmatter 顺序拼接。 */
export function parseCombinedWiki(source: string): CombinedWikiDocument[] {
  const normalized = stripCodeFences(source)
  const marker = /^(?:#{1,6}\s*)?===\s*FILE:[^\r\n]+===\s*\r?\n([\s\S]*?)^===\s*END FILE\s*===\s*$/gimu
  const marked = [...normalized.matchAll(marker)].map(match => match[1]?.trim()).filter((value): value is string => Boolean(value))
  const chunks = marked.length > 0 ? marked : splitFrontmatterDocuments(normalized)
  if (chunks.length === 0) throw new Error('wikis.md 中没有找到 Wiki 文件块')
  const documents = chunks.map((chunk, index) => {
    const rawChunk = `${stripCodeFences(chunk).trim()}\n`
    const sourceWithNewline = FRONTMATTER.test(rawChunk) ? rawChunk : repairRenderedWikiBlock(rawChunk, index)
    const match = FRONTMATTER.exec(sourceWithNewline)
    if (match === null) throw new Error(`合并 Wiki 的第 ${index + 1} 个文件缺少 YAML frontmatter`)
    const raw = load(match[1] ?? '')
    if (typeof raw !== 'object' || raw === null) throw new Error(`合并 Wiki 的第 ${index + 1} 个 frontmatter 无效`)
    const metadata = raw as Record<string, unknown>
    if (typeof metadata.id !== 'string' || !/^[\p{L}\p{N}._-]+$/u.test(metadata.id)) throw new Error(`第 ${index + 1} 个 Wiki 的 id 无效`)
    if (typeof metadata.type !== 'string' || !TYPES.has(metadata.type as KnowledgeType)) throw new Error(`第 ${index + 1} 个 Wiki 的 type 无效`)
    return { id: metadata.id, type: metadata.type as KnowledgeType, source: sourceWithNewline }
  })
  const ids = new Set<string>()
  for (const document of documents) {
    if (ids.has(document.id)) throw new Error(`合并 Wiki 存在重复 id: ${document.id}`)
    ids.add(document.id)
  }
  return documents
}

/**
 * 浏览器复制 Markdown 渲染结果时，开头的 `---` 可能消失，YAML 数组也会变成 `*` 列表。
 * 评测入口只对已知 schema 做一次严格修复，再交给正式 WikiStore 完整校验；生产 Wiki 不走此兼容分支。
 */
function repairRenderedWikiBlock(source: string, index: number): string {
  const lines = source.split(/\r?\n/u)
  const separator = lines.findIndex(line => line.trim() === '---')
  if (separator < 0) throw new Error(`合并 Wiki 的第 ${index + 1} 个文件没有正文分隔线`)
  const header = lines.slice(0, separator)
  const body = lines.slice(separator + 1).join('\n').trim()
  const scalars = new Map<string, string>()
  const arrays = new Map<string, string[]>([
    ['aliases', []], ['triggers', []], ['repos', []], ['domains', []], ['modules', []], ['sources', []], ['related', []],
  ])
  let activeArray: string | undefined
  const known = /^(id|type|title|summary|aliases|triggers|scope|repos|domains|modules|confidence|lifecycle|sources|related|created_at|updated_at|last_verified_at)$/u
  for (const line of header) {
    const property = /^\s*([a-z_]+):(?:\s+(.*))?\s*$/iu.exec(line)
    if (property !== null && known.test(property[1] ?? '')) {
      const key = property[1] ?? ''
      const value = property[2]?.trim()
      activeArray = arrays.has(key) ? key : undefined
      if (value !== undefined && value.length > 0) scalars.set(key, decodedScalar(value))
      continue
    }
    const item = /^\s*\*\s+(.+?)\s*$/u.exec(line)?.[1]
    if (item !== undefined && activeArray !== undefined) arrays.get(activeArray)?.push(decodedScalar(item))
  }
  const required = (key: string): string => {
    const value = scalars.get(key)
    if (value === undefined || value.length === 0) throw new Error(`合并 Wiki 的第 ${index + 1} 个文件缺少 ${key}`)
    return value
  }
  const metadata = {
    id: required('id'),
    type: required('type'),
    title: required('title'),
    summary: required('summary'),
    aliases: arrays.get('aliases') ?? [],
    triggers: arrays.get('triggers') ?? [],
    scope: { repos: arrays.get('repos') ?? [], domains: arrays.get('domains') ?? [], modules: arrays.get('modules') ?? [] },
    confidence: Number(required('confidence')),
    lifecycle: required('lifecycle'),
    sources: arrays.get('sources') ?? [],
    related: arrays.get('related') ?? [],
    created_at: required('created_at'),
    updated_at: required('updated_at'),
    ...(scalars.has('last_verified_at') ? { last_verified_at: scalars.get('last_verified_at') } : {}),
  }
  return `---\n${dump(metadata, { lineWidth: 100, noRefs: true, sortKeys: false }).trimEnd()}\n---\n\n${body}\n`
}

function decodedScalar(value: string): string {
  try {
    const decoded = load(value)
    return typeof decoded === 'string' || typeof decoded === 'number' ? String(decoded) : value
  } catch {
    return value.replace(/^['"]|['"]$/gu, '')
  }
}

/** 兼容 JSON 数组、JSONL 以及被 Markdown 代码围栏包裹的评测数据。 */
export function parseRetrievalEvaluation(source: string): RetrievalEvaluationCase[] {
  const normalized = stripCodeFences(source).trim()
  if (normalized.length === 0) throw new Error('evaluate.md 是空文件')
  let values: unknown[]
  try {
    const parsed = JSON.parse(normalized) as unknown
    values = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    values = extractJsonObjects(normalized)
  }
  const cases = values.map((value, index) => normalizeEvaluationCase(value, index))
  if (cases.length === 0) throw new Error('evaluate.md 中没有找到评测样本')
  return cases
}

/** 计算标准宏平均 Recall@K，同时给出主相关命中、HitRate 和无答案误召回率。 */
export async function evaluateRetrieval(provider: SearchProvider, cases: RetrievalEvaluationCase[], k = 5): Promise<RetrievalEvaluationResult> {
  const answerable = cases.filter(item => !item.noAnswer && item.relevant.size > 0)
  const noAnswer = cases.filter(item => item.noAnswer || item.relevant.size === 0)
  let recall = 0
  let primaryRecall = 0
  let hits = 0
  let falsePositives = 0
  const misses: RetrievalEvaluationResult['misses'] = []
  for (const item of cases) {
    const cards = await provider.search(item.query, { limit: k })
    const retrieved = new Set(cards.slice(0, k).map(card => card.id))
    if (item.noAnswer || item.relevant.size === 0) {
      if (retrieved.size > 0) falsePositives += 1
      continue
    }
    const relevant = [...item.relevant.keys()]
    const found = relevant.filter(id => retrieved.has(id))
    recall += found.length / relevant.length
    const primary = [...item.relevant].filter(([, grade]) => grade >= 2).map(([id]) => id)
    const primaryFound = primary.filter(id => retrieved.has(id))
    primaryRecall += primary.length === 0 ? found.length / relevant.length : primaryFound.length / primary.length
    if (found.length > 0) hits += 1
    if (found.length < relevant.length) misses.push({ caseId: item.caseId, query: item.query, expected: relevant, retrieved: [...retrieved] })
  }
  return {
    k,
    cases: cases.length,
    answerableCases: answerable.length,
    noAnswerCases: noAnswer.length,
    recallAtK: ratio(recall, answerable.length),
    primaryRecallAtK: ratio(primaryRecall, answerable.length),
    hitRateAtK: ratio(hits, answerable.length),
    noAnswerFalsePositiveRate: ratio(falsePositives, noAnswer.length),
    misses,
  }
}

function normalizeEvaluationCase(value: unknown, index: number): RetrievalEvaluationCase {
  if (typeof value !== 'object' || value === null) throw new Error(`第 ${index + 1} 个评测样本不是对象`)
  const raw = value as Record<string, unknown>
  const caseId = typeof raw.case_id === 'string' ? raw.case_id : typeof raw.caseId === 'string' ? raw.caseId : `case-${index + 1}`
  if (typeof raw.query !== 'string' || raw.query.trim().length === 0) throw new Error(`${caseId} 缺少 query`)
  const relevant = new Map<string, number>()
  if (Array.isArray(raw.relevant)) {
    for (const id of raw.relevant) if (typeof id === 'string') relevant.set(id, 1)
  } else if (typeof raw.relevant === 'object' && raw.relevant !== null) {
    for (const [id, grade] of Object.entries(raw.relevant as Record<string, unknown>)) {
      if (typeof grade === 'number' && grade > 0) relevant.set(id, grade)
    }
  }
  return {
    caseId,
    query: raw.query.trim(),
    relevant,
    noAnswer: raw.no_answer === true || relevant.size === 0,
    ...(typeof raw.split === 'string' ? { split: raw.split } : {}),
    ...(typeof raw.category === 'string' ? { category: raw.category } : {}),
  }
}

function splitFrontmatterDocuments(source: string): string[] {
  const starts = [...source.matchAll(/^---\r?\n(?=[\s\S]{0,800}?^id:\s*)/gmu)].map(match => match.index)
  return starts.map((start, index) => source.slice(start, starts[index + 1] ?? source.length).trim()).filter(Boolean)
}

function stripCodeFences(value: string): string {
  return value.replace(/^```(?:markdown|md|jsonl|json)?\s*$/gimu, '').replace(/^```\s*$/gmu, '')
}

function extractJsonObjects(source: string): unknown[] {
  const values: unknown[] = []
  let start = -1
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (character === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (character === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        try { values.push(JSON.parse(source.slice(start, index + 1)) as unknown) } catch { /* 忽略说明文字中的非 JSON 大括号。 */ }
        start = -1
      }
    }
  }
  return values
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4))
}
