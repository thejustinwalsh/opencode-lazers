import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setGlobalSetting } from "../projects/settings.ts"
import { TaskRepository } from "../storage.ts"
import { defaultFeatures } from "../webgpu/features.ts"
import { createPlanningDecisions } from "./server.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
})

function fixture(features: unknown) {
  const root = mkdtempSync(join(tmpdir(), "lazers-planning-server-"))
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  cleanup.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  const sent: unknown[] = []
  const ctx = {
    storage: { get: () => Effect.succeed(features) },
    options: {},
    rpc: () => ({ systemOne: () => Effect.die("local model must not be called") }),
    experimental: {
      generate: {
        decisions: (input: unknown) => {
          sent.push(input)
          return Effect.succeed({
            answers: (input as { questions: { name: string; type: string }[] }).questions.map(
              (q) =>
                q.type === "predicate"
                  ? { type: "predicate", name: q.name, probability: 0.4 }
                  : {
                      type: "score",
                      name: q.name,
                      probabilities: [
                        { value: 0, label: "one", probability: 0.1 },
                        { value: 1, label: "few", probability: 0.8 },
                        { value: 2, label: "many", probability: 0.1 },
                      ],
                    },
            ),
            tokens: { input: 30 },
          })
        },
      },
    },
  }
  const service = createPlanningDecisions(
    ctx as never,
    repository,
    { attached: () => true },
    "proj",
  )
  return { repository, service, sent }
}

const ask = {
  sessionID: "s1",
  messageID: "m1",
  text: "Add a view. Make it fast.",
  agent: "architect",
}

test("a switched-off decisions feature is recorded as feature-off and the note guides the Architect", async () => {
  const { repository, service } = fixture({ ...defaultFeatures(true), decisions: false })
  service.start(ask)
  const note = await service.noteFor("s1", "m1")
  expect(note).toContain("decision model not run (feature-off)")
  expect(note).toContain("answer these about the ask yourself")
  const row = repository.read((db) =>
    db
      .query<{ status: string; reason: string }, []>(
        "SELECT status, reason FROM planning_decisions",
      )
      .get(),
  )
  expect(row).toEqual({ status: "unavailable", reason: "feature-off" })
})

test("Settings choose the external model and the slicer", async () => {
  const { repository, service, sent } = fixture(defaultFeatures(true))
  setGlobalSetting(repository, "decisionModel", {
    kind: "external",
    providerID: "openrouter",
    modelID: "m",
  })
  setGlobalSetting(repository, "decisionSlicer", "whole")
  service.start(ask)
  const note = await service.noteFor("s1", "m1")
  expect(note).toContain("Size guess: a few tasks")
  expect(sent.length).toBeGreaterThan(0)
  const row = repository.read((db) =>
    db
      .query<{ decider: string; strategy: string }, []>(
        "SELECT decider, strategy FROM planning_decisions",
      )
      .get(),
  )
  expect(row).toEqual({ decider: "external", strategy: "whole" })
})

test("the architect setting leaves the classification to the Architect", async () => {
  const { repository, service } = fixture(defaultFeatures(true))
  setGlobalSetting(repository, "decisionModel", { kind: "architect" })
  service.start(ask)
  expect(await service.noteFor("s1", "m1")).toContain("decision model not run (no-model)")
})
