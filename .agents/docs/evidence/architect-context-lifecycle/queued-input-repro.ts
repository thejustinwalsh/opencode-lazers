// Isolated candidate-code experiment. No native sessions, application database,
// worker checkout, models or scheduler state are modified.
const candidate = process.env.LAZERS_CANDIDATE_DIRECTORY
if (!candidate) throw new Error("Set LAZERS_CANDIDATE_DIRECTORY to the retained e127d1a checkout")
const { makeFixture } = await import(`${candidate}/test/trajectory/fixture.ts`)
const { TaskRuntime } = await import(`${candidate}/src/runner/runtime.ts`)
const fixture = makeFixture()
try {
  const now = 2_000_000_000_000
  const owner = {
    id: "ses-owner",
    agent: "architect",
    projectID: "project",
    directory: fixture.directory,
    archived: false,
    busy: false,
    idleAt: now - 1_800_000,
    model: { providerID: "openai", id: "gpt-6.1-sol", variant: "high" },
    tokens: null,
    tools: 0,
    cost: null,
    retries: 0,
    messages: [],
  }
  const sessions = new Map([[owner.id, owner]])
  const foreignInput = {
    id: "msg_external_queued",
    type: "synthetic",
    delivery: "queue",
    text: "External admitted input must not be stranded",
    metadata: { source: "another-plugin" },
  }
  let queued: unknown[] = []
  let inboxReads = 0
  const host = {
    session: async (id: string) => sessions.get(id) ?? null,
    outcomeInbox: async (id: string) => {
      inboxReads++
      return id === owner.id ? queued : []
    },
    createArchitect: async (input: any) => {
      sessions.set(input.id, {
        ...owner,
        id: input.id,
        idleAt: undefined,
        parentID: owner.id,
        metadata: {
          lazersContinuation: true,
          lazersPlanID: input.planID,
          lazersPlanIDs: input.planIDs,
          lazersSourceSessionID: input.sourceSessionID,
        },
      } as any)
      // session.synthetic({delivery: "queue", resume: false}) bypasses the prompt
      // hook on pinned OpenCode and may be admitted while create is outstanding.
      queued = [foreignInput]
    },
    updateSession: async ({ sessionID, archived }: any) => {
      sessions.get(sessionID)!.archived = archived
    },
  }
  const runtime = new TaskRuntime(fixture.store, host as any, "project", undefined, {
    architectPromptHook: true,
    now: () => now,
  })
  const fence = fixture.store.claim(runtime.owner, now)!
  // Exercise the candidate renewal implementation without running unrelated
  // fixture tasks or calling any real native dispatch.
  await (runtime as any).considerArchitectRenewal(
    fixture.store.plan(fixture.receipt.planID),
    owner,
    fence,
  )
  const renewal = fixture.store.architectRenewalForPlan(fixture.receipt.planID)!
  const handoff = fixture.store
    .outboxForDelivery()
    .find((row: any) => row.id === renewal.handoff_outbox_id)
  console.log(
    JSON.stringify(
      {
        artifact: "e127d1a5836b65ca6d89dd19974f94249e9df1ed",
        experiment: "isolated candidate renewal function; not native dogfood",
        renewalState: renewal.state,
        predecessorArchived: owner.archived,
        ownerTransferred:
          fixture.store.plan(fixture.receipt.planID)!.owner === renewal.successor_session_id,
        queuedForeignInputStillOnPredecessor: queued.length === 1,
        nativeInboxReads: inboxReads,
        handoffPayload: handoff ? JSON.parse(handoff.payload) : null,
        nativeOrModelEffects: false,
      },
      null,
      2,
    ),
  )
} finally {
  fixture.close()
}
