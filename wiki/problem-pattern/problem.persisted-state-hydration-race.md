---
id: problem.persisted-state-hydration-race
type: problem-pattern
title: Persisted State Hydration Race
summary: Cold reload can read authentication state before persisted client state has finished hydrating.
aliases:
  - hydration race
  - refresh state loss
  - 冷启动状态丢失
triggers:
  - cold reload user state undefined
  - browser refresh loses login
  - persisted store not ready
  - 刷新后用户状态为空
scope:
  repos:
    - deepseek-harness
  domains:
    - authentication
    - client-state
  modules:
    - src/auth
    - src/store
confidence: 0.92
lifecycle: verified
sources:
  - manual-fixture:loop-engineering-webui-test
  - test:login-hydration-regression:pass
related:
  - decision.client-state-readiness-boundary
  - rule.session-refresh-single-flight
created_at: '2026-08-16'
updated_at: '2026-08-16'
last_verified_at: '2026-08-16'
---

## Problem

Authentication consumers can run during a cold reload before the persisted client store reports that hydration is complete.

## Symptoms

- The first render sees an undefined user even though a valid session exists.
- A browser refresh appears to log the user out, while client-side navigation works.
- The failure is timing-sensitive and may disappear when debugging slows startup.

## Trigger Conditions

- A persisted store restores state asynchronously.
- A route guard or authentication provider reads the store during initial render.
- The application treats an unhydrated state as an unauthenticated state.

## Root Cause

The application conflates “not hydrated yet” with “hydrated and no session”. Consumers therefore make a final authentication decision from an intermediate state.

## Diagnosis

Inspect the startup ordering and record separate timestamps for store creation, hydration completion, route-guard evaluation, and the first authenticated request. Confirm that the failing read precedes the hydration-ready signal.

## Solution Pattern

Expose an explicit readiness signal and defer authentication-dependent reads until it resolves. Keep loading, unauthenticated, and authenticated states distinct rather than encoding all three as a nullable user value.

## Verification

- Run a cold-reload regression test with persisted authenticated state.
- Verify direct navigation to a protected route.
- Verify an actually expired session still becomes unauthenticated after hydration.

## Known Occurrences

- Manual Web UI fixture for Loop Engineering MVP acceptance.

## Evidence

- manual-fixture:loop-engineering-webui-test
- test:login-hydration-regression:pass

