# ChatGPT Web Bridge Source Audit & Hardening Roadmap — 2026-09-02

## Decision

Keep `thdn2027/codex-chatgpt-web` as the primary local gateway. Do **not** add another proxy/gateway in front of it.

The current fork already owns the important contract:

```text
Codex / CLI
    |
    | Responses API
    v
codex-chatgpt-web daemon
    |-- native OpenAI passthrough
    |-- ChatGPT Web ProviderAdapter
    |-- Responses/SSE bridge
    |-- browser worker / Electron host
    |-- turn broker / MCP
    `-- lifecycle / drain / health
```

The optimization target is now **correctness, maintainability, and account-safe traffic shaping**, not replacement.

## Confirmed strengths in the current fork

- Responses API is already the primary local contract.
- Native OpenAI passthrough and routed ChatGPT Web models remain separate.
- `previous_response_id` continuation state is bounded by TTL, count, memory, and disk snapshot caps.
- Browser turns are task-bound and capped at five simultaneous tabs.
- Client disconnect can preserve the exact browser execution for reconnect instead of blindly resending.
- Drain/shutdown is explicit and fail-closed.
- Multi-agent compatibility is explicitly managed rather than inferred from model metadata alone.
- Prompt attachment, send activation, submission acceptance, completion tracking, compaction, tool rounds, rate-limit/session errors, and browser cleanup all have dedicated tests.

## P0 finding: mutation finality must outrank retryability

The browser path already models a useful lifecycle:

```text
prepared
  |
  v
send_activated
  |
  v
accepted
  |
  v
generating / tools
  |
  v
final
```

Generic errors after `send_activated` are converted into an ambiguous non-retryable failure. Generic errors after `accepted` are converted into submitted-turn failures that must not resend the prompt.

However, `submittedTurnFailure()` currently returns an existing `ChatGptWebAdapterError` before applying submission-phase normalization. A structured error that is still marked `retryable=true` can therefore bypass the mutation-phase guard.

Concrete paths to harden and test:

- a rate-limit dialog appears after Send activation but before acceptance proof;
- `Something went wrong` appears after ChatGPT has already accepted the prompt;
- any future structured 429/5xx browser error is raised after the mutation boundary has been crossed.

### Required invariant

```text
mutation phase decides whether a write retry is legal
BEFORE
error.retryable decides whether a preflight/observation retry is legal
```

Recommended semantics:

| Phase | Automatic write retry | Required behavior |
| --- | --- | --- |
| `prepared` | Allowed when the failure is truly retryable | Retry pre-submit work only |
| `send_activated` | Forbidden unless there is positive proof no submission occurred | Return uncertain/ambiguous and reconcile |
| `accepted` | Forbidden | Retry observation/reconciliation only |
| `generating/tools` | Forbidden | Preserve exact turn authority; never replay side effects |
| `final` | N/A | Return canonical result |

## Recommended P0 implementation

Extract a small `SubmissionTransaction` / mutation-authority component that owns:

- `prepared -> send_activated -> accepted -> final` transitions;
- write-retry legality;
- ambiguous/uncertain classification;
- canonical reconciliation hooks;
- side-effect boundary for tool-bearing turns.

Keep `ChatGptWebTurnRetryPolicy`, but constrain it to safe pre-write or observation-level retries. Submission state must have higher authority than retry budget.

## Required fault-injection tests

- [ ] Failure before Send -> retryable when policy allows.
- [ ] Generic failure after `send_activated` -> non-retryable ambiguous.
- [ ] Structured `ChatGptWebAdapterError(retryable=true)` after `send_activated` -> non-retryable ambiguous.
- [ ] Generic failure after `accepted` -> submitted-turn failure, no resend.
- [ ] Structured retryable error after `accepted` -> no write retry.
- [ ] 429 dialog after Send activation -> no automatic resend.
- [ ] `Something went wrong` after acceptance -> no automatic resend.
- [ ] Browser disconnect after acceptance -> reconcile or fail closed.
- [ ] Tool side effect completed before browser failure -> outer turn must never implicitly replay the tool.

## Maintainability finding: `browser-worker.ts` is over-coupled

`src/adapters/chatgpt-web/browser-worker.ts` currently owns too many stateful concerns: page lifecycle, model/effort selection, personalization, connector UI, prompt attachment, send, submission proof, completion detection, DOM health, rate limits, session errors, tool confirmation, multipart flow, diagnostics, and cancellation.

Refactor by **state ownership**, not arbitrary file size:

```text
chatgpt-web/
|-- browser-worker.ts            # orchestration facade
|-- browser/
|   |-- page-lease.ts
|   |-- session-health.ts
|   `-- diagnostics.ts
|-- submission/
|   |-- transaction.ts
|   |-- prompt-attachment.ts
|   |-- send.ts
|   `-- evidence.ts
|-- completion/
|   |-- tracker.ts
|   |-- dom-observer.ts
|   `-- finality.ts
|-- ui/
|   |-- model-effort.ts
|   |-- personalization.ts
|   `-- connector.ts
`-- traffic/
    |-- retry-policy.ts
    |-- pacing.ts
    `-- cooldown.ts
```

Keep `ChatGptBrowserWorker` as the public facade so the adapter contract does not change during extraction.

## Account-safe traffic policy

Concurrency cap is not pacing. Keep the existing maximum-tab limit, but add a separate account-level traffic policy:

```text
AccountTrafficPolicy
|-- max_inflight
|-- min_submission_gap
|-- cooldown_until
|-- last_submission_at
|-- recent_429_count
`-- throttled_ms
```

Start with configurable pacing and telemetry rather than copying a fixed global delay from another project. A 429 or temporary-limit event should set account cooldown; cooldown must never become permission to replay an uncertain write.

## Unified health target

Expose one runtime truth instead of independent health interpretations across server, browser and MCP layers:

```text
runtime
|-- daemon: ready
|-- browser_host: ready
|-- chatgpt_session: authenticated
|-- composer: ready
|-- connector: ready
|-- account
|   |-- rate_limited
|   `-- cooldown_until
|-- turns
|   |-- active
|   `-- capacity
`-- drain
```

## External repository pattern map

| Repository / pattern | Reuse | Do not copy blindly |
| --- | --- | --- |
| `kymuco/chatgpt-web-adapter` | authority/finality boundaries, browser-owned writes, canonical readback | do not introduce a second independent runtime beside the current gateway |
| DrA1ex-style browser effect ledger | `uncertain` write state, reconcile-before-retry, exact ACK/outbox ideas | do not import full ledger complexity if a small transaction state machine is enough |
| `Octo-Lex/ChatGPT-Web2API` | real incremental DOM streaming, completion reconciliation, detector/transport split | do not replace the Responses contract with a parallel API architecture |
| `stufently/gpt-web-gateway` | pacing, cooldown, watchdog, operational metrics | do not copy fixed delay values without account telemetry |
| CatGPT | session/tab routing and durable conversation mapping ideas | its reviewed SSE path chunks completed text; transport streaming is not generation streaming |

## What not to change

- Keep Responses API as the primary local contract.
- Keep the existing `ProviderAdapter` boundary; do not prematurely build a provider plugin framework.
- Keep native OpenAI passthrough separate from routed ChatGPT Web models.
- Keep the bounded `previous_response_id` continuation state unless field evidence proves it insufficient.
- Do not add another gateway in front of this repository.
- Do not use undocumented direct ChatGPT backend writes as the primary mutation path.

## Recommended PR sequence

### PR1 — Submission finality hardening

- normalize structured retryable errors by mutation phase;
- add explicit uncertain/accepted invariants;
- add targeted fault-injection tests.

### PR2 — Fault-injection and reconciliation suite

- browser disconnect;
- 429 after Send activation;
- terminal 5xx after acceptance;
- accepted-but-observation-failed;
- tool side-effect cases.

### PR3 — Browser worker extraction

Extract submission, completion and UI ownership without behavior changes.

### PR4 — Account traffic pacing/cooldown

Add configurable minimum gap, 429 cooldown and telemetry.

### PR5 — Unified health/doctor surface

Report browser/session/connector/capacity/cooldown/drain state in one place.

## Relationship to the multi-agent investigation

Bridge hardening and routed Codex multi-agent debugging are related but distinct workstreams.

Multi-agent debugging should remain:

```text
config
  -> integration journal
  -> model catalog
  -> runtime registry
  -> tool exposure
  -> spawn_agent
  -> wait_agent
```

The hardening work in this document protects browser mutation/finality **after** a routed turn reaches ChatGPT Web. Keeping the tracks separate makes failures easier to localize.

## Definition of Done

- [ ] No automatic browser write is retried after Send activation without positive proof that no submission occurred.
- [ ] Accepted turns never resend the user prompt on structured 429/5xx errors.
- [ ] Tool-bearing turns cannot duplicate local side effects because of browser/UI failures.
- [ ] Browser worker responsibilities are split by ownership without changing the public adapter contract.
- [ ] Account pacing/cooldown is measurable and configurable.
- [ ] Unified health clearly identifies daemon/browser/session/connector/account/turn state.
- [ ] Existing Responses, native passthrough, compaction and multi-agent smoke tests remain green.

## Final recommendation

Keep the current fork as the core product. Harden mutation finality first, then reduce browser-worker coupling, then add account-level traffic policy and unified health. Treat external repositories as architecture donors, not replacement dependencies.
