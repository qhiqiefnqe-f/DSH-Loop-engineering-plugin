import { describe, expect, it } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TraceBuilder, worthDistilling } from '../src/trace-builder.ts'

describe('EngineeringTrace', () => {
  it('projects a solved bug from structured events without copying the full session', () => {
    const session = Session.create(SessionId('trace-session'))
    const builder = new TraceBuilder()
    const observe = () => builder.observe(session, session.events.at(-1)!)

    session.append('turn/start', { turn: 1 }); observe()
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Cold reload crashes AuthProvider; please debug the undefined state.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }); observe()
    session.append('step/start', { turn: 1, step: 1 }); observe()
    session.append('tool/call', { turn: 1, step: 1, callId: 'call-1' as never, name: 'apply_patch', arguments: '{"file":"src/AuthProvider.tsx"}' }); observe()
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: 'call-1' as never,
        content: [{ type: 'text', text: 'login.spec.ts passed ✓' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' }); observe()
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'Fixed the hydration race and verified the regression test.' }], source: { kind: 'model', provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' }); observe()
    session.append('step/end', { turn: 1, step: 1 }); observe()
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const result = observe()

    expect(result).toMatchObject({ sessionId: 'trace-session', turn: 1, resolved: true })
    expect(result?.filesChanged).toContain('src/AuthProvider.tsx')
    expect(result?.tests).toContainEqual({ name: 'login.spec.ts', outcome: 'pass' })
    expect(worthDistilling(result!, 0.65)).toBe(true)
    expect(JSON.stringify(result).length).toBeLessThan(5000)
  })

  it('does not distill an unresolved or ordinary low-value turn', () => {
    const unresolved = {
      sessionId: 'x', turn: 1, task: 'Change button color', errors: [], filesRead: [], filesChanged: [],
      commands: [], tests: [], userConfirmations: [], resolutionConfidence: 0.2, resolved: false,
    }
    expect(worthDistilling(unresolved, 0.65)).toBe(false)
  })
})
