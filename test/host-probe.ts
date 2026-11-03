import { Plugin, Rpc } from "@opencode/plugin/effect"
import { Effect, Schema } from "effect"

const Probe = Rpc.define({
  id: "lazers.validation",
  events: {},
  methods: {
    inspect: {
      input: Schema.Struct({}),
      output: Schema.Struct({
        agentPresent: Schema.Boolean,
        mode: Schema.String,
        description: Schema.String,
        tools: Schema.Array(Schema.String),
        permissions: Schema.Record(Schema.String, Schema.String),
      }),
    },
  },
})

export default Plugin.define({
  id: "lazers.validation",
  effect: (ctx) =>
    Effect.gen(function* () {
      yield* ctx.rpc
        .register(Probe, {
          inspect: () =>
            Effect.gen(function* () {
              const agents = yield* ctx.agent.list().pipe(Effect.orDie)
              const architect = agents.data.find((agent) => agent.id === "architect")
              const tools = yield* ctx.tool.list()
              const session = yield* ctx.session.create({ agent: architect?.id }).pipe(Effect.orDie)
              const permissions: Record<string, string> = {}
              for (const action of [
                "read",
                "glob",
                "grep",
                "question",
                "lz-submit-task",
                "edit",
                "shell",
                "subagent",
                "execute",
              ]) {
                const outcome = yield* Effect.result(
                  ctx.permission.assert({
                    sessionID: session.id,
                    agent: architect?.id,
                    action,
                    resources: ["src/index.ts"],
                  }),
                )
                permissions[action] = outcome._tag === "Success" ? "allow" : "deny"
              }
              yield* ctx.session.remove({ sessionID: session.id }).pipe(Effect.orDie)
              return {
                agentPresent: Boolean(architect),
                mode: architect?.mode ?? "missing",
                description: architect?.description ?? "missing",
                tools: tools.map((tool) => tool.id).filter((name) => name.startsWith("lz-")),
                permissions,
              }
            }),
        })
        .pipe(Effect.orDie)
    }),
})
