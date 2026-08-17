---
id: rule.session-refresh-single-flight
type: business-rule
title: Session Refresh Uses Single Flight
summary: Concurrent requests for one session must share a single refresh operation and must not rotate credentials independently.
aliases:
  - refresh token single flight
  - concurrent session refresh
  - 会话刷新合并
triggers:
  - multiple 401 responses
  - refresh token rotation
  - concurrent authenticated requests
  - 多个请求同时刷新令牌
scope:
  repos:
    - deepseek-harness
  domains:
    - authentication
    - session-management
  modules:
    - src/auth
confidence: 0.88
lifecycle: reviewed
sources:
  - manual-policy:loop-engineering-webui-test
  - review:authentication-owner
related:
  - problem.persisted-state-hydration-race
created_at: '2026-08-16'
updated_at: '2026-08-16'
---

## Rule

For a given user session, all concurrent callers must await one in-flight refresh operation. A second refresh must not start until the first operation succeeds or fails.

## Exceptions

- A refresh for a different session or tenant may proceed independently.
- An operator-authorized credential reset is not part of the normal refresh path.

## Reason

Independent refresh attempts can rotate the same credential more than once, invalidate the winner, and create nondeterministic logout behavior across concurrent requests.

## Evidence

- manual-policy:loop-engineering-webui-test
- review:authentication-owner

