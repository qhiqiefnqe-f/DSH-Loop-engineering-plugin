import { describe, expect, it } from 'vitest'
import {
  learningProposal,
  parseLearningDecision,
  parseRetrievalDecision,
  parseRerankDecision,
  retrievalPrefilter,
} from '../src/decision-gate.ts'

describe('lightweight knowledge decision gate', () => {
  it('skips cheap non-engineering requests before calling the model', () => {
    expect(retrievalPrefilter('翻译这句话')).toBe(false)
    expect(retrievalPrefilter('请修改认证模块刷新后状态丢失的问题')).toBe(true)
  })

  it('accepts a fenced retrieval decision and requires a useful query', () => {
    expect(parseRetrievalDecision('```json\n{"action":"retrieve","query":"认证状态 刷新 丢失","reason":"可能命中历史故障"}\n```'))
      .toEqual({ action: 'retrieve', query: '认证状态 刷新 丢失', reason: '可能命中历史故障' })
    expect(() => parseRetrievalDecision('{"action":"retrieve","query":"","reason":"x"}')).toThrow(/query/)
  })

  it('turns a validated learning decision into the deterministic proposal format', () => {
    const decision = parseLearningDecision(JSON.stringify({
      action: 'learn',
      type: 'problem-pattern',
      title: 'Persisted State Hydration Race',
      summary: 'Cold reload can read state before hydration completes.',
      aliases: ['hydration race'],
      triggers: ['cold reload', 'state missing'],
      reason: 'Root cause and regression test are reusable.',
    }))
    expect(learningProposal(decision)).toBe(
      'problem-pattern | Persisted State Hydration Race | Cold reload can read state before hydration completes. | hydration race | cold reload,state missing',
    )
  })

  it('keeps a skip decision free of candidate fields', () => {
    expect(parseLearningDecision('{"action":"skip","reason":"One-off formatting change"}'))
      .toEqual({ action: 'skip', reason: 'One-off formatting change' })
  })

  it('accepts only known unique ids from the reranker', () => {
    const source = '{"ranking":[{"id":"a","score":0.9,"reason":"symptom match"}]}'
    expect(parseRerankDecision(source, new Set(['a', 'b'])).ranking[0]?.id).toBe('a')
    expect(() => parseRerankDecision(source, new Set(['b']))).toThrow(/unknown/)
  })
})
