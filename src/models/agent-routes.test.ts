import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LAZERS_AGENTS, readAgentRoutes } from "./agent-routes.ts"
import { agentModelText, agentRoutedModels, agentSourceText } from "./panel-shared.ts"
import { AUDITOR_DEFAULT_MODEL } from "../runner/roles.ts"

type Ref = { providerID: string; id: string; variant?: string }

function fakeContext(models: Record<string, Ref | undefined | "missing">) {
  return {
    agent: {
      get: ({ agentID }: { agentID: string }) =>
        models[agentID] === "missing"
          ? Effect.fail(new Error("unknown agent"))
          : Effect.succeed({ data: { model: models[agentID] } }),
    },
  } as never
}

describe("readAgentRoutes", () => {
  test("lists every LAZERS agent in display order", async () => {
    const routes = await readAgentRoutes(fakeContext({}))
    expect(routes.map((route) => route.agentID)).toEqual(LAZERS_AGENTS.map((a) => a.agentID))
    expect(routes.map((route) => route.label)).toEqual(["Architect", "Implementor", "Auditor"])
  })

  test("native configuration is reported as native with effort", async () => {
    const routes = await readAgentRoutes(
      fakeContext({
        architect: { providerID: "openai", id: "gpt-6", variant: "high" },
        "lazers-implementor": { providerID: "anthropic", id: "sonnet" },
        auditor: { providerID: "anthropic", id: "haiku" },
      }),
    )
    expect(routes[0]).toMatchObject({
      source: "native",
      model: { providerID: "openai", id: "gpt-6", variant: "high" },
    })
    expect(routes[2]).toMatchObject({ source: "native", model: { id: "haiku" } })
  })

  test("the plugin's Auditor default is labelled as the default", async () => {
    const routes = await readAgentRoutes(fakeContext({ auditor: { ...AUDITOR_DEFAULT_MODEL } }))
    expect(routes[2]).toMatchObject({ source: "plugin-default" })
    expect(agentSourceText(routes[2]!.source)).toBe("default")
    expect(agentModelText(routes[2]!)).toBe(AUDITOR_DEFAULT_MODEL.id)
  })

  test("an agent with no pinned model, or unknown to the host, has no model", async () => {
    const routes = await readAgentRoutes(
      fakeContext({ architect: undefined, "lazers-implementor": "missing" }),
    )
    expect(routes[0]).toMatchObject({ model: null, source: "none" })
    expect(routes[1]).toMatchObject({ model: null, source: "none" })
    expect(agentModelText(routes[0]!)).toBeNull()
  })
})

describe("agentRoutedModels", () => {
  test("feeds Architect and Auditor effective models into the routed set, skipping unpinned", () => {
    expect(
      agentRoutedModels([
        { model: { providerID: "openai", id: "gpt-6" } },
        { model: null },
        { model: { providerID: "opencode-go", id: "muse-spark-1.3-contributor" } },
      ]),
    ).toEqual([
      { providerID: "openai", modelID: "gpt-6" },
      { providerID: "opencode-go", modelID: "muse-spark-1.3-contributor" },
    ])
  })
})
