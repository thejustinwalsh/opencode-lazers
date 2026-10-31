import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { InferenceBroker, failed } from "./broker.ts"
import { LocalInference, RendererInference } from "./rpc.ts"
import { OpenCode } from "@opencode/client"
import type { RpcClient } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { adaptDecision, decisionQuestion } from "./decisions.ts"
import type { DecisionInput } from "./decisions.ts"
import { validateSystemOne } from "./system-one.ts"
import type { SystemOneInput } from "./system-one.ts"
import { registerInferenceTools } from "./tools.ts"
import { decodePCM16 } from "./audio.ts"
import { TaskReviewer } from "./task-review.ts"
import { registerTaskReviewTool, REVIEW_COMMUNICATION } from "./review-tool.ts"
import { defaultFeatures, FeaturePolicy, FeatureSettings, featureEnabled } from "./features.ts"
import type { LocalFeature } from "./features.ts"

export function registerLocalInference(
  ctx: Pick<
    Plugin.Context,
    "rpc" | "tool" | "permission" | "agent" | "storage" | "location" | "options"
  >,
  resolveWorker?: () => Promise<RpcClient<typeof RendererInference>>,
) {
  return Effect.gen(function* () {
    const broker = new InferenceBroker()
    const stored = yield* ctx.storage.get("webgpu.features")
    const saved = FeatureSettings.safeParse(stored)
    let features = defaultFeatures(false)
    let settingsEpoch = 0
    const policy = new FeaturePolicy(
      saved.success
        ? saved.data
        : defaultFeatures(stored === undefined && ctx.options.webgpu === true),
      (value) => Effect.runPromise(ctx.storage.set("webgpu.features", value)),
      (value) => {
        settingsEpoch++
        features = value
        broker.cancelWhere(
          (job) => !featureEnabled(value, job.feature),
          "This local inference feature was turned off in Settings → LAZERS.",
        )
      },
    )
    const allowed = (feature: LocalFeature) => featureEnabled(features, feature)
    const disabled = (feature: LocalFeature) =>
      featureEnabled(policy.read(), feature)
        ? undefined
        : `LAZERS ${feature} is turned off in Settings → LAZERS.`
    // Location plugins forward to the default-location queue/settings authority used by Desktop.
    const worker =
      resolveWorker ??
      (async () => {
        const endpoint = await Service.discover()
        if (!endpoint) throw new Error("The local OpenCode Desktop service is unavailable")
        return OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) }).rpc(
          RendererInference,
        )
      })
    const systemOne = async (
      input: SystemOneInput,
      signal: AbortSignal,
      feature: "decisions" | "review" = "decisions",
    ) => {
      const error = disabled(feature)
      if (error) return { error }
      const output = await broker.generate(
        {
          prompt: JSON.stringify(input),
          maxTokens: 1,
          timeoutMs: input.timeoutMs ?? 60_000,
          mode: "systemone",
          feature,
        },
        signal,
      )
      if (!output.ok) return { error: output.error }
      try {
        return validateSystemOne(input, JSON.parse(output.text))
      } catch {
        return { error: "Decision runtime returned an invalid System One result" }
      }
    }
    const decide = async (input: DecisionInput, signal: AbortSignal) => {
      try {
        const result = await systemOne(
          {
            model: "d1-omni-2b",
            state: input.context,
            questions: { decision: decisionQuestion(input) },
            timeoutMs: input.timeoutMs,
          },
          signal,
        )
        return "error" in result
          ? { ok: false as const, error: result.error }
          : adaptDecision(input.decision, result.answers.decision!)
      } catch (error) {
        return { ok: false as const, error: String(error) }
      }
    }
    yield* ctx.rpc.register(LocalInference, {
      settings: () => Effect.promise(async (signal) => (await worker()).settings({}, { signal })),
      configure: (input) =>
        Effect.promise(async (signal) => (await worker()).configure(input, { signal })),
      review: (input) =>
        Effect.promise(async (signal) => {
          try {
            return await (await worker()).review(input, { signal })
          } catch (error) {
            return { error: String(error) }
          }
        }),
      ask: (input) =>
        Effect.promise(async (signal) => {
          try {
            return await (await worker()).ask(input, { signal })
          } catch (error) {
            return failed(String(error))
          }
        }),
      speak: (input) =>
        Effect.promise(async (signal) => {
          try {
            return await (await worker()).speak(input, { signal })
          } catch (error) {
            return failed(String(error))
          }
        }),
      decide: (input) =>
        Effect.promise(async (signal) => {
          try {
            return await (await worker()).decide(input, { signal })
          } catch (error) {
            return { ok: false as const, error: String(error) }
          }
        }),
      transcribe: (input) =>
        Effect.promise(async (signal) => {
          try {
            return await (await worker()).transcribe(input, { signal })
          } catch (error) {
            return failed(String(error))
          }
        }),
      systemOne: (input) =>
        Effect.promise(async (signal) => {
          try {
            return await (await worker()).systemOne(input, { signal })
          } catch (error) {
            return { error: String(error) }
          }
        }),
    })
    yield* ctx.rpc.register(RendererInference, {
      settings: () => Effect.sync(policy.read),
      configure: (input) =>
        Effect.promise(() => policy.configure(input)).pipe(
          Effect.tap(() => Effect.all([ctx.tool.reload(), ctx.agent.reload()])),
        ),
      ask: (input) =>
        Effect.promise((signal) =>
          disabled("questions")
            ? Promise.resolve(failed(disabled("questions")!))
            : broker.generate(input, signal),
        ),
      speak: (input) =>
        Effect.promise((signal) =>
          disabled("readAloud")
            ? Promise.resolve(failed(disabled("readAloud")!))
            : broker.generate({ ...input, mode: "speak" }, signal),
        ),
      systemOne: (input) => Effect.promise((signal) => systemOne(input, signal)),
      review: (input) => Effect.promise((signal) => systemOne(input, signal, "review")),
      demand: () => Effect.sync(() => broker.demand()),
      transcribe: (input) =>
        Effect.promise(async (signal) => {
          const error = disabled("dictation")
          if (error) return failed(error)
          try {
            decodePCM16(input.audioBase64)
            return await broker.generate(
              { ...input, prompt: "Transcribe the audio verbatim.", maxTokens: 512 },
              signal,
            )
          } catch (error) {
            return failed(String(error))
          }
        }),
      decide: (input) => Effect.promise((signal) => decide(input, signal)),
      attach: ({ owner }) =>
        Effect.sync(() => {
          if (!policy.read().enabled) throw Error("Local WebGPU inference is turned off")
          broker.attach(owner)
          return {}
        }),
      detach: ({ owner, error }) =>
        Effect.sync(() => {
          broker.detach(owner, error)
          return {}
        }),
      poll: ({ owner, available }) => Effect.sync(() => broker.poll(owner, available)),
      complete: ({ owner, id, result }) =>
        Effect.sync(() => {
          broker.complete(owner, id, result)
          return {}
        }),
    })
    yield* registerInferenceTools(ctx, allowed)
    const reviewer = new TaskReviewer(
      {
        get: (key) => Effect.runPromise(ctx.storage.get(key)),
        set: (key, value) =>
          Effect.runPromise(ctx.storage.set(key, JSON.parse(JSON.stringify(value)))),
      },
      {
        systemOne: (input, options) =>
          Effect.runPromise(ctx.rpc(LocalInference).review(input), { signal: options?.signal }),
      },
    )
    yield* registerTaskReviewTool(ctx, reviewer, () => allowed("review"))
    yield* ctx.agent.transform((editor) => {
      if (!editor.get("architect") || !features.enabled) return
      editor.update("architect", (agent) => {
        const actions = [
          ...(allowed("questions") ? ["lazers_local_ask"] : []),
          ...(allowed("decisions") ? ["lazers_local_decide", "lazers_local_system_one"] : []),
          ...(allowed("review") ? ["lazers_verify_task"] : []),
        ]
        for (const action of actions)
          agent.permissions.push({ action, resource: "*", effect: "allow" })
        if (!allowed("review")) return
        agent.system +=
          "\n\nBefore lazers_submit_task, call lazers_verify_task with the proposal JSON, original user request, and relevant evidence (recorded clarifications, repository facts, concrete test procedures). This one tool owns structural validation, fixed System One questions and advisory progression. Follow its next instruction, address one concern or ask a native clarification for a material missing decision. Reuse reviewID for revised drafts; keep request unchanged and add answers to evidence. At most three rounds total: resolved concerns advance, equal-or-better focused scores advance with concerns, and exhaustion continues with concerns. Completion permits ordinary submission, never execution or acceptance. Errors are explicit limitations, not passes. Never invent user answers. If local review is disabled, continue the ordinary Architect workflow without it."
        agent.system += "\n\n" + REVIEW_COMMUNICATION
      })
    })
    let syncing = false
    const controller = new AbortController()
    const sync = async () => {
      if (syncing || controller.signal.aborted) return
      syncing = true
      const epoch = settingsEpoch
      try {
        const next = await (
          await worker()
        ).settings({}, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]) })
        if (epoch !== settingsEpoch || controller.signal.aborted) return
        if (JSON.stringify(next) !== JSON.stringify(features)) {
          features = next
          await Effect.runPromise(Effect.all([ctx.tool.reload(), ctx.agent.reload()]))
        }
      } catch {
        /* Retry after a service reconnect. Inference handlers enforce the authority. */
      } finally {
        syncing = false
      }
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const timer = setInterval(() => {
          broker.expire()
          void sync()
        }, 1_000)
        void sync()
        return timer
      }),
      (timer) =>
        Effect.sync(() => {
          controller.abort()
          clearInterval(timer)
          broker.close()
        }),
    )
  })
}
