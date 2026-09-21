import type { KnowledgeCard, KnowledgeType } from './types.ts'

/**
 * 与存储介质无关的检索算法层。
 *
 * WikiStore 负责把 Markdown 编译为字段统计，本文件只处理类型软路由、BM25F、RRF 融合和
 * 条件式重排策略。保持纯函数让每个排名阶段都能被独立单测，也便于未来把磁盘扫描替换成
 * 持久索引而不改变排序语义。
 */

export type RetrievalChannel = 'exact' | 'bm25' | 'metadata'

export interface RankedChannel {
  channel: RetrievalChannel
  weight: number
  ids: string[]
}

/** BM25F 的一个字段。字段权重表达编译结构的重要性，b 控制长度归一化强度。 */
export interface Bm25fField {
  tokens: string[]
  termCounts: Map<string, number>
  weight: number
  b: number
}

/** BM25F 只依赖稳定 ID 与字段统计，因此可独立单测，也能替换磁盘索引实现。 */
export interface Bm25fDocument {
  id: string
  fields: Record<string, Bm25fField>
}

const TYPE_CUES: Record<KnowledgeType, readonly RegExp[]> = {
  'problem-pattern': [
    /\b(?:bug|error|exception|failed?|failure|crash|undefined|null|timeout|incorrect|missing|stale|los(?:e|es|t))\b/iu,
    /错误|异常|失败|崩溃|超时|为空|未定义|丢失|失效|不生效|排查|修复/iu,
  ],
  'business-rule': [
    /\b(?:must|shall|should|prohibit(?:ed)?|forbid(?:den)?|allow(?:ed)?|policy|rule|constraint|compliance|requirement)\b/iu,
    /必须|禁止|不得|不可|允许|规则|约束|规范|合规|要求|能否/iu,
  ],
  'architecture-decision': [
    /\b(?:architecture|architectural|design|decision|trade-?off|boundary|adapter|alternative|choose|choice)\b/iu,
    /架构|设计|决策|选型|权衡|边界|适配器|替代方案|为什么采用/iu,
  ],
}

/**
 * 把自然语言查询软路由到三种知识类型。
 *
 * 这里不做硬过滤：类型猜错时正确文档仍能召回，只失去一个小幅加权。多个意图同时出现时，
 * 所有命中的类型都会获得提升，适合“先排查问题，再确认架构约束”这类复合任务。
 */
export function routeKnowledgeTypes(query: string): Record<KnowledgeType, number> {
  const matches = Object.fromEntries(Object.entries(TYPE_CUES).map(([type, patterns]) => [
    type,
    patterns.reduce((total, pattern) => total + (pattern.test(query) ? 1 : 0), 0),
  ])) as Record<KnowledgeType, number>
  const maximum = Math.max(...Object.values(matches))
  if (maximum === 0) return { 'problem-pattern': 1, 'business-rule': 1, 'architecture-decision': 1 }
  return {
    'problem-pattern': typeRouteWeight(matches['problem-pattern'], maximum),
    'business-rule': typeRouteWeight(matches['business-rule'], maximum),
    'architecture-decision': typeRouteWeight(matches['architecture-decision'], maximum),
  }
}

function typeRouteWeight(score: number, maximum: number): number {
  if (score === 0) return 1
  return score === maximum ? 1.18 : 1.08
}

/**
 * 字段级 BM25F：先在每个字段内做长度归一化，再按字段权重汇总词频，最后计算 BM25 饱和分数。
 * 这让标题、症状、规则等编译字段真正拥有独立权重，而不是靠重复拼接文本近似模拟。
 */
export function bm25fScores(documents: Bm25fDocument[], queryTokens: string[], k1 = 1.2): Map<string, number> {
  const output = new Map<string, number>()
  if (documents.length === 0) return output
  const fieldNames = [...new Set(documents.flatMap(document => Object.keys(document.fields)))]
  const averageLengths = new Map(fieldNames.map(name => [
    name,
    documents.reduce((total, document) => total + (document.fields[name]?.tokens.length ?? 0), 0) / documents.length,
  ]))
  for (const document of documents) {
    let score = 0
    for (const token of new Set(queryTokens)) {
      const containing = documents.filter(candidate => Object.values(candidate.fields)
        .some(field => field.termCounts.has(token))).length
      const idf = Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5))
      let weightedFrequency = 0
      for (const [name, field] of Object.entries(document.fields)) {
        const frequency = field.termCounts.get(token) ?? 0
        if (frequency === 0) continue
        const averageLength = Math.max(1, averageLengths.get(name) ?? 1)
        const lengthNormalization = 1 - field.b + field.b * field.tokens.length / averageLength
        weightedFrequency += field.weight * frequency / Math.max(0.001, lengthNormalization)
      }
      score += idf * ((k1 + 1) * weightedFrequency) / Math.max(0.001, k1 + weightedFrequency)
    }
    output.set(document.id, score)
  }
  return output
}

/** 使用 Reciprocal Rank Fusion 融合不同量纲的排名，不直接相加原始分数。 */
export function reciprocalRankFusion(channels: RankedChannel[], k: number): Map<string, { score: number; channels: RetrievalChannel[] }> {
  const fused = new Map<string, { score: number; channels: RetrievalChannel[] }>()
  for (const ranking of channels) {
    ranking.ids.forEach((id, index) => {
      const current = fused.get(id) ?? { score: 0, channels: [] }
      current.score += ranking.weight / (k + index + 1)
      if (!current.channels.includes(ranking.channel)) current.channels.push(ranking.channel)
      fused.set(id, current)
    })
  }
  return fused
}

/** 精确命中无需模型；其余结果只有分差不明显时才值得支付重排序调用。 */
export function shouldConditionallyRerank(cards: KnowledgeCard[], marginThreshold: number): boolean {
  if (cards.length < 2 || cards[0]?.retrievalChannels?.includes('exact')) return false
  return (cards[0]?.relevance ?? 0) - (cards[1]?.relevance ?? 0) <= marginThreshold
}

/** 按模型给出的 ID 顺序重排，遗漏项保持原顺序追加，模型不能凭空加入候选。 */
export function applyRerank(cards: KnowledgeCard[], ranking: Array<{ id: string; score: number }>): KnowledgeCard[] {
  const byId = new Map(cards.map(card => [card.id, card]))
  const selected = ranking.flatMap(item => {
    const card = byId.get(item.id)
    if (card === undefined) return []
    byId.delete(item.id)
    return [{ ...card, relevance: item.score }]
  })
  return [...selected, ...cards.filter(card => byId.has(card.id))]
}
