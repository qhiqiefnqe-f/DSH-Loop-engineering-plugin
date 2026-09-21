import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { EngineeringTrace, KnowledgeCard } from './types.ts'
import {
  learningPrompt,
  parseLearningDecision,
  parseRetrievalDecision,
  parseRerankDecision,
  rerankPrompt,
  retrievalPrompt,
  type LearningDecision,
  type RetrievalDecision,
  type RerankDecision,
} from './decision-gate.ts'

/** 轻量判断模型的部署配置。 */
export interface FlashJudgeConfig {
  provider: string
  model: string
  maxTokens: number
  timeoutMs: number
  stateDir: string
}

/**
 * 通过 Harness 的 LLM 服务调用低成本模型，并把每次判断追加到本地审计日志。
 * 调用失败由上层回退到确定性策略，因此模型可提高精度，但不会成为知识链路的单点故障。
 */
export class FlashKnowledgeJudge {
  constructor(private readonly ctx: Context, private readonly config: FlashJudgeConfig) {}

  /** 判断任务开始时是否值得检索历史知识。 */
  async retrieval(query: string, sessionId: string): Promise<RetrievalDecision> {
    const raw = await this.complete(retrievalPrompt(query), sessionId)
    const decision = parseRetrievalDecision(raw)
    await this.audit('retrieval', sessionId, decision)
    return decision
  }

  /** 判断一条高证据轨迹是否具有跨任务复用价值。 */
  async learning(trace: EngineeringTrace): Promise<LearningDecision> {
    const raw = await this.complete(learningPrompt(trace), trace.sessionId)
    const decision = parseLearningDecision(raw)
    await this.audit('learning', trace.sessionId, { turn: trace.turn, ...decision })
    return decision
  }

  /** 在融合候选分差较小时，根据 L0 语义重新排序。 */
  async rerank(query: string, cards: KnowledgeCard[], sessionId: string): Promise<RerankDecision> {
    const raw = await this.complete(rerankPrompt(query, cards), sessionId)
    const decision = parseRerankDecision(raw, new Set(cards.map(card => card.id)))
    await this.audit('rerank', sessionId, decision)
    return decision
  }

  private async complete(prompt: string, sessionId: string): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of this.ctx.llm.stream({
        provider: this.config.provider,
        model: this.config.model,
        messages: [createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'plugin', plugin: 'loop-engineering' },
        })],
        temperature: 0,
        maxTokens: this.config.maxTokens,
        signal: controller.signal,
        sessionId: sessionId as never,
      })) assembler.push(chunk)
    } finally {
      clearTimeout(timeout)
    }
    if (assembler.finish.kind !== 'stop') throw new Error(`judge model finished with ${assembler.finish.kind}`)
    const text = assembler.blocks()
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim()
    if (text.length === 0) throw new Error('judge model returned no text')
    return text
  }

  private async audit(kind: 'retrieval' | 'learning' | 'rerank', sessionId: string, decision: object): Promise<void> {
    const directory = join(this.config.stateDir, 'decisions')
    await mkdir(directory, { recursive: true })
    await appendFile(join(directory, 'flash-judgements.jsonl'), `${JSON.stringify({
      kind,
      sessionId,
      provider: this.config.provider,
      model: this.config.model,
      createdAt: new Date().toISOString(),
      decision,
    })}\n`, 'utf8')
  }
}
