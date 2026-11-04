# Agent Note：并发任务恢复——单一会话所有者，不存在崩溃路径

Status: implemented

[English](2026-11-03-mission-recovery-concurrency.md) | 中文

## 问题

任务连续性会在启动时自行恢复被中断的任务：[`MissionSupervisor.start()`](../../../../packages/mission/mission-continuity/src/supervisor.ts) 扫描持久化发现索引，并对每个已武装的候选调用 `ctx.agents.resume`。针对同一会话的第二次尝试可能同时存在——另一个共享同一 `DSH_HOME` 的 `dsh` 进程、来自 API 网关的请求驱动 `agents.resume`、配置声明的 `resumeSessionId` 启动，或重复的 sweep。

在测试 harness 内的复现产生了该重叠导致的 `SessionAlreadyOwnedError`，并且该错误被报告为逃逸到进程级别并终止了进程。这一说法从未与生产路径关联，因此本记录说明代码与测试实际表明了什么，以及审阅者可以依赖其中哪些路径。

## 决定

**重叠是真实的；未捕获则不是。** `SessionAlreadyOwnedError` 是一种*稳定的拒绝*，而不是缺陷，并且每个生产调用方都会捕获它。此处未发现任何生产路径能让它到达进程级处理器，因此为此未改动代码——缺口在证明，而不在行为。

### 错误从何而来

三个独立的所有权边界可以拒绝第二次尝试，且三者都抛出同一个错误名：

1. **进程内写占用。** [`claimWrite`](../../../../packages/session/session-persistence-jsonl/src/storage.ts) 会在触碰任何持久化产物之前，拒绝本进程已持有 id 的第二次写打开。
2. **内核写租约。** [`SessionWriteLease.acquire`](../../../../packages/session/session-persistence-jsonl/src/lease.ts) 针对另一进程的持有者在 `session.lock` 上获取非阻塞 `flock(2)`；争用映射为同一错误。进程死亡时内核会释放它，因此崩溃的持有者永远不会阻塞后继者。
3. **Agent 注册表冲突。** [`agents.enter`](../../../../packages/core/agent/src/index.ts) 是权威的发布边界：两次准备都可能成功，但只有确切的一个 id 能发布。

跨进程场景不需要 supervisor 级别的串行化：租约就是仲裁者，且由内核释放，而不是靠协作。

### 为什么生产进程不会因此终止

- **sweep 已经防护了它。** [`ownedElsewhere`](../../../../packages/mission/mission-continuity/src/supervisor.ts) 将该拒绝转换为 `skipped` 结果：不消耗尝试、不写恢复通知、失败方不写索引。胜者的行保留其尝试计数与通知，因此共享同一 home 的两个进程绝不会重复计入一次中断。
- **API 网关会转换它。** [`resolve`](../../../../packages/api/session-controller/src/agent.ts) 将同一个名字映射为 `RemoteError('session/writer-held')`，`Commands.rejectCreation` 对创建也做同样处理。该拒绝成为 RPC 应答，而不是拒绝。
- **配置声明的启动恢复会报告它。** [`AgentLoop.resumeWith`](../../../../packages/core/agent-loop/src/index.ts) 先取得写所有权，因此与活跃所有者冲突的启动通道会被拒绝；构造函数路径会将其汇入 `agent-loop/config-start-failed` 加一条警告。已针对真实的第二进程租约用探针验证：`failures` 持有 `SessionAlreadyOwnedError`，未触发 unhandled rejection，且启动上下文保持活跃。
- **进程守卫是真实的，但不在此路径上。** [`installFailLoud`](../../../../packages/boot/app-boot/src/index.ts) 会把任何逃逸的拒绝变成 `exit(1)`。它只会看到调用方未能 await 的错误；上述四个调用点都会 await 或捕获。
- **supervisor 自身的 await 不会因监听器抛出。** 后台工作是 `void` 加 `.catch`（目标对账）；启动 promise 由 `Service.init` 消费。

无需缺陷即可触达的是：对已被本进程持有写占用的会话执行 sweep 结果是 `skipped`，因此恢复可能被活跃所有者**延迟**，但绝不会丢失——该行保持 `armed`，后续 sweep 会认领它。并发套件断言的是这种"绝不丢失"性质，而不是固定的胜者，因为两种交错都是合法的。

### 唯一未防护的调用方，以及它为何不是生产

`packages/mission/mission-continuity/tests/fixtures/mission-uncertain-child.ts` 调用 `ctx.agents.resume` 时没有 `try`。今天它是安全的，仅因为该路径上 `ctx.agents.get(sessionId)` 为 `undefined`——要么启动未恢复，要么 `held` 模式已提前返回。它以 `sweepOnStartup` 开启运行，因此该证明依赖 sweep 在人工路径恢复之前出于*任务*原因（不确定的操作，或待处理的授权）而拒绝。这正是其 fixtures 所安排的，但这是仅测试内的不变量，故意不加防护，使双重恢复显式失败而非被吞掉。

## 证据

`packages/mission/mission-continuity/tests/concurrency.spec.ts` 驱动真实 AgentLoop、带内核租约的真实 JSONL 后端、真实目标域与真实任务服务，仅模型路由为脚本化。覆盖五个要求场景的九个用例：

| 场景 | 用例 | 断言 |
| --- | --- | --- |
| 1——自动恢复 | 启动时 sweep，无消息、无 API 调用 | 会话被拥有，一次尝试，一条持久化通知 |
| 2——第二次尝试 | 被拥有时重复 sweep；第二个组合；原始并发 `agents.resume` | `skipped`，一次尝试，失败方不留 Agent，拒绝是具名错误 |
| 3——两个实例 | 双方并发 sweep；失败方仍可用 | 恰好一个 `resumed`，一个活跃所有者，一条通知，一行索引 |
| 4——恢复期间的 resume | sweep 与外部 resume 同时发出；恢复后 resume | 不崩溃、不双重恢复、任务绝不丢失、一条通知 |
| 5——所有权失败 | 另一组合取得租约；随后释放 | `skipped` 且不消耗尝试、不写 `hold`；后继者恢复 |

该包的套件总计：11 个文件，112 个测试。两项 built-bin 证明（`mission-startup.e2e.ts`、`uncertain-operations.e2e.ts`）在源码通道通过；built（`DSH_EXAMPLE_MODE=lib`）通道仅由 CI 确立，见下文。

## 考虑过的替代方案

**用 `try` 保护测试 fixture 中未加防护的 `agents.resume`。** 已否决：那会让该证明中的双重恢复变为静默跳过，削弱了这个必须显式失败的唯一位置。该 fixture 的真正不变量是该路径上不存在活跃 Agent。

**在恢复周围增加 supervisor 或服务级互斥锁。** 已否决：内核租约已在跨进程层面仲裁所有权，且进程内 sweep 是单飞的。第二把锁会引入自身的失效模式，并掩盖拒绝而不是报告 `skipped`。

**在 `recover()` 中捕获所有失败并报告为跳过。** 已否决：真正的失败（产物丢失、损坏、不可用的计划）必须成为带诊断的 `recovery-failed` 挂起，而这正是当前防护对它们故意不做的事。

**在并发证明中 fork 第二个操作系统进程。** 已否决：跨进程主张依赖内核租约，已由会话后端的两进程套件证明；fork 的 mission 证明只会增加数分钟子进程成本而不带来新不变量。

**为 `skipped` 的恢复计入一次尝试。** 已否决：失败方并未执行恢复，计入它会把任务预算花在一个什么都没做的进程上，并可能耗尽健康的 mission。

## 后果

并发风险以*记录并测试*的方式关闭，而非行为变更：审阅本工作的审阅者应将 `skipped` 读作对争议会话的设计应答，并且不应期望两个进程共享同一任务。

仍然开放、且不在本次变更之内：

- 本分支的 `node 24 / snapshots and artifacts` 中的 `built-bin smoke` 门禁尚未运行。三个必需的 Linux 作业（`static`、`coverage`、`snapshots and artifacts`）与三个原生 Windows 作业在 `dsh-ubuntu-24-04-16core` / `dsh-windows-2025-16core` 标签上排队且无 runner 被分配，而同一次运行中的托管作业正常执行。预期的补救措施是已记录的、写入者级别的 `DSH_CI_FAILOVER_LINUX` 开关（设为 `selfhosted` 或 `blacksmith`），分支无法设置它；在该门禁真正执行之前，built 通道的证明仍未确认。
- 并发证明通过 `fiber.state` 断言组合的存活性，而不是 fork 进程。跨进程主张依赖内核租约与两进程租约套件，那才是它应在之处；fork 变体只会增加成本而不带来新覆盖。
- 此处的工具链无法本地产出 built 通道：沙箱在完整工作区构建时 OOM，且无法访问 `cdn.sheetjs.com`。这是环境限制，不是对门禁的主张。
