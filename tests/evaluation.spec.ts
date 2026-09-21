import { describe, expect, it } from 'vitest'
import { evaluateRetrieval, parseCombinedWiki, parseRetrievalEvaluation } from '../src/evaluation.ts'
import type { KnowledgeCard } from '../src/types.ts'

describe('retrieval evaluation data', () => {
  // 评测资料常从网页复制，解析器需要同时容忍 FILE 边界和 Markdown 代码围栏。
  it('parses merged FILE blocks and JSONL inside code fences', () => {
    const wiki = `=== FILE: wiki/problem-pattern/problem.example.md ===
---
id: problem.example
type: problem-pattern
---

## Problem

Example
=== END FILE ===`
    expect(parseCombinedWiki(wiki)).toMatchObject([{ id: 'problem.example', type: 'problem-pattern' }])
    const cases = parseRetrievalEvaluation('```jsonl\n{"case_id":"ret-1","query":"example error","relevant":{"problem.example":3},"no_answer":false}\n```')
    expect(cases[0]?.relevant.get('problem.example')).toBe(3)
  })

  // 有答案样本衡量召回，无答案样本衡量误召回；分开计算避免宏平均掩盖拒答缺陷。
  it('computes macro Recall@5 and no-answer false positives separately', async () => {
    const card = (id: string): KnowledgeCard => ({
      id, title: id, type: 'problem-pattern', summary: id,
      scope: { repos: [], domains: [], modules: [] }, lifecycle: 'reviewed', confidence: 0.8,
      relevance: 1, version: 'v1',
    })
    const provider = { search: async (query: string) => query === 'none' ? [card('wrong')] : [card('a')] }
    const cases = parseRetrievalEvaluation([
      { case_id: 'one', query: 'answer', relevant: { a: 3, b: 1 }, no_answer: false },
      { case_id: 'two', query: 'none', relevant: {}, no_answer: true },
    ].map(value => JSON.stringify(value)).join('\n'))
    const result = await evaluateRetrieval(provider, cases, 5)
    expect(result.recallAtK).toBe(0.5)
    expect(result.hitRateAtK).toBe(1)
    expect(result.noAnswerFalsePositiveRate).toBe(1)
  })
})
