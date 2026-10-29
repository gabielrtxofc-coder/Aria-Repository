---
description: "面向必须让打开的 agent 步骤在所选用路由无法服务它时继续存活的组合的模型路由回退执行器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-model-fallback

[English](README.md) | 中文

## 概述

挂载 `@deepseek-ai/dsh-llm-model-fallback`，当当前路由无法服务时，让打开的 agent 步骤在另一个已配置的模型上继续。配额、计费、重试耗尽以及显式选择加入的认证失败，会按链路顺序切换到下一个已注册、具备能力且尚未尝试的候选；暂时性上限先交给重试策略处理。每次切换都是一条持久的 `llm/model-switched` 记录，恢复后的路由会跨后续轮次与重启继续生效，而不可用的链路让任务停在其持久历史上，而不是丢失已完成的工作。候选资格覆盖保留对话真正需要的东西——输入模态、对话中途的系统提示与工具声明、剩余上下文容量，以及所请求的推理强度——切换记录在重试请求发出之前就已确认落盘，部署也可以选择加入「恢复会话时不等待新的用户消息即继续被中断或暂停的任务」。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当长任务必须比单一模型路由活得更久时挂载本插件。任务属于 harness 而非模型：对话、工具结果与打开的步骤都留在会话日志中，由本插件决定由哪条路由继续它们。

### 何时选择

当组合已经挂载 agent loop（智能体循环），且部署能够提供至少一条替代路由时选择它——第二个提供方、第二份凭证，或同一提供方下更便宜的模型。只有一条路由时跳过：空 `chain` 会让每次失败都成为终态，而不添加任何可能改变行为的监听器。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-llm-model-fallback'
  config:
    chain:
      - provider: deepseek
        model: deepseek-chat
      - provider: openrouter
        model: deepseek/deepseek-chat
        reasoningEffort: low
    switchOn: [quota, billing, unavailable, transient]
    maxSwitchesPerTurn: 2
    # Opt-in autonomous continuation on resume.
    resumeInterruptedTurns: false
    maxRecoveryAttempts: 1
```

`chain` 是偏好顺序且必填；每一项包含 `provider`、它的 `model`，以及可选的、由适配器拥有的 `reasoningEffort`，用来替换失败请求的推理强度。`switchOn` 默认是 `transient`、`unavailable`、`quota` 与 `billing`；`auth` 需要显式选择加入，因为损坏的凭证属于配置缺陷而不是路由故障。`maxSwitchesPerTurn` 默认为链长，因此一个轮次尝试的替代路由数不会超过其配置的路由数。

加载期拒绝是刻意的：未知键、空的提供方或模型、重复路由、空的或未知的 `switchOn` 类别，或负的切换额度，都会让插件加载失败，而不是为一个期待恢复的部署静默禁用恢复。

`resumeInterruptedTurns`（默认 `false`）让恢复的会话继续一个被中断、或因链路耗尽而暂停的任务，而不等待新的用户消息；`maxRecoveryAttempts`（默认 `1`）限制最后一条人类消息之后允许的自动继续轮次数。两者在已交付产品中都保持关闭：恢复的会话通常轮到用户说话，Web 或 SDK 表层不得在未被要求的情况下消耗 token。

### 你可以观察到什么

每次切换追加一条非表层 `llm/model-switched` 事件，携带切换标识、轮次与步骤、失败类别及其序列化的提供方失败、失败路由、被选中的路由，以及在它之前被拒绝的每个已配置候选。下一个请求头会记下被选中的路由，因此 transcript（文本记录）仅凭日志即可重建。当没有可用候选剩下时，插件为每个失败步骤追加一条 `llm/model-fallback-exhausted` 事件，并让失败保持终态：轮次以其原始提供方错误结束，会话保留已完成的步骤以供之后恢复。

切换还会为该 agent 记录一条恢复路由：提示词装配、请求路由与请求头都描述实际使用的路由，因此模型切换提示绝不会宣告一个 harness 并未调用的模型。一旦入口点选择了另一条路由，恢复路由即让位——用户的后续选择绝不会被静默改写。

### 失败与恢复

分类优先信任提供方规范化的事实，其次才是措辞，顺序是：显式 code（`AUTH`、`INVALID_CREDENTIAL`、`BILLING`、`QUOTA`、`RATE_LIMIT`、`CONTEXT_WINDOW_EXCEEDED` 等），然后是 HTTP 状态，最后才是没有独立 code 的提供方配额措辞。因此被拒绝的凭证不会仅因为消息里出现「配额」就变成配额切换。暂时性 code 与状态（`RATE_LIMIT`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE`、408、429、5xx）先委派下游：重试策略拥有同路由重试，本插件只在该策略拒绝该失败后才行动。配额与计费状态、配置后的 `AUTH`，以及部署映射到可切换类别的未知 code，会转向下一个候选。

只有在以下条件全部成立时，候选才可用：其提供方已在本进程中注册、其确切模型能通过所属适配器解析、它在当前轮次中尚未失败过，且它能重现保留对话所需的一切：声明的输入模态（带图像的任务绝不会落到纯文本路由上）、历史中已携带的对话中途系统提示与工具声明、足以容纳已测输入加上本次请求输出上限的上下文容量，以及该候选将被调用时使用的推理强度。单个不兼容的候选绝不会终止搜索——扫描会沿链路继续——并且每次拒绝都以原因写入切换记录，因此运维人员可以看清链路为何跳过某条路由。

### 持久化与重启

在重试请求发出之前，插件会等待会话的 `session/flush` 持久化检查点：切换记录必须是下一个进程可以读取的字节，而不是等待批量窗口的追加。若 flush 被拒绝，插件会报告该失败并继续在进程内恢复；检查点失败时，插件绝不会声称该记录已持久化。

折叠状态保留了入口路由、它最近替换掉的路由、本回合已尝试的路由、切换计数、暂停的步骤、链路结束的原因、已观测的输入规模，以及自动继续的次数，因此重启会重现原始路由决策——包括实际在用的推理强度，而不是链路配置的默认值。之后的 `model/selection` 或命名另一条路由的请求头会解除恢复路由，因此用户的选择总是优先。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本章说明执行器是如何构建的；可观察的行为已在[使用本包](#use-this-package)中完整说明。

### 设计原则

三条规则塑造了本插件。**下游优先：** 失败作为 waterfall（瀑布式事件）抵达 `agent/request-error`，因此在之后挂载的恢复监听器——重试策略——会在路由切换发生之前做出决定。**持久先于可见：** 切换在重试运行之前先成为会话事件与投影折叠，因此决策与重试请求之间的崩溃不会重复任何步骤。**每个路由决策只有一个所有者：** 插件只记录一次恢复路由并交给 `ctx.modelRouting`，而不是改写入口点的模型选择。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件：配置 schema 与策略、持久投影，以及请求恢复监听器 |
| [`src/classification.ts`](src/classification.ts) | 把提供方无关的失败分类为切换类别 |
| [`src/selection.ts`](src/selection.ts) | 候选资格：注册状态、模型元数据、调用形状、上下文容量与推理强度 |
| [`src/state.ts`](src/state.ts) | `llmModelFallback` 投影折叠及其读取的持久状态 |
| [`src/continuation.ts`](src/continuation.ts) | 对失去归属者的任务的可选自动继续 |
| [`src/route.ts`](src/route.ts) | 已配置路由的词汇，以及单条路由贡献的选择 |
| [`src/types.ts`](src/types.ts) | 持久事件负载、失败类别与拒绝原因 |

### 恢复流程

失败的尝试带着服务它的提供方、轮次、步骤与该轮次的中止信号抵达。监听器先委派下游恢复，如果其他监听器已安排重试就返回，随后检查失败类别是否在 `switchOn` 中。它读取已配置的请求头以命名失败路由，读取持久状态以取得切换额度与本轮次已尝试的路由，并按链路顺序解析候选。若有目标，它追加 `llm/model-switched`、记录路由覆盖，并返回 `{ kind: 'retry' }`；loop 从会话表层重建同一步骤，因此没有用户消息、工具调用或工具结果被重复。若无目标，它每个步骤追加一次 `llm/model-fallback-exhausted` 并返回空值，让失败保持终态。

### 持久状态

`llmModelFallback` 投影折叠：`turn/start`（重置每轮次的尝试列表与切换计数）、`llm/model-switched`（替换路由、它所代表的入口路由、它最近替换掉的路由，并把两个端点都加入尝试列表）、`llm/model-fallback-exhausted`（暂停的步骤与链路结束的原因）、`assistant/message` 的用量（已观测的输入规模）、`user/message` 的来源（本进程已做过的自动继续次数），以及命名另一条路由的 `request/header` 或 `model/selection`（清除替换）。由于该折叠是投影，恢复的会话会从上一个进程结束时的路由开始，而 `previous` 端点让多步切换继续替换入口路由，而不是退回它。

### waterfall 与插件顺序

该监听器期望运行在提供方重试策略的上游：它调用下游链，并且只在该链拒绝时才行动。在本插件之后挂载较新重试策略的组合会继承这一顺序；永不结算的策略同样会阻止切换与轮次完全停稳。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够时，阅读以下页面。

- [dsh-llm 服务](../llm/README.zh.md) —— 本插件按其路由的提供方无关服务。
- [llm-retry](../llm-retry/README.zh.md) —— 拥有同路由恢复的请求重试执行器。
- [Agent 模型选择](../../core/agent/README.zh.md) —— `ctx.modelRouting` 与入口点选择的路由。
- [持久化目录](../../../docs/persistence-catalog.zh.md) —— `llm/model-switched` 与 `llm/model-fallback-exhausted` 的生成记录。

-----

<a id="model-experience"></a>
## 模型体验

### 路由切换后的模型请求重放

#### 模型看到什么

重试请求携带与失败尝试相同的表层历史：已接纳的用户消息、assistant 的工具调用及其结果，没有摘要也没有占位符。插件不添加自己的提示词文本，也不添加 `user` 或 `developer` 消息；`llm/model-switched` 与 `llm/model-fallback-exhausted` 是仅写入日志的记录，绝不进入派生消息。因此替代路由会读到由失败模型产生的先前轮次，而不会被告知这些轮次来自哪个模型。

#### Token 影响

切换本身不添加任何请求 token。每次重试尝试都是对同一份保留历史的新提供方请求，因此替代路由会为失败路由已经计费过的上下文再次计费自己的输入 token；包含多次尝试的切换链会按每次尝试重复这笔输入成本。

#### KV Cache 影响

重试请求在原路由的规则下保留相同的消息前缀；替代路由有自己的缓存，因此那里的首次请求是缓存未命中。之后切换到第三条路由会重复该未命中，而仅写入日志的切换记录不改变任何缓存标识。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明执行器在哪里停止、由未来工作接续。它们是当前包约束，不是通用回退对比。

- **替代模型不会被告知路由已改变**——切换会被记录，请求头也记下新路由，但没有任何模型可见提示说明先前的 assistant 轮次来自另一个模型；需要该披露的部署自行拥有提示词文本。
- **同路由重试不归本包所有**——暂时性失败先抵达重试策略，因此没有该策略的组合会在首次暂时性失败时切换，且永不重试原始路由。
- **只有已声明的能力会限制候选**——资格判断把适配器元数据与保留对话比较；不报告模态列表、上下文窗口或调用形状支持的适配器仍算可用，而上下文检查需要上一次响应测得的输入规模。
- **自动继续是可选、有界且默认关闭的**——开启 `resumeInterruptedTurns` 后，恢复的会话会自行继续被中断或暂停的任务，且最多在最后一条人类消息之后继续 `maxRecoveryAttempts` 次；保持关闭的部署只会得到持久暂停，不会得到更多。任何产品都不得把该默认值读作自动恢复。
- **工具副作用只做对账，harness 绝不重放**——崩溃修复为从未记录结果的调用写下未知结局，继续提示要求模型在重试前先核对外部状态。这属于重复*抑制*，不是恰好一次执行：模型若重新发出非幂等调用，仍可能重复其副作用。
- **切换按轮次限量**——`maxSwitchesPerTurn` 统计的是切换次数而不是失败请求数，且计数器在 `turn/start` 时重置，因此长任务可以在下一个轮次再次用满额度。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：维护者备注与开放问题。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 插件从持久投影而不是内存计数器读取切换额度，因此恢复的进程不会超出每轮次预算，同一轮次的回放也会重现相同决策。
- `model/selection` 通过事件名匹配而不是导入入口点包：回退包不得依赖它从不挂载的控制器。
- 候选解析通过所属适配器解析确切的模型元数据，这是唯一知道某条路由是否接受图像、对话中途系统提示或推理强度的地方。
- 自动继续挂在 `agent/created` 且 `source === 'resume'` 上；它既不是定时器，也不是新消息路径，这正是它能在 Agent 发布之前运行、而交付默认值仍将其关闭的原因。
- 持久化检查点复用 `ctx.sessions.flush`——会话存储拥有的唯一 flush 入口，而不是直接派发 `session/flush`。

</details>
