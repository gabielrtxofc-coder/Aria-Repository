---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-01-mission-continuity

English | [中文](2026-11-01-mission-continuity.zh.md)

## Summary

Adds the log-only `mission/change` Session event and its `mission` message source. A mission record is committed as a full post-mutation snapshot (or a clear tombstone) so replay, fork, and resume read one authoritative copy of objective, criteria, plan, interruption, checkpoint, and attempts. The `mission` source variant appears in the user-message, developer-message, agent inbox, and title-request message unions because a recovery notice is an ordinary user message attributed to a mission revision and attempt number.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-01-mission-continuity
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-05-working-directory-attribution"
    after: "8005c378b327f9069c2d7d1d1009314205c89b48608d4e6e81c78b65afdf2a11"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "b69d4c282389a988850ea3d74280c61a1bf013fcc4bbaf5cb7ec5976c642a824"
    decision: same-version
  - root: "event:mission/change"
    previous: null
    after: "a84485b7b74e38fa6dd4679e3b65cbfe5ffbd5fa847f75ea1db42bc85613aed3"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-07-title-reasoning-effort"
    after: "1a1e57d00353277a8a271dd878958150ca3427075f0ac20f6119745ad4765544"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "046efc68bf9ec31bf07b86e8ec172f5131b65e89b2d8e59d520c3c4a69a98f8c"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

`mission/change` is required on read: an older build refuses a session log containing it rather than replaying a mission blindly, which is the intended fail-closed direction for state that drives autonomous work. New readers accept logs without the event: absence means no mission is current, and every projection starts from the empty fold state. The added `mission` source variant is additive inside open unions, so older readers keep interpreting other sources unchanged and new readers preserve historical ones; a source kind an older build does not know stays attribution-only and never changes message text.

<a id="verification"></a>
## Verification

`tsx scripts/gen-persistence-catalog.ts --check` matches the regenerated catalog pair and schema snapshot. `pnpm exec vitest run packages/mission/mission-continuity` covers fold rejection of impossible sequences (mutation without a current mission, identity change, skipped revision, backward checkpoint, decreasing attempts), replay failure containment, corrupt-row refusal at mount, and the subprocess restart test that SIGKILLs a live mission process and recovers it in a new one.

<a id="dev-note"></a>
## Dev Note

None.
