---
description: "Aria's design tokens: the graphite-and-lime palette, the type scale, the 4px spacing rhythm, radii, elevation and motion as typed data and as CSS custom properties, plus the scoped overlay that rebinds the DSH semantic aliases inside `.aria-surface`."
kind: "package-library"
---

# @deepseek-ai/dsh-aria-theme

English | [中文](README.zh.md)

## Summary

`dsh-aria-theme` gives a caller the Aria identity as values: `ARIA_PALETTE` lists every palette step with its role, `contrastRatio()` answers the WCAG ratio for any two colours, and importing the module registers the stylesheet that publishes the same values as CSS custom properties under `.aria-surface`. Use it to paint an Aria surface or to assert a contrast pair in a test; keep `@deepseek-ai/dsh-client-ui-theme` for the rest of the product. It is presentation only — no service, no configuration, no model input.

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

The Aria prototype imports it for the token sheet, and any code that must reason about the brand numerically — a contrast assertion, a documentation diagram — reads the same module. A DSH package outside the Aria tree should keep using `@deepseek-ai/dsh-client-ui-theme`; this package is a brand layer that overlays the semantic aliases, not a replacement theme service.

### Entry point

The smallest use is a contrast assertion, which needs no DOM:

```ts
import { ARIA_PALETTE, contrastRatio } from '@deepseek-ai/dsh-aria-theme'

const value = (token: string): string =>
  ARIA_PALETTE.find(step => step.token === token)?.value ?? ''

const ratio = contrastRatio(value('aria-text-500'), value('aria-ink-950'))
```

`ratio` is the WCAG 2.1 contrast ratio as a number, `7.60` for that pair. A token name that is not in `ARIA_PALETTE` yields `''`, and `contrastRatio('', …)` throws rather than returning a misleading number, so a typo fails loudly.

Styles paint only inside a surface that carries the marker class:

```tsx
<div className="aria-surface">…</div>
```

Importing the package registers the stylesheet, but every selector in it is scoped to `.aria-surface`. An element without the class keeps whatever the DSH theme gave it.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Two tiers mirror the DSH theme package. The first tier is the `--aria-*` primitives: the palette, the type scale, the 4px spacing rhythm, the radius ladder, four elevations, and three motion durations. The second tier rebinds the `--dsw-alias-*` semantic aliases that the reused `ui-primitives` atoms paint with, so a `Button`, `Input`, `Modal`, `Tag` or `Switch` keeps its own component contract and inherits the Aria look without a second component copy.

The rebinding is scoped to `.aria-surface`. The prototype puts that class on its own root and, while mounted, on `<body>`, because portalled overlays — the ui-primitives `Modal` and the prototype's drawer — mount under `document.body` and would otherwise paint in DSH default colours. The class leaves `<body>` on unmount.

| File | Owns |
|---|---|
| `src/tokens.ts` | `ARIA_PALETTE`, `ARIA_STATUS`, `ARIA_RADII`, and the `hexToRgb` / `relativeLuminance` / `contrastRatio` helpers. |
| `src/css/tokens.css` | The same values as CSS custom properties, the semantic role aliases, and the `.aria-surface` block that rebinds the `--dsw-*` names; the build copies it to `lib/tokens.css`. |
| `src/index.ts` | The public surface and the stylesheet import. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Aria visual identity and interface prototype](../../../docs/ARIA-VISUAL-IDENTITY.md) — the measured contrast table and the reasoning behind each token.
- [@deepseek-ai/dsh-client-ui-theme](../../client/ui-theme/README.md) — the DSH theme service this layer overlays.
- [@deepseek-ai/dsh-client-ui-primitives](../../client/ui-primitives/README.md) — the atoms whose aliases this package rebinds.
- [@deepseek-ai/dsh-aria-wordmark](../../aria/wordmark/README.md) — the brand artwork that consumes the accent.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package only publishes CSS custom properties and palette data for browser rendering; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The layer is complete for a dark theme only, and it is a stylesheet rather than a runtime theme service.

- **No light values.** The structure is ready for one — components read role aliases, not palette steps — but no light palette exists, so a consumer cannot request it.
- **No runtime switching.** A surface opts in by carrying `.aria-surface`; there is no config field, no persisted preference and no per-user selection.
- **Two sources, kept in step by hand.** The palette exists as typed data and as CSS custom properties, so a change lands in both files.
- **Not published.** The package is a workspace member outside the dsh release sequence and is consumed from source.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`contrastRatio()` is the implementation the reproduction table in the visual-identity page is measured with. When a token changes, re-measure the pairs that name it and update both language sides rather than adjusting prose.

</details>
