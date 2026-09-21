import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { EngineeringTrace } from '../src/types.ts'
import { WikiStore } from '../src/wiki-store.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function store(): Promise<WikiStore> {
  const root = await mkdtemp(join(tmpdir(), 'loop-engineering-'))
  roots.push(root)
  const value = new WikiStore({
    wikiDir: join(root, 'wiki'), stateDir: join(root, 'state'), duplicateThreshold: 0.5,
    rrfK: 60, exactRrfWeight: 2, bm25RrfWeight: 1, metadataRrfWeight: 0.8,
  })
  await value.initialize()
  return value
}

function trace(sessionId: string, turn: number, task = 'Cold reload loses persisted authentication state'): EngineeringTrace {
  return {
    sessionId,
    turn,
    task,
    errors: ['Cannot read properties of undefined in AuthProvider.tsx:73'],
    filesRead: ['src/auth/AuthProvider.tsx', 'src/store/userStore.ts'],
    filesChanged: ['src/auth/AuthProvider.tsx'],
    commands: [{ command: 'pnpm test login.spec.ts', outcome: 'passed' }],
    tests: [{ name: 'login.spec.ts', outcome: 'pass' }],
    userConfirmations: [],
    finalOutcome: 'Fixed the hydration race by waiting for persisted store readiness.',
    resolutionConfidence: 0.9,
    resolved: true,
  }
}

describe('WikiStore MVP loop', () => {
  it('publishes a verified problem pattern and returns L0 before section-level L1/L2', async () => {
    const wiki = await store()
    const first = await wiki.propose(trace('bug-a', 1), 'problem-pattern | Persisted State Hydration Race | Cold reload can read state before hydration completes. | hydration race | cold reload,state missing')
    expect(first.patch.operation).toBe('create')
    expect(first.patch.verification).toBe('SUPPORTED')
    const published = await wiki.publish(first.candidate.candidateId)
    expect(published.metadata.lifecycle).toBe('verified')

    const cards = await wiki.search('user status disappears after cold reload')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ id: published.metadata.id, title: 'Persisted State Hydration Race' })
    expect(cards[0]).not.toHaveProperty('body')

    expect(await wiki.read(published.metadata.id, 'Diagnosis')).toContain('pnpm test')
    expect(await wiki.read(published.metadata.id, undefined, 'evidence')).toContain('session:bug-a')
  })

  it('search-before-create updates one page with a second occurrence instead of duplicating it', async () => {
    const wiki = await store()
    const first = await wiki.propose(trace('bug-a', 1), 'problem-pattern | Persisted State Hydration Race | Cold reload can read state before hydration completes. | hydration race | cold reload,state missing')
    const unit = await wiki.publish(first.candidate.candidateId)

    const second = await wiki.propose(trace('bug-b', 2, 'Pinia state becomes undefined after browser refresh'), 'problem-pattern | Persisted State Hydration Race | Refresh can consume persisted state before hydration. | persisted state race | browser refresh,undefined state')
    expect(second.patch.operation).toBe('update')
    expect(second.patch.targets).toEqual([unit.metadata.id])
    await wiki.publish(second.candidate.candidateId)

    const units = await wiki.list()
    expect(units).toHaveLength(1)
    expect(units[0]?.body).toContain('session:bug-a')
    expect(units[0]?.body).toContain('session:bug-b')
    expect(units[0]?.metadata.sources).toEqual(expect.arrayContaining(['session:bug-a', 'session:bug-b']))
  })

  it('does not treat a weak lexical overlap as the same knowledge after score normalization', async () => {
    const wiki = await store()
    const first = await wiki.propose(trace('bug-a', 1), 'problem-pattern | Persisted State Hydration Race | Cold reload can read state before hydration completes. | hydration race | cold reload,state missing')
    await wiki.publish(first.candidate.candidateId)

    const different = await wiki.propose(
      trace('bug-c', 3, 'Refresh token rotation fails when concurrent requests renew authentication'),
      'problem-pattern | Concurrent Refresh Token Rotation Failure | Parallel authentication requests can rotate the same refresh token twice. | token rotation | concurrent refresh,authentication',
    )

    expect(different.patch.operation).toBe('create')
    expect(different.patch.targets).not.toEqual([first.patch.targets[0]])
  })

  it('keeps business rules reviewed and rejects unsupported publication', async () => {
    const wiki = await store()
    const ruleTrace = { ...trace('rule-a', 1, 'Cancellation must preserve current-period entitlement'), tests: [], resolutionConfidence: 0.72 }
    const proposal = await wiki.propose(ruleTrace, 'business-rule | Subscription Cancellation Entitlement | Cancellation affects renewal only; the paid period remains active.')
    const unit = await wiki.publish(proposal.candidate.candidateId)
    expect(unit.metadata.lifecycle).toBe('reviewed')

    const candidateSource = await readFile(join(wiki.stateDir, 'candidates', `${proposal.candidate.candidateId}.json`), 'utf8')
    expect(candidateSource).toContain('"status": "published"')
  })

  it('dismisses a candidate without changing the canonical wiki', async () => {
    const wiki = await store()
    const proposal = await wiki.propose(trace('dismiss-a', 1), 'problem-pattern | Rejected Example Pattern | This candidate must remain outside the canonical wiki.')

    await wiki.dismiss(proposal.candidate.candidateId)

    expect(await wiki.list()).toHaveLength(0)
    const candidateSource = await readFile(join(wiki.stateDir, 'candidates', `${proposal.candidate.candidateId}.json`), 'utf8')
    expect(candidateSource).toContain('"status": "dismissed"')
    await expect(wiki.publish(proposal.candidate.candidateId)).rejects.toThrow(/dismissed/)
  })
})
