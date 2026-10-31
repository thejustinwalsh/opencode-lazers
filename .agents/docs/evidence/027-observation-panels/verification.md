# Radar and Trajectory — automated verification

Environment: Bun `1.4.4-canary.1` (`da867c60b`), OpenCode CLI `v2.2.5`, starting
revision `e7aae9618ad1f07563c02d82b7dddaa1936f1bf2`.

| Check                                                                                                                                   | Result                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun test test/observation-panels src/radar test/radar src/trajectory-panel test/trajectory-panel src/observability test/observability` | Pass: 34 tests, 211 assertions, 15 files.                                                                                                                                            |
| `bun run build:gui`                                                                                                                     | Pass: one combined `dist/gui-experimental.cjs` bundle; 154 modules transformed. Existing Vite `inlineDynamicImports` deprecation and ONNX Runtime CJS `import.meta` warnings remain. |
| `bun test`                                                                                                                              | Pass: 259 tests, 2,397 assertions, 61 files.                                                                                                                                         |
| `bun run verify`                                                                                                                        | Pass: formatter (287 files), linter (164 files), and typechecker (158 files).                                                                                                        |

`test/observation-panels/root.test.ts` executes the shipped GUI entry setup and
checks that Tasks, Radar, and Trajectory register once, both observation panels
are optional/closable, their stores are declared, and both command and session
menu entries open the corresponding tab. Existing Radar/Trajectory and
observability tests exercise production RPC/projection/state code against local
fixtures. No automated check here mounts the panels in Desktop or observes actual
ongoing scheduler work; see [`native.md`](./native.md).
