---
description: "持久化任务服务：让任务归属于 Aria 而非某一个模型——状态存于会话日志，恢复索引先与日志核对，重启后自动继续，无需新的用户消息。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mission-continuity

[English](README.md) | 中文

## 概述

`dsh-mission-continuity` 让任务归属于 Aria，而不是归属于某一个模型。任务（mission）是一条持久记录——目标、完成标准、计划、已完成与待办步骤、运行时上下文、工具结果、变更文件、中断原因，以及最后一个一致检查点——以 `mission/change` 事件提交到所属会话日志，因此它可以跨越单轮失败、模型失败乃至整个进程重启。一个小的存储域索引记录哪些会话持有可恢复的任务；它只是线索，每次恢复都会与日志核对，绝不作为第二个事实来源。启动时一次有界的扫描会自动恢复被中断的任务：重新激活目标、排队一条 `<mission_recovery …>` 通知说明发生了什么，并交由既有目标续跑驱动进入下一轮，全程不需要新的用户消息。恢复过程从不选择 provider 或模型——它通过 `mission/agent-setup` 瀑布询问组合层——也从不绕过权限：等待审批的任务会被挂起，而不会被恢复。当工作需要跨越单个模型的可用性时选择它；一次性、无需状态的请求不需要它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

请在目标栈（`dsh-goal`、`dsh-goal-round-driver`）、会话日志与投影服务以及存储域之后挂载 `dsh-mission-continuity`。它注册 `ctx.missions` 与 `mission` 会话投影，并在 `sweepOnStartup` 为真（默认）时启动恢复扫描。

只有当组合层说明如何组合 Agent 时，恢复才能续接它。请通过 `mission/agent-setup` 监听器给出这个答案——随包提供的 `@deepseek-ai/dsh-mission-continuity/default-agent-plan` 插件用宿主的默认模型选择（`ctx.agentDefaultModel`）作答；若某个 profile 想要别的路由，只需在此之后注册自己的监听器，它的答案生效：

```ts
ctx.on('mission/agent-setup', async (request, next) => ({
  ...await next(request),
  agentOptions: { provider: 'my-provider', model: 'my-model' },
}))
```

空的方案会用持久会话续接而不带 provider 与模型选项，于是第一次请求就会明确失败，而不会去猜一条路由。这种失败会把恢复行留在 `held` 并附上诊断，而不是丢失任务。

配置：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `sweepOnStartup` | `true` | 组合启动时执行恢复扫描。 |
| `defaultMaxRecoveryAttempts` | `3` | 未指定预算的任务所用尝试次数上限（1–100）。 |
| `maxMissionsPerSweep` | `32` | 单次扫描可考虑的候选数量（1–1000）。连续扫描会在索引中轮转，因此该上限限制的是一次扫描的工作量，而不是能触及哪些任务。 |
| `rebuildIndexOnStartup` | `true` | 启动扫描前依据会话日志重建缺失的索引行。 |
| `maxRebuildSessions` | `64` | 一次重建在查找未知任务时读取的已存会话上限（1–10000）。 |

服务接口为 `ctx.missions.{get, plan, uncertainOperations, start, checkpoint, recordAttempt, authorize, resume, clear, sweep}`。每次修改都要求精确的 `{ id, revision }`，若其他写入者先行推进则以 `MISSION_STALE_REVISION` 失败；`start`、`checkpoint` 与 `recordAttempt` 在返回前会等待所属会话的 `ctx.sessions.flush`，因此成功的 `start` 就是可恢复的任务，已记录的步骤在继续工作之前就已持久化。如果记录无法持久化，`start` 会撤下自己的记录、删除索引行、阻塞目标并抛出 `MISSION_PERSISTENCE_FAILED`，会话不会留下一个调用方被告知并不存在的任务。

<a id="understand-the-implementation"></a>
## 理解实现

三个部分协作：

- **持久记录。** `mission/change` 携带修改之后的完整任务记录（或一个 `clear` 墓碑）。它只写入日志：任何投影重建、分叉或恢复都不得把只被部分解释的任务当作当前任务，且折叠会拒绝任何无法接续既有状态的变更——没有当前任务却做修改、改变身份、跳过版本、检查点后退或尝试次数减少。
- **发现索引。** 一张存储域表映射 `missionId → { sessionId, goalId, revision, attempts, state, lastError }`。只有当自动恢复可以在没有人工介入的情况下认领任务时，`state` 才是 `armed`。每次写入之后都会与日志核对；与所属会话不一致的行会被结算，而不会被信任。索引永远不是事实来源，因此启动时会读取索引未提及的会话日志，并依据每条持久记录重建相应的行——受 `maxRebuildSessions` 限制，跳过目标已完成的任务，介质不可读时则软化失败。
- **监督器。** `sweep()` 读取 `armed` 行，把每个会话解析为一个活动 Agent（已存在的意味着上一轮失败，新续接的意味着进程消失），然后认领任务。认领会结算已完成的任务，挂起被禁用、等待审批或目标缺失的任务，把恢复预算耗尽记录为目标阻塞，否则消耗一次尝试、排队恢复通知并重新激活目标。扫描是单飞、单次有界且轮转的：每次扫描从上一次停止处开始并最多环绕一次，因此即使排在前面的候选是本 supervisor 已经恢复过的任务，每个 `armed` 任务也会在 `ceil(rows / maxMissionsPerSweep)` 次扫描内被触及。销毁时停止认领并释放所有被持有的 Agent。

两条规则保证一次中断只换来一次恢复。如果某个候选的持久记录仍与该监督器已经支付过一次尝试的状态完全相同，则报告为 `skipped`：重复扫描不会消耗第二次尝试、不会写入第二条通知，也不会重新恢复本进程已持有的工作。如果某个候选的会话由另一个活实例持有，同样会跳过，并且不改动它的索引行，使持有者的尝试计数与通知保持唯一。

恢复与模型路由刻意解耦。Aria 拥有任务、目标、计划以及“发生过什么”的记录；网关或 profile 决定下一个请求由哪个 provider 和模型服务。因此任务进行中切换路由属于重新规划，而不是任务丢失——下一次尝试读取的仍是同一份持久状态。

<a id="further-exploration"></a>
## 延伸阅读

- [同会话目标](../../goal/goal/README.zh.md) — 任务所持久化并重新激活的目标。
- [目标轮次驱动](../../goal/goal-round-driver/README.zh.md) — 接纳下一个自动轮次的循环。
- [会话](../../core/session/README.zh.md) — 作为持久权威的日志。
- [任务连续性子系统](../../../docs/subsystems/mission-continuity.zh.md) — 记录字段与恢复决策表。

<a id="model-experience"></a>
## 模型体验

被恢复的任务会用由持久记录渲染出的一条用户消息唤醒模型：

```text
<mission_recovery mission="mission-…" revision="7" attempt="2" interruption="process-restart">
The previous attempt stopped before it finished the mission objective …
Objective: …
Completion criteria: …
Completed steps: …
Pending steps: …
Last consistent checkpoint: session event 42.
Operations whose outcome is unknown: call-17 (bash). Verify the external state before repeating them.
Resume from the last consistent step. Do not repeat work already recorded as complete.
</mission_recovery>
```

通知是有界的：过长的步骤与操作列表会被截断并给出数量。它告诉模型哪些工作已经完成、哪些调用在重复之前必须先核对，因此续接的轮次会继续推进，而不是从头再来。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **未知结果需要人工。** 若任务的某个调用被中断且没有持久结果，任务会以 `uncertain-operations` 代码被挂起而不是恢复，并将该疑问记录为待授权。清除该授权（`ctx.missions.resume`）后，下一次扫描会带着列出这些调用的通知恢复任务；重建索引会忘记这次确认并再次询问，这是安全的方向。
- **没有恰好一次语义。** 结果未知的调用（`TOOL_OUTCOME_UNKNOWN`）永远不会被 Aria 重新执行，但模型仍可能再次发出非幂等调用。任务会记录这一不确定性并要求核对；最终事实以外部系统为准。
- **恢复无法凭空造出路由。** 如果没有 `mission/agent-setup` 的答案，续接的会话会明确失败，其恢复行被挂起。跨模型变更的自动恢复以部署方仍服务该任务的模型、或指定替代模型为前提。
- **审批仍然受控。** 等待授权的任务会被挂起；扫描绝不会续接它。
- **续接依赖目标栈。** 监督器重新激活目标；真正运行下一轮的是 `dsh-goal-round-driver`。缺少它时，被恢复的任务要等到下一个轮次。
- **索引不是权威。** 删除索引只会丢失发现能力，不会丢失任务状态：启动时会依据日志重建它能够证成的行，重建无法触及的会话仍可手动恢复。索引被声明为可丢弃的派生数据（`per-record`、`invalidRecords: 'backup-and-skip'`），因此单条无法读取的提示会被移走并记录原因，而不是拒绝整个 domain 并让组装停止；被截断的索引*文件*仍会在存储后端明确报错，而日志始终是回去的路径。

<a id="dev-note"></a>
## 开发备注

测试会在临时持久目录上挂载真实组合（会话、投影、存储、目标、目标轮次驱动以及脚本化 LLM 适配器）；重启覆盖包含一个子进程测试，它用 `SIGKILL` 杀死正在运行任务的进程并在新进程中恢复该任务。运行方式为 `pnpm exec vitest run packages/mission/mission-continuity`，崩溃测试为 `pnpm exec vitest run --config vitest.e2e.config.ts packages/mission/mission-continuity/tests/restart-process.e2e.ts`。启动流程的覆盖以两个进程通过生产配置加载器启动随包发布的 `headless` 配置（`base` 与 `headless` 两个 bundle）：第一个进程创建任务、持久写入检查点，并在模型请求仍未结束时被 `SIGKILL` 杀死；第二个进程使用同一个 `DSH_HOME` 与相同的默认配置启动，不发送任何消息，也不调用任何恢复 API，仍必须恰好恢复该任务一次。配套用例以 `sweepOnStartup: false` 启动同一世界，任务必须保持原样不被触碰。两者都使用仅替换模型路由的无密钥覆盖层，运行方式为 `pnpm exec vitest run --config vitest.e2e.config.ts packages/mission/mission-continuity/tests/mission-startup.e2e.ts`。第三个用例在 `start()` 解析完成的瞬间杀死进程——没有检查点、没有显式 flush、没有轮次——并要求下一次启动恢复该 start 所承诺的内容。同一套件也在构建产物通道（`DSH_EXAMPLE_MODE=lib`）中运行，每个子进程都会报告它实际解析到的入口，因此证明展示的是它执行了 `lib/` 产物。`uncertain-operations.e2e.ts` 覆盖被中断的外部操作：一个模拟的非幂等工具向进程之外的文件追加记录，崩溃发生在任何结果持久化之前，启动必须挂起而不是恢复；人工清除挂起后只恢复一次，通知会点名该调用，而外部文件仍然只有一条效果记录。本包要求逐文件 100% 覆盖率。
