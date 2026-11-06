# Agent Note: 任务恢复能抵御损坏的提示索引、受限的扫描配额与宽扇出

Status: implemented

[English](2026-11-04-mission-recovery-resilience.md) | 中文

## 问题

`dsh-mission-continuity` 承诺了三件事，但代码并未做到；每一处故障都先复现、后修复。

**损坏的提示索引会让整个组装无法启动。** 发现索引原本是严格的 `single` 布局 domain，`open()` 会校验每一条已存储的行，遇到第一条不符合 schema 的行就拒绝整个 domain。因此一条损坏的行——截断写入、介质恢复或手工编辑——会让任务服务根本无法激活，即便作为权威的 session 日志仍完整保存着每个任务。索引文件被截断时，底层存储后端也会同样失败。该包自己的文档写明：丢失索引损失的是发现能力，而不是任务状态；启动路径与文档相互矛盾。

**受限的扫描会让之后的所有任务长期得不到恢复。** `maxMissionsPerSweep` 的文档含义是一次扫描考虑的候选数。而扫描总是从第一条 armed 行开始，所以一旦 supervisor 认领了首条任务，之后每次扫描都会把全部配额耗在重新检查同一份认领上并报告 `skipped`。在 `maxMissionsPerSweep: 1` 下，只要第一个任务仍在运行，第二个被中断的任务就永远不会被恢复——用三个任务、四次扫描复现：`s1` 存活，`s2` 与 `s3` 缺席。

**宽扇出会隐藏未知的外部结果。** 为恢复提供输入的投影最多跟踪 16 个 pending 工具调用，而 agent loop 默认并发派发 10 个，单步还可能合法地更多。当一步启动的调用数超过窗口容量时，最早的调用会在结果到达前被挤出窗口；这些结果随后匹配不到任何调用，`uncertainOperations` 为空，启动扫描便越过一个无人确认过的外部副作用继续执行。用 20 个调用复现：记录到的疑点为 0。同一条路径上还有另一个独立复现的缺陷：hold 诊断会列出每个调用名，而 `authorize()` 会拒绝超过持久化 500 字符诊断上限的消息，于是一次宽扇出在认领过程中抛错，任务被以 `recovery-failed` 挂起——这个代码无法通过 `resume()` 清除——而不是 `uncertain-operations`。

## 决策

索引是可丢弃的派生数据，因此 domain 现在如实声明：`layout: 'per-record'` 让每条提示拥有独立文档，`invalidRecords: 'backup-and-skip'` 将无法读取的提示移走并记录原因，而不是拒绝整个 domain。无法移动文档的后端仍保持失败即报错的路径；global 槽位始终拒绝。随后的启动重建会从 session 日志恢复该行，普通扫描即可恢复任务。

扫描改为轮转。每次扫描从上次留下的游标开始，并按本次考虑的行数前进，最多环绕一次，因此 `maxMissionsPerSweep` 限制的是一次扫描的工作量，而不是 supervisor 究竟能触及哪些任务：同一索引下，每个 armed 任务都会在 `ceil(rows / perSweep)` 次扫描内被触及。`ledger.list()` 按首次写入顺序返回，因此轮转是稳定的。

跟踪器容纳完整一步。`MAX_TRACKED_CALLS` 为 22——即既有 10 路扇出的两倍再加余量——被上限挤出的调用不再被遗忘：它被记录为结果未知的疑点，因为没有已提交结果的调用可能、也可能没有改变外部世界。保留列表仍然有界，因此无法列出的疑点计入 `MissionProjectionState.uncertainOverflow`；`ctx.missions.uncertainOverflow(agent)` 将其暴露，扫描的判定与恢复通知都把非零计数视同列出的调用。hold 诊断现在先渲染总数，并从末尾裁剪名称以适配持久化上限，因此人需要处理的数量始终保留。

## 备选方案

**保持严格索引并失败即报错。** 对权威数据这是诚实的默认做法，storage-domain 对其他所有 domain 的默认行为也未改变。但在此处是错的：拥有者已声明日志是权威并已从中重建行，因此拒绝启动会把可恢复的提示丢失变成全面瘫痪。

**改为 per-record 但仍拒绝。** 仅 `per-record` 只能把影响限制在一个文件，schema 失败仍会拒绝整个 domain。两者都需要；备份让损坏的字节留待检查而不是被删除。

**每次扫描都从起点重新开始窗口。** 简单，也正是缺陷成因。把“已认领”的行排序到列表末尾也可行，但会每次扫描重写索引并失去首次写入稳定性。

**静默丢弃被挤出的 pending 调用但不设上限。** 取消上限会让长时间并行 session 的投影无界增长，而投影缓存必须承载它。计数溢出既保留上限也保留了疑点。

**让模型自行解决疑点。** 恢复不得越过一个未确认的非幂等调用；由 `ctx.missions.resume` 记录的人类决定才是拥有该权限的接缝，通知则告诉模型需要核实哪些调用。

## 影响

回归覆盖位于 [durability](../../../../packages/mission/mission-continuity/tests/durability.spec.ts)、[persistence-failure](../../../../packages/mission/mission-continuity/tests/persistence-failure.spec.ts)、[projection](../../../../packages/mission/mission-continuity/tests/projection.spec.ts)、[units](../../../../packages/mission/mission-continuity/tests/units.spec.ts) 以及新增的 [sweep-budget](../../../../packages/mission/mission-continuity/tests/sweep-budget.spec.ts) 套件；每一项都已确认在修复前的源码上失败。uncertain-operations 端到端通道原样重跑通过。

轮转只在显式调用 `sweep()` 时生效；随进程启动的扫描每次启动只运行一次，因此部署应依据索引规模来调 `maxMissionsPerSweep`，而不是寄望于重试。溢出计数是派生状态：重启后不会从日志重建，日志已不再支持的溢出会正常恢复任务。两者都是安全方向——丢失的计数器会再问人类一次，丢失的任务则不会回来。
