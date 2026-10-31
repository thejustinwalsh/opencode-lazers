import { expect, test } from "bun:test"
import { Agent } from "@opencode/plugin/effect"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import { Effect } from "effect"
import type { Types } from "effect"
import { architect, registerArchitect } from "./architect.ts"

test("the packaged definition registers a missing primary agent and isolates transform replays", async () => {
  const agents = new Map<string, Types.DeepMutable<Agent.Info>>()
  const editor: AgentEditor = {
    list: () => [...agents.values()],
    get: (id) => agents.get(id),
    default: () => {},
    remove: (id) => {
      agents.delete(id)
    },
    update: (id, update) => {
      const agent = agents.get(id) ?? structuredClone(Agent.Info.default(Agent.ID.make(id)))
      update(agent)
      agents.set(id, agent)
    },
  }
  const ctx = {
    agent: {
      transform: (callback: (editor: AgentEditor) => void) =>
        Effect.sync(() => {
          callback(editor)
          return { dispose: Effect.void }
        }),
    },
  }
  await Effect.runPromise(Effect.scoped(registerArchitect(ctx)))
  const first = agents.get("architect")!
  expect(first.mode).toBe("primary")
  expect(first.hidden).toBe(false)
  expect(first.system).toBeTruthy()
  expect(first.steps).toBeUndefined()
  expect(first.model).toBeUndefined()
  expect(first.permissions).toEqual(architect.permissions.map((rule) => ({ ...rule })))
  expect(first.permissions).toEqual(Agent.Info.default(Agent.ID.make("architect")).permissions)
  expect(first.permissions).toContainEqual({ action: "*", resource: "*", effect: "allow" })
  expect(first.permissions.some((rule) => rule.effect === "deny")).toBe(false)
  expect(first.system).toContain("review the diff and verification")
  expect(first.system).toContain("optional skill suggestions")
  expect(first.system).toContain("name — one-line description")
  expect(first.system).toContain("relevant research summaries")
  expect(first.system).toContain("lazers_project_refresh")
  expect(first.system).toContain("lazers_worker_catalog")
  expect(first.system).toContain("workerModel: {providerID, id, variant?}")
  expect(first.system).toContain("nodes[].persona")
  expect(first.system).toContain("Never substitute another route or effort")
  expect(first.system).toContain("read-only selections of that same snapshot")
  expect(first.system).toContain("freshness as-of-refresh")
  expect(first.system).not.toContain("Required skills")

  first.permissions.push({ action: "edit", resource: "*", effect: "allow" })
  first.request.body.changed = true
  await Effect.runPromise(Effect.scoped(registerArchitect(ctx)))
  expect(agents.size).toBe(1)
  expect(agents.get("architect")!.permissions).toEqual(
    architect.permissions.map((rule) => ({ ...rule })),
  )
  expect(agents.get("architect")!.request.body.changed).toBeUndefined()
})
