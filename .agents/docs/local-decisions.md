# Local models and task review

Checked against OpenCode 2.2.5 and Liquid documentation on 2026-10-31. This is an integration recipe, not an enabled feature or a model-quality result.

## Registering a model from the plugin

The public [`ctx.provider.transform`](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/plugin/src/effect/provider.ts) editor supports `add({info, models})`. Use `Provider.Info.empty` and `Model.Info.default`, then override the runtime package, endpoint, capabilities, and real limits. Set `activation: "enabled"` for a local service without an account credential. Register only when explicitly configured; installation should not start downloads or inference services.

For a local **chat** model, use package `@opencode/ai/providers/openai-compatible` and `settings.baseURL` pointing to the service's `/v1` endpoint. Its chat-completions API and tool support must actually match the model/server. See [custom providers](https://opencode.ai/v2/docs/providers/#custom).

Liquid's current LFM3-based decision model is [**LiquidAI/d1-2B**](https://docs.liquid.ai/lfm/models/d1-2b). It is not a chat model. Its llama.cpp deployment requires 0.8.0 / b11960 or newer and serves **POST `/v1/systemone`**, with `state` and named Noul/Choice/Score questions. Do not register it as a chat-completions model or substitute the earlier LFM2.5-based d1-3B without recording that change.

OpenCode already ships the matching [System One protocol](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/ai/src/protocols/system-one.ts). A local provider module can export:

```ts
import { SystemOne } from "@opencode/ai/protocols/system-one"
import { Auth } from "@opencode/ai/route"

export function model(modelID: string, settings: { baseURL: string }) {
  return SystemOne.route
    .with({
      provider: "lazers-local",
      auth: Auth.none,
      endpoint: { baseURL: settings.baseURL },
    })
    .model({ id: modelID })
}
```

Use that module's **resolvable package export** in the model registration. The host's [model resolver](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/model-resolver.ts) loads its `model(modelID, settings)` export and requires an actual `DecisionModel` instance for a decision request.

```ts
import { Model, Provider } from "@opencode/plugin/effect"

// Inside plugin setup; adapterPackage is a resolvable export of the module above.
const providerID = Provider.ID.make("lazers-local")
yield *
  ctx.provider.transform((editor) => {
    editor.add({
      info: {
        ...Provider.Info.empty(providerID),
        name: "LAZERS Local",
        activation: "enabled",
        package: adapterPackage,
        settings: { baseURL: configuredBaseURL },
      },
      models: [
        {
          ...Model.Info.default(providerID, Model.ID.make("d1-2b")),
          name: "Liquid d1-2B",
          type: "decision",
          capabilities: { tools: false, input: ["text"], output: [] },
          limit: { context: 128_000, output: 0 },
        },
      ],
    })
  })
```

Then a tool can `yield* ctx.experimental.generate.decisions({ model: { providerID, id: Model.ID.make("d1-2b") }, input: [{ type: "json", value: reviewState }], questions: [{ type: "predicate", name: "unresolved-intent", instructions: "Does the proposal depend on a material user decision absent from the recorded request and answers?" }] })`. This is a stateless decision call, not an Architect session or selectable primary chat agent. The API is experimental. The example restricts review to text; multimodal input is unnecessary for task admission.

The endpoint is configuration, not a fixed numbered port. Follow the repository's Portless rules if launching a project-owned inference/verification service. No service or model was downloaded or started for this review.

## What the reviewer may decide

Keep deterministic validation first: strict schema, required fields, bounds, unique IDs, and evidence references. Zod rejects invalid inputs before provenance collection or persistence. A model must never override those failures.

For semantic review, provide the original request, explicit user answers, relevant repository facts with references, and the proposed task. Review separately for unresolved decisions, unsupported scope assumptions, coverage of the requested behavior/failure cases, and whether checks would distinguish success from failure. A proposal alone cannot reveal missing user intent.

Keep probabilities and the model/server/rubric version with the review. Calibrate thresholds against labeled complete/incomplete/contradictory proposals, including cases where an invented assumption sounds plausible. Measure false-ready results and unnecessary interviews. Low confidence, missing answers, transport errors, or malformed review output must return an unresolved review; do not silently classify them as ready. Architect asks the focused question or revises the task.

Start as an advisory checker until comparisons show that it improves admission decisions. Local inference has latency and resource costs even when provider spend is zero. Liquid documents weaker knowledge-heavy performance than larger models and declining reliability beyond about 64K state tokens; send concise evidence. Neither this model nor a checklist can prove that unspecified intent is complete.
