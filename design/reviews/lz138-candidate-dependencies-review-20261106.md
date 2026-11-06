The unresolved boundary is concrete: candidate manifests are fingerprinted and candidate scripts are admitted correctly, but dependency isolation still requires lockfiles to match the installed project byte-for-byte and only clones the project’s existing `node_modules`. The positive dependency fixture has no lockfile, so it doesn’t cover a real candidate lockfile change. Separately, the read-only plan inspection still exposes no retained-check receipts; that leaves native qualification on its existing idle-lineage hold.
## Verdict: **Not ready**

The fixed candidate has solid procedure admission, isolated-resource fixtures, and generation fencing, but it does **not** yet support legitimate candidate-owned dependency changes when those changes require a lockfile update. Native retained-candidate qualification is also still unproven and remains on its separate idle-lineage hold.

### Source review

- `src/runner/retained-verification/procedure.ts:83-151` admits project-relative Bun test targets, the scoped quality chain, and candidate-declared `bun run` scripts. The candidate’s `build:gui` script is declared in `package.json:18-20`; parser coverage includes that chain and other project targets in `isolation.test.ts:550-590`.
- `isolation.ts:395-500` creates operation-specific resources and binds the candidate’s dependency mount and environment. Fixtures exercise separate profile, cache, SQLite, build output, and dependency paths; they check that prior resources remain unchanged.
- The explicit shared-resource holds in `runtime.ts:809-825` reject recognizable external services and caller-owned paths. This is a bounded policy, **not** proof that arbitrary transitive shell I/O is isolated; `procedure.ts:83-90` explicitly limits its claim to procedure/resource binding.
- Generation and history protections have meaningful regression coverage: stale/foreign requests, reassignment, late evidence, cancellation, and database reopen are tested in `retained-reverify.test.ts:475-504`, `824-1024`, and `1069-1181`. The exact-candidate fixture also checks that attempt/session/usage and an old uncertain effect remain unchanged (`326-473`).

### Remaining dependency gap

`isolation.ts:228-255` requires candidate lockfiles to match the installed project’s lock state byte-for-byte. It then validates candidate dependencies against the project’s existing `node_modules` (`258-289`) and clones that tree (`454-492`) rather than resolving the candidate’s lockfile. Thus a real dependency change that updates a lockfile—or requires a package/version not already installed—will be held.

The positive dependency fixture in `isolation.test.ts:245-382` adds an already-installed package and has no lockfile, so it does not establish support for that case.

### Checks and evidence

Confirmed the worktree was clean at fixed HEAD `d37858feb0d6e466227d7a1700fc90c3a99f6a2b`, including after checks.

- `bun test src/runner/retained-verification/isolation.test.ts src/runner/retained-reverify.test.ts` — **14 passed, 156 assertions**.
- `bun fmt --check && bun lint && bun check && git diff --check && bun run build:gui` — passed. The GUI build emitted existing Vite deprecation and ONNX `import.meta` warnings.
- The GUI build ran in the ordinary checkout, not as a retained-runtime check. The tests exercise isolated subprocess fixtures, including a generic build script; neither is a durable native retained-verification receipt.
- I did not rerun the broad suite or claim its inherited fixture failure passed.

Read-only plan inspection still reports the execution **blocked** on `Native idle background observation is unknown`, with `checks: []`. The task attempt is still running and has `artifact: null`. So I cannot independently verify a retained-operation receipt or native no-prompt readback from the available task/plan evidence. The pinned API reference describes `experimental.idle` as a completion boundary with possible remaining background work (`.agents/docs/opencode-api.md:58`); I kept that hold separate and did not attempt a proof turn, activation, or reconciliation.