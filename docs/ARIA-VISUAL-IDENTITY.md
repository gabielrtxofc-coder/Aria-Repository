# Aria visual identity and interface prototype

English | [中文](ARIA-VISUAL-IDENTITY.zh.md)

Aria is a rebrand of the DeepSeek Harness (DSH) client interface: the same operational software — sessions, agents, tools, knowledge, approvals — presented under a new identity and reorganised around *missions* instead of conversations. This document records the brand, the design system, the information architecture, the six screens, the interaction model, and the validation evidence behind the prototype in `packages/aria/`. It is written for the person who will review the work and for the person who will bind it to real services.

**The prototype is a frontend, not a product.** It renders demonstration data, mutates only local component state, and calls no service. Nothing in `packages/aria/` touches authentication, the database schema, agent definitions, model routing, memory infrastructure, or any backend package.

## What the DSH interface is, and what the prototype does to it

The reference is the DSH web client: `apps/web` renders the React application, `packages/client/ui-layout/src/client/AppFrame.tsx` owns the three-column frame (sidebar | centre | right bar), and `packages/client/ui-primitives` supplies the design-system atoms. That client is conversation-first: the sidebar lists sessions, the centre column is a chat transcript with a composer, and the right column holds contextual panels. Its visual language is a blue-tinted neutral dark theme (`packages/client/ui-theme/src/styles/design-platform.css`), with `--dsw-*` semantic aliases driving every component.

Aria keeps that architecture and changes three things. It regroups navigation around five operational areas plus settings instead of a session list; it reframes the unit of work from *conversation* to *mission* with an explicit plan, review gate and artifact record; and it restyles the shell in a graphite-and-lime palette derived from the requested brand values. No DSH package was modified to achieve this. The prototype consumes `ui-primitives` atom by atom, overlays the Aria token layer on its own subtree, and leaves the stock client pixel-identical if both are ever mounted side by side.

## Brand identity

The personality brief is intelligence, precision, reliability, discretion, and technological maturity. Each of those maps to a decision rather than an adjective:

| Value | Decision |
| --- | --- |
| Intelligence | A geometric mark built from one apex and two tapered strokes, read as a letter *A* and as a portal opening. Nothing decorative competes with it. |
| Precision | One accent colour, one stroke weight family (1.6 on the 24-unit grid), one radius ladder, and hairline borders instead of shadows. |
| Reliability | The interface states time, status and ownership on every record; no figure appears without a source. |
| Discretion | A dark graphite ground, low-chroma secondary text, and no glow, gradient, or neon wash. The lime accent appears only where Aria is asking for attention or confirming an action. |
| Technological maturity | Classical proportion — a narrow tapered body, a flat truncated apex, a lintel rule across the portal — rather than a specific historical quotation. |

The result is restrained on purpose. A prototype built to look "premium" often reaches for gradients and glow; this one reaches for proportion, spacing and restraint, which is what the reference brand values describe.

### The mark

The symbol is a single abstract form on a 24-unit grid. Three parts:

- **Portal** — a narrow quadrilateral, widest at the base and cut flat at the top: `M10.6 2.7H13.4L19.2 21.3H4.8Z`. The flat apex matters. An earlier iteration closed the shape to a point and immediately read as a house pictogram; truncating the apex keeps it architectural without naming a building.
- **Lintel** — a horizontal rule at `M7.6 14.4H16.4`, one stroke weight lighter than the body. It crosses the portal the way a lintel crosses an opening, and it is the only interior line in the mark.
- **Corners** — `linecap: square` and `linejoin: miter`. Round caps soften the form into something friendlier than the brand allows.

The plate tone fills the rounded square with `--aria-lime-400` and draws the mark in `--aria-lime-ink`; the outline tone strokes the plate and draws the mark in `currentColor`, which is how the mark sits on an ink ground. At 16px and below the stroke widens from 1.75 to 2.3 so the aperture stays open; the lintel stays at 0.86× the body weight in both cases (`2.15` at the same threshold inside the plate variant). The geometrical construction is exported as `ARIA_MARK_GEOMETRY` so a future icon pipeline can regenerate the same shape at any size.

### The wordmark

The wordmark sets **Aria.** in Montserrat at weight 500, with the period in `--aria-lime-400`. The period is the only coloured element: it is the mark's full stop, the claim that the sentence is finished. The uppercase form **ARIA.** at weight 400 with `letter-spacing: 0.19em` is the institutional variant used where the product name must read as a proper noun rather than a voice.

Letter outlines were attempted first and abandoned. Hand-traced contours for four letters looked amateurish at every size; setting the name in a typeface the repository already ships is both more credible and more maintainable, and it keeps the mark as the only bespoke drawing in the identity.

### The four brand variants

| Variant | Component | Use |
| --- | --- | --- |
| Primary wordmark | `AriaWordmark`, `AriaLockup` | Page headers, documentation, anything that has room for the name and the tagline `OPERATIONAL INTELLIGENCE`. |
| Compact symbol | `AriaSymbol` | The navigation rail header, favicons, and any square slot under 32px. The plate is a 24-unit rect inset 0.6 with radius 5.4 and a 1.1 stroke. |
| Sidebar lockup | `AriaLockup compact` | The 56px collapsed rail: symbol only, no wordmark, no tagline. |
| App icon | `AriaAppIcon` | Installers and operating-system chrome: ink plate, a 1.5 hairline inset, and the mark translated to `25 25` and scaled 3.25 on a 128-unit canvas with radius 12.5. |

All four are SVG, all four are legible at the sizes above, and all four are drawn from the same geometry constants. See the brand sheet in `docs/assets/aria/brand-sheet.png`.

## Colour

The requested palette is used as specified, with the minimum adjustments needed for contrast and for consistency with the DSH atoms the prototype reuses.

| Token | Value | Role |
| --- | --- | --- |
| `--aria-bg-canvas` | `#0b0e0c` | The page ground (`aria-ink-950`). |
| `--aria-bg-surface` | `#121713` | Cards, panels, the drawer body (`aria-ink-850`). |
| `--aria-bg-elevated` | `#181f19` | Nested wells, tags, hovered rows (`aria-ink-800`). |
| `--aria-bg-raised` | `#1d251e` | Selected rows, menus, toast ground (`aria-ink-750`). |
| `--aria-border-subtle` | `#273128` | Every hairline (`aria-line-900`). |
| `--aria-text-primary` | `#f1f5ee` | Headings and record titles (`aria-text-100`). |
| `--aria-text-secondary` | `#9aa59a` | Supporting copy and metadata (`aria-text-500`). |
| `--aria-lime-400` | `#c8f169` | The accent. |

Components never read a palette step directly. Every component consumes the semantic role — `--aria-bg-surface`, `--aria-text-secondary`, `--aria-status-waiting` — and the palette lives one level below, which is what lets a token change stay a one-line edit.

Two decisions extend the brief. First, the text ramp needed intermediate steps: `#f1f5ee` and `#9aa59a` alone cannot express a five-level hierarchy, so steps were added above, between and below them (`text-050` through `text-700`). The darkest step, `text-700`, is reserved for labels that are read only as texture. Second, each status colour needed a readable text variant: `amber-300`, `red-300` and `blue-300` are the text steps used inside tinted status fills, because the 400-level steps pass contrast as dots and borders but sit too close to the 4.5:1 line as small text on a tinted ground.

The accent is used deliberately rather than sparingly: the primary button, the selected navigation rail, running-status dots and progress rules, step markers, the "in progress" chip, the greeting rule, and the period in the wordmark all take `lime-400`, and several surfaces tint it toward the ground with `color-mix`. The restraint is in the amount per element, not the count of elements — a 6–16% tint reads as a warm black, and the full accent only ever appears on something 1px wide or on a label that states a state. Very few gradients exist: two, both in the overview banner, one a 6%-alpha wash and one a fade from the accent that marks the greeting rule. They are the only place in the interface where colour varies along an axis. The system's one elevation shadow is the drawer's left edge; every other `box-shadow` is a 1px inset ring or a 3px status halo.

### Measured contrast

Every pair below was computed with the repository's own WCAG implementation (`contrastRatio` in `packages/aria/theme/src/tokens.ts`) against the actual surfaces. Ratios are shown for the worst ground each token is used on.

| Foreground | Canvas `#0b0e0c` | Surface `#121713` | Elevated `#181f19` | Raised `#1d251e` | Verdict |
| --- | --- | --- | --- | --- | --- |
| `text-100` `#f1f5ee` | 17.59:1 | 16.44:1 | 15.24:1 | 14.25:1 | AAA |
| `text-300` `#cbd3c7` | 12.64:1 | 11.82:1 | 10.96:1 | 10.24:1 | AAA |
| `text-500` `#9aa59a` | 7.60:1 | 7.10:1 | 6.58:1 | 6.16:1 | AAA |
| `text-600` `#7c887d` | 5.24:1 | 4.90:1 | 4.54:1 | 4.25:1 | AA on canvas and surface; AA-large on raised |
| `text-700` `#646e65` | 3.66:1 | 3.42:1 | 3.17:1 | 2.97:1 | Decorative only |
| `lime-400` `#c8f169` | 15.01:1 | 14.03:1 | 13.01:1 | 12.16:1 | AAA |
| `amber-400` `#e8b95c` | 10.65:1 | 9.96:1 | 9.23:1 | 8.63:1 | AAA |
| `red-400` `#ef7d75` | 7.26:1 | 6.79:1 | 6.29:1 | 5.89:1 | AAA |
| `blue-400` `#8fb6e8` | 9.26:1 | 8.66:1 | 8.03:1 | 7.51:1 | AAA |
| `lime-ink` `#0b0e0c` on `lime-400` | 15.01:1 | — | — | — | AAA |

Two steps fall short of AA for small text everywhere they appear. `text-700` never carries body copy: it is limited to the `·` separators inside metadata rows and the disabled feed row, both of which repeat meaning available elsewhere in the same block. `text-600` is the tertiary text step and passes AA on the canvas and surface grounds but only reaches 4.25:1 on the raised ground, so it is not used there for text below 18.66px bold or 24px regular; that is exactly why the status text variants exist.

## Typography

The interface reuses the fonts the repository already ships — a Montserrat display face for the brand and a system UI stack for the interface — rather than adding a webfont dependency. The scale is eight steps, and every screen uses only these:

| Token | Size / line height | Use |
| --- | --- | --- |
| `--aria-text-2xl` | 30 / 36 | Page title on every screen. |
| `--aria-text-xl` | 22 / 28 | Drawer titles and the overview banner headline. |
| `--aria-text-lg` | 17 / 24 | Section headings. |
| `--aria-text-md` | 14 / 22 | Card headings and emphasised body copy. |
| `--aria-text-base` | 13 / 20 | Body copy, record titles, prose. |
| `--aria-text-sm` | 12 / 18 | Card metadata, list rows, controls. |
| `--aria-text-xs` | 11 / 16 | Supporting lines under a record. |
| `--aria-text-2xs` | 10 / 14 | Step timings, table captions, uppercase labels. |

Three tracking values accompany the scale: `--aria-tracking-display` (0.02em) on identity text, `--aria-tracking-label` (0.08em) on the uppercase eyebrows and status chips, and `--aria-tracking-data` (0.01em) on numbers. Weights come from four tokens — `--aria-weight-light` 300, `regular` 400, `medium` 500, `semibold` 600 — and no component uses a weight outside them.

Numbers are tabular wherever they change (`font-variant-numeric: tabular-nums`), so a progress percentage does not shift the row it sits in. The monospace face is reserved for identifiers — mission and agent ids, model names, timestamps in the event log — where the reader benefits from character alignment.

## Design tokens

The token layer lives in `packages/aria/theme/src/css/tokens.css` and is mirrored as data in `tokens.ts`.

- **Spacing** — a 4px rhythm: `--aria-space-1` through `--aria-space-10` (4, 8, 12, 16, 20, 24, 32, 40, 48, 64). Screens compose from these and never hard-code a pixel gap.
- **Radius** — `xs` 3px, `sm` 6px, `md` 10px, `lg` 14px, `panel` 18px, `pill` 999px. Cards use `md`, panels use `panel`, chips use `xs`, controls use `sm`. A square-ish ladder is deliberate: large soft corners would soften a brand built on precision.
- **Borders** — every boundary is a 1px (`--aria-hairline`) stroke from `--aria-line-900`; the heavier `--aria-line-800` appears only on interactive controls and selected rows.
- **Elevation** — four tokens, all of them a 1px stroke plus a low-alpha ambient shadow: `hairline`, `card`, `raised`, `overlay`. There is no glow and no coloured shadow, so the lime accent never becomes light.
- **Controls** — three shared heights, `--aria-control-sm` 28px, `md` 34px, `lg` 40px, so buttons, inputs and filter chips line up on one row.
- **Motion** — three durations (`fast` 90ms, `base` 160ms, `slow` 260ms) on one easing curve (`--aria-ease`), with `--aria-ease-exit` for dismissals. Every transition is disabled under `prefers-reduced-motion`.

Because the drawer and the modal are portalled to `document.body`, the prototype adds `aria-surface` to `<body>` while it is mounted and removes it on unmount. Without that class the overlays would paint in DSH default colours, which is exactly the bug the first integration screenshot showed.

## Component inventory

Reused unchanged from `packages/client/ui-primitives`: `Button` (primary / outline / ghost variants), `Input`, `Switch`, `Modal` (with its own focus contract and Escape handling), and the icon set where a glyph already existed.

Written for the prototype, each in `packages/aria/prototype/src/components/`:

| Component | Responsibility |
| --- | --- |
| `Shell` | Navigation rail (collapsed state, mobile overlay drawer), top bar (breadcrumb, system indicator, search trigger, notifications), skip link. |
| `Panel`, `SectionHeading`, `MetaList`, `Divider` | The only components allowed to draw a card surface, so padding and stroke never drift between screens. |
| `StatusDot`, `StatusBadge`, `SystemIndicator` | One six-tone status map (`active`, `waiting`, `review`, `done`, `failed`, `idle`) drives every status mark in the product. |
| `MissionCard`, `AgentCard`, `ActivityRow`, `Tag` | The three record types, each with its own hover, focus and selected states. |
| `PageHeader`, `FilterRow`, `SearchField`, `ProgressBar`, `Metric`, `TabStrip`, `PrototypeNotice` | The repeated controls above the level of a primitive: a page title with an eyebrow and an action slot, a chip filter row with counts, a search field with a clear button, a two-value progress rule, an indicator block, and the notice that marks demonstration data. |
| `Drawer`, `DrawerSection`, `DrawerProse` | The right-hand detail panel: portal, scrim, focus trap, Escape, focus restore. |
| `NewMissionModal` | The new-mission form on top of the primitive `Modal`, with inline validation and a planning state. |
| `FeedbackBanner`, `useFeedback` | A dismissible banner with an optional action, used for the "mission created" confirmation. |
| `RegionState`, `Spinner`, `SkeletonList`, `BusyOverlay` | The empty, loading and error vocabulary, so those states look the same everywhere. |
| `icons` | Twenty-three glyphs on the 24-unit grid for concepts the shared set does not carry (missions, knowledge, activity, capabilities, verification, artifacts, and so on). |

`components/primitives.tsx` is the single seam to `ui-primitives`: every screen imports its atoms through it, so the inventory of reused controls is one file rather than a grep. Underneath it, `src/atoms.ts` imports those atoms and glyphs from their source files instead of from the package barrel — the barrel also re-exports markdown, diff and syntax-highlighting modules whose third-party dependencies a source-mode checkout may not have installed, and the prototype renders none of them. That one indirection is why the preview and the specs run with no build step and no barrel dependency.

## Information architecture

Primary navigation is five destinations in reading order of a working day — **Overview**, **Missions**, **Agents**, **Knowledge**, **Activity** — with **Settings** separated into a secondary group at the foot of the rail. The rail badges the Missions item with the number of missions waiting on a decision, because that is the only count that asks the operator to act.

Routing is hash-based and owned by `routes.ts`: `#/missions?mission=mis-vendor-diligence` opens the register with that mission's drawer already open, so a detail view is linkable and survives a refresh. Unknown routes fall back to the overview.

The six screens answer six questions, in this order:

1. **Overview** — what is running, what needs me, what just happened?
2. **Missions** — what is the register, and what is the plan inside one mission?
3. **Agents** — who can do the work, and what are they trusted with?
4. **Knowledge** — what can Aria read, and how current is it?
5. **Activity** — what did Aria do, when, and how did it end?
6. **Settings** — how is the workspace configured? (Visual reference only.)

## The screens

### Overview

A greeting banner names the workspace and states the count of missions in flight in one sentence; three action buttons sit beside it. A four-up indicator row follows — active mission, awaiting decision, agents engaged, runs today — each with one supporting figure rather than a sparkline, because a single number with a caption is read faster than a chart with a legend. The page then splits into a 1.55 : 1 column pair: the wide column carries active missions and the recent-activity tail, the narrow column carries the attention list, the agents on duty, and the execution pipeline. The asymmetry is intentional — the wide column is where the reader scans, the narrow one is where they decide.

### Missions

A four-up summary, then a chip filter row with a count on every status, a search field, and a two-column card grid. Each card states the objective, the current step, a progress rule, the desk, the age, and the participating agents' initials; the status badge sits top-right. Selecting a card opens the drawer with the objective and brief, the numbered execution plan (marker colour per step state, agent and timing under each), the review verdict, the artifacts with their kind, and the event log with timestamps. Approval actions appear in the drawer footer only when the mission is actually waiting.

### Agents

The roster as cards: identity, availability dot, summary, up to three capability tags, model, and assignment count. The availability filter counts each state. The drawer adds the model context, runs and mean runtime, write access, last activity, the full capability list with each capability's maturity, current assignments (each opening the mission register), and the agent's recent activity. The assign button is honest about its scope: it stages a label in the drawer and says so, because there is no backend to assign anything to.

### Knowledge

A collection rail on the left and the resource register on the right. Each collection shows its index state, resource count and classification; a collection that is not indexed carries a note explaining that missions cannot cite it. The register shows format, source, size, age, tags, citation count and classification per resource. Search is local across title, source and tags, and paging is explicit rather than infinite.

### Activity

A day-grouped timeline. Each row carries the time, an outcome dot, the event title, one line of detail, and the actor and scope. Two filter rows — scope and outcome — narrow it locally, the group heading repeats the count, and any row opens a drawer with the timestamp, elapsed time, scope, outcome, full detail, and links to the mission and agent it belongs to.

### Settings

Six sections in a rail: General, Appearance, Models, Memory, Integrations, Security. Every control is either read-only or local state, and the page says so twice — in the subtitle and in the persistent prototype notice. The Appearance section doubles as the type-scale specimen, which is the cheapest way to keep the typography honest.

## Interaction model

Everything below is local state. There are no API calls, no `fetch`, no websocket, and no persistence beyond the browser session.

- **Navigation** — rail items change the route and the hash; the sidebar collapses to an icon rail under 1024px and becomes an overlay drawer under 720px.
- **Mission detail** — opens from a card or from the hash, closes with Escape, the close button, or the scrim, and restores focus to whatever opened it.
- **Agent detail** — same contract, from a roster card or from a step's agent name.
- **Filtering** — mission status, agent availability, activity scope and activity outcome each filter locally and show their counts; the empty state always offers the way back.
- **Search** — knowledge search matches title, source and tags; mission search matches title, objective and desk.
- **New mission** — the modal validates that an objective exists, shows a planning state, then inserts a demonstration mission into local state, routes to it, and confirms with a banner that names it a demonstration record.
- **Feedback** — the banner is dismissible and joins the toast vocabulary; the button-level feedback is the button's own pressed and disabled states.
- **States** — empty, loading, error and disabled states exist as components and are used: the knowledge register has an unindexed warning, every filter has an empty state, the drawer has empty sections for artifacts and assignments, and the settings integration rows include a disabled connection.
- **Focus** — one focus ring (`--aria-focus-ring`) on every interactive element, a skip link to the main region, and focus order that follows reading order.

## Responsive behaviour

Desktop is the reference at 1440px. The shell's own breakpoints are 1180px, 1023px and 720px; individual screens add narrower ones at 900, 860, 760, 640 and 560px where their own content needs it, and the rail collapses on the same 1023px boundary as the DSH frame it mirrors. At 1024px the rail is already the compact one, the overview drops to a single column below the indicator row, and card grids go to two columns. At 720px the rail becomes an overlay drawer, the top bar drops the breadcrumb and keeps the system indicator, search and notifications, filter rows scroll horizontally instead of wrapping, the indicator grids go two-up, and detail drawers take the full width. The three breakpoints were checked by screenshot at 1440, 1024 and 390 and by an automated overflow probe that reports the exact element crossing the viewport edge; the final run reports no overflow on any of the six screens at any of the three widths.

## Known limitations

- **Demonstration data only.** The workspace, missions, agents, collections and activity entries are fixtures. A mission created in the session lives in React state and disappears on reload; that is stated in the dialog, in the banner, and in the notice on every screen.
- **No host integration yet.** The prototype is a package (`AriaPrototype`), not a registered DSH plugin. Binding it means mapping real session, agent and memory data onto the presentation types in `model.ts`; no screen assumes more than those types provide.
- **Settings are visual only.** No toggle writes configuration, and the Models, Memory and Security sections are deliberately read-only.
- **One theme, one locale.** The interface is dark and English. The token layer can carry a light theme, but no light values are defined, and `locales/en.ts` is the only dictionary.
- **The Agent assign control stages a label.** It demonstrates the interaction without pretending to be a backend call; the hint text says as much.
- **Offline toolchain.** The sandbox that produced this work could not install the workspace, so the repository-wide `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` were not run end to end. The substitutes, with their exact scope, are: a TypeScript program at the repository's own ES2024 client settings covering the three Aria packages plus every `ui-primitives` source the atom seam reaches (0 errors); the same packages built through the repository's composite project references (0 errors from `packages/aria/`); oxlint over `packages/aria` with the strict rule set (0 errors); eleven jsdom interaction specs; and the Puppeteer capture pass. What was *not* verified is the rest of the repository's gates, which need the full dependency tree.

## Future improvements

1. **Bind to the host.** Register the screens as DSH navigation entries and replace `fixtures.ts` with adapters over the session, job and memory services — the model types were written for that mapping.
2. **Real mission semantics.** The prototype's mission is a presentation concept. A real implementation needs a durable mission record, a scheduler that owns step transitions, and an approval path that the review gate can block on.
3. **A light theme.** The tokens are structured for it; only the values are missing.
4. **Motion and skeletons.** Loading states exist as components but no screen waits long enough to display them. Real data will make them load-bearing.
5. **Icon suite as SVG assets.** The glyphs are React components on a shared grid; exporting them as standalone SVGs would let the desktop installer and the documentation site share exactly the same artwork.
6. **Accessibility audit with assistive technology.** Automated contrast and focus checks pass; a screen-reader walkthrough of the drawer's focus trap and the timeline's grouping has not been performed.

## Validation

The measurements behind the claims in this document, the exact commands, and the per-item verdicts are in the mission report. In summary: 0 TypeScript errors in `packages/aria/` under both the standalone and the repository's composite build, 0 lint errors, 11 of 11 interaction specs passing, no console error or failed request in any captured run, no horizontal overflow at 1440 / 1024 / 390, and 22 screenshots committed under `docs/assets/aria/` — 18 of the six screens at three widths, 3 interaction states, and the brand sheet. The repository's own documentation and workspace gates that can run offline were run against this change: translation pairing (936 pairs), Markdown wrapping (1,889 files), cross-links (1,859 files), documentation references (3,880 files), package paths (5,702 files), package-README summaries, limitations and model-experience classifications, export JSDoc, DSH package licences, workspace manifest policy, `tsconfig` path generation and the module graph.

## Screenshots

All captures are of the running prototype with its demonstration workspace.

| Screen | Desktop 1440 | Tablet 1024 | Phone 390 |
| --- | --- | --- | --- |
| Overview | [overview-1440](assets/aria/overview-1440.png) | [overview-1024](assets/aria/overview-1024.png) | [overview-390](assets/aria/overview-390.png) |
| Missions | [missions-1440](assets/aria/missions-1440.png) | [missions-1024](assets/aria/missions-1024.png) | [missions-390](assets/aria/missions-390.png) |
| Agents | [agents-1440](assets/aria/agents-1440.png) | [agents-1024](assets/aria/agents-1024.png) | [agents-390](assets/aria/agents-390.png) |
| Knowledge | [knowledge-1440](assets/aria/knowledge-1440.png) | [knowledge-1024](assets/aria/knowledge-1024.png) | [knowledge-390](assets/aria/knowledge-390.png) |
| Activity | [activity-1440](assets/aria/activity-1440.png) | [activity-1024](assets/aria/activity-1024.png) | [activity-390](assets/aria/activity-390.png) |
| Settings | [settings-1440](assets/aria/settings-1440.png) | [settings-1024](assets/aria/settings-1024.png) | [settings-390](assets/aria/settings-390.png) |

Detail and interaction states: [mission detail](assets/aria/state-mission-detail.png), [agent detail](assets/aria/state-agent-detail.png), [new mission](assets/aria/state-new-mission.png), and the [brand sheet](assets/aria/brand-sheet.png).

## Running the prototype

From the repository root, with dependencies installed:

```sh
pnpm --filter @deepseek-ai/dsh-aria-prototype run preview
```

The preview binds to `0.0.0.0:5273` and needs no build step; it aliases the workspace packages to their sources. The interaction specs run with:

```sh
pnpm --filter @deepseek-ai/dsh-aria-prototype exec vitest run
```
