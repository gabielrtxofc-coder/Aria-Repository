---
description: "Aria's demonstration interface: the Overview, Missions, Agents, Knowledge, Activity and Settings screens on the DSH atoms, with fixtures that never reach a service — a design and interaction prototype, not a product surface."
kind: "package-library"
---

# @deepseek-ai/dsh-aria-prototype

English | [中文](README.zh.md)

## Summary

`dsh-aria-prototype` renders Aria's six screens — Overview, Missions, Agents, Knowledge, Activity and Settings — as a React component, `AriaPrototype`, over an in-package demonstration workspace. Mount it to review the identity and the interaction model, or run the standalone preview to walk the flows. It renders fixtures, mutates only local state, and calls no service; it is a prototype, and every screen says so. The architecture and evidence live in the visual-identity page.

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

Use it to review the Aria identity, the six-screen information architecture and the interaction contract — drawers, filters, the new-mission flow — without a backend. Do not use it as a product surface: it registers no Cordis plugin, owns no Session, and cannot be mounted into the DSH shell as a panel without an adapter over real data.

### Entry point

```tsx
import { AriaPrototype } from '@deepseek-ai/dsh-aria-prototype'

<AriaPrototype />
```

The component renders the whole interface and owns its own hash routing, so it needs no router. It adds `aria-surface` to `<body>` while mounted and removes it on unmount, which is what lets its portalled overlays inherit the Aria tokens. To review it without a host, run the preview from the repository root:

```sh
pnpm --filter @deepseek-ai/dsh-aria-prototype run preview
```

The preview binds `0.0.0.0:5273` and aliases the two Aria packages to their sources, so it needs no build step.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is presentation only. `model.ts` declares the presentation types — workspace, mission, step, agent, collection, resource, activity entry — and `fixtures.ts` fills one `DEMO_WORKSPACE`; a real binding replaces the fixtures with adapters and touches no screen. `routes.ts` parses and formats the hash route, so a detail view (`#/missions?mission=…`) is linkable and survives a refresh. `locales/en.ts` is the only dictionary and `translate()` its only accessor.

Screens import their atoms from `components/primitives.tsx`, the single seam to `ui-primitives`; that seam reads `src/atoms.ts`, which imports the six atoms and the glyph set from their source files rather than the package barrel, so no markdown or syntax-highlighting dependency enters the graph.

| Path | Owns |
|---|---|
| `src/App.tsx` | State ownership: the demonstration workspace, selection, filters, feedback, and the drawer and modal hosts. |
| `src/shell/Shell.tsx` | The navigation rail, its collapse and mobile overlay, the top bar and the skip link. |
| `src/screens/*` | One file per screen, each with its own module stylesheet. |
| `src/components/*` | Panels, records, status marks, controls, the drawer, the modal, feedback, and the empty/loading vocabulary. |
| `preview/` | The standalone Vite entry: `index.html`, `main.tsx` and the alias config. |
| `tests/prototype.spec.tsx` | Eleven jsdom interaction specs over the real components. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Aria visual identity and interface prototype](../../../docs/ARIA-VISUAL-IDENTITY.md) — brand, tokens, screens, interaction model and the verification evidence.
- [@deepseek-ai/dsh-aria-theme](../../aria/theme/README.md) — the token layer the screens paint with.
- [@deepseek-ai/dsh-aria-wordmark](../../aria/wordmark/README.md) — the rail header's lockup.
- [@deepseek-ai/dsh-client-ui-primitives](../../client/ui-primitives/README.md) — the atoms behind the seam.
- [@deepseek-ai/dsh-client-ui-layout](../../client/ui-layout/README.md) — the three-column frame this shell echoes.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package renders a demonstration interface over in-package fixtures and mutates only local component state; it registers no plugin, performs no request, and contributes nothing to model context.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The prototype is complete as a design artefact and deliberately stops short of being a product surface.

- **Demonstration data only.** The workspace, missions, agents, collections and activity entries are fixtures; a mission created in the session lives in React state and disappears on reload, which the dialog, the banner and the on-screen notice all state.
- **No host integration.** The package registers no Cordis plugin, owns no Session and reads no service; binding it means writing adapters onto the presentation types and routing real navigation into the shell.
- **Settings are visual.** No control writes configuration, and the Models, Memory and Security sections are read-only by design.
- **One theme, one locale.** Dark only, English only; the token layer could carry a light theme but defines no light values.
- **The assign control stages a label.** It demonstrates the interaction without pretending to reach a backend, and says so in the drawer.
- **Not published.** The package is a workspace member outside the dsh release sequence and is consumed from source.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`src/atoms.ts` is the load-bearing indirection: importing the `ui-primitives` barrel drags in markdown, diff and syntax-highlighting modules the prototype never renders, and a source-mode checkout may not have their dependencies installed. A new atom must be added there and in `components/primitives.tsx` together, and the two lists must match what the screens actually import.

</details>
