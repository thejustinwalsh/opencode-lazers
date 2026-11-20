import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../../storage.ts"
import { registerPlanningDecisionHooks } from "../server.ts"
import { PlanningStore } from "../store.ts"
import { PlanningDecisions } from "./step.ts"
import type { Answers, Decider } from "./procedure.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
})

function fixture(options: { delayMs?: number; available?: boolean; runbook?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lazers-decision-step-"))
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  cleanup.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  const store = new PlanningStore(repository)
  let release: (() => void) | undefined
  const gate = options.delayMs ? new Promise<void>((r) => (release = r)) : undefined
  let calls = 0
  const decider: Decider = {
    id: "local",
    model: "stub",
    available: () =>
      options.available === false ? { ok: false, reason: "no-window" } : { ok: true },
    async ask(_state, questions) {
      calls++
      if (gate) await gate
      const answers: Answers = {}
      for (const name of Object.keys(questions))
        answers[name] =
          name === "breadth"
            ? { type: "score", probabilities: { "0": 0.1, "1": 0.8, "2": 0.1 } }
            : { type: "noul", noul: 0.4 }
      return { answers, inputTokens: 50 }
    },
  }
  const service = new PlanningDecisions({
    store,
    projectKey: "proj",
    decider: () => decider,
    // The delivery wait is the injected clock, never real time.
    wait: (ms) =>
      options.delayMs
        ? new Promise((r) => setTimeout(r, 5))
        : new Promise((r) => setTimeout(r, ms)),
    constants: options.delayMs ? { deliveryWaitMs: 3_000, budgetMs: 1e9 } : {},
    runbook: options.runbook ? (first) => (first ? "RUNBOOK TEXT" : "(pointer)") : undefined,
    now: (() => {
      let t = 0
      return () => (t += options.delayMs ? 1_000 : 1)
    })(),
  })
  let handler: ((event: unknown) => Effect.Effect<void>) | undefined
  Effect.runSync(
    Effect.scoped(
      registerPlanningDecisionHooks(
        {
          session: {
            hook: (name: string, callback: (event: unknown) => Effect.Effect<void>) => {
              if (name === "context") handler = callback
              return Effect.void
            },
          },
        } as never,
        service,
      ),
    ),
  )
  const send = (messages: unknown[], agent = "architect", sessionID = "s1") => {
    const event = { agent, sessionID, messages }
    return Effect.runPromise(handler!(event)).then(() => messages)
  }
  return { service, store, send, release: () => release?.(), calls: () => calls }
}

const ask = (id: string, text: string) => ({ id, role: "user", content: [{ type: "text", text }] })
const start = (
  f: ReturnType<typeof fixture>,
  id = "m1",
  text = "Add a plan view with a few tasks.",
) => f.service.start({ sessionID: "s1", messageID: id, text, agent: "architect" })

test("one stable note is added to the user message, and a second request gets the same text", async () => {
  const f = fixture()
  start(f)
  const first = (await f.send([ask("m1", "Add a plan view with a few tasks.")])) as ReturnType<
    typeof ask
  >[]
  expect(first[0]!.content).toHaveLength(2)
  const note = first[0]!.content[1]!.text
  expect(note.startsWith("[lz-planning decision m=m1]")).toBe(true)
  const second = (await f.send([ask("m1", "Add a plan view with a few tasks.")])) as ReturnType<
    typeof ask
  >[]
  expect(second).toEqual(first)
  expect(f.store.decision("s1", "m1")?.deliveredText).toBe(note)
})

test("a slow decider delivers the unavailable note with its self-classify guidance, then records late", async () => {
  const f = fixture({ delayMs: 5_000 })
  start(f)
  const messages = (await f.send([ask("m1", "Add a plan view with a few tasks.")])) as ReturnType<
    typeof ask
  >[]
  const delivered = messages[0]!.content[1]!.text
  expect(delivered).toContain("decision model not run (timeout)")
  const row = f.store.decision("s1", "m1")!
  expect(row).toMatchObject({ status: "unavailable", reason: "timeout" })
  f.release()
  await new Promise((r) => setTimeout(r, 50))
  const after = f.store.decision("s1", "m1")!
  expect(after.deliveredText).toBe(delivered)
  expect(JSON.parse(after.lateJson!).status).toBe("decided")
  expect(f.store.decisionNodes(after.id).length).toBeGreaterThan(0)
})

test("a notice, a non-architect session and a repeat record at most one decision", async () => {
  const f = fixture()
  f.service.start({
    sessionID: "s1",
    messageID: "n1",
    text: "[lz-notice kind=accepted plan=p] x",
    agent: "architect",
  })
  f.service.start({
    sessionID: "s1",
    messageID: "w1",
    text: "Work on it.",
    agent: "lazers-implementor",
  })
  start(f)
  start(f)
  await new Promise((r) => setTimeout(r, 20))
  expect(f.store.sessionDecisions("s1").map((r) => r.messageId)).toEqual(["m1"])
  expect(f.calls()).toBe(14)
  const worker = (await f.send([ask("w1", "Work on it.")], "lazers-implementor")) as ReturnType<
    typeof ask
  >[]
  expect(worker[0]!.content).toHaveLength(1)
})

test("the first decided note of a session carries the runbook and the next one only a pointer", async () => {
  const f = fixture({ runbook: true })
  start(f, "m1")
  start(f, "m2", "Another ask. With sentences.")
  const [one, two] = (await f.send([
    ask("m1", "Add a plan view with a few tasks."),
    ask("m2", "Another ask. With sentences."),
  ])) as ReturnType<typeof ask>[]
  expect(one!.content[1]!.text).toContain("RUNBOOK TEXT")
  expect(two!.content[1]!.text).not.toContain("RUNBOOK TEXT")
  expect(two!.content[1]!.text).toContain("(pointer)")
})

test("with no decision model the note still delivers, and the Architect's own pick can be recorded", async () => {
  const f = fixture({ available: false })
  start(f)
  const out = (await f.send([ask("m1", "Add a plan view with a few tasks.")])) as ReturnType<
    typeof ask
  >[]
  expect(out[0]!.content[1]!.text).toContain("decision model not run (no-window)")
  const row = f.store.decision("s1", "m1")!
  f.store.setArchitectPick(row.id, { size: "a few tasks", agents: ["grounding"] })
  expect(JSON.parse(f.store.decision("s1", "m1")!.architectJson!)).toEqual({
    source: "architect",
    size: "a few tasks",
    agents: ["grounding"],
  })
})

test("a runbook is offered for a plan-sized ask and never for a simple one", async () => {
  const f = fixture({ runbook: true })
  start(f, "m1")
  const out = (await f.send([ask("m1", "Add a plan view with a few tasks.")])) as ReturnType<
    typeof ask
  >[]
  expect(out[0]!.content[1]!.text).toContain("RUNBOOK TEXT")
})
