# Spike 028: Tasks native menu placement and tab icon

## Spike record

- **Question:** Can the Tasks panel ride the native extra-panel affordances —
  an ordered `session.panel` menu entry and a closable tab label with a themed
  icon — without touching Start/layout/continuation behavior or the panel body?
- **Increment:** Register the Tasks `session.panel` MenuItem at `order: 40` so
  the host's ascending sort places it after the native entries, and give the
  closable Tasks tab a stable `label` rendering the native `task` icon with the
  Tasks title, mirroring the host review tab.
- **Scope:** `src/tasks/panel.tsx` registration and the native tab label only.
  Start, continuation, search, split, scroll restoration, session/project
  scope, other panels, audio placement, and inference settings are untouched.
- **Acceptance:** Menu ordering puts Tasks last; the tab keeps `closable:
"hover"`, `title: "Tasks"`, and stable open/close/reopen semantics;
  registration/render tests fail the previous iconless/order-0 behavior; full
  tests and quality pass.

## Behavior

The host sorts `session.panel` items ascending by `order ?? 0`
(`packages/app/src/runtime/plugin/panel-menu.ts`, OpenCode 2.2.5). Pinned
native registrations in `packages/gui-plugins/src/*/renderer.tsx` use Review 10,
Browser 15, Terminal 20, and Files 30; Tasks 40 therefore lists last in the
extra-panel + menu. Terra confirmed the bottom placement ("fully last, after
Browser/Files") before implementation.

The tab is one stable object with a `label` function matching the native
pattern (`packages/gui-plugins/src/review/renderer.tsx:126-131`): a flex row
with `<Ui.Icon name="task" size="small" />` plus the "Tasks" text. `title:
"Tasks"` remains the accessible name and the trigger fallback, `closable:
"hover"` is unchanged, and `Panel.list` still returns the same object while
listed so a session switch does not re-render the label. Icon and classes are
host-native (`task` is a catalog IconName; `flex items-center gap-1.5` are host
utilities), so theming comes from the app, not plugin CSS.

## Test approach

Bun has no Solid DOM host and the root `tsconfig.json` pins
`jsxImportSource: "solid-js"` (vite-plugin-solid compiles the shipped bundle).
`test/task-panel/menu-tab.test.ts` therefore mocks the `@opencode/plugin/gui`
barrel with stable registry tokens and an identity `bindPlugin` (the real
`bindPlugin` needs a plugin-contribution context), and mocks the Solid JSX
dev/runtime modules into inspectable vnode records. Gotcha recorded during
authoring: `solid-js/jsx-runtime` and `solid-js/jsx-dev-runtime` resolve to the
same file, and a later `mock.module` replaces the earlier whole-module mock, so
both mocks export the full set with the dev entry registered last.

Tests cover: merged ascending order with the native fixture (Tasks last, and
greater than Files' 30); the closable tab's label renders the themed `task`
icon (`size: "small"`) with the "Tasks" span and keeps `title`/`closable`;
tab-object stability; open/closed/reopened listing; Command and MenuItem runs
opening `lazers:tasks` with `{ tab: "select" }` for a located session only.
Against the previous registration (no `label`, no `order`) the order and
render tests fail; the stability/scoping guards pass on both, matching their
role as regression fences.

## Native review — outstanding

Source tests and the bundled GUI artifact do not establish Desktop behavior.
No driver has captured the post-change native menu and tab yet. Outstanding
observations for Terra:

- the + menu before the side panel lists Tasks below Review, Browser,
  Terminal, and Files with the task icon;
- the open Tasks tab strip shows the themed icon next to "Tasks" with the
  hover close button, and close/reopen and session scoping behave as before;
- Start/continuation flows and inference settings show no regression.

Per the record, this attempt should retain its explicitly selected Go
route/effort/persona and measured usage/failures; no fallback is claimed and
no comparative cost or model-quality claim is made.

## Verification

- `bun test test/task-panel src/tasks` — focused suite passes (5 new tests);
  stashing the panel change fails exactly the two behavior tests, restoring it
  passes again.
- `bun test` — 221 pass / 0 fail, 2,169 expectations, 45 files.
- `bun run verify` — fmt, lint, and typecheck clean.
- `bun run build:gui` — bundle builds; `dist/gui-experimental.cjs` contains
  the new label classes and `order: 40` (pre-existing onnxruntime `cjs`
  `import.meta` warnings only).

Source references: `src/tasks/panel.tsx` (`setupTaskPanel`), OpenCode 2.2.5
`panel-menu.ts` sort, `gui-plugins` native orders and review tab label,
`node_modules/@opencode/plugin/dist/gui/registries.d.ts` (`MenuItem.order`,
`PanelTab.label`).
