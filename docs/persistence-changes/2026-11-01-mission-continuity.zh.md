---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-01-mission-continuity

[English](2026-11-01-mission-continuity.md) | 中文

## 概述

新增仅写入日志的 `mission/change` 会话事件及其 `mission` 消息来源。任务记录以修改后的完整快照（或清除墓碑）提交，因此重放、分叉与恢复读取的是目标、完成标准、计划、中断、检查点与尝试次数的唯一权威副本。`mission` 来源变体出现在用户消息、开发者消息、Agent 收件箱与标题请求的消息联合类型中，因为恢复通知就是一条归属于某个任务版本与尝试序号的普通用户消息。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

`mission/change` 在读取时为必需：旧版本会拒绝包含它的会话日志，而不是盲目重放任务，这正是驱动自主工作的状态所需要的失败关闭方向。新读取方接受不含该事件的日志：缺失即表示当前没有任务，所有投影都从空折叠状态开始。新增的 `mission` 来源变体位于开放联合类型之内，因此旧读取方对其他来源的解析保持不变，新读取方也能保留历史含义；旧版本不认识的来源种类仅作为归属信息，永不改变消息正文。

<a id="verification"></a>
## 验证

`tsx scripts/gen-persistence-catalog.ts --check` 与重新生成的目录对及 schema 快照一致。`pnpm exec vitest run packages/mission/mission-continuity` 覆盖折叠对非法序列的拒绝（无当前任务的修改、身份变化、跳过版本、检查点后退、尝试次数减少）、重放失败的抑制、挂载时拒绝损坏行，以及用 SIGKILL 杀死正在运行任务的进程并在新进程中恢复的子进程重启测试。

<a id="dev-note"></a>
## 开发备注

无。
