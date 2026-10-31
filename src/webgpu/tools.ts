import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { z } from "zod"
import { LocalInference } from "./rpc.ts"
import { SystemOneRequest } from "./system-one.ts"
import type { LocalFeature } from "./features.ts"

const timeoutMs = z.int().min(1_000).max(120_000).default(60_000)
const ask = z.strictObject({
  prompt: z.string().min(1).max(8_000),
  maxTokens: z.int().min(1).max(512).default(256),
  timeoutMs,
})
const decide = z.strictObject({
  question: z.string().min(1).max(1_000),
  context: z.string().max(6_000),
  timeoutMs,
  decision: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("boolean") }),
    z.strictObject({
      kind: z.literal("choice"),
      choices: z.array(z.string().min(1).max(64)).min(2).max(20),
    }),
    z.strictObject({ kind: z.literal("score"), minimum: z.number(), maximum: z.number() }),
  ]),
})

export function registerInferenceTools(
  ctx: {
    rpc: Plugin.Context["rpc"]
    permission: Pick<Plugin.Context["permission"], "assert">
    tool: Pick<Plugin.Context["tool"], "transform">
  },
  allowed: (feature: LocalFeature) => boolean = () => true,
) {
  const guard = (feature: LocalFeature, run: () => Effect.Effect<Tool.Result, Tool.Error>) =>
    Effect.suspend(() =>
      allowed(feature)
        ? run()
        : Effect.fail(
            new Tool.Error({
              message: "This local inference feature is turned off in Settings → LAZERS.",
            }),
          ),
    )
  return ctx.tool.transform((editor) => {
    if (allowed("decisions"))
      editor.add({
        name: "lazers_local_system_one",
        description:
          "Evaluate named noul (yes probability), choice (categories with descriptions), or score (ordered rubric) questions over shared text/JSON state using genuine local d1-Omni-2B on WebGPU. Autoloads; up to 16 questions, 20 choices, 8,000 serialized characters, default 60-second inclusive deadline. Returns System One answers/probabilities and measured zero-output-token usage, or an explicit error. Advisory; never grants permission or accepts a task. Ask concrete observable questions; use clarification for missing evidence or uncertain results.",
        input: SystemOneRequest,
        options: { codemode: false, permission: "lazers_local_system_one" },
        execute: (input, context) =>
          guard("decisions", () =>
            ctx.permission
              .assert({
                sessionID: context.sessionID,
                agent: context.agent,
                action: "lazers_local_system_one",
                resources: ["*"],
              })
              .pipe(
                Effect.flatMap(() =>
                  ctx
                    .rpc(LocalInference)
                    .systemOne(SystemOneRequest.parse(input))
                    .pipe(Effect.mapError((error) => new Tool.Error({ message: String(error) }))),
                ),
                Effect.map((result) => ({ content: JSON.stringify(result) })),
              ),
          ),
      })
    if (allowed("questions"))
      editor.add({
        name: "lazers_local_ask",
        description:
          "Ask the optional local WebGPU model a general question. Autoloads. Bounded FIFO queue; default 60-second total deadline including loading and waiting. Returns measured text/usage or an explicit error.",
        input: ask,
        options: { codemode: false, permission: "lazers_local_ask" },
        execute: (input, context) =>
          guard("questions", () =>
            ctx.permission
              .assert({
                sessionID: context.sessionID,
                agent: context.agent,
                action: "lazers_local_ask",
                resources: ["*"],
              })
              .pipe(
                Effect.flatMap(() =>
                  ctx
                    .rpc(LocalInference)
                    .ask(ask.parse(input))
                    .pipe(Effect.mapError((error) => new Tool.Error({ message: String(error) }))),
                ),
                Effect.map((result) => ({ content: JSON.stringify(result) })),
              ),
          ),
      })
    if (allowed("decisions"))
      editor.add({
        name: "lazers_local_decide",
        description:
          "Ask the optional local WebGPU model for an advisory typed boolean, exact choice, or bounded numeric score using supplied context. Output is validated; malformed or unavailable results remain unresolved. Does not authorize actions or accept tasks.",
        input: decide,
        options: { codemode: false, permission: "lazers_local_decide" },
        execute: (input, context) =>
          guard("decisions", () =>
            ctx.permission
              .assert({
                sessionID: context.sessionID,
                agent: context.agent,
                action: "lazers_local_decide",
                resources: ["*"],
              })
              .pipe(
                Effect.flatMap(() =>
                  ctx
                    .rpc(LocalInference)
                    .decide(decide.parse(input))
                    .pipe(Effect.mapError((error) => new Tool.Error({ message: String(error) }))),
                ),
                Effect.map((result) => ({ content: JSON.stringify(result) })),
              ),
          ),
      })
  })
}
