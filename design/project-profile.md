# Project profile and init

Status: design approved by the owner in conversation on 2026-11-20. Not built.
Related: [Architect planning flow](architect-planning.md), [multi-project](multi-project.md).
Facts behind it: the toolchain survey reported in the driver session (verification commands are
free text per task; the runtime assumes Bun and TypeScript in eight places).

## Intent

LAZERS must work in any project: TypeScript with bun, npm or pnpm, Rust with cargo, and others.
Today the Architect and workers are told `bun run verify`, auto-fix only knows `bun fmt` and
`bun lint --fix`, only Bun is located on the path, the isolated recheck runs `bun install`, and
Fallow reads only JavaScript and TypeScript yet its config is demanded everywhere. One stored
profile per project replaces every such assumption, and an init flow lets the Architect discover
and prove it.

## The profile

```ts
type ProjectProfile = {
  toolchains: string[] // "bun", "npm", "pnpm", "yarn", "cargo", ...
  verify: { id: string; command: string }[] // format check, lint, types, tests
  fix: { command: string; files?: string[] }[] // auto-fix: "cargo fmt", "npx prettier --write"
  install?: string // "npm ci", "cargo fetch"
  env: string[] // variables to keep: CARGO_HOME, RUSTUP_HOME
  audit: "fallow" | "off" // Fallow only where it can read the code
  source: {
    include: string[] // LAZERS: ["src/**/*.ts", "src/**/*.tsx"]
    exclude: string[] // tests, fixtures, vendored trees, records, build output
    exports?: string // how exported names are found, per language
  }
}
```

A project with two toolchains carries both in one profile. LAZERS itself becomes a profile with
Bun commands; nothing special stays in the code. Stored in the shared database per project key
(the settings store accepts numbers only today and must take structured values).

## Readers

One definition, read by everything that assumed Bun or had its own file filter:

| Reader                                                                     | Uses                                         |
| -------------------------------------------------------------------------- | -------------------------------------------- |
| Architect and worker guidance                                              | `verify`, `toolchains`                       |
| Mechanical auto-fix                                                        | `fix`                                        |
| Tool lookup before a check                                                 | `toolchains`                                 |
| Isolated recheck                                                           | `install`, `env`, the project's lockfile     |
| Fallow, its config demand, and the audit's "does this change matter" check | `audit`, `source`                            |
| Repository map (paths plus exported names)                                 | `source` (replaces `deriveSourceDefinition`) |
| Bun test hang guard                                                        | becomes part of a Bun profile's commands     |

The repository map's export scan reads TypeScript only; a profile names how exports are found per
language, and a language without a scan gets paths only.

## Init

```
project loads -> profile exists? -- yes -> normal
                      | no
                      v
        notice in OpenCode: "Set up LAZERS for this project"  [Set up]
                      | click
                      v
        Architect session with setup instructions:
          reads manifests, lockfiles, CI files, AGENTS.md, the folder tree
          proposes a profile
          runs each command once and records the result
          runs the repository map with the proposed source filter and reports
            file count, map tokens, largest folders
          the owner confirms -> stored
```

- A runtime check at project load raises the notice.
- A hook at Architect session start adds the setup guidance when the project has no profile, so a
  session the owner starts by hand gets it too.
- The Architect proves the profile: a command that fails is not stored as working, and a source
  filter that pulls in records or vendored trees shows up in the numbers before it is stored.
- Detection is the Architect's job with manifests as input; there is no hard-coded detector per
  language.
- Not a gate: with no profile, work runs with the Architect's own commands as today. The notice
  stays until the owner sets up or dismisses it.

Settings gains a "Verification" group per project: view and edit the profile, and "Run setup
again".

## Build order

1. Profile store, RPC and the Settings view.
2. Guidance, tool lookup and auto-fix read the profile.
3. Init notice, the Architect setup session and the session-start hook.
4. Isolated recheck: install command, variables, lockfiles.
5. Fallow and the audit per profile; the repository map reads `source`.

First profiles to test: Bun, npm and cargo. The split of `src/runner/runtime.ts` moves the
verification modules first (check activities, verification candidate, effect reconciliation) so
steps 2 and 4 build on them.
