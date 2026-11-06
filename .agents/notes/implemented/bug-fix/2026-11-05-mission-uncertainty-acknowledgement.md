# Agent Note: An uncertainty review covers the doubts it saw, and a displaced call is only an open call

Status: implemented

English | [中文](2026-11-05-mission-uncertainty-acknowledgement.zh.md)

## Problem

Two defects remained in `dsh-mission-continuity` after the wide fan-out was bounded (see
[the previous note](2026-11-04-mission-recovery-resilience.md)). Both were reproduced against the
unmodified source of that change before either was fixed.

**An acknowledgement was a session-wide pardon.** A human decision about an unknown outcome was
stored as one marker on the *disposable discovery row* — `lastError.code = 'uncertain-acknowledged'`
— and `supervisor.claim()` skipped the whole uncertainty gate while that marker was present. The
marker named no call and counted nothing, so two things followed. A mission whose operations became
uncertain *after* the review resumed with no second question: work continued past an external effect
nobody had confirmed. And because the marker lived only on the row, any rewrite of the row — above
all the index rebuild that reconstructs rows from the session log — decided afresh what a human had
already answered. The record of the permission had become the permission, in a component whose own
documentation says the index is derived data and the log is the authority.

**An open call was remembered as a doubt.** The pending-call window holds 22 identities, and the
projection recorded a doubt for every call the window had to drop — at the moment it dropped it, while
the call was merely *open*. The result path then returned the state unchanged whenever the identity
was no longer in the window, so that doubt could never be retracted. A step with more than 22
concurrent calls therefore ended with permanent doubts attached to calls that had completed
successfully, which held the mission for a human to review nothing. This fired in ordinary operation,
and more often in exactly the wide, long missions recovery exists to serve.

## Decision

The review is a fact about the mission, so it is recorded with the mission: `MissionSnapshot.uncertainAcknowledged`
counts how many unknown outcomes the last review covered, is folded from the session log, and can
never shrink — `fold.ts` rejects a mutation that narrows the mark or drops it, which also catches a
writer that loses the field silently. `resume()` writes the mark as `max(previous, recorded)`, and
still writes the row marker, but only as a diagnostic: no gate consults it any more.

The gate and the service ask one pure function what is still outstanding. `unacknowledgedUncertainty(operations,
unlisted, acknowledged)` in `src/uncertainty.ts` subtracts the covered prefix from the recorded doubts
and reports the rest, keeping what the bounded window could not name in `unlisted`. A mark outside
`[0, recorded]` clears nothing, so a state that does not correspond to a real review cannot release
work. The function depends on no service and no runtime, so both callers share one arithmetic without
importing each other.

Counting displaced calls stays *counting*, on the same projection state: `MissionProjectionState.pendingOverflow`
is the number of open calls the window does not hold, incremented when a call is displaced and
decremented when a result arrives for an identity the window no longer lists. A doubt is recorded only
when the committed result itself says the outcome is unknown. No second registry of open calls was
introduced — one bounded window, one count beside it, and the same strict fold on both the live path
and the replay path. Cached projection state moves to `stateVersion: 2`, so a state folded before this
change is discarded and re-read from the log rather than trusted.

## Alternatives considered

**Keep the marker and add the acknowledged identities to it.** A list of cleared `callId`s looks
precise, but two classes break: a doubt the window could not name can never be named in a clearance,
so it would block forever; and evicting an acknowledged identity from a bounded list would re-open
work a human already cleared. A monotonic count is invariant to how the window bounds and evicts.

**Retract a doubt when a definite result arrives for its identity.** Rejected. A recorded unknown
outcome is a fact of the log, and clearing it because *some* later result with the same identity looked
normal would erase a confirmed doubt. Only the count of still-open calls may be settled this way.

**Track open calls in a second bounded list.** Rejected on the mission's own instruction and on merit:
a second list needs its own displacement rule, which is the bug class we were fixing. A count needs no
rule of its own — it is decremented by the same event that would have removed the entry.

**Re-block by resetting the mark when a new doubt appears.** Rejected: the mark must survive any
ordering of writes and rebuilds, and resetting it on each new doubt would let the *model* move a
human's decision by producing more work.

## Consequences

[uncertainty-acknowledgement](../../../../packages/mission/mission-continuity/tests/uncertainty-acknowledgement.spec.ts)
holds the acknowledgement scenarios, including one that crosses a process boundary and rebuilds the
recovery index from disk; [wide-fanout-calls](../../../../packages/mission/mission-continuity/tests/wide-fanout-calls.spec.ts)
drives the real agent loop at 10, 30 and 40 simultaneous calls and pins the fold-level orderings a
bounded window produces. Thirteen of the seventeen tests added here fail against the pre-fix source;
the four that pass are deliberate controls (a step narrow enough to fit the window, the rule that a
recorded unknown outcome is never retracted, an unmatched result settling nothing, and the diagnostic
budget fixed earlier). The package runs 136 unit tests at 100% statement, branch and function coverage
per source file, and the end-to-end lane that kills a live mission process with `SIGKILL` stays 7/7.

A review covers the *most recent* N recorded doubts rather than a chosen subset, so a partial review of
a huge fan-out asks again about the oldest ones — the conservative direction, and visible in the hold
message, which states the total before any name. Because `tool/call` may repeat an identity, a duplicate
displaced call can inflate the recorded total by one and cost one extra review; nothing is released
early by it. The imprecision inherited from the bounded window also remains: when a displaced call
settles while an older named doubt is still outstanding, the names in one hold message can be off by
one position. Counts stay exact, and the next review realigns them.
