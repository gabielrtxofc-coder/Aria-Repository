# 任务连续性

[English](mission-continuity.md) | 中文

持久任务记录、用于发现它的核对索引，以及自动恢复的决策表。[包参考](../../packages/mission/mission-continuity/README.zh.md)负责使用方式与配置；本页记录 [`packages/mission/mission-continuity/src/types.ts`](../../packages/mission/mission-continuity/src/types.ts) 与 [`supervisor.ts`](../../packages/mission/mission-continuity/src/supervisor.ts) 中的确切字段与恢复结果。

## 记录

任务以 `mission/change` 提交到所属会话日志，携带修改后的完整快照或一个 `clear` 墓碑：

```ts
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

`MissionView` 增加派生的 `settled` 标志：当且仅当当前目标存在、与任务的目标一致且已完成时为真。每次修改都对 `{ id, revision }` 做比较并交换，且版本恰好加一；[任务折叠](../../packages/mission/mission-continuity/src/fold.ts)会拒绝无法接续既有状态的变更，而遇到此类变更的投影会保留失败，而不是暴露被部分解释的任务。

`interruption` 记录上一次尝试停止的原因——Agent 需要被重新续接时是 `process-restart`，活动 Agent 的一轮失败时是 `request-failed`——并带有时间与最多 500 字符的可选诊断。`checkpoint` 记录任务认为一致的最后一个会话事件序号。`authorization` 保存待处理的策略代码与消息：只要它存在，自动恢复就会被拒绝。

## 发现索引

存储域为每个可恢复任务保存一行。它只是线索，绝不是第二权威：

```ts
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

仅当记录本身支持自动恢复时，`state` 才是 `armed`：`recovery === 'enabled'`、没有待处理授权，且尝试次数未超出预算。每次写入之后都会执行一次核对，与所属会话日志不一致的行会被结算，而不是被信任。丢失索引只丢失发现能力，不会丢失任务状态。

## 恢复决策表

`MissionSupervisor` 认领每个 `armed` 行，并且只依据持久记录做判断：

| 观测到的状态 | 结果 | 对行的处理 |
| --- | --- | --- |
| 没有任务，或任务 id 不同 | `settled` | 删除该行 |
| 任务已 `settled` | `settled` | 删除该行 |
| `recovery: 'disabled'` | `held`（`recovery-disabled`） | 挂起该行 |
| 存在待处理 `authorization` | `held`（策略代码） | 挂起该行 |
| 目标缺失或被替换 | `held`（`objective-missing`） | 挂起该行 |
| 目标暂停或阻塞 | `held`（`objective-paused`/`objective-blocked`） | 挂起该行 |
| `attempts >= maxRecoveryAttempts` | `exhausted` | 阻塞目标并挂起该行 |
| 其他情况 | `resumed` | 记录一次尝试，重新激活目标 |
| 意外失败 | `failed` | 挂起该行并附上被截断的诊断 |

被恢复的任务会消耗一次尝试、刷新记录、排队 `<mission_recovery …>` 通知并重新激活目标；随后[目标轮次驱动](../../packages/goal/goal-round-driver/README.zh.md)接纳下一个自动轮次，因此不需要新的用户消息。被挂起或耗尽的行走在等待人工动作——审批、恢复或更多预算——扫描永远不会绕过它。

## 组合接缝

恢复不拥有 provider 与模型的选择权。在续接会话之前，它用持久会话 id 派发 `mission/agent-setup` 瀑布，并把返回的方案交给 Agent 工厂：

```ts
ctx.on('mission/agent-setup', async (request, next) => ({
  ...await next(request),
  agentOptions: { provider, model },
}))
```

空方案会在没有 provider/模型选项的情况下续接日志，并在第一次请求时明确失败，于是该行被挂起而不是猜测路由。随包提供的 `default-agent-plan` 插件用 `ctx.agentDefaultModel` 作答；profile 可以在后续补丁层给出不同答案，而两次尝试之间更换模型属于改道，不是任务丢失。

## 持久性

`checkpoint` 与 `recordAttempt` 在返回前会等待所属会话的 `ctx.sessions.flush`，因此已记录的步骤或尝试在继续工作之前就已持久化；刷新被拒绝会以 `MISSION_PERSISTENCE_FAILED` 使调用失败，并保持索引不变。`start` 在记录提交之后写入索引行；索引写入被拒绝会阻塞目标，而不是留下无法恢复的工作。

## 已知限制

- 结果未知的调用不会被 Aria 重新执行，但模型可能再次发出非幂等调用；任务会记录这一不确定性并要求核对，且不承诺恰好一次。
- 出现未知结果的调用会挂起任务，直到人工确认。这次确认是当时已记录结果的水位线，因此之后记录的疑问会再次挂起任务；水位线与任务一同折叠进会话日志，重建恢复索引不会带来过期的放行。
- 恢复受 `maxMissionsPerSweep` 与 `defaultMaxRecoveryAttempts` 限制；耗尽会作为目标阻塞记录下来供人处理。
- 待处理审批是持久的；恢复只有在审批通过之后才会继续。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
 * @param agent - owning live agent.
 * @returns bounded call identities for recovery diagnostics.
 */
uncertainOperations(agent: Agent): readonly UncertainOperation[]

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

Types: [Agent](core.zh.md)

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

Types: [Agent](core.zh.md) · [Scoped](scope.zh.md)

Source: [`packages/mission/mission-continuity/src/domain.ts`](../../packages/mission/mission-continuity/src/domain.ts)
<!-- END GENERATED cordis-surface -->
