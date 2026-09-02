# Agent Debug Plan

## Goal
Restore and verify ChatGPT Web routed Codex subagents.

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
