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

## Review outcomes, 2026-11-20

Five planning agents reviewed this design (results in `.agents/reviews/2026-11-20-planning/`).
Changes taken from them:

- **Blocker, now in scope: two Bun-only command recognisers.** The retained-verification procedure
  (`src/runner/retained-verification/procedure.ts`) and the failure classifier
  (`src/runner/quality-failure.ts`) accept or classify only a fixed list of Bun commands. A profile
  command such as `cargo test` or `npm run lint` would be refused or misread. Both become readers
  of the profile: a command is recognised because it is a profile `verify` or `fix` command, not
  because it matches a Bun pattern.
- **One source store.** `repo_map_sources` (keyed by project directory) already holds a source
  filter. It is migrated into the profile (keyed by project key) and removed; there are not two.
- **The isolated recheck is `node_modules`-shaped** (dependency symlink, tree ownership checks).
  Step 4 is larger than an install command: each toolchain states where its dependencies live and
  how the isolated copy gets them. Cargo is the test case.
- **No profile means today's behaviour, exactly:** the built-in derived source filter, the
  Architect's own commands, Fallow as now. Nothing changes until a profile is stored.
- **LAZERS gets its profile through the same init** as any project; nothing is seeded by a
  migration, so the init path is exercised on our own repository first.
- **Profile commands the runtime runs unattended are owner-confirmed** (lead's default, unanswered
  by the owner): init shows the exact commands; a later change to a command, including a re-run of
  setup, shows the difference and needs the owner's confirm. The Architect proposes. Reason: the
  Architect writes the profile from repository files, and the runtime then runs those commands
  with no model in the loop.
- **Install hardening** (lead's default): each toolchain gets its safe install form by default (no
  lifecycle scripts, locked lockfile); the profile may state another, confirmed like any command.
- **A command that fails at init is kept, marked unproven,** with its recorded result; it is never
  stored as working, and the runtime does not run an unproven fix or install unattended.
- **Fields made precise in the build:** how changed paths are passed to a `fix` command; ordering
  and scope of commands across two toolchains; validation on save (empty `verify`, empty
  `source.include`, unknown `audit`); revisions of a profile, following the Fallow config store's
  append-only pattern; `source.exports` is deferred until a second language needs it.
- **Init also stores the Fallow config** when `audit` is `fallow`, in the same setup session.
- **The setup notice** is a toast with an action plus an entry in "Needs you"; a toast needs an
  open window, so the GUI raises it.
- **Each build step states its acceptance check;** the first is a profile for this repository,
  for an npm fixture and for a cargo fixture, each proven by running its commands.

## Final pass outcomes, 2026-11-20

One Readiness pass on the revised design. Its blocker: no build step states its acceptance check.
That lives in the implementation plan, `.agents/plans/project-profile.md`. Answers to the rest:

- **A project with a stored source filter and no profile:** the row stays in use until init writes
  a profile; then it becomes the profile's `source` and the row is dropped. No source-only profile
  is created.
- **Two toolchains:** `verify` commands run in listed order; all run and every failure is
  reported. A `fix` chain runs in listed order and stops at its first failure.
- **Changed paths reach a `fix` command** appended as arguments, filtered by the command's `files`
  globs when given; with no matching file the command does not run.
- **Setup notice:** dismissal is stored per project; Settings can raise it again; an abandoned or
  failed setup session leaves the notice in place.
- **Confirmation:** each stored command records when the owner confirmed it and its last proven
  result. An edit is stored as a pending revision; the runtime keeps running the last confirmed
  revision until the owner confirms the new one.

## Owner decision, 2026-11-20: one JSON, one schema

The primary interface for a profile is the Architect: it explores the repository and makes one
tool call with the profile as JSON. That JSON has one schema (the profile type's). Settings shows
the same JSON, validated by the same schema, for now: no separate form model and no second shape.
The tool's input, the stored revision and the Settings view are the same document. Plan tasks 1.6,
1.7 and 3.2 follow this: the Settings view renders and edits that JSON and the owner confirms it
there.
