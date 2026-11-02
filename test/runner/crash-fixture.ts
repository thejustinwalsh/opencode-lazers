import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { TaskRepository } from "../../src/storage.ts"
import { RunnerStore } from "../../src/runner/store.ts"
import { git } from "../../src/runner/artifacts.ts"
import { TaskRuntime } from "../../src/runner/runtime.ts"
import type { HostSession, RunnerHost } from "../../src/runner/host.ts"

const root = process.argv[2]!,
  fault = process.argv[3]!
const config = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as {
  planID: string
  scopeUpdate?: boolean
  unownedTranscript?: boolean
}
const repository = new TaskRepository(join(root, "data", "tasks.sqlite"), root)
const store = new RunnerStore(repository)
type State = {
  sessions: Record<string, HostSession>
  calls: { kind: string; id: string }[]
  instructions?: Record<string, Record<string, string>>
}
const load = () => JSON.parse(readFileSync(join(root, "host.json"), "utf8")) as State
const save = (value: State) => writeFileSync(join(root, "host.json"), JSON.stringify(value))
function cut(boundary: string) {
  if (fault === boundary && !existsSync(join(root, "fault-used"))) {
    writeFileSync(join(root, "fault-used"), boundary)
    process.kill(process.pid, "SIGKILL")
  }
}
const host: RunnerHost = {
  worktree: async ({ directory, base }) => {
    git(root, ["worktree", "add", "--detach", directory, base])
    return directory
  },
  worktrees: async () =>
    git(root, ["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice(9)),
  removeWorktree: async (directory) => {
    git(root, ["worktree", "remove", directory])
  },
  session: async (id) => load().sessions[id] ?? null,
  create: async (input) => {
    cut("before-session")
    const state = load()
    state.calls.push({ kind: "create", id: input.id })
    state.sessions[input.id] = {
      id: input.id,
      parentID: input.parentID,
      projectID: "fixture",
      directory: input.directory,
      agent: input.agent,
      archived: false,
      busy: false,
      model: input.model,
      metadata: { lazersAttemptID: input.attemptID },
      tokens: 20,
      tools: 1,
      cost: null,
      messages: [],
    }
    save(state)
    cut("after-session")
  },
  createArchitect: async (input) => {
    const state = load()
    state.calls.push({ kind: "create-architect", id: input.id })
    state.sessions[input.id] = {
      id: input.id,
      parentID: input.parentID,
      projectID: "fixture",
      directory: input.directory,
      agent: "architect",
      metadata: {
        lazersContinuation: true,
        lazersPlanID: input.planID,
        lazersSourceSessionID: input.sourceSessionID,
      },
      archived: false,
      busy: false,
      model: input.model,
      tokens: 0,
      tools: 0,
      cost: null,
      messages: [],
    }
    save(state)
  },
  prompt: async (input) => {
    cut("before-prompt")
    const state = load(),
      session = state.sessions[input.sessionID]!
    state.calls.push({ kind: "prompt", id: input.id })
    session.messages.push({ id: input.id, text: input.text })
    writeFileSync(join(session.directory, "result.txt"), "correct\n")
    session.outcome = "succeeded"
    session.turn = { inputID: input.id, state: "completed" }
    session.background = {
      state: "observed",
      source: "experimental.idle",
      observedAt: Date.now(),
      inputID: input.id,
      executionStartSequence: 1,
      eventSequence: 2,
      count: 0,
      kinds: { shell: 0, subagent: 0, image: 0 },
    }
    save(state)
    cut("after-prompt")
  },
  updateInstruction: async (input) => {
    cut("before-instruction")
    const state = load()
    const instructions = (state.instructions ??= {})
    const entries = (instructions[input.sessionID] ??= {})
    if (entries[input.key] !== input.text) {
      entries[input.key] = input.text
      state.calls.push({ kind: "instruction", id: input.key })
      save(state)
    }
    cut("after-instruction")
  },
  notify: async (input) => {
    // This is external host behavior: inspect the committed outbox before accepting delivery.
    const persisted = store.atomic((db) =>
      db.query("SELECT id FROM runner_outbox WHERE message_id=? AND state='sending'").get(input.id),
    )
    if (!persisted) throw new Error("Notification preceded its durable outbox")
    cut("before-notify")
    const state = load()
    const messages = state.sessions[input.sessionID]!.messages
    if (!messages.some((message) => message.id === input.id)) {
      state.calls.push({ kind: "notify", id: input.id })
      messages.push({
        id: input.id,
        text: input.text,
        ...(!config.unownedTranscript
          ? { type: "synthetic", ...(input.metadata ? { metadata: input.metadata } : {}) }
          : {}),
      })
    }
    save(state)
    cut("after-notify")
  },
  interrupt: async (id) => {
    const state = load()
    state.sessions[id]!.busy = false
    state.sessions[id]!.outcome = "interrupted"
    save(state)
  },
}
const runtime = new TaskRuntime(store, host, "fixture")
process.env.LAZERS_TEST_RUNNER_PID = String(process.pid)
if (store.plan(config.planID)!.state === "draft")
  await runtime.command(
    { requestID: "run", planID: config.planID, expectedVersion: 1, action: "run" },
    "owner",
  )
for (let n = 0; n < 12; n++) {
  await runtime.tick()
  if (config.scopeUpdate) {
    const attempt = store.attempts(config.planID)[0]!
    if (
      attempt.state === "running" &&
      !store.latestTransition(config.planID, attempt.task_id, "SCOPE_AMENDED")
    )
      await runtime.command(
        {
          requestID: "authorize-dependency",
          planID: config.planID,
          expectedVersion: store.plan(config.planID)!.version,
          action: "amend-scope",
          taskID: attempt.task_id,
          scopeAdditions: ["dependency.test.ts"],
          reason: "Reviewed dependency test.",
        },
        "owner",
      )
  }
}
console.log(
  JSON.stringify({ state: store.plan(config.planID)!.state, detail: store.detail(config.planID) }),
)
runtime.stop()
repository.close()
