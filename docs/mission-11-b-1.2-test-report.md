# Mission 11 — B-1.2 frozen uncertainty scope

**Date:** 2026-11-06
**Base:** PR #18 head `2b79f9d365e2b5e12b64b2e90571b0bf9d5fc16b`
**Working branch:** `arena/6c66c879-aria-repository`
**Status:** implementation and package validation complete; no commit, push, merge, or PR update has been made yet.

## Correctness change

An `uncertain-operations` authorization now stores the exact review interval `(from, through]`, the identities actually included in its bounded diagnostic, and an `unlisted` count for everything represented only by the aggregate. The authorization and nested scope are runtime-frozen as well as readonly in TypeScript. `resume()` validates and acknowledges only the saved interval; outcomes recorded after the hold remain pending for a new authorization. The message and scope are captured synchronously before the authorization event is appended, which orders a concurrent result wholly before or after that durable event.

Replay validates the watermark and transition against event order. Projection state version 3 forces a rebuild of cached states. A legacy authorization with the exact historical `N recorded` diagnostic is reconstructed from the count at its event-log position; an unrecognized legacy message remains unscoped and cannot acknowledge uncertainty. The previous H1/H2/C1/C2 and L-1 behavior was not weakened.

## Validation results

| Check | Result |
| --- | --- |
| Mission-continuity unit suite | **150 passed, 0 failed** (14 files) |
| Package-scoped coverage (`src/**`) | **100% statements, branches, functions, and lines** |
| Mission-continuity project typecheck | **passed** (`tsc -b packages/mission/mission-continuity/tsconfig.json`) |
| H1/H2/C1/C2 named regressions | **9/9 passed** |
| B-1 acknowledgement adversarial suite | **12/12 passed** |
| L-1 / fan-out suite | **11/11 passed**, including 10-, 30-, and 40-call successful fan-outs and unknown-result overflow cases |
| SIGKILL process-restart E2E | **1/1 passed** when run directly |

Commands used for the package checks:

```sh
corepack pnpm exec vitest run packages/mission/mission-continuity/tests
corepack pnpm exec vitest run --coverage --coverage.include='packages/mission/mission-continuity/src/**' packages/mission/mission-continuity/tests
corepack pnpm exec tsc -b packages/mission/mission-continuity/tsconfig.json
corepack pnpm exec vitest run packages/mission/mission-continuity/tests/uncertainty-acknowledgement.spec.ts
corepack pnpm exec vitest run packages/mission/mission-continuity/tests/wide-fanout-calls.spec.ts
corepack pnpm exec vitest run --config vitest.e2e.config.ts packages/mission/mission-continuity/tests/restart-process.e2e.ts
```

The nine H1/H2/C1/C2 tests were selected by their names from `sweep-budget.spec.ts`, `persistence-failure.spec.ts`, `projection.spec.ts`, `durability.spec.ts`, and `units.spec.ts`. The B-1 cases cover later doubts, new authorization, fan-out overflow and result order, rebuild/restart, legacy records, and a result racing with `resume()`.

## Failure-before / success-after evidence

A controlled mutation temporarily restored the prior open-ended behavior: `resume()` acknowledged the current result count instead of the count captured when authorization was presented, and replay accepted that broader acknowledgement. With that behavior deliberately reintroduced, the late-result regression failed as intended: **expected acknowledgement 1, received 2**. The temporary mutation was restored immediately. The same targeted test then passed against the fixed implementation, followed by the full 150-test package suite and the 100% package coverage gate. This is a behavioral mutation check, not a claim that a live provider or external service was exercised.

## E2E limitation

The complete command

```sh
corepack pnpm exec vitest run --config vitest.e2e.config.ts packages/mission/mission-continuity
```

was also attempted. Its SIGKILL process-restart test passed, but the full lane had **3 failures and 4 passes** because the filtered dependency install did not produce several generated host entry files (for example `lib/typert.host.js`); the boot-level tests reported those missing modules as plugin import failures. The isolated SIGKILL E2E passed without relying on those missing boot artifacts. A full workspace build was not run to manufacture them. No live-provider credentials or paid API calls were used.

Coverage here is intentionally scoped to the mission-continuity package. A full-workspace coverage run and full host build/typecheck are not claimed by this report.
