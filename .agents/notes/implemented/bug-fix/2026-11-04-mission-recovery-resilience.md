# Agent Note: Mission recovery survives a damaged hint, a bounded sweep, and a wide fan-out

Status: implemented

English | [中文](2026-11-04-mission-recovery-resilience.zh.md)

## Problem

`dsh-mission-continuity` promised three things its code did not deliver, and every failure was reproduced before it was fixed.

**A damaged hint could stop the whole composition.** The discovery index was declared as a strict `single`-layout domain, so `open()` validated every stored row and rejected the domain on the first one that failed its schema. One torn row — a truncated write, a restored medium, a hand edit — therefore stopped the mission service from activating at all, even though the session logs, which are the authority, still held every mission intact. A truncated index file did the same one level lower in the storage backend. The package's own documentation says a lost index costs discovery, not mission state; the boot path contradicted it.

**A bounded sweep could starve every later mission.** `maxMissionsPerSweep` is documented as the number of candidates one sweep considers. The sweep always started at the first armed row, so once the supervisor had claimed the leading mission, every later sweep spent its whole budget re-examining that same claim and reporting `skipped`. With `maxMissionsPerSweep: 1`, a second interrupted mission was never recovered for as long as the first one ran — reproduced with three missions and four sweeps: `s1` live, `s2` and `s3` absent.

**A wide fan-out could hide an unknown external outcome.** The projection that feeds recovery tracked at most 16 pending tool calls, while the agent loop dispatches 10 by default and a step may legitimately hold more. A step that started more calls than the window held pushed its earliest calls out before their results arrived; the results then matched nothing, no `uncertainOperations` were recorded, and the startup sweep resumed the mission past an external effect nobody had confirmed. Reproduced with 20 calls: zero doubts recorded. A related, independently reproduced defect sat on the same path: the hold diagnostic listed every call name, and `authorize()` rejects a message over the durable 500-character diagnostic limit, so one wide fan-out threw inside the claim and the mission was held under `recovery-failed` — a code no `resume()` clears — instead of `uncertain-operations`.

## Decision

The index is disposable derived data, so the domain now declares what it is: `layout: 'per-record'` gives each hint its own document, and `invalidRecords: 'backup-and-skip'` moves an unreadable hint aside with its cause logged, instead of rejecting the domain. Backends that cannot move a document keep the loud path; the global slot always rejects. The startup rebuild then restores the row from the session log and the ordinary sweep recovers the mission.

The sweep rotates. Each sweep starts at the cursor the previous one left and advances by the number of rows it considered, wrapping once, so `maxMissionsPerSweep` bounds one sweep's work rather than which missions a supervisor can ever reach: every armed mission is reached within `ceil(rows / perSweep)` sweeps of the same index. `ledger.list()` is first-write ordered, so the rotation is stable.

The tracker admits a whole step. `MAX_TRACKED_CALLS` is 22 — twice the shipped 10-way fan-out plus a margin — and a call displaced by the bound is no longer forgotten: it is recorded as an unknown-outcome doubt, because a call without a committed result may or may not have touched the world. The retained list stays bounded, so a doubt that cannot be listed is counted in `MissionProjectionState.uncertainOverflow`; `ctx.missions.uncertainOverflow(agent)` exposes it, and both the sweep's gate and the recovery notice treat a non-zero count exactly like a listed call. The hold diagnostic now renders the total first and trims names from the end to fit the durable limit, so the count a human acts on always survives.

## Alternatives considered

**Keep the strict index and fail loud.** It is the honest default for authoritative data, and the storage-domain default is unchanged for every other domain. It is wrong here: the owner declares the log as the authority and already rebuilds rows from it, so refusing to boot converts a recoverable hint loss into a total outage.

**Make the index per-record but keep rejecting.** `per-record` alone limits the blast radius to one file but a schema failure still rejects the whole domain. Both parts are needed; the backup keeps the damaged bytes for inspection rather than deleting them.

**Restart the sweep window from the beginning every time.** Simple, and the reason for the bug. Serializing "already claimed" rows to the end of the list would also work, but it rewrites the index on every sweep and loses first-write stability.

**Drop displaced pending calls silently but bound nothing.** Removing the bound lets a long parallel session grow the projection without limit, which the projection cache has to carry. Counting the overflow keeps the bound and the doubt.

**Let the model resolve the doubt itself.** Recovery must not resume past an unconfirmed non-idempotent call; the human decision recorded by `ctx.missions.resume` is the seam that owns it, and the notice tells the model which calls to verify.

## Consequences

Regression coverage lives in [durability](../../../../packages/mission/mission-continuity/tests/durability.spec.ts), [persistence-failure](../../../../packages/mission/mission-continuity/tests/persistence-failure.spec.ts), [projection](../../../../packages/mission/mission-continuity/tests/projection.spec.ts), [units](../../../../packages/mission/mission-continuity/tests/units.spec.ts), and the new [sweep-budget](../../../../packages/mission/mission-continuity/tests/sweep-budget.spec.ts) suites; each was confirmed to fail against the pre-fix source. The uncertain-operations end-to-end lane re-ran unchanged.

Rotation is only exercised by explicit `sweep()` calls; the shipped startup sweep runs once per process, so a deployment tunes `maxMissionsPerSweep` against the size of its index, not against a hoped-for retry. The overflow count is derived state: it is not rebuilt from the log after a restart, and a mission whose overflow the log no longer justifies resumes normally. Both are the safe direction — a lost counter asks a human once more, a lost mission does not come back.
