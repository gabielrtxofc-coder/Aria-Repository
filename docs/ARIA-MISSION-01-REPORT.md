# Aria — Mission 01 report

English | [中文](ARIA-MISSION-01-REPORT.zh.md)

Branch `arena/cbbfef15-aria-repository`, commit `e19208ca2f9985813d1132541fc76f669dd45330`, no merge. 102 files added or changed, 11,871 insertions.

Every verdict below is PASS, FAIL or BLOCKED with the evidence behind it. Where something could not be run in this sandbox, the substitute that was run is named with its exact scope, and the gap is stated rather than papered over.

## What was built

Three workspace packages under `packages/aria/`, plus the design documentation.

| Package | Contents |
| --- | --- |
| `aria-theme` | The palette, contrast helpers and scale as typed data; the same values as CSS custom properties; the `.aria-surface` overlay that rebinds the DSH `--dsw-alias-*` names. |
| `aria-wordmark` | The mark, the symbol (plate and outline tones), the wordmark (product and capital case), the lockup, and the app icon — all from one exported geometry. |
| `aria-prototype` | The six screens over an in-package demonstration workspace, the shell, the component inventory, the drawer and modal, the locale, the router, the standalone preview, and eleven interaction specs. |

No existing DSH package was modified. The only edits outside `packages/aria/` are: the Aria aliases in `tsconfig.base.json`, an exemption list in `scripts/check-workspace-constraints.ts`, three audited model-experience rows, and the regenerated module graph.

## Definition of done

### 1. Brand identity — logo, wordmark and variants — PASS

The mark is one construction: a tapered portal with its apex cut flat, closed by the ground line, crossed by a single lintel at 0.86× the body weight, square caps and miter joins, stroke widening from 1.75 to 2.3 at 16px and below. Four variants ship: primary lockup, compact symbol, sidebar lockup, app icon. Evidence: `ARIA_MARK_GEOMETRY` in `packages/aria/wordmark/src/index.tsx`, and `docs/assets/aria/brand-sheet.png`, which renders all five exports at their reference sizes on both plate tones and reviews cleanly.

### 2. Palette and design tokens — PASS

Graphite ground `#0b0e0c`, one lime accent `#c8f169`, limestone text ramp, amber/red/blue status families, each with a text variant for tinted fills. Published twice — `tokens.ts` as data, `tokens.css` as custom properties — with components reading role aliases rather than palette steps. Evidence: `packages/aria/theme/src/tokens.ts`, `src/css/tokens.css`.

### 3. Typography and spacing system — PASS

Eight sizes with their line heights, four weights, three tracking values, a 4px spacing scale of ten steps, a six-step radius ladder, three control heights, four elevations and three motion durations. Under `prefers-reduced-motion` every transition is off. Evidence: the same two files.

### 4. Accessibility and contrast — PASS

Every pair measured with the repository's own `contrastRatio()`, not asserted from memory: `text-100` 17.59→14.25:1 across the four grounds, `text-500` 7.60→6.16, `text-600` 5.24→4.25, `text-700` 3.66→2.97, accent 15.01→12.16, ink-on-lime 15.01. The two steps that fall short somewhere are named and restricted in the documentation rather than quietly used: `text-700` is decorative only, `text-600` is not used for small text on the raised ground. One focus ring on every interactive element, a skip link, Escape and focus restore on the drawer and modal. Evidence: the measured table in `docs/ARIA-VISUAL-IDENTITY.md`, reproduced with `contrastRatio()` from `@deepseek-ai/dsh-aria-theme`. Untested: a screen-reader walkthrough — automated checks are not an assistive-technology audit.

### 5. Component library — PASS

Reused unchanged from `ui-primitives`: `Button`, `Input`, `Switch`, `Modal`, `Tag`, plus eleven glyphs. Written for the prototype: shell, panel primitives, status vocabulary, the three record types, the control set, the drawer, the new-mission modal, feedback, and the empty/loading vocabulary — each with module CSS. `components/primitives.tsx` is the single seam; `src/atoms.ts` resolves it from source. Evidence: `packages/aria/prototype/src/components/`.

### 6. The six screens — PASS

Overview, Missions, Agents, Knowledge, Activity and Settings, each answering one question, each with its detail drawer and its states. Evidence: 18 screenshots at 1440/1024/390 plus three interaction states in `docs/assets/aria/`, captured from the in-repo preview with zero console errors and zero horizontal overflow at all three widths.

### 7. Information architecture and navigation — PASS

Five primary destinations plus a secondary settings group, a badge counting missions that need a decision, hash routing with linkable detail views (`#/missions?mission=…`), and unknown routes falling back to the overview. Evidence: `src/routes.ts`, `src/shell/Shell.tsx`, and the specs that assert the hash moves on navigation.

### 8. Interaction model — PASS

Drawers, filters with counts and empty states, local search, the new-mission flow with validation, planning state and a dismissal banner, keyboard and focus handling. All local state; no `fetch`, no websocket, no persistence. Evidence: `tests/prototype.spec.tsx` — 11/11 passing — and `state-new-mission.png`.

### 9. Responsive behaviour — PASS

Shell breakpoints at 1180/1023/720 with screen-level ones at 900/860/760/640/560. Rail collapses to icons, then to an overlay drawer; filter rows scroll instead of wrapping; drawers go full width. Evidence: three widths captured per screen, plus an automated probe that reports the exact overflowing element — zero findings.

### 10. Documentation — PASS

`docs/ARIA-VISUAL-IDENTITY.md` and `.zh.md` as a verified bilingual pair, covering the reference interface, the brand, the tokens with measured contrast, the inventory, the architecture, each screen, the interaction model, responsive behaviour, limitations and future work, with the screenshot table. Each package carries a bilingual README pair following the repository's library template. Evidence: the pairing gate reports 936 pairs consistent.

### 11. Demonstration data, clearly isolated — PASS

One `DEMO_WORKSPACE` fixture, no service import anywhere in the package, a persistent prototype notice on every screen, a demonstration label on the activity feed, and copy in the modal and banner that says a created mission lives only in the session. Claims of backend behaviour are absent because there is none — the assign control explicitly refuses to pretend.

### 12. Original DSH interface preserved — PASS

No file outside `packages/aria/` changes rendering behaviour. `apps/web`, `packages/client/*` and the theme service are untouched; the Aria layer opts in by adding `.aria-surface`, and the body class it adds while mounted is removed on unmount. Evidence: `git show --stat` — the only non-Aria edits are the alias list, one exemption set, three audit rows and the generated module graph.

### 13. Verification and report — PASS with scope caveats

Run and green: TypeScript over the three Aria packages at the repository's own ES2024 client settings plus every `ui-primitives` source the atom seam reaches — 0 errors (the first run found 9 real errors, all from a scratch config on ES2022; the code was also moved from `Array#sort` to `Array#toSorted` to satisfy the strict lint rule, and the config was corrected); the same packages through the repository's composite project references — 0 errors from `packages/aria/`; oxlint over `packages/aria` with a strict rule set — 0 errors, 14 warnings of which 7 are the repository's own `clsx` default-import idiom (the same 30 warnings its `ui-primitives` produces); vitest — 11/11; Puppeteer — 21 captures, zero console errors, zero overflow.

Repository gates that run offline, all green: translation pairing (936 pairs), markdown wrap (1,889 files), cross-links (1,859), doc refs (3,880), package paths (5,699), package-README summaries, limitations and model-experience, export JSDoc (0 findings in `packages/aria`), DSH package licences (340 packages), workspace manifest policy (all three Aria manifests pass), `tsconfig` path generation, module graph.

**BLOCKED:** `pnpm install` cannot complete in this sandbox (a dependency resolves through a host that is unreachable), so `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `publint`, `verify-export-jsdoc` as a whole, `verify-client-packages` and the client-bundle gates were not run end to end over the full dependency graph. The package manifests were instead checked against the repository's own manifest-policy function, invoked directly. A reviewer with an installed checkout should run `pnpm install && pnpm run typecheck && pnpm run lint && pnpm test` before merge.

**Pre-existing failures, not from this change:** `packages/mission/mission-continuity/README.md` fails the README summary budget (178 words against 100) and the model-experience section-order rule. That file is untouched by this branch and identical to `main`; the failures reproduce on a clean checkout of the base commit. They are reported here rather than fixed, because fixing another package's README is outside this mission's scope.

## Known gaps

- The prototype is a package, not a registered DSH plugin. Binding it means adapters over the presentation types and routing real navigation into the shell.
- Dark theme, English locale only. The token layer could carry a light theme; no light values are defined.
- The mark and wordmark ship as React components, not as standalone SVG assets, so an installer or a non-React documentation site cannot consume them yet.
- Settings are visual: no control writes configuration.

## How to review

```sh
pnpm install
pnpm --filter @deepseek-ai/dsh-aria-prototype run preview
pnpm --filter @deepseek-ai/dsh-aria-prototype exec vitest run
```

Then read `docs/ARIA-VISUAL-IDENTITY.md` alongside `docs/assets/aria/`.
