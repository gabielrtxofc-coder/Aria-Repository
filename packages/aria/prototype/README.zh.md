---
description: "Aria 的演示界面：在 DSH 原子组件之上实现的总览、任务、智能体、知识、活动与设置六个界面，使用从不触达任何服务的固定数据——是设计与交互原型，不是产品界面。"
kind: "package-library"
---

# @deepseek-ai/dsh-aria-prototype

[English](README.md) | 中文

## Summary

`dsh-aria-prototype` 以 React 组件 `AriaPrototype` 渲染 Aria 的六个界面——总览、任务、智能体、知识、活动与设置——底层是包内的演示工作区。挂载它以评审识别与交互模型，或运行独立预览走完各条流程。它渲染固定数据、只修改本地状态、不调用任何服务；它是原型，且每个界面都如此声明。架构与证据见视觉识别页面。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

在没有后端的情况下评审 Aria 识别、六界面信息架构与交互契约——抽屉、筛选、新建任务流程——时使用它。不要把它当作产品界面：它不注册 Cordis 插件、不拥有 Session，若不先在真实数据上写适配层，无法作为面板挂入 DSH 外壳。

### Entry point

```tsx
import { AriaPrototype } from '@deepseek-ai/dsh-aria-prototype'

<AriaPrototype />
```

组件渲染整个界面并自带哈希路由，因此不需要路由器。挂载期间它为 `<body>` 添加 `aria-surface`，卸载时移除，这正是其传送式浮层能继承 Aria 令牌的原因。若要在无宿主时评审，从仓库根目录运行预览：

```sh
pnpm --filter @deepseek-ai/dsh-aria-prototype run preview
```

预览绑定 `0.0.0.0:5273`，并把两个 Aria 包别名到源码，因此无需构建步骤。

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

本包只负责呈现。`model.ts` 声明展示类型——工作区、任务、步骤、智能体、集合、资源、活动条目——`fixtures.ts` 填充一份 `DEMO_WORKSPACE`；真实接入用适配层替换固定数据，无需改动任何界面。`routes.ts` 解析与格式化哈希路由，因此详情视图（`#/missions?mission=…`）可被链接并在刷新后保持。`locales/en.ts` 是唯一字典，`translate()` 是唯一取值入口。

各界面从 `components/primitives.tsx` 导入原子组件，那是通向 `ui-primitives` 的唯一接缝；该接缝读取 `src/atoms.ts`，后者从源码文件而非包总出口导入六个原子与符号集，因此依赖图中不会混入 markdown 或语法高亮依赖。

| 路径 | 负责 |
|---|---|
| `src/App.tsx` | 状态归属：演示工作区、选中项、筛选、反馈，以及抽屉与模态框宿主。 |
| `src/shell/Shell.tsx` | 导航栏及其折叠与移动端浮层、顶栏、跳转链接。 |
| `src/screens/*` | 每个界面一个文件，各自带有模块样式表。 |
| `src/components/*` | 面板、记录、状态标记、控件、抽屉、模态框、反馈，以及空/加载词汇。 |
| `preview/` | 独立 Vite 入口：`index.html`、`main.tsx` 与别名配置。 |
| `tests/prototype.spec.tsx` | 覆盖真实组件的十一个 jsdom 交互测试。 |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Aria 视觉识别与界面原型](../../../docs/ARIA-VISUAL-IDENTITY.zh.md) —— 品牌、令牌、界面、交互模型与验证证据。
- [@deepseek-ai/dsh-aria-theme](../../aria/theme/README.zh.md) —— 各界面绘制所用的令牌层。
- [@deepseek-ai/dsh-aria-wordmark](../../aria/wordmark/README.zh.md) —— 导航栏头部的组合标识。
- [@deepseek-ai/dsh-client-ui-primitives](../../client/ui-primitives/README.zh.md) —— 接缝背后的原子组件。
- [@deepseek-ai/dsh-client-ui-layout](../../client/ui-layout/README.zh.md) —— 本外壳所映照的三栏框架。

-----

<a id="model-experience"></a>
## Model Experience

None, as the package renders a demonstration interface over in-package fixtures and mutates only local component state; it registers no plugin, performs no request, and contributes nothing to model context.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

原型作为设计产物已经完整，并有意识地止步于产品界面之外。

- **仅演示数据。** 工作区、任务、智能体、集合与活动条目都是固定数据；会话中创建的任务存在于 React 状态中，刷新即消失，对话框、横幅与界面提示都写明这一点。
- **没有宿主集成。** 本包不注册 Cordis 插件、不拥有 Session、不读取任何服务；接入意味着在展示类型上写适配层，并把真实导航路由进外壳。
- **设置为视觉呈现。** 没有任何控件写入配置，Models、Memory 与 Security 分区按设计只读。
- **单一主题、单一语言。** 仅深色、仅英文；令牌层可以承载浅色主题，但未定义任何浅色取值。
- **指派控件只暂存一个标记。** 它演示该交互而不假装触达后端，并在抽屉中说明。
- **未发布。** 本包是 dsh 发布序列之外的工作区成员，从源码消费。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`src/atoms.ts` 是承重的那层间接：导入 `ui-primitives` 总出口会拖入原型根本不渲染的 markdown、diff 与语法高亮模块，而源码模式检出未必安装了它们的依赖。新增原子必须同时加在那里与 `components/primitives.tsx`，两份清单都必须与各界面实际导入的一致。

</details>
