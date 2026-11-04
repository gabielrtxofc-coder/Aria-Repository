# Agent Note: concurrent mission recovery — one session owner, no crash path

Status: implemented

English | [中文](2026-11-03-mission-recovery-concurrency.zh.md)

## Problem

Mission continuity resumes an interrupted mission by itself during startup: [`MissionSupervisor.start()`](../../../../packages/mission/mission-continuity/src/supervisor.ts) sweeps the durable discovery index and calls `ctx.agents.resume` for every armed candidate. A second attempt at the same session can exist at the same time — another `dsh` process over one `DSH_HOME`, a request-driven `agents.resume` from the API gateway, a config-declared `resumeSessionId` boot, or a repeated sweep.

A reproduction inside the test harness produced `SessionAlreadyOwnedError` from that overlap, and the error was reported as escaping to the process level and terminating it. That claim was never tied to a production path, so this note records what the code and the tests actually show, and which of those paths a reviewer can rely on.

## Decision

**The overlap is real; an uncaught one is not.** `SessionAlreadyOwnedError` is a *stable refusal*, not a defect, and every production caller contains it. No production path found here lets it reach the process-level handlers, so no code changed for it — the gaps were in proof, not behaviour.

### Where the error comes from

Three independent ownership boundaries can refuse a second attempt, and all three raise the same error name:

1. **In-process write claim.** [`claimWrite`](../../../../packages/session/session-persistence-jsonl/src/storage.ts) rejects a second write open for an id this process already holds, before any durable artifact is touched.
2. **Kernel write lease.** [`SessionWriteLease.acquire`](../../../../packages/session/session-persistence-jsonl/src/lease.ts) takes a non-blocking `flock(2)` on `session.lock` for another process's holder; contention maps to the same error. The kernel releases it on process death, so a crashed holder never blocks a successor.
3. **Agent registry collision.** [`agents.enter`](../../../../packages/core/agent/src/index.ts) is the authoritative publication boundary: two prepares may both succeed, but only one exact id can publish.

No supervisor-level serialization is needed for the cross-process case: the lease is the arbiter, and it is released by the kernel, not by cooperation.

### Why a production process does not die from it

- **The sweep already guards it.** [`ownedElsewhere`](../../../../packages/mission/mission-continuity/src/supervisor.ts) turns the refusal into the `skipped` outcome: no attempt consumed, no recovery notice, no index write by the loser. The winner's row keeps its attempt count and notice, so two processes over one home never double-charge an interruption.
- **The API gateway translates it.** [`resolve`](../../../../packages/api/session-controller/src/agent.ts) maps the same name to `RemoteError('session/writer-held')`, and `Commands.rejectCreation` does the same for creation. The refusal becomes an RPC answer, not a rejection.
- **A config-declared boot resume reports it.** [`AgentLoop.resumeWith`](../../../../packages/core/agent-loop/src/index.ts) takes write ownership first, so a boot lane that collides with a live owner rejects; the constructor path funnels that into `agent-loop/config-start-failed` plus a warning. Verified by probe against a real second-process lease: `failures` held the `SessionAlreadyOwnedError`, no unhandled rejection fired, and the boot context stayed active.
- **The process guard is real, but not on this path.** [`installFailLoud`](../../../../packages/boot/app-boot/src/index.ts) shapes any escaping rejection into `exit(1)`. It only sees an error a caller failed to await; each of the four call sites above awaits or catches.
- **The supervisor's own await cannot throw from a listener.** Background work is `void`-ed with a `.catch` (goal reconciliation); the boot promise is consumed by `Service.init`.

What *is* reachable without a bug: a sweep over a session whose write claim this process already holds is `skipped`, so a recovery can be **delayed** by a live owner but never lost — the row stays `armed` and a later sweep claims it. The concurrency suite asserts this "never lost" property rather than a fixed winner, because both interleavings are legitimate.

### The one unguarded caller, and why it is not production

`packages/mission/mission-continuity/tests/fixtures/mission-uncertain-child.ts` calls `ctx.agents.resume` with no `try`. It is safe today only because `ctx.agents.get(sessionId)` is `undefined` on that path — either startup did not recover, or the `held` mode returned earlier. It runs with `sweepOnStartup` on, so the proof depends on the sweep having declined for a *mission* reason (an uncertain operation, or a pending authorization) before the human path resumes. That is exactly what its fixtures arrange, but it is a test-only invariant, deliberately left unguarded so a double recovery fails loud instead of being swallowed.

## Evidence

`packages/mission/mission-continuity/tests/concurrency.spec.ts` drives the real AgentLoop, the real JSONL backend with its kernel lease, the real goal domain and the real mission service, with only the model route scripted. Nine cases over the five required scenarios:

| Scenario | Case | Asserts |
| --- | --- | --- |
| 1 — automatic recovery | boot with the startup sweep, no message, no API call | session owned, one attempt, one durable notice |
| 2 — second attempt | repeated sweep while owned; second composition; raw concurrent `agents.resume` | `skipped`, one attempt, loser leaves no Agent, refusal is a named error |
| 3 — two instances | both sweep concurrently; loser stays usable | exactly one `resumed`, one live owner, one notice, one index row |
| 4 — resume during recovery | sweep and external resume issued together; resume after recovery | no crash, no double recovery, mission never lost, one notice |
| 5 — ownership failure | lease taken by another composition; then released | `skipped` with no attempt consumed and no `hold` written; successor recovers |

Suite totals for the package: 11 files, 112 tests. The two built-bin proofs (`mission-startup.e2e.ts`, `uncertain-operations.e2e.ts`) pass in the source lane; the built (`DSH_EXAMPLE_MODE=lib`) lane is established only by CI, see below.

## Alternatives considered

**Guard the test fixture's unguarded `agents.resume` with a `try`.** Rejected: a double recovery in that proof would turn into a silent skip, weakening the one place where it must fail loud. The fixture's real invariant is that no Agent is live on that path.

**Add a supervisor- or service-level mutex around recovery.** Rejected: the kernel lease already arbitrates cross-process ownership and the sweep is single-flight in process. A second lock would add a failure mode of its own and hide the refusal instead of reporting `skipped`.

**Catch every failure in `recover()` and report it as a skip.** Rejected: genuine failures (a lost artifact, corruption, an unusable plan) must become `recovery-failed` holds carrying a diagnostic, which is what the current guard deliberately does not do for them.

**Fork a second OS process in the concurrency proof.** Rejected: the cross-process claim rests on the kernel lease, already proven by the session backend's two-process suite; a forked mission proof would add minutes of subprocess cost without a new invariant.

**Charge an attempt for a `skipped` recovery.** Rejected: the loser performed no recovery, so charging it would spend the mission's budget on a process that did nothing and could exhaust a healthy mission.

## Consequences

The concurrency risk is closed as *documented and tested*, not as a behaviour change: a reviewer approving this work should read `skipped` as the designed answer to a contested session, and should not expect two processes to share one mission.

Still open, and outside this change:

- The `built-bin smoke` gate inside `node 24 / snapshots and artifacts` has not run for this branch. The three required Linux jobs (`static`, `coverage`, `snapshots and artifacts`) and the three native Windows jobs are queued on the enterprise labels `dsh-ubuntu-24-04-16core` / `dsh-windows-2025-16core` with no runner assigned, while hosted jobs in the same run execute. The expected remedy is the documented writer-level `DSH_CI_FAILOVER_LINUX` switch (to `selfhosted` or `blacksmith`), which cannot be set by a branch; the built-lane proof stays unconfirmed until a run actually executes the gate.
- The concurrency proof asserts a composition's liveness through `fiber.state`, not a forked process. The cross-process claim rests on the kernel lease and the two-process lease suite, which is where it belongs; a forked variant would add cost without new coverage.
- The toolchain here cannot produce the built lane locally: the sandbox OOMs on the full workspace build and has no registry access to `cdn.sheetjs.com`. That is an environment limit, not a claim about the gate.
