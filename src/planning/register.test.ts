import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { collectTools } from "../../test/tool-inventory.ts"
import { PLANNING_AGENT_IDS } from "./contract.ts"
import { planningAgent } from "./index.ts"
import {
  PLANNING_PERMISSIONS,
  PLANNING_ROUTE_ID,
  planningHostID,
  registerPlanningAgents,
} from "./register.ts"

type Registered = Record<string, Record<string, any>>

async function register(routes?: (id: string) => unknown) {
  const agents: Registered = {}
  const ctx = {
    agent: {
      transform: (transform: (editor: unknown) => void) =>
        Effect.sync(() =>
          transform({
            update: (id: string, update: (value: unknown) => void) =>
              update(
                (agents[id] ??= { permissions: [{ action: "*", resource: "*", effect: "allow" }] }),
              ),
          }),
        ),
    },
  } as unknown as Plugin.Context
  await Effect.runPromise(Effect.scoped(registerPlanningAgents(ctx, routes as never)))
  return agents
}

/** Last matching rule wins, as the implementor's trailing denials rely on. */
const effect = (
  rules: { action: string; resource: string; effect: string }[],
  action: string,
  resource = "src/a.ts",
) => {
  const match = (pattern: string, value: string) =>
    new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(value)
  return rules.filter((r) => match(r.action, action) && match(r.resource, resource)).at(-1)?.effect
}

test("five hidden read-only subagents with the composed prompt", async () => {
  const agents = await register()
  expect(Object.keys(agents).sort()).toEqual(
    PLANNING_AGENT_IDS.map((id) => `lazers-planning-${id}`).sort(),
  )
  for (const id of PLANNING_AGENT_IDS) {
    const agent = agents[planningHostID(id)]!
    expect(agent.hidden).toBe(true)
    expect(agent.mode).toBe("subagent")
    expect(agent.system).toBe(planningAgent(id).prompt)
    expect(agent.model).toBeUndefined()
    for (const allowed of ["read", "grep", "glob"])
      expect(effect(agent.permissions, allowed)).toBe("allow")
    for (const denied of [
      "edit",
      "write",
      "patch",
      "bash",
      "webfetch",
      "websearch",
      "subagent",
      "task",
      "mcp_x",
    ])
      expect(effect(agent.permissions, denied)).toBe("deny")
    expect(effect(agent.permissions, "read", ".env")).toBe("deny")
  }
})

test("every lz-* tool is denied, including one added later", async () => {
  const names = [...(await collectTools()).keys(), "lz-tool-added-next-year"]
  expect(names.length).toBeGreaterThan(10)
  for (const name of names) expect(effect([...PLANNING_PERMISSIONS], name)).toBe("deny")
  // Deny-by-default holds even if the explicit family rules are dropped.
  const base = PLANNING_PERMISSIONS.slice(0, 4)
  expect(effect([...base], "lz-tool-added-next-year")).toBe("deny")
})

test("route: shared planning route, else the Implementor's, else native", async () => {
  const route = (providerID: string, id: string) => ({
    route: { providerID, id },
    scope: "shared",
    revision: 1,
  })
  const own = await register((id) =>
    id === PLANNING_ROUTE_ID
      ? route("p", "mid")
      : id === "lazers-implementor"
        ? route("i", "big")
        : null,
  )
  const inherit = await register((id) => (id === "lazers-implementor" ? route("i", "big") : null))
  for (const id of PLANNING_AGENT_IDS) {
    expect(String(own[planningHostID(id)]!.model.id)).toBe("mid")
    expect(String(inherit[planningHostID(id)]!.model.id)).toBe("big")
  }
})
