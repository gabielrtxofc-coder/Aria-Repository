---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-27-llm-model-fallback

[English](2026-10-27-llm-model-fallback.md) | 中文

## 概述

新增 `llm/model-switched` 与 `llm/model-fallback-exhausted` 两个 Session 事件类型。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

两者都是仅写入日志的新事件类型，不产生可见内容，也不进入派生消息，因此在此变更之前写入的 Session 读取结果完全一致，而包含这两个事件的 Session 仍能解释此前全部记录。不了解这两个类型的旧读取方会以 `SessionFormatUnsupportedError` 拒绝该日志，而不是静默丢弃恢复记录；这正是兼容性规则允许的同版本新增所要求的必备特性拒绝路径。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/llm/llm-model-fallback：40 个测试通过，其中包含从 JSONL 后端恢复暂停任务的重启套件；pnpm run verify-persistence-changes 将两个根均报告为已确认的同版本新增。

<a id="dev-note"></a>
## 开发备注

无。
