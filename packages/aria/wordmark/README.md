---
description: "Aria's brand artwork as React components: the geometric A mark, the square symbol plate, the Montserrat wordmark in product and capital case, the sidebar lockup, and the application icon, all drawn from one exported geometry."
kind: "package-library"
---

# @deepseek-ai/dsh-aria-wordmark

English | [中文](README.zh.md)

## Summary

`dsh-aria-wordmark` renders the Aria identity at any size: `AriaMark` draws the bare geometric A, `AriaSymbol` places it on the square plate, `AriaWordmark` sets the name, `AriaLockup` composes symbol and name for a header, and `AriaAppIcon` draws the installable icon. Every component is SVG with no runtime dependency beyond React, and `ARIA_MARK_GEOMETRY` exports the path data so a future icon pipeline can redraw the same shape. Importing the module registers the brand stylesheet.

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

The Aria prototype's rail header uses `AriaLockup`, and the documentation brand sheet renders all five exports. Reach for this package when a surface needs the Aria mark or name; reach for `@deepseek-ai/dsh-aria-theme` when it needs the colours those marks are drawn in. For the product's own identity — DeepSeek's, not Aria's — keep `@deepseek-ai/dsh-client-ui-brand-official`.

### Entry point

```tsx
import { AriaLockup, AriaSymbol } from '@deepseek-ai/dsh-aria-wordmark'

<AriaLockup tagline="Operational intelligence" />
<AriaSymbol size={40} />
```

The lockup renders a 26px symbol, a 15px wordmark and the tagline in the plate's own muted tone; `compact` drops the wordmark and tagline for a 56px rail. Every component is `aria-hidden` and decorative: the name is set as SVG text, so a caller that needs the brand announced supplies its own accessible label, which is what the prototype's rail button does.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One construction, five compositions. The mark is a 24-unit grid: a tapered portal `M10.6 2.7H13.4L19.2 21.3H4.8Z` with its apex cut flat, closed by the ground line and crossed by one lintel `M7.6 14.4H16.4` at 0.86× the body weight. `square` caps and `miter` joins keep the corners architectural. At 16px and below the body stroke widens from 1.75 to 2.3 so the aperture stays open; the plate variant raises both weights by the same threshold (`2.5` and `2.15`).

`AriaSymbol` insets a 24-unit rounded rect by 0.6 and either fills it with the accent and draws the mark in ink (`tone: 'plate'`, the default) or strokes the plate in `currentColor` and draws the mark in the same colour (`tone: 'outline'`). `AriaAppIcon` translates the same paths to `25 25`, scales them 3.25 on a 128-unit canvas and rounds the plate at 12.5, so the icon is the mark at icon weight rather than a separate drawing.

| File | Owns |
|---|---|
| `src/index.tsx` | The geometry constants and the five components; imports `brand.css` for their side effect. |
| `src/brand.css` | The lockup and wordmark stylesheet: layout of the symbol, name and tagline, plus the Montserrat stack; the build copies it to `lib/brand.css`. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Aria visual identity and interface prototype](../../../docs/ARIA-VISUAL-IDENTITY.md) — the rationale for the mark's construction and the brand sheet.
- [@deepseek-ai/dsh-aria-theme](../../aria/theme/README.md) — the palette these drawings use.
- [@deepseek-ai/dsh-client-ui-brand-official](../../client/ui-brand-official/README.md) — the product's own brand occupants, which this package does not replace.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package renders decorative SVG for a browser surface and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The artwork is complete for browser rendering; shipping it as standalone assets is not.

- **No standalone SVG files.** The glyphs are React components, so an installer, a favicon or a documentation site that is not a React app cannot consume them without rendering first.
- **Wordmark needs the brand face.** The name is set in Montserrat, which `brand.css` names; a host that loads neither the DSH brand font nor a Montserrat webfont falls back to its system sans.
- **The components are decorative.** They carry no accessible name, so each caller must label the control that contains them.
- **Not published.** The package is a workspace member outside the dsh release sequence and is consumed from source.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

A hand-traced letter outline was attempted and rejected: Montserrat was already shipped and looked better at every size. Keep the mark as the only bespoke drawing — adding a traced wordmark would put two drawing systems in one identity. `ARIA_MARK_GEOMETRY` exists so an icon export can regenerate the same shape instead of re-tracing it.

</details>
