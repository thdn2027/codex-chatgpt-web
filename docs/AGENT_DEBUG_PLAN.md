# Agent Debug Plan

## Goal
Restore and verify ChatGPT Web routed Codex subagents.

## Scope boundary

This document tracks **multi-agent capability and lifecycle debugging only**.

Browser mutation/finality, retry safety, browser-worker decomposition, pacing/cooldown, and unified health are tracked separately in:

- [`CHATGPT_WEB_BRIDGE_AUDIT_2026-09-02.md`](./CHATGPT_WEB_BRIDGE_AUDIT_2026-09-02.md)

Do not mix these two workstreams. Agent capability failures should be localized before changing browser execution behavior.

## Current evidence
- Codex config has compatibility-v1 multi agent enabled.
- Sessions do not show spawn_agent events.
- Therefore debug order is before runtime lifecycle.

## Debug order
1. Config
2. Integration journal
3. Model catalog
4. Runtime registry
5. Tool exposure
6. spawn_agent
7. wait_agent lifecycle

## Phase checklist
- [ ] Add agent diagnostics command
- [ ] Inspect model cache/catalog
- [ ] Verify multi_agent_version
- [ ] Add pre-lifecycle smoke test
- [ ] Test spawn_agent
- [ ] Investigate upstream lifecycle only if spawn_agent executes

## Cross-workstream invariant

If a routed agent turn reaches ChatGPT Web, bridge execution must still obey the hardening rules in the bridge audit, especially:

- no automatic browser write retry after Send activation without proof that no submission occurred;
- no prompt replay after accepted-turn structured 429/5xx failures;
- no implicit replay of tool side effects;
- retry/finality fixes must not be used to mask a model-catalog or tool-exposure failure.
