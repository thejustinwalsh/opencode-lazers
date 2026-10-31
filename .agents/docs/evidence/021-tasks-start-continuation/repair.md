# Architect repair verification — 2026-10-31

Repairs on top of worker artifact `d215cc8`:

- Run rejects unauthorized/stale callers before continuation effects. Original
  caller/command fingerprints remain unchanged across replay. Native continuation
  identity survives a lost response; owner adoption and Run receipt commit in
  one transaction. Concurrent reassignment invalidates the old request.
- Start admits existing draft graphs, retains their dependencies/selected route,
  and ticks queued eligible work without duplicate plans. The inspector exposes
  Start for submitted/queued/ready tasks, not ended or held work.
- Native implementor selection is separate from Architect selection. The role
  transform preserves native `agent.model`; admission uses explicit plan selection
  or native worker-agent configuration, with no provider/catalog-enabled veto or
  silent Architect inheritance. Project agent config records the requested Luna
  Max route; this is user configuration, not a runtime provider default.
- Search and the root grid have shrinkable columns. List and detail restoration
  have independent readiness and selection identities; placeholder scroll events
  cannot overwrite saved detail position. Start feedback ignores late results
  from old selections/scopes. Disconnected-dot accessibility matches its state.

## Executed checks

- Focused runner/native/Tasks suite: **51 passed**, 665 expectations.
- Full `bun test`: **165 passed**, 1,459 expectations, 37 files.
- `bun run verify`: formatting, lint and typecheck passed. The recovery-process
  fixture now explicitly selects its worker model rather than relying on the
  withdrawn Architect-inheritance behavior; process-death assertions remain intact.
- `bun run build:gui`: passed, producing `dist/gui-experimental.cjs`.
  Existing upstream inlineDynamicImports/ONNX CommonJS import.meta warnings remain;
  no engine, inference switch, settings or model-cache behavior was changed.
- `git diff --check`: passed during review.

Production-runtime reproductions (`/private/tmp/lazers-start-review.ts`):

- `--command`: running receipt returned identically on replay; one continuation.
- `--foreign`: both calls denied, zero Architect creations.
- `--owner-crash`: injected failure before Run receipt, then the original request
  successfully returned running, reusing one continuation.

These are fake-host reproductions against production runtime code, not Desktop
acceptance. Pending native checks and root-owned refresh/captures are recorded in
`native.md`. The worker-session Tasks discovery finding belongs to existing task
`efd8459f`, not this repair. The isolated scheduler worker was not edited.
