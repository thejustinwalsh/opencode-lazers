# Settings, project instructions and native workers

Authorized 2026-11-28. Basis: [Settings review](../../design/reviews/settings-and-agent-customization-20261128.md).

## Outcomes and ownership

Deliver all three requested increments. Project supplements extend packaged
agent bases; `AGENTS.md` is complementary, not a substitute. Preserve native
permissions, request settings, model/effort selections and ordinary tools.
Setup stays optional. No approval or activation-confirmation step is added.

| Feature | Producer | Consumer |
| --- | --- | --- |
| Truthful project checks/setup | Native Luna Max | Reserved external Opus Settings UI |
| Per-agent project supplements | Native Luna Max | Reserved external Opus Settings UI |
| Native custom scheduled workers | Native Luna Max | Existing runtime/Models/trajectory, plus reserved Opus Settings UI |

The three backend features are sequenced because they share project identity and
agent/route contracts. One UI task owns the coherent Settings experience, rather
than splitting it by file or dispatching a competing native UI worker.

## Truthful project setup producer

Expose a small, typed, project-scoped summary through the existing Projects
contract/stream family. Keep active profile state separate from dated setup
proofs and current task verification. Include the project key/checkouts,
revision, proof date and outcome counts. Distinguish absent, invalid/unreadable
and loading/error states; do not turn a failed historical proof into inactive
configuration. Preserve existing profile editing, immediate activation,
unattended fix/install eligibility and no-profile behavior.

Proof details, command text, source filters, environment names, map snapshots
and prior revisions remain available through existing selected-project detail
streams, not an expanded payload on every project row. Use bounded stored reads
and preserve stream lifecycle/authorization.

## Project agent supplements producer

Provide a permission-checked typed project-agent read/update boundary for
Settings. It must expose packaged base, existing native instruction provenance,
editable project supplement, effective composition and revision/conflict state,
without leaking request secrets or resetting unrelated native fields.

Select one durable supplement authority: native configuration files where
practical, otherwise existing canonical-project settings. Do not mirror one
editable preference into two stores. The implementation must document the
chosen backing/edit path and actual exported contract before UI launch.
`AgentApi` has only list/get; `AgentEditor` belongs to the in-memory
`ctx.agent.transform` callback. Neither establishes a persistent agent editor API.

The canonical project's preferences must apply to native worker worktrees,
including uncommitted/local preferences. Native project-wide instructions remain
separately composed. A supplement appears once after repeated reload/transform
replay, and clearing it restores the base/native composition rather than erasing
native settings. Edits must not interrupt or replay a running worker or change
its pinned model route. Document normal next-request/attempt application semantics.

Verify with real native registration/session/worktree behavior and an actual
runtime-managed worker request, not only a fake AgentEditor assertion. A
deterministic model transport may capture the request without paid inference.
Use owned fixtures; do not edit real user preferences or create another Desktop
profile. Record which native version was exercised and the observed instruction
revision/content count.

## Native custom scheduled workers

Accept eligible native agent definitions through the existing runtime worker
selection path, preserving exact IDs, native base/settings and explicit model
overrides. Validate against native discovery and mode; missing/disabled or
primary-only IDs must not silently become Implementor.

Extend the existing role/mapping and trajectory/reporting consumers coherently;
preserve historical built-in IDs, model-independent personas and retained
attempts. Custom agents use native definitions, not a second LAZERS agent-definition
store. Canonical native definitions and supplements must be available in the
worker worktree even when local/uncommitted. Existing runtime worker safeguards,
capacity, checks, repair, integration and cleanup still apply, without inventing
new approval gates or broad permission resets.

## Reserved external Opus Settings UI

The driver owns the single external Claude Opus implementation through Side
Piece in a native worktree. Submit its normal LAZERS task, but do not admit a
duplicate native UI implementation attempt.

Deliver:

1. A truthful selected-project checks/setup summary with advanced disclosures.
2. Settings → Agents: readable packaged bases, editable per-agent project
   supplements, native source/provenance, effective composition and draft-safe
   save/conflict/error behavior.
3. Native custom worker discovery/source navigation and links into existing
   Models assignments and trajectory, using the producer's supported eligibility
   and identity rather than hardcoded built-in-only lists.

Models owns model/effort/cost routing. Settings links there, and Models links to
agent configuration. Use native theme/fonts/controls and preserve project/server
identity on switching, hiding, reconnecting and saving. No duplicate prompt or
model configuration authority.

### Real consumer boundary and launch condition

Current usable surfaces are `Projects` in `src/projects/contract.ts`,
`projectsRefs` in `src/streams/sources/projects-ref.ts`, native agent list/get and
existing Models assignments. Their current implementations do **not** provide
the new durable supplement write path or arbitrary scheduled-worker support.

Each backend producer must publish its actual typed exports, methods/stream
references, input/output/error shapes and positive registered-boundary tests in
this section (or a linked committed contract note). Proposed API names are not
implemented capability. The external task begins against that committed
boundary, not a made-up adapter or a mock-only persistence facade.

Before launch, Architect confirms planning helpers have released their slots
and tells the driver the remaining delegation capacity. External Opus counts
within the project's total of three. Readiness of the consumer contract is a
dependency, not a new user approval gate.

### External delivery and integration

Preserve the external commits and native workspace identity. Architect reviews
the supplied candidate and uses the existing LAZERS candidate validation,
retained/adoption controls where applicable and integration proofs. Do not run
a native implementation worker on the same UI. The existing external-candidate
verification pattern used for Review UI is a reuse point, not permission to
invent an initial descendant-adoption API or skip ordinary checks.

## Integration order and combined acceptance

1. Keep current Review work moving. Backend tasks touching its shared
   registration/schema files wait for the current discussion plan's integrated
   baseline; do not alter active Review scopes.
2. Integrate setup summary, supplements and custom-worker producers in that order.
   Related tests stay with each feature.
3. Launch reserved external UI only against the committed consumer contract and
   available delegation slot; review and integrate its retained commits normally.
4. Run project quality, focused producer/runtime/UI regressions, server and GUI
   builds, and assembled regular-Desktop probes. Demonstrate a real scheduled
   worker inherits a local project supplement exactly once across reload, custom
   IDs/routes remain visible in trajectory, and Settings state stays project-scoped.

Use `bun run verify` for automatic formatting/lint fixes and type checking;
`bun test --timeout 120000 <focused paths>` for behavior; `bun run build:server`
and `bun run build:gui` for installed entrypoints. Do not rerun profile setup,
rewrite existing stored commands or change release configuration as incidental
UI work. Architect owns branch composition; driver coordinates regular Desktop
activation. No additional Desktop profile or human-evidence gate is required.

## Pending Review finish feedback — not dispatched

Separately requested: reactive OpenCode theme support; actual populated semantic
information; review-importance file ordering inside the panel; Oaink-style
slightly dimmed unchanged code so structural changes dominate. The driver is
auditing current/queued/missing behavior and Oaink prior art.

Wait for the user's word before adding Review finish agents or changing active
worker scope for this feedback. Preserve existing structural wiring,
discussion, symbol and final-consumer tasks and their dependencies.
