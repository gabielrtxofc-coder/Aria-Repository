---
description: "The durable mission service that keeps a task owned by Aria rather than by one model: state in the session log, a reconciled recovery index, and an automatic restart sweep that continues work without a new user message."
kind: "package-reference"
---

# @deepseek-ai/dsh-mission-continuity

English | [中文](README.zh.md)

## Summary

`dsh-mission-continuity` makes the task belong to Aria instead of to one model. A mission is a durable record — objective, completion criteria, plan, steps, operational context, tool results, changed files, interruptions, and the last consistent checkpoint — committed to the owning session log as `mission/change` events, so it survives a turn failure, a model failure, or a whole process restart. A small storage-domain index records which sessions hold recoverable missions; it is a hint that every recovery reconciles against the log, never a second source of truth. On startup a bounded sweep resumes interrupted missions on its own: it re-arms the objective, queues a `<mission_recovery …>` notice explaining what happened, and lets the existing goal continuation driver take the next round, all without a new user message. Recovery never selects a provider or a model — it asks the composition through the `mission/agent-setup` waterfall — and it never bypasses a permission: a mission waiting for approval is held, not resumed. Choose it when work must outlive one model's availability; skip it for single-turn requests that need no state.

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

Mount `dsh-mission-continuity` after the goal stack (`dsh-goal`, `dsh-goal-round-driver`), the session log and projection services, and a storage domain. It registers `ctx.missions` plus the `mission` session projection, and it starts the recovery sweep when `sweepOnStartup` is true (the default).

Recovery can only resume an Agent if the composition says how to compose it. Provide that answer with a `mission/agent-setup` listener — the shipped `@deepseek-ai/dsh-mission-continuity/default-agent-plan` plugin answers with the host's default model selection (`ctx.agentDefaultModel`), and a profile that wants another route registers its own listener later and wins:

```ts
ctx.on('mission/agent-setup', async (request, next) => ({
  ...await next(request),
  agentOptions: { provider: 'my-provider', model: 'my-model' },
}))
```

An empty plan resumes the durable session without provider or model options, which fails loud on the first request instead of guessing a route. That failure holds the recovery row with a diagnostic rather than losing the mission.

Configuration:

| Key | Default | Meaning |
| --- | --- | --- |
| `sweepOnStartup` | `true` | Run the recovery sweep while the composition starts. |
| `defaultMaxRecoveryAttempts` | `3` | Attempt budget for a mission started without one (1–100). |
| `maxMissionsPerSweep` | `32` | Candidates one sweep may consider (1–1000). |

The service surface is `ctx.missions.{get, plan, uncertainOperations, start, checkpoint, recordAttempt, authorize, resume, clear, sweep}`. Every mutation takes the exact `{ id, revision }` it expects and fails with `MISSION_STALE_REVISION` when another writer moved first; `checkpoint` and `recordAttempt` await `ctx.sessions.flush` for the owning session before they resolve, so a recorded step is durable before work continues.

<a id="understand-the-implementation"></a>
## Understand the implementation

Three pieces cooperate:

- **The durable record.** `mission/change` carries the complete post-mutation mission record (or a `clear` tombstone). It is log-only: no projection rebuild, fork, or resume may treat a partly interpreted mission as current, and the fold rejects any change that cannot follow the accumulated state — a mutation without a current mission, an identity change, a skipped revision, a backward checkpoint, or a decreasing attempt count.
- **The discovery index.** One storage domain table maps `missionId → { sessionId, goalId, revision, attempts, state, lastError }`. `state` is `armed` only while autonomous recovery may claim the mission without human action. Every write is followed by reconciliation against the log; a row that disagrees with its session is settled, not trusted.
- **The supervisor.** `sweep()` reads armed rows, resolves each session to a live Agent (an existing one means the turn failed; a resumed one means the process went away), and claims the mission. Claiming settles finished missions, holds missions that are disabled, waiting for approval, or missing their objective, records exhaustion as an objective blocker, and otherwise consumes one attempt, queues the recovery notice, and re-arms the objective. Sweeps are single-flight and bounded, and disposal stops claiming and releases every held Agent.

Recovery is deliberately decoupled from model routing. Aria owns the mission, the objective, the plan, and the record of what happened; a gateway or a profile owns which provider and model serve the next request. Switching routes mid-mission is therefore replanning, not mission loss — the next attempt reads the same durable state.

<a id="further-exploration"></a>
## Further Exploration

- [Same-session goals](../../goal/goal/README.md) — the objective the mission persists and re-arms.
- [Goal round driver](../../goal/goal-round-driver/README.md) — the loop that admits the next automatic round.
- [Sessions](../../core/session/README.md) — the log that is the durable authority.
- [Mission continuity subsystem](../../../docs/subsystems/mission-continuity.md) — the record fields and the recovery decision table.

<a id="model-experience"></a>
## Model Experience

A recovered mission wakes the model with one user message rendered from the durable record:

```text
<mission_recovery mission="mission-…" revision="7" attempt="2" interruption="process-restart">
The previous attempt stopped before it finished the mission objective …
Objective: …
Completion criteria: …
Completed steps: …
Pending steps: …
Last consistent checkpoint: session event 42.
Operations whose outcome is unknown: call-17 (bash). Verify the external state before repeating them.
Resume from the last consistent step. Do not repeat work already recorded as complete.
</mission_recovery>
```

The notice is bounded: long step and operation lists are truncated with a count. It tells the model what was already done and which calls must be verified before repeating, so a resumed turn continues rather than restarting.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **No exactly-once guarantee.** A call whose outcome is unknown (`TOOL_OUTCOME_UNKNOWN`) is never re-executed by Aria, but a model may still re-issue a non-idempotent call. Missions record the uncertainty and instruct verification; the external system keeps the final word.
- **Recovery cannot invent a route.** Without a `mission/agent-setup` answer, a resumed session fails loud and its row is held. Automatic recovery across a model change assumes the deployment keeps serving the mission's model or names a replacement.
- **Approval stays gated.** A mission waiting for authorization is held; the sweep never resumes it.
- **Continuation needs the goal stack.** The supervisor re-arms the objective; the loop that runs the next round is `dsh-goal-round-driver`. Without it, a resumed mission waits for the next turn.
- **The index is not authoritative.** Deleting it loses discovery, not mission state; every surviving session can still be started by hand.

<a id="dev-note"></a>
## Dev Note

Tests mount a real composition (sessions, projections, storage, goals, the goal round driver, and a scripted LLM adapter) on a temporary durable root; the restart coverage includes a subprocess test that `SIGKILL`s a live mission process and recovers it in a new one. Run them with `pnpm exec vitest run packages/mission/mission-continuity` and the crash test with `pnpm exec vitest run --config vitest.e2e.config.ts packages/mission/mission-continuity/tests/restart-process.e2e.ts`. The package carries a 100%-per-file coverage requirement.
