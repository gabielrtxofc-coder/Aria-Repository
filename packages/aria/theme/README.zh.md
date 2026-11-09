---
description: "Aria 的设计令牌：石墨色加青柠的调色板、字阶、4px 间距节奏、圆角、高度与动效，既可作类型化数据也可作 CSS 自定义属性，并包含在 `.aria-surface` 内重绑 DSH 语义别名的局部覆盖层。"
kind: "package-library"
---

# @deepseek-ai/dsh-aria-theme

[English](README.md) | 中文

## Summary

`dsh-aria-theme` 以取值形式把 Aria 识别交给调用方：`ARIA_PALETTE` 列出每个调色板档位及其角色，`contrastRatio()` 给出任意两色的 WCAG 比值，而导入本模块会注册样式表，把同一组值以 CSS 自定义属性发布在 `.aria-surface` 之下。用它绘制 Aria 表面，或在测试中断言一对对比度；产品其余部分仍用 `@deepseek-ai/dsh-client-ui-theme`。它只负责呈现——没有服务、没有配置、没有模型输入。

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

Aria 原型导入它获取令牌表；任何需要以数值方式推理品牌的地方——对比度断言、文档图示——读同一个模块。Aria 目录之外的 DSH 包应继续使用 `@deepseek-ai/dsh-client-ui-theme`；本包是叠加语义别名的品牌层，而不是主题服务的替代。

### Entry point

最小的用法是对比度断言，不需要 DOM：

```ts
import { ARIA_PALETTE, contrastRatio } from '@deepseek-ai/dsh-aria-theme'

const value = (token: string): string =>
  ARIA_PALETTE.find(step => step.token === token)?.value ?? ''

const ratio = contrastRatio(value('aria-text-500'), value('aria-ink-950'))
```

`ratio` 是 WCAG 2.1 对比度比值，该组合为 `7.60`。不在 `ARIA_PALETTE` 中的令牌名返回 `''`，而 `contrastRatio('', …)` 会抛出错误而不是返回一个误导性的数字，因此拼写错误会立刻失败。

样式只在带有标记类的表面内生效：

```tsx
<div className="aria-surface">…</div>
```

导入本包会注册样式表，但其中每个选择器都限定在 `.aria-surface` 之下。没有该 class 的元素保持 DSH 主题赋予的样式。

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

两层结构对应 DSH 主题包。第一层是 `--aria-*` 原语：调色板、字阶、4px 间距节奏、圆角阶梯、四处高度与三条动效时长。第二层重绑复用 `ui-primitives` 原子所绘制的 `--dsw-alias-*` 语义别名，使 `Button`、`Input`、`Modal`、`Tag` 或 `Switch` 保持自身的组件契约并继承 Aria 外观，而无需第二套组件副本。

重绑限定在 `.aria-surface` 内。原型把该 class 放在自身根元素上，并在挂载期间放到 `<body>` 上，因为被传送的浮层——ui-primitives 的 `Modal` 与原型抽屉——挂在 `document.body` 之下，否则会以 DSH 默认配色绘制。卸载时该 class 会从 `<body>` 移除。

| 文件 | 负责 |
|---|---|
| `src/tokens.ts` | `ARIA_PALETTE`、`ARIA_STATUS`、`ARIA_RADII`，以及 `hexToRgb`、`relativeLuminance`、`contrastRatio` 辅助函数。 |
| `src/css/tokens.css` | 同一组值作为 CSS 自定义属性、语义角色别名，以及重绑 `--dsw-*` 名称的 `.aria-surface` 区块；构建时复制到 `lib/tokens.css`。 |
| `src/index.ts` | 公开接口与样式表导入。 |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Aria 视觉识别与界面原型](../../../docs/ARIA-VISUAL-IDENTITY.zh.md) —— 实测对比度表与每个令牌的取舍理由。
- [@deepseek-ai/dsh-client-ui-theme](../../client/ui-theme/README.zh.md) —— 本层所覆盖的 DSH 主题服务。
- [@deepseek-ai/dsh-client-ui-primitives](../../client/ui-primitives/README.zh.md) —— 其别名被本包重绑的原子。
- [@deepseek-ai/dsh-aria-wordmark](../../aria/wordmark/README.zh.md) —— 消费强调色的品牌图形。

-----

<a id="model-experience"></a>
## Model Experience

None, as the package only publishes CSS custom properties and palette data for browser rendering; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

本层只为深色主题完成，且它是样式表而非运行时主题服务。

- **没有浅色取值。** 结构已为浅色就绪——组件读取角色别名而非调色板档位——但不存在浅色调色板，调用方无法请求。
- **没有运行时切换。** 表面通过携带 `.aria-surface` 选择加入；没有配置字段、没有持久化偏好、没有按用户选择。
- **两份来源，需手工保持一致。** 调色板既是类型化数据也是 CSS 自定义属性，改动需落到两个文件。
- **未发布。** 本包是 dsh 发布序列之外的工作区成员，从源码消费。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

视觉识别页面中的复现表以 `contrastRatio()` 实测。令牌变更时，重新测量提及它的组合并更新两个语言版本，而不是调整散文。

</details>
