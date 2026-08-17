---
id: decision.client-state-readiness-boundary
type: architecture-decision
title: Client State Exposes an Explicit Readiness Boundary
summary: Consumers wait on a readiness boundary instead of inferring initialization from nullable domain values.
aliases:
  - explicit hydration readiness
  - client initialization barrier
  - 客户端状态就绪边界
triggers:
  - async state initialization
  - hydration ordering
  - nullable state ambiguity
  - 异步状态初始化顺序
scope:
  repos:
    - deepseek-harness
  domains:
    - client-state
    - architecture
  modules:
    - src/store
    - src/auth
confidence: 0.9
lifecycle: reviewed
sources:
  - manual-decision:loop-engineering-webui-test
  - review:client-platform-owner
related:
  - problem.persisted-state-hydration-race
  - problem.hmr-stale-plugin-config
created_at: '2026-08-16'
updated_at: '2026-08-16'
---

## Decision

Asynchronously initialized client-state services expose an explicit readiness promise or state. Consumers must wait for readiness before interpreting domain values.

## Context

Nullable user and configuration values cannot distinguish “initialization has not completed” from “initialization completed with no value”. That ambiguity creates timing-dependent behavior during cold startup and reload.

## Rejected Alternatives

- Add fixed startup delays before reading state.
- Retry every consumer independently when it sees an undefined value.
- Treat the first undefined value as authoritative and repair state later.

## Trade-offs

The readiness boundary adds one lifecycle state and requires consumers to handle loading explicitly. In return, initialization ordering becomes observable, testable, and consistent across consumers.

## Evidence

- manual-decision:loop-engineering-webui-test
- review:client-platform-owner
