import { describe, expect, it } from 'vitest'
import type { KnowledgeCard } from '../src/types.ts'
import { applyRerank, bm25fScores, reciprocalRankFusion, routeKnowledgeTypes, shouldConditionallyRerank } from '../src/retrieval.ts'

/** 构造最小 L0 卡片，测试只改变与当前排序规则有关的 id、相关度和召回通道。 */
const card = (id: string, relevance: number, retrievalChannels: KnowledgeCard['retrievalChannels'] = ['bm25']): KnowledgeCard => ({
  id, title: id, type: 'problem-pattern', summary: id,
  scope: { repos: [], domains: [], modules: [] }, lifecycle: 'verified', confidence: 0.9,
  relevance, version: 'v1', retrievalChannels,
})

describe('multi-route retrieval', () => {
  // 同一个 token 放在不同字段中，标题权重必须压过普通正文，证明不是简单全文词频。
  it('BM25F gives a title match more weight than the same term in generic body text', () => {
    const field = (text: string, weight: number) => {
      const tokens = text.split(' ')
      return { tokens, termCounts: new Map(tokens.map(token => [token, 1])), weight, b: 0.75 }
    }
    const scores = bm25fScores([
      { id: 'title-hit', fields: { title: field('hydration race', 3), body: field('startup', 0.75) } },
      { id: 'body-hit', fields: { title: field('startup issue', 3), body: field('hydration race', 0.75) } },
    ], ['hydration'])
    expect(scores.get('title-hit')!).toBeGreaterThan(scores.get('body-hit')!)
  })

  // 软路由只提升意图类型；其他类型保持 1，避免分类器猜错造成无法召回。
  it('soft-routes failure, policy, and design queries without filtering other types', () => {
    expect(routeKnowledgeTypes('browser refresh loses login')['problem-pattern']).toBe(1.18)
    expect(routeKnowledgeTypes('requests must share one refresh')['business-rule']).toBe(1.18)
    expect(routeKnowledgeTypes('architecture trade-off for adapter boundary')['architecture-decision']).toBe(1.18)
    expect(routeKnowledgeTypes('architecture trade-off for adapter boundary')['problem-pattern']).toBe(1)
  })

  // 三个通道的分数量纲不同，RRF 只融合名次；同时验证命中通道会被保留用于解释。
  it('uses RRF ranks instead of adding incompatible raw scores', () => {
    const fused = reciprocalRankFusion([
      { channel: 'exact', weight: 2, ids: ['a'] },
      { channel: 'bm25', weight: 1, ids: ['b', 'a'] },
      { channel: 'metadata', weight: 0.8, ids: ['b', 'a'] },
    ], 60)
    expect(fused.get('a')?.channels).toEqual(['exact', 'bm25', 'metadata'])
    expect(fused.get('a')!.score).toBeGreaterThan(fused.get('b')!.score)
  })

  // 头部差距小时才值得调用模型；精确命中必须绕过重排以降低延迟并防止漂移。
  it('reranks close non-exact results but skips an exact first result', () => {
    expect(shouldConditionallyRerank([card('a', 1), card('b', 0.92)], 0.12)).toBe(true)
    expect(shouldConditionallyRerank([card('a', 1, ['exact']), card('b', 0.99)], 0.12)).toBe(false)
  })

  // 模型只能重排输入候选，不能凭空构造知识 ID；未返回项保持原相对顺序。
  it('applies only known rerank ids and preserves omitted candidates', () => {
    expect(applyRerank([card('a', 1), card('b', 0.95), card('c', 0.9)], [{ id: 'b', score: 0.98 }]).map(item => item.id))
      .toEqual(['b', 'a', 'c'])
  })
})
