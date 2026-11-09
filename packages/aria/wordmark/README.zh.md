---
description: "Aria 的品牌图形，以 React 组件形式提供：几何 A 标记、方形符号底板、Montserrat 字标的产品与大写两种字形、侧边栏组合，以及应用图标——全部由同一份导出几何绘制。"
kind: "package-library"
---

# @deepseek-ai/dsh-aria-wordmark

[English](README.md) | 中文

## Summary

`dsh-aria-wordmark` 可在任意尺寸下渲染 Aria 识别：`AriaMark` 画出裸几何 A，`AriaSymbol` 把它放到方形底板上，`AriaWordmark` 排印名称，`AriaLockup` 为页头组合符号与名称，`AriaAppIcon` 绘制可安装图标。每个组件都是 SVG，除 React 外没有运行时依赖，而 `ARIA_MARK_GEOMETRY` 导出路径数据，未来的图标流水线可据此重绘同一形状。导入本模块会注册品牌样式表。

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

Aria 原型的导航栏头部使用 `AriaLockup`，文档品牌图版渲染全部五个导出。某处界面需要 Aria 的标记或名称时使用本包；需要绘制它们所用的颜色时使用 `@deepseek-ai/dsh-aria-theme`。产品自身的识别——DeepSeek 的而非 Aria 的——仍用 `@deepseek-ai/dsh-client-ui-brand-official`。

### Entry point

```tsx
import { AriaLockup, AriaSymbol } from '@deepseek-ai/dsh-aria-wordmark'

<AriaLockup tagline="Operational intelligence" />
<AriaSymbol size={40} />
```

组合渲染 26px 符号、15px 字标与底板自身柔和色调的标语；`compact` 去掉字标与标语，供 56px 窄栏使用。所有组件都是 `aria-hidden` 的装饰性图形：名称以 SVG 文本绘制，因此需要被朗读的调用方须自带无障碍标签——原型导航栏按钮正是这样做的。

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

一套构造，五种组合。标记位于 24 单位网格：一个收窄的拱门 `M10.6 2.7H13.4L19.2 21.3H4.8Z`，顶端平截，由地面线闭合，并被一条 `M7.6 14.4H16.4` 的楣线以主体 0.86 倍粗细横穿。`square` 端点与 `miter` 接头保持棱角建筑感。16px 及以下主体笔画从 1.75 加粗到 2.3，使开口保持通透；底板变体在同一阈值下把两者都抬高（`2.5` 与 `2.15`）。

`AriaSymbol` 把 24 单位的圆角矩形内缩 0.6，或用强调色填充并以墨色绘制标记（`tone: 'plate'`，默认），或以 `currentColor` 描出底板并用同色绘制标记（`tone: 'outline'`）。`AriaAppIcon` 把同一组路径平移至 `25 25`、在 128 单位画布上缩放 3.25，并把底板圆角设为 12.5，因此图标是图标粗细的标记，而不是另一幅画。

| 文件 | 负责 |
|---|---|
| `src/index.tsx` | 几何常量与五个组件；为副作用导入 `brand.css`。 |
| `src/brand.css` | 组合与字标样式表：符号、名称与标语的布局，以及 Montserrat 字族；构建时复制到 `lib/brand.css`。 |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Aria 视觉识别与界面原型](../../../docs/ARIA-VISUAL-IDENTITY.zh.md) —— 标记构造的理由与品牌图版。
- [@deepseek-ai/dsh-aria-theme](../../aria/theme/README.zh.md) —— 这些图形使用的调色板。
- [@deepseek-ai/dsh-client-ui-brand-official](../../client/ui-brand-official/README.zh.md) —— 产品自身的品牌占位组件，本包不替代它们。

-----

<a id="model-experience"></a>
## Model Experience

None, as the package renders decorative SVG for a browser surface and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

图形在浏览器渲染层面已完整；作为独立资产分发尚未完成。

- **没有独立 SVG 文件。** 图形是 React 组件，因此安装程序、网站图标或非 React 的文档站点必须先渲染才能使用。
- **字标需要品牌字族。** 名称以 Montserrat 排印，由 `brand.css` 指定；既未加载 DSH 品牌字体、也未加载 Montserrat 网络字体的宿主会回退到系统无衬线体。
- **组件是装饰性的。** 它们不携带无障碍名称，每个调用方须为包含它们的控件加标签。
- **未发布。** 本包是 dsh 发布序列之外的工作区成员，从源码消费。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

曾尝试手工描摹字母轮廓并放弃：Montserrat 已经随附，且在任何尺寸下都更好看。让标记成为唯一的定制绘制——再加一套描摹字标会让一套识别里出现两套绘制体系。`ARIA_MARK_GEOMETRY` 的存在是为了让图标导出能重建同一形状，而不是重新描摹。

</details>
