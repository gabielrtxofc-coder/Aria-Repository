# Mission continuity

English | [中文](mission-continuity.zh.md)

The durable mission record, the reconciliation index that discovers it, and the automatic recovery decision table. The [package reference](../../packages/mission/mission-continuity/README.md) owns the usage story and configuration; this page records the exact fields and the recovery outcomes from [`packages/mission/mission-continuity/src/types.ts`](../../packages/mission/mission-continuity/src/types.ts) and [`supervisor.ts`](../../packages/mission/mission-continuity/src/supervisor.ts).

## The record

A mission is committed to the owning session log as `mission/change`, carrying the complete post-mutation snapshot or a `clear` tombstone:

```ts
import type { GoalRef } from '@deepseek-ai/dsh-goal/types'
import type {
  MissionAuthorization,
  MissionCheckpoint,
  MissionId,
  MissionInterruption,
} from '@deepseek-ai/dsh-mission-continuity'

/** Complete post-mutation mission state. */
interface MissionSnapshot {
  readonly id: MissionId
  readonly revision: number
  readonly goal: GoalRef
  readonly completionCriteria: readonly string[]
  readonly recovery: 'enabled' | 'disabled'
  readonly maxRecoveryAttempts: number
  readonly attempts: number
  readonly interruption?: MissionInterruption
  readonly checkpoint?: MissionCheckpoint
  readonly authorization?: MissionAuthorization
  readonly createdAt: number
  readonly updatedAt: number
}
```

`MissionView` adds the derived `settled` flag, which is true only while the current objective exists, matches the mission's goal, and is complete. Every mutation is compare-and-set on `{ id, revision }` and advances the revision by exactly one; the [mission fold](../../packages/mission/mission-continuity/src/fold.ts) refuses a change that cannot follow the accumulated state, and a projection that hits such a change keeps the failure instead of exposing a partly interpreted mission.

`interruption` records why the last attempt stopped — `process-restart` when the Agent had to be resumed, `request-failed` when a live Agent's turn failed — with its time and an optional 500-character diagnostic. `checkpoint` records the last session event sequence the mission considered consistent. `authorization` holds a pending policy code and message: while it exists, autonomous recovery is refused.

## The discovery index

The storage domain holds one row per recoverable mission. It is a hint, never a second authority:

```ts
import type { GoalId } from '@deepseek-ai/dsh-goal/types'
import type { MissionId } from '@deepseek-ai/dsh-mission-continuity'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** One durable discovery row. */
interface RecoveryRecord {
  readonly sessionId: SessionId
  readonly missionId: MissionId
  readonly goalId: GoalId
  readonly revision: number
  readonly attempts: number
  readonly state: 'armed' | 'held'
  readonly lastError?: { readonly code: string; readonly message: string }
  readonly updatedAt: string
}
```

`state` is `armed` only when the record itself justifies autonomous recovery: `recovery === 'enabled'`, no pending authorization, and fewer attempts than the budget. Every write is followed by a reconciliation pass, and a row that disagrees with its session log is settled rather than trusted. Losing the index loses discovery, not mission state.

## Recovery decision table

`MissionSupervisor` claims each armed row and decides from the durable record, never from the log's shape:

| Observed state | Outcome | Effect on the row |
| --- | --- | --- |
| No mission, or a different mission id | `settled` | row deleted |
| Mission `settled` | `settled` | row deleted |
| `recovery: 'disabled'` | `held` (`recovery-disabled`) | row held |
| Pending `authorization` | `held` (policy code) | row held |
| Objective missing or replaced | `held` (`objective-missing`) | row held |
| Objective paused or blocked | `held` (`objective-paused`/`objective-blocked`) | row held |
| `attempts >= maxRecoveryAttempts` | `exhausted` | objective blocked, row held |
| Otherwise | `resumed` | attempt recorded, objective re-armed |
| Unexpected failure | `failed` | row held with a truncated diagnostic |

A resumed mission consumes one attempt, flushes the record, queues the `<mission_recovery …>` notice, and re-arms the objective; the [goal round driver](../../packages/goal/goal-round-driver/README.md) then admits the next automatic round, so no new user message is needed. A held or exhausted row is waiting for human action — an approval, a resume, or a larger budget — and the sweep never bypasses it.

## The composition seam

Recovery does not own provider or model selection. Before resuming a session it dispatches the `mission/agent-setup` waterfall with the persisted session id and uses the returned plan for the agent factory:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { MissionAgentSetupPlan } from '@deepseek-ai/dsh-mission-continuity'

declare const provider: string
declare const model: string

export function apply(ctx: Context): void {
  ctx.on('mission/agent-setup', async (request, next): Promise<MissionAgentSetupPlan> => ({
    ...await next(request),
    agentOptions: { provider, model },
  }))
}
```

An empty plan resumes the log without provider/model options and fails loud on the first request, which holds the row instead of guessing a route. The shipped `default-agent-plan` plugin answers from `ctx.agentDefaultModel`; a profile may answer differently in a later patch layer, and a model that changes between attempts is a reroute, not a lost mission.

## Durability

`checkpoint` and `recordAttempt` await `ctx.sessions.flush` for the owning session before they resolve, so a recorded step or attempt is durable before work continues; a rejected flush fails the call with `MISSION_PERSISTENCE_FAILED` and leaves the index untouched. `start` writes the index row after the record commits; a rejected index write blocks the objective instead of leaving unrecoverable work behind.

## Known limits

- A call with an unknown outcome is never re-executed by Aria, but a model may re-issue a non-idempotent call; missions record the uncertainty and ask for verification, and no exactly-once claim is made.
- An unknown outcome holds the mission until a person acknowledges it. The acknowledgement is a watermark over the outcomes recorded at that moment, so a doubt recorded later holds the mission again, and it is folded into the session log with the mission so a rebuilt recovery index cannot grant a stale clearance.
- Recovery is bounded by `maxMissionsPerSweep` and `defaultMaxRecoveryAttempts`; exhaustion is recorded as an objective blocker for a human.
- A pending approval is durable; recovery resumes only after it is granted.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmissions--missionservice"></a>

### `ctx.missions` — `MissionService`

Mission service (`ctx.missions`). Mission state lives in the owning session log; the durable storage domain holds only the discovery index a later process start reads, and that index is always reconciled against the log.

```ts cordis-catalog
/**
 * Read the current mission for one exact live agent.
 * @param agent - owning live agent.
 * @returns a fresh view, or `undefined` when no mission is current.
 * @throws {@link MissionError} when the agent is not the registry's live
 *   instance, or when the session's mission history failed strict replay.
 */
get(agent: Agent): MissionView | undefined

/**
 * Recorded calls whose committed outcome is unknown, oldest first.
 *
 * This is what the durable log says about these calls, not what recovery still
 * has to stop for: a doubt a human already reviewed stays visible here — the
 * model still needs to know the outcome of a call nobody confirmed — and is
 * excluded only from the backlog `unacknowledgedUncertainty` reports.
 * @param agent - owning live agent.
 * @returns bounded call identities for recovery diagnostics.
 */
uncertainOperations(agent: Agent): readonly UncertainOperation[]

/**
 * Unknown-outcome calls the bounded tracker could not list. Non-zero means the
 * doubt is at least as serious as a listed call, so callers that gate on
 * {@link uncertainOperations} must gate on this value too — and gate on both
 * through {@link unacknowledgedUncertainty}, which is also what subtracts the
 * reviews the mission record already carries.
 * @param agent - owning live agent.
 * @returns how many unknown-outcome calls were counted but not listed.
 */
uncertainOverflow(agent: Agent): number

/**
 * Current plan entries from the todo projection, in plan order.
 * @param agent - owning live agent.
 * @returns plan entries, empty when no plan owner is composed for the session.
 */
plan(agent: Agent): readonly RecoveryNoticeStep[]

/**
 * Start one mission and the durable objective it carries. The discovery row
 * is written before the mission change, so a later process start can find the
 * mission; a rejected row write fails the start instead of leaving work that
 * nothing can recover.
 * @param agent - owning live agent.
 * @param request - objective, completion criteria, and optional budgets.
 * @returns the created mission view.
 * @throws {@link MissionError} on invalid input, an existing mission, or a
 *   rejected durable write.
 */
async start(agent: Agent, request: StartMissionRequest): Promise<MissionView>

/**
 * Record a durable checkpoint of the mission's progress: the session prefix
 * up to the appended event is flushed before the call resolves, so a later
 * process start resumes after completed work instead of repeating it.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @returns the checkpointed view.
 * @throws {@link MissionError} on a stale ref or a rejected flush.
 */
async checkpoint(agent: Agent, ref: MissionRef): Promise<MissionView>

/**
 * Consume one recovery attempt and record why recovery is taking over. The
 * appended record and the work it authorizes are flushed before this resolves,
 * so a rejected flush fails the attempt instead of running work the durable
 * log cannot justify.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @param input - the interruption cause and optional bounded detail.
 * @returns the updated view with the consumed attempt.
 * @throws {@link MissionError} on a stale ref, a disabled policy, an exhausted
 *   budget, or a rejected flush.
 */
async recordAttempt( agent: Agent, ref: MissionRef, input: { readonly interruption: MissionInterruption }, ): Promise<MissionView>

/**
 * Record pending human authorization. Autonomous recovery stops claiming the
 * mission until {@link resume} records the decision, so recovery never
 * substitutes for the approval the approval seam owns.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @param authorization - policy-owned code and explanation.
 * @returns the updated view.
 */
async authorize(agent: Agent, ref: MissionRef, authorization: MissionAuthorization): Promise<MissionView>

/**
 * Clear pending human authorization after the decision was recorded, making
 * the mission claimable again.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @returns the updated view.
 * @throws {@link MissionError} when no authorization is pending.
 */
async resume(agent: Agent, ref: MissionRef): Promise<MissionView>

/**
 * Clear the current mission, retaining a durable tombstone, and remove its
 * discovery row. The linked objective is deliberately untouched: releasing
 * the continuity commitment is not completing the work.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @returns the tombstone ref, one revision past the cleared record.
 */
async clear(agent: Agent, ref: MissionRef): Promise<MissionRef>

/**
 * Recover every armed mission the durable index lists, then report what
 * happened. Calls are serialized, so two sweeps never claim one mission twice.
 * @returns the sweep report; per-mission failures are reported, never thrown.
 */
async sweep(): Promise<MissionSweepReport>

/**
 * Standing index state for one durable record: `armed` only while autonomous
 * recovery may claim it without human action.
 * @param current - durable mission record.
 * @returns the row state the record justifies.
 */
rowState(current: MissionSnapshot): 'armed' | 'held'
```

Types: [Agent](core.md)

Source: [`packages/mission/mission-continuity/src/service.ts`](../../packages/mission/mission-continuity/src/service.ts)

<a id="mission-events"></a>

### `mission/*` events

<a id="missionagent-setup--waterfall"></a>

#### `mission/agent-setup` — waterfall

Decide how mission recovery composes the Agent that will continue a persisted session. The deployment supplies provider, model, and any session-scoped capability setup; recovery never invents them. Listeners must delegate through `next` and merge into its result. A composition without a listener resumes the durable log with no options, which fails loud on the first request — recovery documents that as a deployment requirement rather than guessing a route.

```ts cordis-catalog
/**
 * Decide how mission recovery composes the Agent that will continue a
 * persisted session. The deployment supplies provider, model, and any
 * session-scoped capability setup; recovery never invents them. Listeners
 * must delegate through `next` and merge into its result. A composition
 * without a listener resumes the durable log with no options, which fails
 * loud on the first request — recovery documents that as a deployment
 * requirement rather than guessing a route.
 * @param payload.sessionId - persisted session about to be resumed.
 * @param payload.agentOptions - options recovery would otherwise pass unchanged.
 * @param next - delegation to the remaining listeners and the default plan.
 * @mode waterfall
 */
'mission/agent-setup'( payload: MissionAgentSetupRequest, next: (request: MissionAgentSetupRequest) => Promise<MissionAgentSetupPlan>, ): Promise<MissionAgentSetupPlan>
```

Source: [`packages/mission/mission-continuity/src/domain.ts`](../../packages/mission/mission-continuity/src/domain.ts)

<a id="missionchanged--emit"></a>

#### `mission/changed` — emit

Mission mutation accepted by one live agent. The matching `mission/change` session event has already committed. Listener failures are contained. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.

```ts cordis-catalog
/**
 * Mission mutation accepted by one live agent. The matching `mission/change`
 * session event has already committed. Listener failures are contained.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners
 * receive only that agent.
 * @param payload.agent - agent whose session owns the mission.
 * @param payload.change - fresh current view or clear tombstone.
 * @mode emit
 */
'mission/changed'(this: import('@deepseek-ai/dsh-scope').Scoped<Agent>, payload: { agent: Agent; change: MissionChanged }): void
```

Types: [Agent](core.md) · [Scoped](scope.md)

Source: [`packages/mission/mission-continuity/src/domain.ts`](../../packages/mission/mission-continuity/src/domain.ts)
<!-- END GENERATED cordis-surface -->
