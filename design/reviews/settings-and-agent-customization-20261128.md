# Settings and agent customization review

**Date:** 2026-11-28  
**Purpose:** Explain the current Settings surface, project/profile state, agent prompts, and viable customization boundaries before any implementation or dispatch.

## Finding

Settings feels like a wall of text because one LAZERS page combines optional local inference and its diagnostics with operational controls for budgets, projects, verification, planning, and retention. The actual project-profile setup is active for `opencode-lazers`; it is not an agent-prompt customization mechanism. There is no LAZERS prompt editor. Model assignments live in the separate Models panel.

The key customization boundary is real: OpenCode has native agent and project-instruction mechanisms, but LAZERS registers fixed roles with packaged prompts. A read-only operator probe found that `registerArchitect()` did not preserve a seeded native Architect system extension, permission, or request header, while it did preserve the model. This was a local fake-editor measurement, **not** a live-host integration result.

**Required outcome:** Settings → Agents must show each packaged role's base instructions and let the user add supplemental instructions **per agent, per project**. The effective role keeps its packaged base and composes the project supplement without replacing the user's permissions, request settings, or model selection. `AGENTS.md` remains complementary common guidance, not a substitute for this feature. Full base replacement is not requested.

No implementation, configuration write, setup rerun, gate, build, task, or release work was performed. Release 0.2.1 has already been operator-verified through a normal public npm install; the two existing native 0.3 workers were left untouched.

## Evidence and limits

- **Source** means behavior read from this checkout or the exact upstream source identified below.
- **Stored state** means the reviewer's bounded, read-only snapshot on 2026-11-28 of `/Users/tjw/.local/share/opencode/plugins/lazers/tasks.sqlite`; proof output tails were not read. Counts and loaded presence are observations at collection time, not live counters.
- **Operator UI observation** means the driver’s report of the regular Desktop Settings view. It is not a screenshot-backed or independently reproduced host observation. Further regular Desktop observations may follow.
- **Operator local measurement** means the supplied `.cache/driver/probe-agent-customization.ts` result. It uses a fake editor shaped like `src/architect.test.ts`; it did not change live agent configuration or production source and was not rerun.

The plugin pins OpenCode SDK/API 2.3.0 (`package.json`). The regular Desktop is 2.4.1. I checked the pinned source at commit `dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06` and source at tag `v2.4.1`. The agent-field behavior described here is present in both versions. This does not make a fake-editor measurement a live 2.4.1 result.

## Settings and operator UI observations

Source (`src/gui.tsx:174-190,464-621`): Desktop puts optional local inference and its advanced diagnostics on the same LAZERS page as provider-usage display, project/scheduling controls, verification profiles, and storage retention. Non-Desktop hosts omit local inference. The separate Models panel has Compare and Assignments; Assignments changes model/effort routes, not prompts or permissions (`src/models/assignments-view.tsx:103-188,232-343`).

The operator reports seeing model toggles, voice/residency, usage ring, global pause, D1 decision settings, per-project controls, planning, and retention, with no prompt-extension editor. This is operator-reported UI evidence, not a screenshot-backed independent observation.

### Verification should become a concise, truthful setup state

The current profile row expands commands, proof badges, map counts, and history in Settings (`src/projects/profile-gui.tsx:241-333`). A clearer default summary would distinguish:

- **Profile state:** `No profile` or `Active · revision 1`.
- **Setup:** for no profile, `LAZERS uses Architect-authored commands; setup is optional and does not block work` (`src/projects/setup-notice.tsx:47-80`; `docs/reference/contributor-contracts.md:70-73`).
- **Recorded proof state:** for this project, `7/8 verification proofs passed · 1 failed · last proved 2026-11-20`; label it historical evidence, not current health.

Scope the summary explicitly to the selected project and its canonical identity/checkouts. Keep commands, proof details, source filters, environment names, map previews, and earlier revisions behind advanced disclosures. “Active profile” must not be conflated with “all checks currently pass”; missing profile must not be presented as a gate.

## Current project/profile state

Read-only inventory of the plugin database contains these three records:

| Stored project                       | Checkout                                         | Current presence | Profile/tasks                                                    |
| ------------------------------------ | ------------------------------------------------ | ---------------- | ---------------------------------------------------------------- |
| `tjw` (`TJW`)                        | `~/`                                             | Loaded           | No active profile; 0 task rows                                   |
| `opencode-lazers` (`LZ`)             | `~/Documents/ChatGPT/opencode-lazers`            | Loaded           | Active profile revision 1; 291 task rows; stored project limit 3 |
| `opencode-native-settlement` (`ONS`) | `~/Documents/ChatGPT/opencode-native-settlement` | Not loaded       | No active profile; 2 task rows                                   |

There is no `ruNNtime` record in this inventory. The third record is explicitly `opencode-native-settlement`, with an `anomalyco/opencode` remote alias; the absence of a `ruNNtime` row does not establish intent about any other project.

The `tjw` root record was created at **2026-11-17 20:47:04 UTC**, has only an OpenCode-project-ID alias, no tasks, and no profile. It has a live-presence row from **2026-11-28 17:48 UTC**. Registration therefore predates this review; today's location-less `api form.list` observation does not explain its original creation. Whether that read loaded the location or refreshed presence, and whether the user intended Home as a LAZERS project, remain unproved. LAZERS defines “loaded” as a live OpenCode location for any registered checkout, not intent, active profile, or readiness (`src/projects/scope.ts:22-29`).

For `opencode-lazers`, the database confirms revision 1 is **active**, written by the Architect on **2026-11-20 10:48 UTC**. Its stored map preview reports 538 files, 3,227 names, and 16,117 tokens; separate preview fields record 466 current files and 14,905 current tokens. These are stored preview values, not a new live measurement.

The profile declares Bun and Cargo toolchains; eight verification commands; Bun and Cargo fixes; an install command; `CARGO_HOME` and `RUSTUP_HOME`; Fallow audit; and source include/exclude globs. The stored proofs show seven verification commands proven and `cargo fmt --manifest-path crates/fallow-wasm/Cargo.toml --check` failed with exit 1. The fixes, install, and tool-version probes were recorded as proven. The proof is dated historical evidence, not a rerun or present-day claim about the checkout.

The profile is constrained to verification/toolchain/install/fix/environment/audit/source-map fields (`src/projects/profile.ts:8-16`). Saving proves commands in a separate native worktree and activates a new revision immediately; there is no approval step (`src/projects/profile-tools.ts:23-27,95-120`; `src/projects/profile-store.ts:262-340`). A failed fix or install is not run unattended (`src/projects/profile-runtime.ts:53-70`). A missing profile produces a setup notice, not a dispatch gate (`src/projects/setup-notice.tsx:47-80`). Therefore “No profile” for `tjw` or `opencode-native-settlement` does not mean LAZERS cannot run there.

## Native configuration and packaged agents

### OpenCode’s native mechanisms

Current OpenCode agent documentation uses `system` for the agent instruction field and supports Markdown agents under `.opencode/agents/<name>.md` or the global agents directory, as well as inline `agents` configuration: [Agents documentation](https://opencode.ai/docs/agents). Native project instructions such as `AGENTS.md` are a separate instruction source, not an agent’s `system` string. The pinned instruction loader discovers global/project `AGENTS.md` and renders discovered instruction files separately ([pinned `config/plugin/instruction.ts`](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/config/plugin/instruction.ts#L35-L75); current [instruction discovery source](https://github.com/anomalyco/opencode/blob/v2.4.1/packages/core/src/config/plugin/instruction.ts#L35-L80)). This repository’s root `AGENTS.md` remains in that separate channel.

Pinned OpenCode’s native agent state editor creates a missing ID from `Agent.Info.default(id)` before applying an update ([`agent.ts`](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/agent.ts#L74-L86)). Its config-agent plugin processes config documents in order: present model/system/description/etc. fields are assigned; request headers and body are merged into the existing request objects; permission rules are appended. The config document order places project configuration above global supplementary configuration, with the latest defined `default_agent` winning ([`config.ts`](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/config.ts#L330-L373); [`config/plugin/agent.ts`](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/config/plugin/agent.ts#L64-L101)). In that native layer, `system` is a whole-field assignment, not automatic prompt concatenation.

**API boundary:** installed OpenCode 2.3.0 `AgentApi` exposes only `list` and `get` (`node_modules/@opencode/client/dist/effect/api/api.d.ts:112-115`). `AgentEditor` is the in-memory editor passed to `ctx.agent.transform`, with `list/get/default/update/remove`; `AgentDomain` adds transform/reload (`node_modules/@opencode/plugin/dist/effect/agent.d.ts:5-15`). These are not evidence of a persistent agent-configuration editor or HTTP mutation endpoint. Native Markdown/config files are supported configuration sources; the exact durable Settings write path still needs validation.

The inspected global config has no `agents`, `default_agent`, or `instructions` entries, and no global agent Markdown file was found under `~/.config/opencode/agents`. It sets a global default model. This project’s `opencode.json` sets `default_agent` to `architect` and the native `lazers-implementor` model to `openai/gpt-6-luna#max`. The project also has an `AGENTS.md`.

| Instructions or settings       | Where configured today                                                                          | Current boundary                                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Shared/project coding guidance | Global/project `AGENTS.md`, or native config `instructions`                                     | Composed separately from the role's system; usable today.                                                                      |
| Named agent definition         | `~/.config/opencode/agents/<id>.md`, `.opencode/agents/<id>.md`, or native config `agents.<id>` | Markdown body supplies `system`; later native system values replace earlier ones. LAZERS transforms can overwrite that result. |
| LAZERS role base               | Packaged `src/architect.md`, `src/implementor.md`, `src/auditor.md`                             | No user-facing base/extension editor today. Worker persona guidance also comes from `src/personas/*.md`.                       |
| Model and effort               | Native agent model, session selection, and LAZERS Models → Assignments                          | Route selection is not prompt configuration.                                                                                   |

### How LAZERS roles treat native values

- **Architect:** `src/architect.ts:15-37` parses `src/architect.md` and `Object.assign`s that packaged definition onto the agent. That replaces defined packaged fields, including `system`, default permissions, and request defaults. The packaged object omits `model`, so a configured model can remain; a LAZERS route overrides it.
- **Implementor/Auditor:** `src/runner/roles.ts:143-189` replaces `system` with packaged text, combines existing permissions with LAZERS deny rules, leaves request fields alone, and applies a LAZERS route before native model fallback (Auditor also has a plugin default).
- **Planning agents:** `src/planning/register.ts:61-78` replaces system text and permissions with fixed packaged prompts and a read-only ruleset.

These are source-level transform behaviors, not proof of exact live-host transform ordering or effective agent values.

### Operator-measured local registration probe

The operator supplied `.cache/driver/probe-agent-customization.ts`, which seeds the fake Architect editor with a `system` value (`PROJECT_AGENT_EXTENSION`), a shell `ask` rule, a configured model, and a request header, then calls `registerArchitect()` using the fake `AgentEditor`/Effect pattern in `src/architect.test.ts`.

| Probe assertion            | Reported result |
| -------------------------- | --------------- |
| Extension survived         | **false**       |
| Seeded permission survived | **false**       |
| Configured model survived  | **true**        |
| Request/header survived    | **false**       |

This agrees with the shape of `Object.assign` in `src/architect.ts` and the packaged Architect defaults. It is an **operator-reported measurement of the local registration function against a fake editor**, not assembled evidence from a live OpenCode agent, native config merge, or Desktop session. No live agent configuration or production source was changed.

The current native Agents documentation also warns that per-agent `request` overlays are preserved but not yet sent by the V2 runner. The probe establishes lost configuration data at registration; it does **not** establish a live request-header, authentication, or transport failure.

## Current model customization state

Model routes are versioned LAZERS records, separate from prompt definitions (`src/models/agent-ids.ts`, `src/models/mapping-store.ts`). The stored project routes for `ui`, `systems`, and `small-refactoring` are `openai/gpt-6-luna#max`. A project Architect mapping is explicitly empty and therefore falls back to the shared Architect route, `openai/gpt-6.1-sol` (`src/models/mapping-resolver.ts:21-46`). These routes control model/effort, not prompt text.

## Custom scheduled agents and proposed increments

OpenCode native definitions alone do **not** make a new ID schedulable by LAZERS. The accepted `WorkerAgent` type is fixed to `lazers-implementor` and `auditor` (`src/runner/worker-agent.ts:1-10`). `ModelMappingSubject` is also an explicit allowlist of three personas plus `architect`, `lazers-implementor`, `auditor`, and `lazers-planning` (`src/models/agent-ids.ts:4-24`). Thus native custom agents can exist for OpenCode use, but making one a LAZERS worker would require changes beyond its native definition: at least LAZERS worker/dispatch validation and route-subject support. The exact integration points remain for later review; no new architecture is proposed here.

**Proposed coherent increments, not an implementation plan or dispatch:**

1. **Truthful, project-scoped verification summary.** Show active/no-profile state, revision, and dated setup-proof warnings for the selected project. Put commands, failure details, source filters, environment names, map snapshots, and history under advanced details. Preserve optional setup and normal work without a profile; do not add confirmation or health gates.
2. **Settings → Agents: packaged base plus editable project supplement.** Show the packaged base separately from the user's per-agent, per-project supplemental instructions, their source, and the effective composition. Keep **one durable authority**: native configuration files where practical, otherwise the existing canonical project settings—not parallel copies. Preserve unrelated permissions, request fields, and model settings. Correct LAZERS registration narrowly so base + supplement remains stable across replay/reload; native `system` scalar merging does not do this automatically. Apply the canonical project's preferences across native worktrees, including uncommitted project preferences rather than relying on committed files being copied. Validate the exact backing/edit path; do not assume a persistent `agent.editor` API. `AGENTS.md`/native `instructions` continue supplying common guidance alongside it. Do not introduce a second agent framework. **Models remains responsible for model/effort/cost routing, with links to agent configuration rather than a competing prompt editor.**
3. **Native custom workers, if included.** Define custom agents through native OpenCode capabilities and integrate their IDs with existing LAZERS worker validation, role/mapping, dispatch, and trajectory/reporting flows. Native definitions alone cannot satisfy the fixed-ID boundaries above. Keep this additional scope explicit; do not make it a prerequisite for packaged-agent project supplements.

**Genuinely open details:**

- **Custom-agent scope:** whether arbitrary scheduled workers are included in this change, which existing worker semantics they inherit, and how they appear in role mappings and trajectory.
- **Backing/edit path to validate:** native project agent Markdown or config where practical, otherwise existing canonical project settings, with one authority and no invented persistent editor API. Preserve existing native sources and unrelated fields; establish handling when both native file forms define the same ID. Per-project supplements remain required; optional global supplements are additional scope.
- **Worktree inheritance mechanism:** applying canonical-project supplements across native worktrees, including uncommitted/local preferences, is required. How to provide that inheritance, and whether an existing attempt keeps its initial instructions or receives later edits, needs validation. Do not assume canonical-project files are automatically present in every worktree.

These details do not reopen the clear base-plus-project-extension requirement. No Settings implementation is authorized by this report.

Required composition, **not current guaranteed behavior**:

```text
LAZERS packaged role base + native configured per-role system addition
  → native OpenCode instruction assembly
      + global/project AGENTS.md and configured instructions
      + normal skills, references, environment and session instructions
```

These increments share existing sources and runtime authority. They do not add approval gates, make setup mandatory, or alter either active Review worker.

## Remaining evidence limits

- The `registerArchitect()` probe is an isolated fake-editor measurement, not a live OpenCode 2.4.1 observation. No effective native-plus-LAZERS agent was inspected in the regular Desktop.
- The stored `tjw` registration has no causal activity evidence tying it to the earlier location-less `api form.list` read; intent remains unknown.
- The operator’s Settings observations may be updated by further regular Desktop inspection. This report is usable without that follow-up.
- The root cause of the old Cargo format failure and the current validity of all stored commands were not reproduced. The operator's tail mentioning a `files` field is a research lead, not a diagnosed cause. Updating a profile or rerunning setup would be separate authorized work.
- If an active stored payload no longer parses, current readers return no profile (`src/projects/profile-store.ts:207-215,367-405`). A concise UI should distinguish missing from invalid/unreadable state rather than silently suggesting initial setup; this review did not reproduce a corrupt profile.

## Source index

- Settings registration and Desktop/non-Desktop composition: `src/gui.tsx:108-190,464-621`
- Project controls and verification editor: `src/projects/gui.tsx:197-287,291-429,432-485`; `src/projects/profile-gui.tsx:70-73,241-333`
- Setting definitions/defaults: `src/projects/setting-schemas.ts:35-48`
- Budget and retention: `src/budget/gui.tsx:200-272`; `src/retention/gui.tsx:148-336`
- Profile schema, activation, unattended eligibility: `src/projects/profile.ts:8-16`; `src/projects/profile-store.ts:262-340`; `src/projects/profile-runtime.ts:53-70`
- Packaged Architect and worker prompts: `src/architect.md`; `src/implementor.md`; `src/auditor.md`
- Local probe and matching fake editor: `.cache/driver/probe-agent-customization.ts`; `src/architect.test.ts:8-68`
- Installed API boundary: `node_modules/@opencode/client/dist/effect/api/api.d.ts:112-115`; `node_modules/@opencode/plugin/dist/effect/agent.d.ts:5-15`
- Native docs: [OpenCode Agents](https://opencode.ai/docs/agents), [Instructions](https://opencode.ai/docs/rules), [Config](https://opencode.ai/docs/config), [Permissions](https://opencode.ai/docs/permissions)
