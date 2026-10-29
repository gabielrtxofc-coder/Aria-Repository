---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-27-llm-model-fallback

English | [中文](2026-10-27-llm-model-fallback.zh.md)

## Summary

Adds the `llm/model-switched` and `llm/model-fallback-exhausted` Session event types.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-27-llm-model-fallback
baseline: false
changes:
  - root: "event:llm/model-fallback-exhausted"
    previous: null
    after: "5ec3cfab7b8fa276770aa156e6da80d70d44859361ff734b8c38f1d5c9f544b3"
    decision: same-version
  - root: "event:llm/model-switched"
    previous: null
    after: "b5d3ea31d045363f33aaaee00cfca7f1b193e162bfa293b5bc65468102af2f07"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Both are new log-only event types with no surface effect and no place in derived messages, so a Session written before this change reads exactly as before and a Session that contains them keeps every earlier record interpretable. An older reader that does not know the types refuses the log with `SessionFormatUnsupportedError` instead of silently dropping recovery records, which is the required-feature refusal path the compatibility rules allow for same-version additions.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/llm/llm-model-fallback: 40 tests passed, including a restart suite that resumes a paused task from the JSONL backend; pnpm run verify-persistence-changes reports both roots as acknowledged same-version additions.

<a id="dev-note"></a>
## Dev Note

None.
