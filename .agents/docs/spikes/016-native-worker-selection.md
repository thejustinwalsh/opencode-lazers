# Spike 016 — native worker selection and personas

## Task record

- **Task:** `fc88ccc0-0265-4f71-a688-c19f99c76a58`, revision 1.
- **Question:** Can users select any native worker route while choosing concise,
  model-independent task guidance, without LAZERS becoming a model router?
- **Increment:** Preserve the exact native provider/model/variant; add three
  optional per-task personas and guide route choices with live native catalog
  context and explicit user preferences.
- **Starting revision:** `286975751b492d672eceddb5cb95062233feca1d`.
- **Write scope:** `src/runner/**`, `src/implementor.md`, `src/personas/**`,
  `src/architect.md`, `src/architect.test.ts`, `test/runner/**`, `README.md`,
  `.agents/docs/task-authoring.md`, `.agents/docs/implementor-profiles.md`, and
  this spike.
- **Exclusions:** Automatic routing/ranking/fallback, route/capability vetoes,
  custom transport, separate settings engine, inference, telemetry and Radar.

## Result

The versioned execution plan records an optional exact `workerModel` and an
optional persona on each task node. Existing plans without either field retain
their behavior. One hidden worker core supplies normal coding tools and the
no-delegation boundary; each selected node adds at most one short UI, Systems, or
Small task/refactoring overlay to its attempt prompt. Persona and route are
independent.

The Architect-only `lazers_worker_catalog` reads the live native model list and
configured implementor selection, including listed prices, variants, and
capability metadata. It is advisory: missing prices are unknown; capability or
enabled flags and catalog omissions are not route gates. A user preference
question records an explicit route in `workerModel`, or omission retains native
implementor inheritance. The admitted route reaches native session creation
without substitution; native failures remain visible and are not retried on a
different route or effort.

## Verification

- `bun test src/runner src/architect.test.ts test/runner` — 47 passed, 0 failed,
  736 assertions.
- `bun test` — 182 passed, 0 failed, 1,674 assertions.
- `bun run verify` — formatting, lint, and strict typecheck passed.

## Native catalog and registration observations

- The installed `opencode` CLI reported version `2.2.5`. Its read-only
  `opencode models` listing included routes from several configured providers,
  including `opencode-go/qwen3.8-flash`, `opencode-go/glm-5.3-flash`, and
  `openai/gpt-6-luna`. The CLI listing exposes route names only; it does not
  establish prices, variant options, tool support, or model rankings.
- The pinned `@opencode/schema` 2.2.5 `Model.Info` includes catalog price,
  variant, enabled, and capability fields; `Model.Ref` consists of provider ID,
  model ID, and optional variant. The plugin's native `model.list` supplies the
  live context consumed by the advisory tool, while `session.create` accepts the
  selected `Model.Ref`.
- Focused native adapter tests register the shared worker and pass an arbitrary
  configured provider, an OpenCode Go route represented as tool-incompatible in
  the test catalog, and an unlisted route with absent capability metadata to
  `session.create` unchanged. The adapter does not query the catalog to create a
  session. Its native error is propagated; runtime tests verify it is surfaced
  without a second route attempt.
- Catalog serialization tests retain disabled/tool-incompatible entries and
  entries missing capability or price data; missing prices serialize as
  `null`. Registration tests verify the catalog tool is permission-checked and
  Architect-only. No Go inference was launched, and no model ranking is claimed.

## Limits

The CLI route listing is a current native observation, not a Desktop interaction
test of the registered Architect tool. API composition and unchanged route
selection are covered by focused adapter/registration tests; actual provider
availability and error behavior remain governed by OpenCode at execution time.
