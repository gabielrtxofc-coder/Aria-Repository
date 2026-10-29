---
description: "The model-route fallback executor for compositions that must keep an open agent step alive when the selected route cannot serve it."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-model-fallback

English | [中文](README.zh.md)

## Summary

Mount `@deepseek-ai/dsh-llm-model-fallback` to continue an open agent step on another configured model when the current route cannot serve it. Quota, billing, exhausted-retry, and explicitly opted-in authentication failures switch to the next registered, capable, not-yet-tried candidate in chain order; transient limits reach the retry policy first. Every switch is one durable `llm/model-switched` record, the recovered route survives later turns and restarts, and an unusable chain leaves the task paused on its durable history instead of losing completed work. Eligibility covers what the retained conversation actually needs — input modalities, mid-conversation system prompts and tool declarations, remaining context capacity, and the requested reasoning effort — the switch record is confirmed on storage before the retried request leaves, and a deployment can opt in to continuing an interrupted or paused task on resume without a new user message.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when a long task must outlive one model route. A task belongs to the harness, not to a model: the conversation, tool results, and open step stay in the Session log, and this plugin decides which route continues them.

### When to choose it

Choose it when a composition already mounts the agent loop and the deployment can offer at least one alternative route — a second provider, a second credential, or a cheaper model for the same provider. Skip it when only one route exists: an empty `chain` makes every failure terminal without adding listeners that can change behavior.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-llm-model-fallback'
  config:
    chain:
      - provider: deepseek
        model: deepseek-chat
      - provider: openrouter
        model: deepseek/deepseek-chat
        reasoningEffort: low
    switchOn: [quota, billing, unavailable, transient]
    maxSwitchesPerTurn: 2
    # Opt-in autonomous continuation on resume.
    resumeInterruptedTurns: false
    maxRecoveryAttempts: 1
```

`chain` is the preference order and is required; an entry names a `provider`, its `model`, and optionally an adapter-owned `reasoningEffort` that replaces the failed request's effort. `switchOn` defaults to `transient`, `unavailable`, `quota`, and `billing`; `auth` is opt-in because a malformed credential is a configuration defect rather than a route outage. `maxSwitchesPerTurn` defaults to the chain length, so a turn never tries more alternatives than it configures.

A load-time rejection is deliberate: an unknown key, an empty provider or model, a repeated route, an empty or unknown `switchOn` category, or a negative switch allowance fails plugin load instead of silently disabling recovery for a deployment that expected it.

`resumeInterruptedTurns` (default `false`) lets a resumed Session continue a task whose turn was interrupted or left paused by an exhausted chain, without waiting for a new user message; `maxRecoveryAttempts` (default `1`) bounds how many automatic continuations may follow the last human message. Both stay off in shipped products: a resumed Session is normally the user's turn to speak, and a Web or SDK surface must not spend tokens unasked.

### What you can observe

Each switch appends one non-surface `llm/model-switched` event carrying the switch identity, the turn and step, the failure category and its serialized provider failure, the failed route, the selected route, and every configured candidate rejected before it. The next request header names the selected route, so the transcript stays reconstructable from the log alone. When nothing eligible remains, the plugin appends one `llm/model-fallback-exhausted` event per failed step and leaves the failure terminal: the turn closes with its original provider error, and the Session keeps the completed steps for a later resume.

A switch also records a recovery route for that Agent: prompt assembly, request routing, and the request header all describe the route actually used, so a model-switch notice never announces a model the harness is not calling. The recovery route yields as soon as the entry point selects another route — a user's later choice is never silently rewritten.

### Failures and recovery

Classification prefers provider-normalized facts over wording, in that order: an explicit code (`AUTH`, `INVALID_CREDENTIAL`, `BILLING`, `QUOTA`, `RATE_LIMIT`, `CONTEXT_WINDOW_EXCEEDED`, …), then the HTTP status, and only then provider quota phrasing that arrives with no distinct code. A rejected credential therefore never becomes a quota switch merely because its message says "quota". Transient codes and statuses (`RATE_LIMIT`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`, 408, 429, 5xx) delegate downstream first: the retry policy owns same-route retries, and this plugin acts only after that policy declines the failure. Quota and billing states, `AUTH` when configured, and unknown codes that a deployment maps to a switchable category move to the next candidate.

A candidate is eligible only when its provider is registered in this process, its exact model resolves through the owning adapter, it did not already fail during this turn, and it can reproduce what the retained conversation needs: the declared input modalities (an image-bearing task never lands on a text-only route), mid-conversation system prompts and tool declarations the history already carries, enough context capacity for the measured input plus the request's output cap, and the reasoning effort this candidate would be called with. One incompatible candidate never ends the search — the scan continues down the chain — and every rejection is written into the switch record with its reason, so an operator can see why a chain skipped a route.

### Durability and restart

Before the retried request is dispatched, the plugin awaits the Session's `session/flush` durability checkpoint: the switch record must be a byte the next process can read, not an append waiting in a batch window. A rejected flush is reported and the in-process recovery continues; the plugin never claims the record is durable when the checkpoint failed.

The folded state keeps the entry route, the route it replaced most recently, the routes this turn already tried, the switch count, the paused step, why the chain ended, the observed input size, and the number of automatic continuations, so a restart reproduces the routing decision — including the reasoning effort actually in use, not the chain's configured default. A later `model/selection` or a request header naming another route retires the recovery, so a user choice always wins.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the executor is built; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

Three rules shape the plugin. **Downstream first:** the failure reaches `agent/request-error` as a waterfall, so a recovery listener mounted later — the retry policy — decides before a route switch happens. **Durable before visible:** the switch is a Session event and a projection fold before the retry runs, so a crash between the decision and the retried request repeats no step. **One owner per route decision:** the plugin records the recovered route once and hands it to `ctx.modelRouting`, instead of rewriting the entry point's model selection.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The plugin: configuration schema and policy, the durable projection, and the request-recovery listener |
| [`src/classification.ts`](src/classification.ts) | Provider-neutral failure classification into switch categories |
| [`src/selection.ts`](src/selection.ts) | Candidate eligibility: registration, model metadata, call shapes, context capacity, and reasoning effort |
| [`src/state.ts`](src/state.ts) | The `llmModelFallback` projection fold and the durable state it reads |
| [`src/continuation.ts`](src/continuation.ts) | The opt-in autonomous continuation of an ownerless task |
| [`src/route.ts`](src/route.ts) | Configured route vocabulary and the selection one route contributes |
| [`src/types.ts`](src/types.ts) | Durable event payloads, failure categories, and rejection reasons |

### Recovery flow

A failed attempt arrives with the provider that served it, the turn, the step, and the turn's abort signal. The listener delegates to downstream recovery, returns when another listener scheduled a retry, and then checks the failure category against `switchOn`. It reads the configured header to name the failed route, reads the durable state for the switch allowance and the routes this turn already tried, and resolves candidates in chain order. With a target, it appends `llm/model-switched`, records the route override, and returns `{ kind: 'retry' }`; the loop rebuilds the same step from the Session surface, so no user message, tool call, or tool result is duplicated. Without a target it appends `llm/model-fallback-exhausted` once per step and returns nothing, leaving the failure terminal.

### Durable state

The `llmModelFallback` projection folds `turn/start` (resetting the per-turn attempt list and switch count), `llm/model-switched` (the replacement route, the entry route it stands in for, the route it replaced most recently, and both endpoints added to the attempt list), `llm/model-fallback-exhausted` (the paused step and why the chain ended), `assistant/message` usage (the observed input size), `user/message` source (how many automatic continuations this process already made), and a `request/header` or `model/selection` naming another route (clearing the replacement). Because the fold is a projection, a resumed Session starts with the route the previous process ended on, and the `previous` endpoint lets a multi-step switch keep replacing the entry route instead of dropping back to it.

### Waterfall and plugin order

The listener expects to run upstream of provider retry policies: it calls the downstream chain and only acts when that chain declines. A composition that mounts a newer retry policy after this plugin inherits that ordering; a policy that never settles also prevents a switch and turn quiescence.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [dsh-llm service](../llm/README.md) — the provider-neutral service this plugin routes across.
- [llm-retry](../llm-retry/README.md) — the request-retry executor that owns same-route recovery.
- [Agent model selection](../../core/agent/README.md) — `ctx.modelRouting` and the route an entry point selects.
- [Persistence catalog](../../../docs/persistence-catalog.md) — the generated record of `llm/model-switched` and `llm/model-fallback-exhausted`.

-----

<a id="model-experience"></a>
## Model Experience

### Model-request replay after a route switch

#### What the model sees

The retried request carries the same surface history the failed attempt carried: the admitted user messages, the assistant tool calls, and their results, with no summary and no placeholder. The plugin adds no prompt text of its own and no `user` or `developer` message; `llm/model-switched` and `llm/model-fallback-exhausted` are log-only records that never reach derived messages. The alternative route therefore reads the earlier turns produced by the failed model without being told which model produced them.

#### Token effect

The switch itself adds zero request tokens. Each retried attempt is a new provider request over the same retained history, so the alternative route bills its own input tokens for context the failed route already billed; a switch chain with several attempts repeats that input cost once per attempt.

#### KV Cache effect

The retried request keeps the same message prefix on the original route's terms; the alternative route has its own cache, so the first request there is a cache miss. A later switch to a third route repeats that miss, and the log-only switch records do not change any cache identity.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the executor stops and future work begins. They are current package constraints, not a general fallback comparison.

- **The alternative model is not told the route changed** — the switch is logged and the header records the new route, but no model-visible notice states that earlier assistant turns came from another model; a deployment that needs that disclosure owns the prompt text.
- **Same-route retries are not owned here** — a transient failure reaches the retry policy first, so a composition without that policy switches on the first transient failure and never retries the original route.
- **Only declared capabilities gate a candidate** — eligibility compares adapter metadata against the retained conversation; an adapter that reports no modality list, no context window, or no call-shape support stays eligible, and the context check needs a measured input size from a previous response.
- **Autonomous continuation is opt-in, bounded, and off by default** — with `resumeInterruptedTurns` a resumed Session continues an interrupted or paused task by itself, at most `maxRecoveryAttempts` times after the last human message; a deployment that leaves it off gets the durable pause and nothing more, and no product should read that default as autonomous recovery.
- **Tool side effects are reconciled, never re-executed by the harness** — crash repair records the unknown outcome of a call whose result was never stored, and the continuation instructs the model to verify external state before retrying. That is duplicate *suppression*, not exactly-once execution: a model that re-issues a non-idempotent call can still repeat its side effect.
- **Switches are per-turn bounded** — `maxSwitchesPerTurn` counts switches, not failed requests, and the counter resets on `turn/start`, so a long task can spend the full allowance again on the next turn.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: notes for maintainers and open questions. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The plugin reads the durable projection rather than in-memory counters for the switch allowance, so a resumed process cannot exceed the per-turn budget and a replay of the same turn reproduces the same decisions.
- `model/selection` is matched by event name instead of importing the entry-point package: the fallback package must not depend on a controller it never mounts.
- Candidate resolution resolves exact model metadata through the owning adapter, which is the only place that knows whether a route accepts images, a mid-conversation system prompt, or a reasoning effort.
- Autonomous continuation hangs off `agent/created` with `source === 'resume'`; it is not a timer and not a new-message path, which is why it can run before the Agent is published and why the shipped default keeps it off.
- The durability checkpoint reuses `ctx.sessions.flush`, the one flush entry point the Session store owns, rather than dispatching `session/flush` directly.

</details>
