---
id: problem.hmr-stale-plugin-config
type: problem-pattern
title: HMR Retains Stale Plugin Configuration
summary: A plugin can keep an old resolved configuration when an HMR reload replaces config without rebuilding derived state.
aliases:
  - stale config after reload
  - HMR config cache
  - 热更新配置未生效
triggers:
  - config change requires restart
  - HMR still uses old value
  - plugin reload stale state
  - 修改配置后仍使用旧值
scope:
  repos:
    - deepseek-harness
  domains:
    - plugin-runtime
  modules:
    - cordis
    - hmr
confidence: 0.86
lifecycle: verified
sources:
  - manual-fixture:loop-engineering-webui-test
  - test:plugin-config-reload:pass
related:
  - decision.client-state-readiness-boundary
created_at: '2026-08-16'
updated_at: '2026-08-16'
last_verified_at: '2026-08-16'
---

## Problem

An HMR reload applies a new Cordis plugin config, but request handling continues to use state derived from the previous config.

## Symptoms

- A config file change is detected but behavior changes only after a full process restart.
- Logs print the new config while a cache or closure still uses the old value.
- Repeated reloads can create multiple timers or listeners with different settings.

## Trigger Conditions

- Plugin startup derives state from config and captures it in long-lived callbacks.
- The reload path updates the config object but does not dispose and rebuild derived resources.
- Timers, listeners, or caches outlive the plugin instance that created them.

## Root Cause

Configuration and the resources derived from it have different lifecycles. Reload replaces one without disposing and recreating the other.

## Diagnosis

Log plugin instance identity, resolved config version, resource creation, and dispose events. Check that every old resource is disposed before callbacks from the new instance begin serving work.

## Solution Pattern

Treat resolved configuration as immutable per plugin instance. Register derived resources with the Cordis lifecycle so reload disposes the old instance before applying the replacement.

## Verification

- Change a watched config value and observe behavior without restarting the process.
- Confirm one dispose and one replacement resource creation.
- Confirm only one timer or listener remains active after repeated reloads.

## Known Occurrences

- Manual Web UI fixture for Loop Engineering MVP acceptance.

## Evidence

- manual-fixture:loop-engineering-webui-test
- test:plugin-config-reload:pass

