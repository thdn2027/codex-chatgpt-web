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
- [x] Add agent diagnostics command — `codex-chatgpt-web agent inspect`
- [x] Inspect model cache/catalog — reported under `catalog.webModels`
- [x] Verify multi_agent_version — warns per routed model when it is not `v1` under Compatibility V1
- [ ] Add pre-lifecycle smoke test
- [ ] Test spawn_agent
- [ ] Investigate upstream lifecycle only if spawn_agent executes

Steps 1-3 of the debug order are now one command. It reads Codex's real
`[features]`/`[agents]` state through the same TOML helpers setup writes with, so a
drifted config cannot read back as healthy. Note the thread-pinning next step it
emits: affected Codex versions pin the multi-agent protocol at thread creation, so a
correct config still requires a fresh task before spawn_agent can appear.

## Cross-workstream invariant

If a routed agent turn reaches ChatGPT Web, bridge execution must still obey the hardening rules in the bridge audit, especially:

- no automatic browser write retry after Send activation without proof that no submission occurred;
- no prompt replay after accepted-turn structured 429/5xx failures;
- no implicit replay of tool side effects;
- retry/finality fixes must not be used to mask a model-catalog or tool-exposure failure.
