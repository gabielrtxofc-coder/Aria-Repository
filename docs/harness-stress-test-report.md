# ARIA Harness Stress Test — audit report

**Mission.** Evaluate the stability, reliability, security, and operational capacity of the DeepSeek Harness (`dsh`) that underpins Aria; reproduce real failures in a controlled environment; fix what is proven; and give an honest statement of what is ready.

**Branch:** `arena/e9e19faa-aria-repository`, based on `main` @ `46df1890` (the merge of PR #16, *"feat(mission): durable mission records with automatic restart recovery"*). PR #16 is confirmed integrated; `packages/mission/mission-continuity` is present and green on `main`.

**Method.** Every defect below was reproduced against the unmodified source *before* any fix, then re-run against the fix. Each regression test was also verified to fail when its fix is reverted (see "Proof of the fix").

---

## 1. Verdict

| Area | State |
| --- | --- |
| Session log durability, append-only contract, projections | **Working and proven** |
| Mission record durability (`start`/`checkpoint`/`recordAttempt`) | **Working and proven** |
| Crash recovery end-to-end (SIGKILL mid-request, startup sweep) | **Working and proven** |
| Unknown-outcome handling (never auto-repeat; human gate) | **Working and proven** (after C1/C2 fixes) |
| Recovery index resilience | **Was broken (H1); fixed and proven** |
| Sweep scheduling under a bounded budget | **Was broken (H2); fixed and proven** |
| Concurrency (two supervisors, two processes, one session) | **Working and proven** |
| Load and scale | **Working, measured** (limits recorded in §8) |
| Lint gate (`oxlint`) | **Blocked by environment** (§11) |
| Full-repo typecheck | **Blocked by environment** (OOM, §11) |

The Harness can **safely hold long missions**, but three proven defects in the mission-continuity layer were each capable of losing or freezing work. They are fixed and covered. It is not "perfect"; see §14.

---

## 2. Components examined

- **Initialisation/teardown:** Cordis composition, `ctx.effect` disposers, profile boot (`packages/boot`, `apps/cli`).
- **Agent execution cycle:** `packages/core/agent-loop` (turn/step, `maxParallelToolCalls` = 10 default), `packages/core/tools`.
- **Sessions and history:** `packages/core/session` (contiguous `seq`, surface projection, compaction markers), `packages/session/session-persistence` + `-jsonl`.
- **Storage:** `packages/storage/storage`, `storage-domain` (spec/layout/invalidRecords semantics), `storage-json`, `storage-sqlite`.
- **Context assembly:** surface/surface-replacement, `packages/compaction/compaction-basic`.
- **Model calls and providers:** `packages/llm/llm` (adapter seam, error taxonomy, `TOOL_OUTCOME_UNKNOWN`), `llm-retry`, `llm-deepseek`, `llm-pi-ai`.
- **Tools:** `packages/core/tools` dispatch, `packages/guard/timeout-policy`, `guard/repeat-tool-reminder`.
- **Events:** Cordis events/waterfalls (`mission/agent-setup`, `goal/changed`, `agent/disposed`), `agentEvents` `mission/changed`.
- **Permissions/config:** `packages/interaction/permission-presets`, `user-approval`, settings/credentials packages.
- **Mission continuity (PR #16):** `service.ts`, `supervisor.ts`, `ledger.ts`, `fold.ts`, `prompt.ts`, `types.ts`, `runtime.ts`, `domain.ts`.
- **OmniRoute:** not present in this repository; **not integrated**, and no second routing layer was added. See §14.

---

## 3. Tests executed (all real runs)

| Lane | Command | Result |
| --- | --- | --- |
| Native host addon | `pnpm run build:native-system` | built `linux-x64/bin/glibc/system.node` |
| Mission-continuity unit | `vitest run packages/mission/mission-continuity` | **112 → 119 passed** (13 files) |
| Mission-continuity e2e/crash | `vitest run --config vitest.e2e.config.ts packages/mission/mission-continuity` | **7 passed** (SIGKILL recovery, startup sweep, uncertain operations) |
| llm + session + goal + storage | `vitest run packages/llm packages/session packages/goal packages/storage` | **4251 passed**, 1 skipped (174 files) — pre-change baseline |
| Affected subsystems + mission + core + guard | same, plus `packages/mission packages/core packages/guard` | **6027 passed**, 1 skipped (255 files) — post-change |
| Load/scale probes (temporary, not committed) | seed 24 missions; 4 000-event session | see §8 |
| Translation pairing | `pnpm run verify-translation-pairing` | 933 pairs consistent |
| Agent Note gates | `verify-agent-note-classification`, `verify-agent-note-format` | 302 notes consistent |
| Typecheck (package) | `tsc -b packages/mission/mission-continuity` | exit 0 |
| Lint | `oxlint` | **blocked** — binary panics on untouched input (§11) |

---

## 4–5. Problems found, with severity

### H1 — One damaged recovery-index row prevents the whole composition from starting — **High**

- **Observed.** With a mission durably recorded, damaging one row of the discovery index (`mission_continuity.json`) makes `ctx.storageDomain.open()` reject: `DomainError: stored record 'mission-…' in table 'recoveries' does not match its schema`. The mission service — and therefore the composition — never activates. A truncated index file fails the same way (`StorageError: file is not valid JSON`).
- **Component.** `packages/mission/mission-continuity/src/ledger.ts` (domain declaration), interacting with `packages/storage/storage-domain` defaults.
- **Cause.** The index was declared as a strict `single`-layout domain with the default `invalidRecords` policy, i.e. as authoritative data. The package's own documentation says the index is a *hint*, the session log is the authority, and startup rebuilds every row the logs justify.
- **Impact.** Total unavailability of mission continuity (and of anything else in that composition) caused by a file the code itself calls disposable — while every mission sits intact in its log. Recovery-by-hint is supposed to be the cheap path, not a single point of failure.
- **Classification.** Preexisting (present on `main` before this mission).

### H2 — A bounded sweep starves every later mission — **High**

- **Observed.** Seed three interrupted missions (`s1`, `s2`, `s3`) sharing one durable root with `maxMissionsPerSweep: 1`, then sweep repeatedly:

  ```
  sweep 1: {"considered":1,"resumed":0,"held":0,...,"skipped":1}
  sweep 2: {"considered":1,"resumed":0,"held":0,...,"skipped":1}
  sweep 3: {"considered":1,"resumed":0,"held":0,...,"skipped":1}
  sweep 4: {"considered":1,"resumed":0,"held":0,...,"skipped":1}
  live agents: s1:live s2:absent s3:absent
  ```

- **Component.** `supervisor.ts` → `runSweep()`.
- **Cause.** Every sweep took `armed.slice(0, maxMissionsPerSweep)` from the same first-write-ordered list. After the supervisor claimed the first mission, each later sweep spent its entire budget re-examining that claim (`alreadyRecovered` → `skipped`).
- **Impact.** Any deployment that bounds the sweep (the documented, supported way to control startup cost) silently loses automatic recovery for every mission behind the first one. Work is not lost from disk, but it never resumes without a human.
- **Classification.** Preexisting.

### C1 — A wide tool fan-out hides unknown external outcomes, and recovery resumes past them — **Critical**

- **Observed.** A single step that starts 20 tool calls whose results are all `TOOL_OUTCOME_UNKNOWN` leaves `uncertainOperations` **empty** (`call-0` not retained; only `call-4 … call-19` were tracked). With the pre-existing bound of 16 and the loop's default 10-way dispatch, an ordinary wide step silently loses its earliest calls.
- **Component.** `service.ts` → `missionProjectionDefinition.apply` / `trackCall` / `MAX_TRACKED_CALLS`.
- **Cause.** A 16-entry window for pending calls, smaller than a legitimate step's fan-out; an evicted still-open call was simply dropped, and its later unknown-outcome result then matched nothing.
- **Impact.** The Harness resumes a mission past an external, possibly non-idempotent operation whose effect nobody confirmed — the exact class of risk the C1 gate exists to prevent. This breaks the package's central promise ("a call whose outcome is unknown is never re-executed automatically").
- **Classification.** Preexisting.
- **Related, independently reproduced (C2):** the unknown-outcome hold message listed every call name; `authorize()` rejects messages over the 500-character durable diagnostic limit, so a wide fan-out threw inside `claim()` and the mission was held as `recovery-failed` — a code `resume()` cannot clear — instead of `uncertain-operations`. The human path to unblock the mission was therefore closed.

### Observations that are *not* defects (checked, documented behavior)

- `checkpoint.seq` is one below the mission change's own seq — correct: it names the last event of the *covered* prefix, i.e. the work before the checkpoint. Verified by probe (`seq = 16`, next event 17, after append 18).
- `authorize()` and `clear()` resolve without an explicit flush, yet the JSONL backend persists each batch on append; a crash-copy probe found both the authorization and the tombstone in the durable log.
- A truncated index *file* still fails loudly by design (`invalidRecords` only covers record-level damage); that is recorded as a residual limitation rather than silently swallowed.

---

## 6. Problems corrected

1. **H1** — `missionContinuityDomain` now declares `layout: 'per-record'` and `invalidRecords: 'backup-and-skip'`: each hint gets its own document, a schema-invalid hint is moved aside (`*.bak.<stamp>`, kept for inspection) with its cause logged, and the open continues. Backends that cannot move a document keep the loud path; the global slot always rejects. The startup rebuild restores the row from the session log.
2. **H2** — the sweep rotates: it starts at the cursor left by the previous sweep and advances by the number of rows it considered, wrapping once. `maxMissionsPerSweep` now bounds one sweep's *work*, and every armed mission is reached within `ceil(rows / perSweep)` sweeps. Single-flight and one-recovery-per-interruption semantics are unchanged.
3. **C1** — `MAX_TRACKED_CALLS` is 22 (2× the shipped 10-way fan-out + margin), and a call displaced from the pending window is recorded as an unknown-outcome doubt instead of being forgotten. The retained list stays bounded; an unlistable doubt is counted in `MissionProjectionState.uncertainOverflow`, exposed as `ctx.missions.uncertainOverflow(agent)`, and treated exactly like a listed call by both the sweep gate and the recovery notice.
4. **C2** — the hold diagnostic renders the total first and trims names from the end to fit `MAX_DIAGNOSTIC_LENGTH`, so the authorization is always recordable and the count a human acts on always survives.

**Proof of the fix** (mutation check, all run): reverting the source turns 9 named tests red —
`reaches a second interrupted mission while the first stays claimed`, `keeps one recovery per interrupted mission across repeated sweeps`, `survives one corrupted discovery row and still recovers the mission from its log`, `holds the mission instead of resuming past calls it could not track`, `bounds the tracked calls…`, `counts unknown outcomes it cannot forget…`, `omits optional sections and bounds long lists`, `names a doubt the bounded tracker could not list`, `renders an unknown-outcome diagnostic the durable record accepts` — and restoring the fix turns all 119 green. The end-to-end `uncertain-operations.e2e.ts` lane was re-run unchanged and passes.

---

## 7. Regression tests created

| File | What it pins |
| --- | --- |
| `tests/sweep-budget.spec.ts` (new) | A bounded sweep reaches a second interrupted mission; repeated sweeps never buy a second recovery for the same interruption |
| `tests/persistence-failure.spec.ts` | One corrupted hint no longer refuses to open: the boot proceeds, the damaged document is kept as `.bak`, the row is rebuilt from the log, and the mission is recovered |
| `tests/projection.spec.ts` | A full 10-way step is tracked; 30 unknown outcomes keep 22 listed + count the rest; the bound holds |
| `tests/durability.spec.ts` | End-to-end: a 24-call unknown-outcome step holds the mission under `uncertain-operations`, spends no attempt, queues no notice, and names the total in the diagnostic |
| `tests/units.spec.ts` | A 47-doubt diagnostic fits the durable limit, keeps the count, and names the overflow |

---

## 8. Performance and resistance results (measured, this sandbox, Node 22.22.3, 2 vCPU)

| Scenario | Measurement |
| --- | --- |
| Cold start (24 seeded missions, full sweep) | sweep **684 ms** (28.5 ms/mission incl. session resume + notice), index read **1 ms** |
| RSS delta across that sweep | **+4 MB** |
| 8 concurrent `sweep()` calls over the recovered state | **4 ms** total; all resolved `resumed: 0` (single-flight + claim guard hold) |
| Attempt accounting under that load | 24 missions, **24 attempts** — exactly one per interruption |
| Deep history: 4 002 committed events in one session, 500 fan-out steps | append **157 ms** total; `missions.get()` **<1 ms**; `checkpoint()` **56 ms** (durability flush included); pending-call window stayed at its **22** bound |
| Startup sweep rotating over 24 rows with `maxMissionsPerSweep: 1` | reaches every mission in ≤ 24 sweeps (proven by the fairness test) |

No unbounded growth, deadlock, or lost attempt was observed in any of these runs.

---

## 9. Security risks identified

- **C1 was a security-relevant integrity issue**, not just a convenience bug: it allowed the Harness to resume past an unconfirmed non-idempotent external effect. Fixed.
- **C2 closed a denial-of-recovery path**: a wide fan-out made the mission un-resumable through the normal human gate. Fixed.
- **A damaged hint previously gave a local file the power to stop the service** (H1) — a cheap local denial of availability. Fixed for record-level damage; a truncated file still fails loudly (deliberate, §14).
- Checked and found **working**: unknown outcomes are never auto-repeated; the human `resume()` gate is required; the recovery sweep never invents a provider/model (empty plan fails loud); a mission waiting for approval is held, never resumed; a second process cannot steal a session (`SessionAlreadyOwnedError` → skipped, winner's row untouched).
- **Not exercised in this environment:** real-credential handling, log redaction of provider keys, sandbox/landlock confinement, and approval-seam UI paths. Their unit suites pass (`packages/guard`, `packages/interaction`), but no adversarial run was performed here. Listed in §11.

---

## 10. Preexisting problems

H1, H2, C1, and C2 all exist on `main` @ `46df1890` and were introduced with (or exposed by) PR #16's layer. None of them is a regression from this mission. The documentation/behavior mismatch in H1 and the untested bound in C1 are the underlying causes: both were "documented intentions" that no test pinned.

---

## 11. Tests blocked by environmental limitations

| Blocked | Why |
| --- | --- |
| `oxlint` (repo lint gate) | The binary aborts in this sandbox (`panicked at oxc_allocator/src/pool/fixed_size.rs`, SIGABRT) **even on untouched packages** (`packages/util`). Not caused by these changes. |
| Full `tsc -b tsconfig.host.json` | Exceeds the sandbox heap (~1.9 GB cap, OOM at ~100 s). The affected package was typechecked directly (`tsc -b packages/mission/mission-continuity`, exit 0). |
| `pnpm install --frozen-lockfile` | `cdn.sheetjs.com` is unreachable from this sandbox; the install was completed with a temporary local override of `xlsx`, and `pnpm-lock.yaml`/`pnpm-workspace.yaml` were restored afterwards — **no lockfile change is part of this work**. |
| Web/GUI/snapshot/benchmark lanes | Not run: they require a full `pnpm run build` of host+client artifacts, which does not fit this environment. |
| External-provider behaviour (real 429/quota/timeout/malformed-stream against a live API) | No paid APIs may be consumed and no real credentials may be used. Simulated-provider coverage exists and passes (`llm-retry`, mission `model-failure.spec.ts`); a live adversarial provider run is **not tested**. |
| OmniRoute | Not present in this repository; there is no integration to test, and no second routing layer was added. |

---

## 12. Files and modules changed

```
packages/mission/mission-continuity/src/ledger.ts       H1: per-record + backup-and-skip index
packages/mission/mission-continuity/src/supervisor.ts   H2: rotating sweep; C2: bounded hold diagnostic
packages/mission/mission-continuity/src/service.ts      C1: 22-call window, overflow accounting, uncertainOverflow()
packages/mission/mission-continuity/src/types.ts        C1: uncertainOverflow projection field
packages/mission/mission-continuity/src/prompt.ts       C1/C2: notice names the overflow count
packages/mission/mission-continuity/tests/*.spec.ts     regressions (5 files touched/added)
packages/mission/mission-continuity/README.md/.zh.md    documented behavior updated (+ i18n sidecars)
.agents/notes/implemented/bug-fix/2026-11-04-mission-recovery-resilience.*   decision record (en/zh/sidecar)
docs/harness-stress-test-report.md  (this report, in the repository)
```

No unrelated refactor was performed. `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and all generated `lib/` artifacts were restored/removed before committing.

---

## 13. Commits and PR

See the pull request opened from `arena/e9e19faa-aria-repository` against `main` (single PR, described by this report). No merge, no release, no deployment was performed.

---

## 14. Still needs attention

1. **Truncated index file** still prevents boot (`StorageError: file is not valid JSON`). A backend-level "quarantine the whole unit and start empty" path is a possible follow-up; it needs a storage-domain decision, not a mission-local patch, so it was left loud on purpose.
2. **`uncertainOverflow` is derived state** and is not rebuilt from the log after a restart; a doubt whose log no longer justifies it disappears. This is the safe direction, but it means the counter is advisory.
3. **Rotation only helps explicit `sweep()` calls.** The shipped startup sweep runs once per process; a deployment with a very large index and a small `maxMissionsPerSweep` still starts only one window at boot. Either size the budget to the index or drive repeated sweeps.
4. **No exactly-once guarantee** (documented): a model may still re-issue a non-idempotent call after verification. The external system keeps the final word.
5. **Live-provider adversarial matrix not run** (429, quota exhausted, auth failure, malformed/incomplete stream, mid-stream interruption, context overflow). The seams exist and are unit-covered; an authorized run against a *sandboxed* provider remains to be done before production claims are made.
6. **Repo-wide lint/typecheck gates** must be run in a full CI environment; they could not run here.
7. **OmniRoute integration** is still unvalidated — the mission deliberately did not build a second router. The Harness's own seam (`mission/agent-setup` waterfall) is the place a router would plug in, and it is proven to *not* pick a route by itself.
8. **Human-approval and permission seams** were verified only through unit suites; no adversarial prompt-injection run against the approval seam was performed here.
