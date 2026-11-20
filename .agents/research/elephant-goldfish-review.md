# google/elephant-goldfish-model: what LAZERS should take

Read-only review. Nothing in either repository was changed except this file. No file from the clone was run.

- `egm:` = clone at `/private/tmp/claude-501/-Users-tjw-Documents-ChatGPT-opencode-lazers/b47493ed-6bdc-45ea-82fa-61d28bfbfe2d/scratchpad/research/egm/repo`, commit `70406c4d22cc7ea8299637c2c5b44625c48b3f08` (2026-11-17), plugin version 0.1.1 (`egm:plugin.json:4`).
- `lz:` = `/Users/tjw/Documents/ChatGPT/opencode-lazers` on `main`.
- `db:` = read-only queries on `~/.local/share/opencode/plugins/lazers/tasks.sqlite` run 2026-11-20 (queries in the appendix).

## Summary

| Owner's reading                                        | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Basis                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| (1) LAZERS already follows the elephant/goldfish split | **Mostly true for execution, false for planning.** Workers are fresh-context sessions given only the task (`lz:src/runner/roles.ts:143-182`, `lz:docs/reference/contributor-contracts.md:90`). The one pre-dispatch reviewer, `lz-verify-task`, is a 2B local model that sees only the task JSON, the request and evidence strings the Architect chooses (`lz:src/webgpu/task-review.ts:13-27`). It has no read access to code. Nothing with fresh context and code access reviews a plan before dispatch.                                                          | `egm:README.md:18`, `egm:docs/designs/review.md:27-38` |
| (2) Goldfish plan hardening would help                 | **Plausible, unproven, and the cost is not small against LAZERS' measured waste.** EGM publishes no benefit measurement (`egm:docs/faq.md:41-46`). Two passes cost about $0.4-0.9 per plan; the expected repair spend per plan is about $0.33 (median) to $0.82 (p75). Run it selectively and backtest it on recorded plans before turning it on by default.                                                                                                                                                                                                        | Section 3.6                                            |
| (3) Per-folder READMEs                                 | **Reject.** EGM's value there is an LLM-generated index of interface, invariants and side effects (`egm:skills/egm-bootstrap/references/templates.md:13-31`). LAZERS already ships the generated, never-hand-maintained part (paths and exported names, `lz:src/context/repo-map.ts`). Controlled evidence says LLM-written context files cost ~20% more and slightly reduce success (`lz:.agents/research/agent-memory-evidence.md:85,103`). EGM itself says READMEs "may be unnecessary" when designs reference the code (`egm:docs/getting_started.md:135-138`). | Section 5                                              |

Top recommendations, in order:

1. **Deterministic plan pre-pass (S, adopt).** No model. Check every path in `writeScope`, `context`, `guidance` and verification commands against the repository map; list same-plan write-scope overlaps without a dependency edge. Mirrors EGM's deterministic false-positive filter (`egm:.github/scripts/review_pr.py:638-683`).
2. **Two fresh-context passes, Readiness and Grounding, run by a runtime tool on the draft plan (M, adapt).** Typed findings, Architect dispositions, never a gate. Section 3.
3. **Backtest before default-on (S, adopt).** Replay the reviewer on recorded plans that later needed repair, scope decisions or takeover, the same way `lz:scripts/replay-concerns.ts` tunes the struggle detector (`lz:design/runtime-state-machines.md:484-486`).
4. **Fresh-context diff review of an accepted multi-task plan before integration (M, adapt).** The Sol review found 4 blockers in 37 already-integrated units (`lz:.agents/reviews/2026-11-20-sol/INDEX.md:3`), which verification, Fallow and Architect review did not catch.

---

## 1. The model in one page

### Roles and what each holds

| Role                          | Holds in context                                                                              | Job                                                                                                              | Source                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Elephant (main agent)         | Project, requirements, earlier decisions, the whole conversation                              | Explores, drafts, resolves findings, edits the document                                                          | `egm:README.md:18,116`; `egm:docs/designs/architecture.md:42-45` |
| Goldfish (subagent reviewers) | The document, a "GoldfishContext" reading list, its persona and one standard. No conversation | Find unstated assumptions, unclear requirements, risks                                                           | `egm:README.md:117`; `egm:skills/egm-review-loop/SKILL.md:24-27` |
| Synthesizer                   | Reviewer reports only                                                                         | Spawns reviewers (optionally two instances A/B each), deduplicates, assigns Blocker/Major/Nit, writes the report | `egm:agents/synthesizer.md:9-14,40-63`                           |
| Human                         | Goals and constraints                                                                         | Trade-offs, approval, what to build                                                                              | `egm:README.md:118`                                              |

Reviewer personas (all share "read-only, no history, no chit-chat" mandates, e.g. `egm:agents/design_critic.md:11-13`):

| Persona                    | Catches                                                                                                            | Source                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zoom_out`                 | YAGNI, reinvention (must code-search), premature detail, symptom-not-root fixes, dead ends                         | `egm:agents/zoom_out.md:44-55`; standard `egm:resources/document_standards/zoom-out-standard.md:14-60`                                             |
| `comprehension`            | Writes a paraphrase first; an unparaphrasable section is a Blocker; undefined project terms; assumed prerequisites | `egm:agents/comprehension.md:37-48,57`                                                                                                             |
| `design_critic`            | Unbacked assumptions, unmitigated risks, missing standard sections                                                 | `egm:agents/design_critic.md:37-44`                                                                                                                |
| `implementation_readiness` | Decisions left to the implementer; vague steps; missing file list or tests                                         | `egm:agents/implementation_readiness.md:37-43`; "Zero-Decision Rule" `egm:resources/document_standards/implementation-readiness-standard.md:12-18` |
| `codebase_details`         | Document contradicts code (Blocker); non-existent references; proposed files are not findings                      | `egm:agents/codebase_details.md:37-50`                                                                                                             |
| `structural`, `style`      | Heading/template conformance; tone, hedging (`DROP/CALIBRATE/RELOCATE/KEEP`)                                       | `egm:agents/structural.md:37-46`; `egm:agents/style.md:37-48`                                                                                      |
| `inventive_catalyst`       | TRIZ "false compromise" patterns, must say "No false compromise detected" when none                                | `egm:agents/inventive_catalyst.md:29-71`                                                                                                           |

Output format of every reviewer is free prose with Severity, Affected Scope, Rationale (`egm:agents/design_critic.md:52-56`). Only the synthesizer and the CI PR reviewer impose structure (`egm:agents/synthesizer.md:45-63`; JSON in `egm:.github/scripts/review_pr.py:1135-1148`).

### Lifecycle of a design

```
/egm-brainstorm ──► 7 goldfish in BRAINSTORM mode ──► concepts_brief.md
/egm-draft      ──► section by section, human gate per section ──► design_draft.md
/egm-review     ──► Stage 5 zoom_out + inventive_catalyst (whole doc)
                    Stage 6 comprehension (feature + plan ranges, no standard, no synthesizer)
                    Stage 7 design_critic + structural + style (feature range)   ─┐ egm-review-loop
                    Stage 8 zoom_out again (focus on additions from 6-7)          │ + egm-resolve
                    Stage 9 implementation_readiness + codebase_details + style ─┘ (plan range)
human approves ──► coding agent implements ──► /egm-drift-report periodically
```

Sources: `egm:docs/designs/architecture.md:88-169`; stages `egm:skills/egm-review/SKILL.md:282-303`; semantic split at `## Detailed Implementation Plan` `egm:skills/egm-review/SKILL.md:179-207`.

Artefacts: `concepts_brief.md`, `design_draft.md` → `docs/designs/<name>.md`, per-stage reports (`zoom_out_report.md`, `comprehension_report.md`, `critic_report.md`, `intermediate_zoom_out_report.md`, `implementation_readiness_report.md`), `consolidated_review_report.md`, `goldfish_review_report.md`, `egm_lite_checklist.md`, `{date}_DRIFT_REPORT.md`, generated per-folder `README.md` (`egm:docs/designs/architecture.md:160-167`; `egm:skills/egm-drift-report/SKILL.md:47`).

### Skills and adapters

| Skill              | What it does                                                                                                 | Source                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `egm-brainstorm`   | Multi-turn open questions, then 7 goldfish lenses, writes brief                                              | `egm:skills/egm-brainstorm/SKILL.md:104-210`            |
| `egm-draft`        | Template with a mandatory "Detailed Implementation Plan" listing files Create/Modify and a verification plan | `egm:skills/egm-draft/references/design_doc.md:139-171` |
| `egm-review`       | The 5-stage pipeline with 4 presets and per-stage human gates                                                | `egm:skills/egm-review/SKILL.md:121-224`                |
| `egm-review-loop`  | Reviewer swarm, stable finding IDs, settled/fixed/clean/converged/churn rules                                | `egm:skills/egm-review-loop/SKILL.md:103-181`           |
| `egm-resolve`      | Elephant classifies each finding CONTEST / ESCALATE / PROPOSE FIX / DECLINE                                  | `egm:skills/egm-resolve/SKILL.md:54-82`                 |
| `egm-lite`         | Checklist → optional goldfish spec review → exec → goldfish diff review, P0-P3                               | `egm:skills/egm-lite/SKILL.md:96-428`                   |
| `egm-drift-report` | Compares design docs or READMEs with code, reports only differences                                          | `egm:skills/egm-drift-report/SKILL.md:21-66`            |
| `egm-bootstrap`    | Generates per-folder README "contracts" bottom-up with explorer scouts                                       | `egm:skills/egm-bootstrap/SKILL.md:13-25,206-341`       |

Adapters are packaging for Claude Code, Codex, Cursor, Copilot, Windsurf, Gemini and OpenCode V1. The OpenCode adapter is experimental, targets V1 `task`/`permission` 1.18.29, and denies reviewers everything but `read` and `glob` (`egm:docs/opencode.md:3-8,92-101`). It states that "a fresh child session alone does not prove Goldfish isolation" (`egm:docs/opencode.md:116-117`).

### How it is evaluated: assertion, plus harness plumbing evidence

| Claim                                                                                                   | Evidence in the repository                                                                                                                                                                                              | Kind                                                                                                                |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Goldfish reviews improve designs                                                                        | None measured. FAQ: "Completing the EGM workflow alone does not demonstrate a productivity improvement" (`egm:docs/faq.md:45-46`)                                                                                       | Assertion                                                                                                           |
| `test_scenarios.yaml` "evaluating model review precision and recall" (`egm:docs/designs/review.md:186`) | No runner exists. The only test checks the YAML has `scenario_id`, `eval_type`, `turns` (`egm:tests/unit/test_scenario_coverage.py:23-53`); no code reads `required_pattern` (grep of `tests/`, `scripts/`, `.github/`) | Assertion; the scenarios are regex checks on single prompts, e.g. `egm:skills/egm-review/test_scenarios.yaml:79-89` |
| A/B duplicate reviewers raise recall (`egm:docs/designs/synthesizer.md:62-65`)                          | No measurement                                                                                                                                                                                                          | Assertion                                                                                                           |
| Reviewers are isolated from the parent conversation                                                     | Live probes with a random marker and trace verifiers per harness (`egm:TESTING.md:89-102,137-152`; `egm:tests/integration/opencode_trace_verifier.py`)                                                                  | Real evidence, but of plumbing, not of review quality                                                               |
| Unit tests                                                                                              | Offline: frontmatter, links, packaging, manifests (`egm:TESTING.md:43-46`)                                                                                                                                              | Real, structural only                                                                                               |

Their testing discipline is strict about what counts as a pass ("A failed workflow or missing native evidence is not a pass", `egm:TESTING.md:133`; "a persona read request alone is not a successful read", `egm:TESTING.md:171-174`). The benefit of the method itself is not measured anywhere.

---

## 2. Correspondence table

| EGM principle or mechanism                                             | LAZERS today                                                                                                                                                                            | Rating                                                                                                                         |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Long-context author (Elephant)                                         | Architect: long-lived, continuity checkpoint, renewal (`lz:src/architect.md:28-32,158-162`)                                                                                             | **Same**                                                                                                                       |
| Fresh-context executors                                                | Workers are native sessions given only `lz-get-task` + map (`lz:docs/reference/contributor-contracts.md:90`); delegation denied (`lz:src/runner/roles.ts:161-167`)                      | **Stronger** (EGM has no executor role; implementation is "ask your coding agent", `egm:docs/designs/architecture.md:157-159`) |
| Fresh-context reviewers of the plan with code read access              | `lz-verify-task`: fresh, but a 2B local model, no code access, only Architect-chosen evidence strings (`lz:src/webgpu/task-review.ts:13-27,203-207`; `lz:src/webgpu/review-tool.ts:24`) | **Weaker**                                                                                                                     |
| Paraphrase test (comprehension)                                        | Absent                                                                                                                                                                                  | **Absent**                                                                                                                     |
| Zero-decision rule for plans                                           | Partly opposite by design: LAZERS leaves routine choices to the worker (`lz:src/architect.md:24-26,75-77`; `lz:.agents/docs/task-authoring.md:3-4`)                                     | **Different on purpose** (keep LAZERS' rule; check only _material_ decisions)                                                  |
| Code-grounding of plan claims (`codebase_details`)                     | Absent before dispatch; map is delivered to Architect (`lz:src/architect.md:18-21`)                                                                                                     | **Absent**                                                                                                                     |
| Reuse / YAGNI review (`zoom_out`)                                      | Fallow duplication and dead code after the change (`lz:docs/reference/contributor-contracts.md:53`)                                                                                     | **Weaker pre-dispatch, stronger post-change**                                                                                  |
| Verification discriminates (would a broken implementation pass?)       | `lz-verify-task` asks this per assertion, without reading tests (`lz:src/webgpu/review-questions.ts:68-76`)                                                                             | **Weaker** (no code access)                                                                                                    |
| Write boundary list                                                    | Typed `writeScope` / `createScope` / `protectedScope`, enforced at verify (`lz:src/task.ts:55-81`; `lz:design/runtime-state-machines.md:281-306`)                                       | **Stronger** (EGM: "a convention, and nothing enforces it", `egm:docs/designs/architecture.md:160-167`)                        |
| Dependency graph checks                                                | Cycles, order, duplicates, missing nodes (`lz:src/runner/schema.ts:129-171`); overlapping scopes serialize (`lz:docs/reference/contributor-contracts.md:29`)                            | **Stronger** (EGM has no graph)                                                                                                |
| Hidden dependency / scope-overlap judgement                            | Overlap warning only at mechanical preparation (`lz:src/runner/runtime.ts:10841-10846`)                                                                                                 | **Weaker** (neither does it semantically)                                                                                      |
| Typed findings with severity                                           | Fallow package (`lz:src/audit/contract.ts:106-145`); detector findings (`lz:src/recovery/detector.ts:98-107`)                                                                           | **Stronger** (EGM reviewers emit prose)                                                                                        |
| "Not run" is never "zero findings"                                     | `classesNotChecked`, "Never presented as zero findings" (`lz:src/audit/contract.ts:154`)                                                                                                | **Same** (`egm:agents/synthesizer.md:41`)                                                                                      |
| Author must contest with checkable evidence; cannot downgrade severity | Absent for reviews; scope divergence asks for a reason (`lz:.agents/docs/task-authoring.md:74-84`)                                                                                      | **Absent**                                                                                                                     |
| Settled findings do not reopen; fixed ones do; churn detection         | `lz-verify-task` progression: rounds, fingerprint replay, focus (`lz:src/review/progression.ts:1-60`)                                                                                   | **Weaker** (no churn rule)                                                                                                     |
| Round cap 5 / 1 re-audit per stage                                     | `lz-verify-task` caps 3 rounds (`lz:src/review/progression.ts:1`)                                                                                                                       | Both have caps; owner rule rejects caps that refuse work                                                                       |
| Human gate at every stage, one question per turn                       | Owner asked only for material decisions via native question tool (`lz:src/architect.md:22-26`)                                                                                          | **Stronger for the owner** (no gates)                                                                                          |
| Fresh-context diff review of implemented work                          | Verification checks + Fallow + scope classification + Architect review (`lz:src/architect.md:100-104`); no fresh reviewer                                                               | **Different**: deterministic is stronger; adversarial fresh review absent                                                      |
| Two-pass review: hunt, then a fresh pass that tries to disprove        | Absent                                                                                                                                                                                  | **Absent** (`egm:.github/scripts/review_pr.py:1162-1216`)                                                                      |
| Deterministic filter of reviewer claims against the repo inventory     | Absent; the inventory exists (repo map)                                                                                                                                                 | **Absent, cheap**                                                                                                              |
| Untrusted input fenced with a per-call nonce tag                       | Not for reviewer prompts                                                                                                                                                                | **Absent** (`egm:.github/scripts/review_pr.py:1074-1079`)                                                                      |
| Struggle detection and takeover                                        | Detector rules tuned on history, takeover machine (`lz:src/recovery/detector.ts:32-62`; `lz:design/runtime-state-machines.md:477-528`)                                                  | **Stronger** (EGM-lite only halts on "convergence stalls", `egm:skills/egm-lite/SKILL.md:268-272`)                             |
| Drift report docs vs code                                              | Map is regenerated, never hand-kept (`lz:docs/reference/contributor-contracts.md:90`)                                                                                                   | **Not needed** for the map; see section 4 for contracts docs                                                                   |
| Per-folder README contracts                                            | Repo map (paths + exports), contracts doc, tests                                                                                                                                        | **Rejected** (section 5)                                                                                                       |
| Measurement of benefit                                                 | Detector thresholds carry measured base rates (`lz:src/recovery/detector.ts:33-61`); cost basis rules (`lz:docs/reference/contributor-contracts.md:112-120`)                            | **Stronger**                                                                                                                   |

---

## 3. Plan hardening in depth

### 3.1 Exactly what EGM runs on a plan

| Item                            | EGM detail                                                                                                                                                                                                                                    | Source                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Agents on the plan part         | Stage 9: `implementation_readiness` + `codebase_details` + `style`, standard `implementation-readiness-standard`                                                                                                                              | `egm:skills/egm-review/SKILL.md:300-303,398-405`                                      |
| Agents on the design part       | Stage 5 `zoom_out` + `inventive_catalyst`; Stage 6 `comprehension`; Stage 7 `design_critic` + `structural` + `style`; Stage 8 `zoom_out`                                                                                                      | `egm:skills/egm-review/SKILL.md:287-299`                                              |
| Prompt                          | Persona file + "Mode: REVIEW" + target file and line range + standard + GoldfishContext; "Pass the prompt verbatim"                                                                                                                           | `egm:skills/egm-review-loop/SKILL.md:117-135`; `egm:skills/egm-review/SKILL.md:21-27` |
| Inputs                          | Target doc, linked files inside the working dir added automatically, others need approval; URLs saved to files                                                                                                                                | `egm:skills/egm-review/SKILL.md:101-119`                                              |
| Forbidden to see                | Parent history, private reasoning, memory, unsolicited earlier findings; Stage 6 sees the document alone (no GoldfishContext)                                                                                                                 | `egm:docs/opencode.md:76-81`; `egm:skills/egm-review/SKILL.md:118-119`                |
| Lite spec review                | Checklist injected "stripping conversational history"; must not do AST/diff checks; rubric = scope/YAGNI, contract tagging, edge cases, test plan actionability; binary `[✅ LGTM]` or P0-P3 findings; skip settled CONTESTs                  | `egm:skills/egm-lite/SKILL.md:202-220`                                                |
| Output                          | Severity [Blocker/Major/Nit] + scope + rationale, free prose; comprehension starts with two paraphrase headings                                                                                                                               | `egm:agents/implementation_readiness.md:51-55`; `egm:agents/comprehension.md:57`      |
| Aggregation                     | Flat list, stable IDs `<reviewer>-<round>-<n>`, failed reviewer retried once then `not run`                                                                                                                                                   | `egm:skills/egm-review-loop/SKILL.md:136-144`                                         |
| Disagreement                    | Elephant classifies: CONTEST needs evidence the reviewer could read; ESCALATE when the refuting fact is outside readable files; do not add context only a zero-context reader needs; never contest a comprehension gap; never change severity | `egm:skills/egm-resolve/SKILL.md:56-82`                                               |
| Who decides                     | Human: auto-accept, continue, item-by-item, or comment on the report                                                                                                                                                                          | `egm:skills/egm-resolve/SKILL.md:115-178`                                             |
| Passes / stop                   | Clean round = no unsettled Blocker/Major; converged = two consecutive clean rounds; cap 5; churn = new finding at a fixed scope that reverting would resolve; then ask human                                                                  | `egm:skills/egm-review-loop/SKILL.md:157-181`                                         |
| In `/egm-review`                | Max 1 re-audit per stage, then residuals "documented as accepted trade-offs"                                                                                                                                                                  | `egm:skills/egm-review/SKILL.md:271-275`                                              |
| CI PR review (implemented work) | Pass 1 hunts Blocker/Major on changed lines only, ≤N findings, JSON; Pass 2 is a fresh "disproof" pass over the candidates; then a deterministic filter drops claims that a path is missing when it exists                                    | `egm:.github/scripts/review_pr.py:1081-1160,1162-1216,638-683`                        |

### 3.2 Failure modes: who catches what

| Failure mode                                       | EGM reviewer                                                                                                                                   | LAZERS today                                                                                                                                                                   | Gap                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Ambiguity                                          | `comprehension` paraphrase (`egm:agents/comprehension.md:37`)                                                                                  | `lz-verify-task` "acceptance covers objective" (`lz:src/webgpu/review-questions.ts:24-31`)                                                                                     | No paraphrase; the Architect never sees how a fresh reader reads the task          |
| Missing acceptance criteria                        | `implementation_readiness` vs standard (`egm:agents/implementation_readiness.md:39-43`)                                                        | Same check as above, plus cancellation/performance probes (`lz:src/webgpu/review-questions.ts:50-67`)                                                                          | Covered for request→task, not for "how does a worker know it is done"              |
| Untestable requirements / weak verification        | Lite "test plan actionability" (`egm:skills/egm-lite/SKILL.md:219-220`)                                                                        | "Could verification pass while this assertion is false?" judged without reading tests (`lz:src/webgpu/review-questions.ts:68-76`)                                              | Needs code access: does the named test file exist and exercise the assertion       |
| Hidden dependencies                                | None explicit (EGM has no task graph)                                                                                                          | Schema checks only (`lz:src/runner/schema.ts:141-152`)                                                                                                                         | Absent in both                                                                     |
| Scope overlap                                      | None                                                                                                                                           | Serialization and a late warning (`lz:src/runner/runtime.ts:10841-10846`)                                                                                                      | Not reported to the Architect at plan time                                         |
| Scope too narrow (needed files outside writeScope) | File boundary in standard (`egm:resources/document_standards/implementation-readiness-standard.md:29-33`)                                      | Asked of the 2B model without code (`lz:src/webgpu/review-questions.ts:107-115`); measured cost: 67 `SCOPE_AMENDED` in 44 plans, 16 `SCOPE_DECISION_REQUIRED` in 14 (`db:` Q3) | Highest-yield target: it is answerable by reading code                             |
| Assumptions vs real code                           | `codebase_details` "Contradicts the Code", "Non-Existent References" (`egm:agents/codebase_details.md:47-50`)                                  | "Does the evidence establish this assumption?" over Architect-supplied strings (`lz:src/webgpu/review-questions.ts:97-106`)                                                    | Absent with code access                                                            |
| Risk                                               | `design_critic` (`egm:agents/design_critic.md:39-44`)                                                                                          | Self-declared `requirements.risk` (`lz:src/task.ts:118`); 97 high, 133 medium, 28 low of 258 tasks (`db:` Q5)                                                                  | The declared risk does not discriminate                                            |
| Wrong decomposition                                | `zoom_out` altitude, standard "phases leave a buildable state" (`egm:resources/document_standards/implementation-readiness-standard.md:20-23`) | Prompt rules (`lz:src/architect.md:41-47`)                                                                                                                                     | Absent as review; low priority because 195 of 219 plans are single-task (`db:` Q4) |
| Reinvention / YAGNI                                | `zoom_out` must code-search (`egm:agents/zoom_out.md:45`)                                                                                      | Fallow duplication after the fact                                                                                                                                              | Pre-dispatch absent                                                                |

### 3.3 The LAZERS version

Principles carried over: fresh context; read access to the code; a typed finding list; the author answers each finding with checkable evidence; a reviewer that did not finish is "not run", never "clean". Principles not carried over: human gates per stage, round caps, the zero-decision rule in full, prose findings, the synthesizer (the runtime aggregates deterministically).

The key LAZERS fact that shapes the design: **a worker sees only `lz-get-task` and the frozen map** (`lz:docs/reference/contributor-contracts.md:90`). So the reviewer should see exactly that, per task, plus the other tasks of the plan. It should not see the owner's request: request coverage stays with `lz-verify-task`, which takes the request (`lz:src/webgpu/task-review.ts:15`). This split gives each reviewer one question it can answer.

```
Architect drafts tasks (lz-verify-task per task, as today)
        │
        ▼
lz-review-plan {draft}                        ◄── one tool, runtime-built prompts
        │
        ├─ P0 deterministic (no model) ───────────┐
        ├─ P1 Readiness  (fresh native session) ──┤  run in parallel
        └─ P2 Grounding  (fresh native session) ──┘
        │
        ▼
PlanReview {findings[], paraphrases[], status per pass}
        │
Architect: lz-resolve-plan-review {dispositions}   (revise | contest | escalate | decline)
        │
lz-submit-task … lz-submit-plan {reviewID?}  ── never refused for review reasons
```

**Where it runs.** A new tool `lz-review-plan` takes the draft inline, in the same shape the Architect will submit: `{ tasks: TaskProposal[] (each with a local key), plan: { dependencies, integrationOrder, acceptance, verification } (by local keys), baseCommit, reviewID? }`. Inline input avoids churn: submitted task specs are immutable (`lz:docs/reference/contributor-contracts.md:31`), so reviewing after `lz-submit-task` would force new tasks per revision. `lz-verify-task` already takes inline task JSON for the same reason (`lz:src/webgpu/task-review.ts:13-27`).

**How the sessions are created and counted.** The runtime, not the Architect, writes the reviewer prompt from the stored draft, the frozen map and a fixed system prompt, so no Architect reasoning can leak in (EGM's rule `egm:docs/opencode.md:76-77`; LAZERS cannot trust a model-written subagent prompt to obey it). Register a hidden subagent `lazers-plan-reviewer` next to Implementor and Auditor (`lz:src/runner/roles.ts:143-182`) with: native read, grep, glob; `lz-get-task`/`lz-inspect-plan` reads; deny edit, patch, shell, webfetch, `subagent`, every `lz-submit*`/`lz-plan-command` (same deny list as `lz:src/runner/roles.ts:161-167` plus edit/shell). Create its sessions with the host calls the runner already uses (`lz:src/runner/native.ts:1089-1188`). Count each as a `native` admission with the Architect session as parent (`lz:src/runner/delegated-agent-capacity.ts:304`; queueing at `lz:src/runner/roles.ts:215-240`), so the per-project limit applies and Architect work stays uncounted (`lz:README.md:5`). A reviewer is a tool call, like `lz-verify-task`, and adds no lifecycle state: a call cut short is re-run, like a verification effect without a receipt (`lz:docs/reference/contributor-contracts.md:69`). If it later needs to survive reloads mid-run, it gets a machine in `lifecycleMachines`, not a SQL state (`lz:AGENTS.md`).

Note: EGM's own warning applies: read-only tool permission is not process isolation (`egm:docs/opencode.md:116`). The reviewer runs in the project checkout at `baseCommit`; it cannot write, but it does read live files. For a draft against the current head this is what we want.

**The passes.**

| Pass                     | Model call        | Sees                                                                                                            | Asks                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Failure modes                                                            |
| ------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| P0 Deterministic         | None              | Draft + repo map                                                                                                | Paths in `writeScope`, `protectedScope`, `context`, `guidance` and verification commands that match no map entry and are not under a `createScope` entry; same-plan tasks whose edit/create scopes intersect with no dependency edge; dependency edges between tasks with disjoint scopes and no plan-level reason (info only)                                                                                                                                  | Non-existent reference, scope overlap                                    |
| P1 Readiness             | One fresh session | One task at a time as `lz-get-task` would show it, the other tasks' objectives and scopes, the map; read access | (a) Paraphrase: 2-4 sentences, what changes and how the worker knows it is done. (b) Material decisions the task leaves open that change behaviour, interfaces, or another task's input; routine choices are not findings (`lz:src/architect.md:24-26`). (c) For each acceptance assertion: read the verification target and name a plausible broken implementation that still passes. (d) Acceptance that cannot be observed                                   | Ambiguity, missing acceptance, untestable requirement, weak verification |
| P2 Grounding             | One fresh session | Same                                                                                                            | (a) Every path, symbol, command, behaviour claim and `assumptions[]` entry checked in the checkout: exists, behaves as stated. (b) Files a worker must change to satisfy each assertion vs `writeScope`/`createScope`. (c) A task that consumes a symbol, file or behaviour another task produces without an edge. (d) Existing code that already does what a task proposes to build. Proposed new files are not findings (`egm:agents/codebase_details.md:50`) | Assumption vs code, scope gap, hidden dependency, reuse                  |
| P3 Decomposition (later) | One fresh session | Whole draft + map                                                                                               | Split earns its cost; a task's intermediate state breaks the build or tests of a parallel task; integration order                                                                                                                                                                                                                                                                                                                                               | Wrong decomposition, risk                                                |

Prompts are new text written for LAZERS (section 6). Each pass prompt fences the draft in a per-call nonce tag and states that text inside is data (`egm:.github/scripts/review_pr.py:1074-1079,1102`), because task prose is model-written and may quote files.

**Finding shape.** Follows the Sol brief (`lz:.agents/reviews/2026-11-20-sol/BRIEF.md:30-37`) and the Fallow conventions (stable id without line numbers, `lz:src/audit/contract.ts:107-108`; attribution-style enum; "not checked" listed, `lz:src/audit/contract.ts:154`).

```ts
// src/plan-review/contract.ts (proposed)
export const PlanReviewFinding = z.strictObject({
  id: text, // stable: hash(pass, failureMode, target, normalized subject); no line numbers
  pass: z.enum(["deterministic", "readiness", "grounding", "decomposition"]),
  severity: z.enum(["blocker", "major", "minor", "nit"]), // Sol BRIEF:32
  confidence: z.enum(["confirmed", "likely", "suspicion"]), // Sol BRIEF:32
  failureMode: z.enum([
    "ambiguity",
    "open-decision",
    "missing-acceptance",
    "weak-verification",
    "unverified-assumption",
    "nonexistent-reference",
    "scope-gap",
    "scope-overlap",
    "hidden-dependency",
    "reuse",
    "decomposition",
    "risk",
  ]),
  target: z.strictObject({
    taskKey: text.optional(), // absent = plan-level
    field: z.enum([
      "objective",
      "acceptance",
      "verification",
      "writeScope",
      "createScope",
      "protectedScope",
      "constraints",
      "assumptions",
      "exclusions",
      "guidance",
      "context",
      "dependencies",
      "integrationOrder",
      "plan.acceptance",
      "plan.verification",
    ]),
    item: text.optional(), // acceptance/verification id or array index
  }),
  what: text, // one or two sentences
  failureScenario: text, // concrete: "worker edits X, test Y still passes because ..."
  evidence: z.array(
    z.strictObject({ path: text, line: z.int().nonnegative().optional(), note: text }),
  ),
  suggestion: text.optional(),
})
export const PlanReviewPass = z.strictObject({
  pass: PlanReviewFinding.shape.pass,
  status: z.enum(["completed", "not-run"]),
  reason: text.optional(), // why not-run; never rendered as zero findings
  paraphrases: z.array(z.strictObject({ taskKey: text, text })).optional(), // readiness only
  findings: z.array(PlanReviewFinding),
  usage: z.strictObject({
    model: text,
    input: z.int().nullable(),
    cacheRead: z.int().nullable(),
    output: z.int().nullable(),
  }),
})
```

A Blocker needs `confidence !== "suspicion"` and at least one `evidence` entry the reviewer read; otherwise the runtime records it as Major (a parse rule, not a model judgement). Reviewer claims that a path is missing are re-checked against the map and dropped if the path exists, as EGM's CI does (`egm:.github/scripts/review_pr.py:672-682`).

**How the Architect responds.** `lz-resolve-plan-review {reviewID, responses: [{findingID, disposition, note, evidence?}]}`:

| Disposition | Rule                                                                                                                                                                  | EGM origin                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `revised`   | The draft changed at the target                                                                                                                                       | PROPOSE FIX                                             |
| `contested` | Must cite evidence the reviewer could read: `path:line` or a plan field                                                                                               | CONTEST, `egm:skills/egm-resolve/SKILL.md:58-60,71-73`  |
| `escalated` | The refuting fact is outside the repository; becomes a native question to the owner only when it changes behaviour, scope or acceptance (`lz:src/architect.md:24-25`) | ESCALATE, `egm:skills/egm-resolve/SKILL.md:61-63,74-76` |
| `declined`  | Allowed for `minor` and `nit` only                                                                                                                                    | DECLINE, `egm:skills/egm-resolve/SKILL.md:66-67`        |

Two EGM rules worth keeping verbatim in meaning: a paraphrase that differs from intent is a defect in the task, not in the reader (`egm:skills/egm-resolve/SKILL.md:77-78`); and "you wrote the document under review; a wish to contest is not evidence" (`egm:skills/egm-resolve/SKILL.md:81-82`).

**Advice, never a gate.** `lz-submit-plan` takes an optional `reviewID` and records how many blocker/major findings had no disposition; it never refuses. The owner's Tasks panel **Start** stays on the same path (`lz:docs/reference/contributor-contracts.md:41`). The Tasks inspector shows one line per plan, for example `Hardening: 3 revised, 1 contested, 1 open (grounding not run)`. No owner prompt, no hold family (`lz:docs/reference/contributor-contracts.md:66`).

**Rounds and stopping.** One round by default. The Architect may call `lz-review-plan` again with the same `reviewID` after revising; the runtime passes the settled list (contested, escalated, declined) to the reviewers so they do not re-raise it (`egm:skills/egm-review-loop/SKILL.md:162-165`; `egm:skills/egm-lite/SKILL.md:209-210`), and reopens a `revised` finding that comes back (`egm:skills/egm-review-loop/SKILL.md:166-168`). A new finding at a revised target that reverting would resolve is labelled `churn` (`egm:skills/egm-review-loop/SKILL.md:176-177`). There is no round cap: the exit is always available because submission never waits on review. EGM's "two consecutive clean rounds" is not adopted; at about $0.4-0.9 a round it doubles cost for an unmeasured gain.

**Relation to existing reviewers.**

| Reviewer                     | Decision                       | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lz-verify-task`             | **Run alongside; trim later.** | It is the only check that compares the task with the owner's request, and it is local and cheap. Its scope question (`lz:src/webgpu/review-questions.ts:107-115`) and assumption question (`:97-106`) are better answered by P2 with code access; drop them only after the backtest shows P2 finds what they find. Separately: its 64-check refusal (`lz:src/webgpu/task-review.ts:167-173`), 20-evidence cap (`:18`) and 3-round budget (`lz:src/review/progression.ts:1`) are limits that refuse or truncate work, which the owner's rules forbid; worth a separate fix |
| Auditor                      | **Unrelated.**                 | Auditor is a worker for refactors that runs Fallow (`lz:src/auditor.md:1-11`), not a plan reviewer                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Fallow audit                 | **Complementary.**             | P2's reuse question is the pre-dispatch counterpart of Fallow duplication; Fallow stays the post-change truth                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Scope review at verify       | **Complementary.**             | P2 predicts the files; `classifyChange` records what happened (`lz:design/runtime-state-machines.md:283-306`). The pair gives a direct accuracy measure for P2                                                                                                                                                                                                                                                                                                                                                                                                            |
| Struggle detector / takeover | **Downstream outcome.**        | Its concern records are one of the outcome measures (`lz:src/recovery/detector.ts:76-88`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### 3.4 When to run, which model

| Trigger                         | Default                                                                                                                                        | Why                                                                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project setting `planHardening` | `"auto"`; `"always"` and `"off"` available, like `fallowReview` (`lz:docs/reference/contributor-contracts.md:53`)                              | Owner choice, no prompt                                                                                                                                 |
| `auto` runs P0                  | Always                                                                                                                                         | Free                                                                                                                                                    |
| `auto` runs P1+P2               | Plan with ≥2 tasks, or any task whose draft scope intersects an active plan's reserved scope, or the Architect asks                            | 24 multi-task plans vs 195 single (`db:` Q4); self-declared risk does not discriminate (`db:` Q5)                                                       |
| `auto` on single-task plans     | After the backtest, only if it shows a hit rate worth the cost                                                                                 | Single-task plans carry most repairs (42 of 50, `db:` Q6)                                                                                               |
| Model                           | A `plan-reviewer` route resolved like Implementor/Auditor routes (`lz:src/runner/roles.ts:114-130`), default = the project's implementor route | The question is "can the model that will execute this do it without guessing"; the implementor route answers that, and it is cheaper than the Architect |

### 3.5 Expected tokens per pass

Inputs from LAZERS measurements:

- Map, source without tests, paths + exports: 15,435 tokens (`lz:.agents/research/repo-map-cost.md:21`).
- Task body: 258 tasks, mean 5,396 chars (~1.4k tokens), max 45,112 chars (~11k) (`db:` Q5).
- Architect sessions, a proxy for a read-and-judge session: median 15 tool calls, p75 28 (`lz:.agents/research/repo-map-cost.md:119`).
- Prices per million: gpt-6.2-sol 2.00 in / 0.10 cache-read / 2.50 cache-write; opus-5.5 4.00 / 0.20 / 5.00; muse-spark-1.3 1.25 / 0.15 / 0; deepseek-v4-pro 0.90 / 0.25 / 0 (`lz:.agents/research/repo-map-cost.md:128-133`). Output prices are not in that table, so output is not priced here.

Estimate for one pass on a 3-task plan (assumptions marked):

```
prefix      = system ~2k (assumed) + map 15.4k + draft ~4k           ≈ 21k
reads       ≈ 40k new tokens over the session (assumed: ~10 file reads)
requests R  = 15 (median proxy), context grows 21k → ~60k, mean ~45k
new tokens  ≈ 21k + 40k ≈ 60k        (billed at cache-write, or input where no write price)
cache-read  ≈ R·mean − new ≈ 15·45k − 60k ≈ 615k
output      ≈ 5-8k (assumed; unpriced)

cost/pass   gpt-6.2-sol   60k·2.50 + 615k·0.10  = $0.15 + $0.06 = $0.21
            opus-5.5      60k·5.00 + 615k·0.20  = $0.30 + $0.12 = $0.42
            muse-spark    60k·1.25 + 615k·0.15  = $0.08 + $0.09 = $0.17
            deepseek-v4   60k·0.90 + 615k·0.25  = $0.05 + $0.15 = $0.21
at R = 28 (p75): roughly ×1.8
```

Two passes: about $0.35-0.85 per plan before output tokens, plus the Architect's turns to dispose of findings (Architect request usage is not recorded, `lz:.agents/research/repo-map-cost.md:115`).

### 3.6 Does it pay? Baseline and how to measure

Baseline from the runtime's own transitions (`db:` Q1-Q6), 219 plans:

| Outcome                                                      | Plans    | Share     |
| ------------------------------------------------------------ | -------- | --------- |
| Integrated / cancelled                                       | 135 / 71 | 62% / 32% |
| Revised after first submission (`runner_plan_revisions` > 1) | 61       | 28%       |
| `REPAIR` or `RETAINED_REPAIR`                                | 50       | 23%       |
| `SCOPE_AMENDED`                                              | 44       | 20%       |
| `SCOPE_DECISION_REQUIRED`                                    | 14       | 6%        |
| "Combined artifact verification failed" hold                 | 14       | 6%        |
| Takeover requested                                           | 2        | 1%        |

Cost of a repair, from worker attempt medians (`lz:.agents/research/repo-map-cost.md:107-108`) on gpt-6.2-sol: 232,502 × $2.00/M + 9,526,016 × $0.10/M ≈ **$1.42** median, ≈ $3.55 at p75. Expected repair spend per plan ≈ 0.23 × $1.42 ≈ **$0.33** (median) to $0.82 (p75).

Reading: two passes on every plan cost about as much as all repair spend. Many recorded repairs and holds come from runtime defects of the period (the largest `BLOCKED` reasons are host idle observations, `db:` Q2), which plan review cannot prevent. On token cost alone hardening pays only if it prevents a large share of the plan-caused repairs, scope stops and cancellations, or if Architect and wall-clock time saved count. That is why `auto` is selective and why the backtest comes first.

Measurement, in order of cost:

1. **Backtest (before shipping default-on).** Select recorded plans with a repair, scope decision, scope amendment, combined failure or takeover, plus an equal number of clean integrated plans. Rebuild each draft from its first `runner_plan_revisions` body and its tasks at `baseCommit` (`lz:src/runner/schema.ts:93`). Run P0-P2 in a temporary worktree. Score: did a finding target the field that later failed (for scope: P2's predicted files vs the recorded `SCOPE_REPORTED`/`SCOPE_AMENDED` paths); false-positive rate on clean plans. Same pattern as `lz:scripts/replay-concerns.ts`.
2. **Per-finding attribution in production.** For each `revised` finding, did its failure mode recur on that task; for each `contested`/`declined` one, did the predicted failure happen. Gives precision without a randomised trial.
3. **Plan-level comparison.** Hardened vs not-hardened plans on the table above, plus tokens per accepted task, as `lz:docs/reference/contributor-contracts.md:120` requires (include failed attempts; one success is not an optimisation). With ~220 plans in the whole history, a randomised split would need on the order of 200 plans per arm to see 23% → 12%; treat this as a trend check, not proof.

### 3.7 Minimal first version

Two passes: **P0 + P2 Grounding**. P2 targets the largest measurable plan-caused cost (scope amendments and scope stops, 44 + 14 plans) and the failure mode `lz-verify-task` cannot see (claims vs code). P1 Readiness follows if the backtest supports it.

| File                                     | Change                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/plan-review/contract.ts` (new)      | Finding, pass and review schemas above                                                                                                  |
| `src/plan-review/deterministic.ts` (new) | P0 over the frozen map (`lz:src/context/repo-map-store.ts`) and the draft                                                               |
| `src/plan-review/reviewer.md` (new)      | Grounding system prompt, LAZERS text                                                                                                    |
| `src/plan-review/run.ts` (new)           | Build prompt, create native session, parse and validate, retry once, else `not-run`                                                     |
| `src/plan-review/store.ts` (new)         | Append-only `plan_reviews` / `plan_review_responses`, installed like `lz:src/runner/delegated-agent-capacity.ts:297-330`                |
| `src/plan-review/tools.ts` (new)         | `lz-review-plan`, `lz-resolve-plan-review`                                                                                              |
| `src/runner/roles.ts`                    | Register hidden `lazers-plan-reviewer` with read-only permissions (`:143-182`)                                                          |
| `src/runner/schema.ts`                   | Optional `reviewID` on plan submission, recorded, never validated against review state                                                  |
| `src/guidance/plan-review.md` (new)      | Disposition rules, delivered in the first `lz-review-plan` result, per the situational-guidance pattern (`lz:src/architect.md:106-116`) |
| `src/architect.md`                       | One sentence in Specify next to `lz-verify-task` (`:84-86`)                                                                             |
| `scripts/replay-plan-review.ts` (new)    | Backtest                                                                                                                                |
| Tests                                    | Contract parsing, P0 on fixtures, not-run never zero, submit never refused                                                              |

---

## 4. Everything else, ranked

| #   | Idea                                                                                                                                                                   | EGM source                                                                           | LAZERS today                                                                                                                                   | Value   | Effort | Risk         | Verdict                                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Deterministic check of reviewer and plan claims against the repository inventory                                                                                       | `egm:.github/scripts/review_pr.py:620-683`                                           | Map exists, unused for this (`lz:src/context/repo-map.ts`)                                                                                     | High    | S      | Low          | **Adopt** (P0)                                                                                                                                                                                                                                                                                 |
| 2   | Fresh-context adversarial diff review of an accepted multi-task plan before integration: hunt pass, then a fresh disproof pass, Blocker/Major only, changed lines only | `egm:.github/scripts/review_pr.py:1081-1216`; `egm:skills/egm-lite/SKILL.md:297-345` | Checks + Fallow + scope + Architect review; Sol found 4 blockers in 37 integrated units (`lz:.agents/reviews/2026-11-20-sol/INDEX.md:3,68-73`) | High    | M      | Cost; noise  | **Adapt**: run on plans that integrate ≥2 tasks or touch lifecycle machines; findings go to the Architect as one notice; never holds. Disproof pass is the cheap noise filter                                                                                                                  |
| 3   | Backtest any reviewer against recorded outcomes before shipping it                                                                                                     | (EGM lacks this)                                                                     | `lz:scripts/replay-concerns.ts` already does it for the detector                                                                               | High    | S      | None         | **Adopt**                                                                                                                                                                                                                                                                                      |
| 4   | Paraphrase-first output                                                                                                                                                | `egm:agents/comprehension.md:37,57`                                                  | Absent                                                                                                                                         | Medium  | S      | Low          | **Adopt** inside P1                                                                                                                                                                                                                                                                            |
| 5   | "Contest must cite evidence the reviewer could read"; no severity changes; author's wish is not evidence                                                               | `egm:skills/egm-resolve/SKILL.md:71-82`                                              | Divergence asks for a reason only (`lz:.agents/docs/task-authoring.md:82-84`)                                                                  | Medium  | S      | Low          | **Adopt** for plan review and for the diff review in #2                                                                                                                                                                                                                                        |
| 6   | Settled / fixed / churn rules across rounds                                                                                                                            | `egm:skills/egm-review-loop/SKILL.md:162-177`                                        | `lz-verify-task` progression lacks churn (`lz:src/review/progression.ts`)                                                                      | Medium  | S      | Low          | **Adopt** without the cap                                                                                                                                                                                                                                                                      |
| 7   | Untrusted text fenced in nonce tags inside reviewer prompts                                                                                                            | `egm:.github/scripts/review_pr.py:1074-1079`                                         | Not used for model-written task text                                                                                                           | Medium  | S      | Low          | **Adopt** in reviewer prompts                                                                                                                                                                                                                                                                  |
| 8   | "Not run" ≠ zero findings; retry once                                                                                                                                  | `egm:agents/synthesizer.md:41`                                                       | Already for Fallow (`lz:src/audit/contract.ts:154`)                                                                                            | Medium  | S      | None         | **Same**; apply to reviewers                                                                                                                                                                                                                                                                   |
| 9   | Review baseline recorded before work, so the diff reviewer sees exactly the task's change                                                                              | `egm:skills/egm-lite/SKILL.md:246-253,297-309`                                       | Base commit and artifacts are recorded per attempt                                                                                             | Low     | —      | —            | **Already stronger**                                                                                                                                                                                                                                                                           |
| 10  | Drift report: compare checked-in docs with code                                                                                                                        | `egm:skills/egm-drift-report/SKILL.md:21-66`                                         | `contributor-contracts.md` and `design/*.md` are hand-written                                                                                  | Medium  | M      | Noise        | **Adapt narrowly**: a fresh reviewer that checks only `path:line` and symbol references in `docs/reference/contributor-contracts.md` and `design/runtime-state-machines.md` resolve (deterministic first, model only for behaviour claims), run on demand. Generated check, no hand-kept index |
| 11  | `codebase_details` "proposed files are not findings"                                                                                                                   | `egm:agents/codebase_details.md:50`                                                  | `createScope` exists                                                                                                                           | Low     | S      | —            | **Adopt** as a P0/P2 rule                                                                                                                                                                                                                                                                      |
| 12  | Two independent instances per reviewer (A/B) for recall                                                                                                                | `egm:docs/designs/synthesizer.md:62-65`                                              | —                                                                                                                                              | Unknown | S      | Doubles cost | **Skip** until the backtest measures single-instance recall                                                                                                                                                                                                                                    |
| 13  | Inventive catalyst (TRIZ patterns)                                                                                                                                     | `egm:agents/inventive_catalyst.md`                                                   | —                                                                                                                                              | Low     | S      | Noise        | **Skip**                                                                                                                                                                                                                                                                                       |
| 14  | Feature-spec "alternatives rule"                                                                                                                                       | `egm:resources/document_standards/feature-spec-standard.md:13-21`                    | Not required in tasks                                                                                                                          | Low     | —      | Adds prose   | **Skip** for tasks; fine for `design/` docs written by hand                                                                                                                                                                                                                                    |
| 15  | Style persona's claim calibration (`CALIBRATE` claims to evidence)                                                                                                     | `egm:agents/style.md:48`                                                             | Architect report rules (`lz:src/architect.md:203-211`)                                                                                         | Low     | —      | —            | **Already covered**                                                                                                                                                                                                                                                                            |

Where LAZERS is already stronger: typed scopes enforced at verify vs EGM's unenforced convention; dependency graph checks; runtime-owned lifecycle; detector thresholds derived from measured history; struggle takeover; Fallow as a typed, deterministic post-change reviewer; cost accounting. EGM has none of these.

---

## 5. Not worth it

- **Per-folder READMEs (`egm-bootstrap`).** Hand- or LLM-maintained prose; LLM-written context files cost ~20% more and slightly reduce success (`lz:.agents/research/agent-memory-evidence.md:85,103`). Mechanism behind them: a bottom-up index of interface + invariants + side effects (`egm:skills/egm-bootstrap/references/templates.md:13-31`). LAZERS already gets the interface part generated (paths + exported names, byte-identical per tree, `lz:docs/reference/contributor-contracts.md:90`). Invariants live in tests and the contracts doc; side effects are what P2 reads from code on demand. If a generated addition is ever wanted, the only candidate is a per-file "imports from / imported by" line computed from the same parse as the map, measured with the map-cost method first (`lz:.agents/research/repo-map-cost.md`). EGM itself: "If all of your design artifacts already reference all the code, READMEs may be unnecessary" (`egm:docs/getting_started.md:135-138`).
- **Checked-in design docs per feature (`docs/designs/<feature>.md`).** LAZERS plans and tasks are typed records with `sourcePlan` linking to written plans when they exist (`lz:src/task.ts:24-40`); a mandatory doc per feature is a hand-maintained document.
- **Human gate after every stage, one question per turn, "challenge the user at every step".** Gates on the owner (`egm:resources/execution_instructions.md:20-28`; `egm:skills/egm-review/SKILL.md:229-279`).
- **Round caps (5 rounds, 1 re-audit per stage).** Arbitrary limits that end review with "accepted trade-offs" (`egm:skills/egm-review/SKILL.md:271-275`; `egm:skills/egm-review-loop/SKILL.md:175`).
- **Bootstrap "more than 15 subdirectories" approval prompt and 1,500-line scout chunks.** A trust prompt and a made-up limit (`egm:skills/egm-bootstrap/SKILL.md:66-68,249-252`).
- **Structural and style reviewers on plans.** LAZERS plans are JSON validated by zod; layout review has nothing to check.
- **Synthesizer agent.** The runtime aggregates typed findings deterministically; a model in the middle only loses fidelity (EGM itself bypasses it for comprehension because it drops the paraphrase, `egm:skills/egm-review/SKILL.md:351-355`).
- **Brainstorm 7-lens swarm on every request.** Seven sessions for a concept brief the Architect forms in conversation already; no measured gain.
- **Regex "behavioral scenarios" as an eval.** Unexecuted (`egm:tests/unit/test_scenario_coverage.py:23-53`); LAZERS' replay against recorded outcomes is a real eval.
- **EGM-lite's command state machine in prose (`checklist`/`exec`/`goldfish`).** LAZERS has the real one in XState.
- **Banned-adjective and anti-sycophancy lists.** Prompt text with no measurement; the finding schema does the work.

---

## 6. Licence and attribution

- Licence: Apache-2.0 (`egm:LICENSE:1-2`); files carry "Copyright 2026 Google LLC" headers (`egm:skills/egm-bootstrap/references/templates.md:1-4`; `egm:.github/scripts/review_pr.py:1-13`); personas declare `license: Apache-2.0` in frontmatter (`egm:agents/zoom_out.md:4`). No `NOTICE` file exists, so §4(d) adds nothing.
- Reusing any text (persona prompts, standards, skill wording): ship a copy of the licence, keep the copyright and attribution notices, and mark modified files as changed (`egm:LICENSE:90-105`, §4(a)-(c)). Apache-2.0 is compatible with LAZERS' distribution, but every copied prompt then carries those obligations in the bundle.
- Ideas, rubrics as concepts, and workflow structure are not covered by copyright. **Recommendation: write all LAZERS prompts and rules fresh** (section 3 does), and cite EGM in the design record as prior art. No text in this report's design is copied from EGM prompts; short quoted phrases above are for attribution.
- §6 grants no trademark rights (`egm:LICENSE:139`): do not name LAZERS features "Elephant", "Goldfish" or "EGM" in product UI. The project states it is not an officially supported Google product (`egm:README.md:158`).
- The method credits Dave Rensin's essay (`egm:docs/designs/architecture.md:12`); cite it if the design record describes the elephant/goldfish split.

---

## 7. Could not verify

- **Benefit of goldfish review.** EGM publishes no measurement; none was run here.
- **Prompt rewriting in the native subagent hook.** Whether the V2 `tool.execute.before` hook can replace a `subagent` call's prompt was not checked; the design avoids depending on it by having the runtime create the session.
- **A plugin tool creating and awaiting a native child session within one call.** The runner creates sessions (`lz:src/runner/native.ts:1089-1188`) from the scheduler; doing it from inside a tool call and blocking on completion was not tested.
- **What agents the Architect already delegates to.** It made 138 native `subagent` calls in 39 of 390 sessions (`db:` Q7), but the recorded payload does not keep the `agent` argument, so their types are unknown.
- **Attribution of repairs to plan quality.** Transition counts mix plan defects with runtime defects of the period; no labelled split exists.
- **Reviewer token usage.** Section 3.5 is an estimate from Architect tool-call proxies, map size and task sizes; output token prices are not in the measured price table.
- **EGM's OpenCode adapter on OpenCode 2.3.0.** It targets V1 1.18.29 and is marked experimental (`egm:docs/opencode.md:3-8`); not run.
- **`delegated_agent_admissions` contents.** The table is not in `tasks.sqlite` on this machine (query failed), so the native admission history could not be read.

---

## Appendix: read-only queries (`db:`)

All against `file:$HOME/.local/share/opencode/plugins/lazers/tasks.sqlite?mode=ro`, 2026-11-20.

```sql
-- Q1 plan states
SELECT state, count(*) FROM runner_plans GROUP BY 1;            -- integrated 135, cancelled 71, running 9, blocked 2, ...
-- Q2 transition events (top), BLOCKED reasons
SELECT event, count(*), count(DISTINCT plan_id) FROM runner_transitions GROUP BY 1 ORDER BY 2 DESC;
SELECT substr(payload,1,60), count(*), count(DISTINCT plan_id) FROM runner_transitions WHERE event='BLOCKED' GROUP BY 1 ORDER BY 2 DESC;
-- Q3 scope, takeover, combined events
SELECT event, count(*), count(DISTINCT plan_id) FROM runner_transitions
 WHERE event LIKE '%SCOPE%' OR event LIKE '%TAKEOVER%' OR event LIKE '%COMBINED%' GROUP BY 1;
-- Q4 revisions per plan; nodes per latest revision
SELECT n, count(*) FROM (SELECT plan_id, count(*) n FROM runner_plan_revisions GROUP BY plan_id) GROUP BY n;
--   1:158 2:33 3:11 4:7 then single plans up to 102 revisions
-- latest revision node counts: 1:195 2:20 3:3 5:1
-- Q5 task sizes and declared risk
SELECT count(*), avg(length(body)), max(length(body)) FROM tasks;          -- 258, 5395.6, 45112
SELECT json_extract(body,'$.proposal.requirements.risk'), count(*) FROM tasks GROUP BY 1;  -- high 97, medium 133, low 28
-- Q6 outcomes by plan size (single 195: repair 42, scope-decision 14, amended 39, takeover 2, cancel 63;
--                           multi 24:  repair 8,  scope-decision 0,  amended 5,  takeover 0, cancel 8)
-- Q7 Architect tool usage
SELECT tool, count(*), count(DISTINCT session_id) FROM native_tool_calls
 WHERE agent='architect' AND identity_kind='native-call' GROUP BY tool;    -- subagent 138 / 39 sessions
```
