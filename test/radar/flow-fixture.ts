import type { RadarLive } from "../../src/radar/live-view.ts"

/**
 * The data behind design/reviews/fable-ui-review-20261117/mockups/radar-flow.html as a live read:
 * an idle Architect, four running workers (one waiting on a permission) and one failed worker,
 * with the mockup's per-destination counts and heats.
 */
const TASK = "5f0c2a1e-7b3d-4c8e-9a1f-0d2b3c4e5f60"
type Sink =
  "luna" | "kimi" | "qwen" | "sol" | "files" | "shell" | "git" | "checks" | "search" | "you"
const MODELS: Record<string, { modelID: string; variant: string | null }> = {
  luna: { modelID: "gpt-6-luna", variant: "max" },
  kimi: { modelID: "kimi-k3.1-pro", variant: null },
  qwen: { modelID: "qwen3.8-flash", variant: null },
  sol: { modelID: "gpt-6.1-sol", variant: "high" },
}
const SESSIONS = [
  { id: "arch", ref: undefined, agent: "architect" },
  { id: "s99", ref: "LZ-99", agent: "lazers-implementer" },
  { id: "s146", ref: "LZ-146", agent: "lazers-implementer" },
  { id: "s135", ref: "LZ-135", agent: "lazers-implementer" },
  { id: "s134", ref: "LZ-134", agent: "lazers-verifier" },
  { id: "s118", ref: "LZ-118", agent: "lazers-implementer" },
]
/** [session, sink, count in 2 min, heat 0..1 (1 = a call is running now)] */
const FLOWS: Array<[string, Sink, number, number]> = [
  ["s99", "luna", 6, 1],
  ["s99", "shell", 4, 1],
  ["s99", "files", 9, 0.8],
  ["s99", "search", 2, 0.35],
  ["s146", "luna", 3, 0.9],
  ["s146", "files", 5, 1],
  ["s135", "kimi", 1, 0.2],
  ["s135", "you", 1, 1],
  ["s135", "git", 1, 0.5],
  ["s134", "qwen", 2, 0.8],
  ["s134", "checks", 3, 1],
  ["s118", "shell", 2, 0.12],
  ["s118", "luna", 1, 0.1],
  ["arch", "sol", 1, 0.1],
]
const TOOL: Partial<Record<Sink, string>> = {
  files: "edit",
  shell: "bash",
  git: "git_worktree",
  checks: "check",
  search: "grep",
  you: "question",
}
const TARGETS = [
  "src/runner/lifecycle.ts",
  "src/runner/resume.test.ts",
  "src/models/comparison-panel.tsx",
  "src/runner/lease.ts",
]

export function mockupFlowLive(now: number): RadarLive {
  const sessions = SESSIONS.map((entry) => ({
    id: `session:${entry.id}`,
    sessionID: entry.id,
    projectID: "project",
    classification: "managed",
    isViewSession: false,
    isCurrentArchitect: entry.id === "arch" ? true : null,
    availability: "available",
    freshness: "current",
    agent: entry.agent,
    state: entry.id === "arch" ? "idle" : "busy",
    assignment: entry.ref
      ? {
          planID: TASK,
          taskID: TASK,
          attemptID: TASK,
          state: entry.id === "s134" ? "verifying" : "running",
          startedAt: now - 12 * 60_000,
          taskReference: entry.ref,
        }
      : null,
    selectedRouteID: null,
    configuredRouteID: null,
    observedRouteID: null,
    routeCoverage: { selected: "unavailable", configured: "unavailable", observed: "not-observed" },
    updatedAt: entry.id === "arch" ? now - 29 * 60_000 : now - 1_000,
    observedAt: now,
  }))
  const routes = Object.entries(MODELS).map(([key, model]) => ({
    id: `route:${key}`,
    providerID: "openai",
    ...model,
    source: "step-event" as const,
    sessionID: "s99",
    attemptID: null,
    messageID: null,
    eventID: null,
    observedAt: now - (key === "kimi" ? 6 * 60_000 : key === "sol" ? 29 * 60_000 : 5_000),
  }))
  const calls: unknown[] = []
  const flow: unknown[] = []
  let n = 0
  for (const [session, sink, count, heat] of FLOWS) {
    const lastAt = now - Math.round((1 - heat) * 120_000)
    for (let index = 0; index < count; index++) {
      n++
      const running = heat === 1 && index === 0
      const at = running
        ? now - 5_000
        : Math.min(now - 1_500, lastAt - (index - (heat === 1 ? 1 : 0)) * 6_000)
      const model = MODELS[sink]
      if (model) {
        const messageID = `m${n}`
        flow.push({
          id: `req${n}`,
          kind: "model-request",
          source: "native-event",
          sessionID: session,
          messageID,
          routeID: `route:${sink}`,
          status: "request-started",
          startedAt: at,
          observedAt: at,
          from: null,
          to: null,
          callID: null,
          tool: null,
          agent: null,
          toolID: null,
          sourceProgressSequence: null,
          sourceNativeRevision: null,
          sourceEventID: null,
          sourceEventType: null,
        })
        if (!running)
          flow.push({
            id: `res${n}`,
            kind: "model-response",
            source: "native-event",
            sessionID: session,
            messageID,
            routeID: `route:${sink}`,
            status: "request-ended",
            startedAt: null,
            observedAt: at + 1_500,
            from: null,
            to: null,
            callID: null,
            tool: null,
            agent: null,
            toolID: null,
            sourceProgressSequence: null,
            sourceNativeRevision: null,
            sourceEventID: null,
            sourceEventType: null,
            usage: { input: sink === "luna" ? 41_000 : 8_000, output: sink === "luna" ? 620 : 300 },
          })
        continue
      }
      const failed = session === "s118" && sink === "shell" && index === 0
      const tool = sink === "files" && index % 2 === 1 ? "read" : TOOL[sink]!
      calls.push({
        id: `c${n}`,
        sessionID: session,
        attemptID: TASK,
        messageID: "m",
        callID: `c${n}`,
        tool,
        status: running ? "running" : failed ? "failed" : "succeeded",
        execution: "executed",
        inputAt: at,
        calledAt: at,
        completedAt: running ? null : at + 800,
        observedAt: at,
        sourceProgressSequence: 1,
        sourceEventID: null,
        sourceEventType: null,
        result: null,
        error: failed ? "exit 1 · 3 tests failed" : null,
        payloadAvailable: false,
        ...(sink === "files"
          ? {
              fileTargets: {
                coverage: "observed",
                operation: tool === "edit" ? "edit" : "read",
                paths: [TARGETS[index % TARGETS.length]!],
              },
            }
          : {}),
      })
    }
  }
  return {
    sessions,
    routes,
    calls,
    flow,
    scheduler: { status: "scheduled", participants: 5 },
    workload: { queued: 6, needsYou: 1, failed: 1 },
  } as unknown as RadarLive
}
