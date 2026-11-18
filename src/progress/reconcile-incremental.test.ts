import { expect, test } from "bun:test"
import { makeFixture } from "../../test/trajectory/fixture.ts"
import { ProgressRecorder } from "./recorder.ts"

const workerSession = "ses-failed"

function toolPart(id: string, status: "running" | "completed", index: number) {
  return {
    type: "tool",
    id,
    name: "Bash",
    executed: true,
    time: { created: 1_000 + index, ran: 1_100 + index },
    state:
      status === "completed"
        ? { status, input: { command: "ls" }, content: [{ type: "text", text: `out ${index}` }] }
        : { status, input: { command: "ls" } },
  }
}

function assistant(index: number, parts: number, status: "running" | "completed" = "completed") {
  return {
    id: `msg-${index}`,
    type: "assistant",
    time: {
      created: 1_000 + index,
      ...(status === "completed" ? { completed: 2_000 + index } : {}),
    },
    content: [
      { type: "text", text: `message ${index} api_key=sk-secret-${index}-abcdefghijklmnop` },
      ...Array.from({ length: parts }, (_, part) =>
        toolPart(`call-${index}-${part}`, status, index),
      ),
    ],
  }
}

function history(count: number, parts: number) {
  return Array.from({ length: count }, (_, index) => assistant(index, parts))
}

function rows(fixture: ReturnType<typeof makeFixture>) {
  return (
    fixture.store
      .atomic((db) =>
        db
          .query<{ dedupe_key: string; kind: string; call_id: string | null; payload: string }, []>(
            "SELECT dedupe_key,kind,call_id,payload FROM runner_progress ORDER BY dedupe_key",
          )
          .all(),
      )
      .filter((row) => !row.dedupe_key.startsWith("recovery-gap:"))
      // Key order differs between a streamed-then-completed merge and a one-shot write.
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown }))
  )
}

test("one-pass and incremental reconciliation record identical rows", () => {
  const onePass = makeFixture()
  const incremental = makeFixture()
  try {
    const full = [
      ...history(30, 3),
      assistant(30, 2, "running"),
      { id: "msg-user", type: "user", text: "hello", time: { created: 5 } },
    ]
    new ProgressRecorder(onePass.store, "project").reconcileMessages(workerSession, [
      ...full.slice(0, 30),
      assistant(30, 2, "completed"),
      full[31]!,
    ])

    const recorder = new ProgressRecorder(incremental.store, "project")
    for (const length of [5, 12, 30])
      recorder.reconcileMessages(workerSession, full.slice(0, length))
    // A message streams: running first, then completes with one more part.
    recorder.reconcileMessages(workerSession, [...full.slice(0, 30), assistant(30, 2, "running")])
    // A fresh recorder (restart) finishes the history.
    new ProgressRecorder(incremental.store, "project").reconcileMessages(workerSession, [
      ...full.slice(0, 30),
      assistant(30, 2, "completed"),
      full[31]!,
    ])

    expect(rows(incremental)).toEqual(rows(onePass))
    expect(rows(onePass).length).toBeGreaterThan(100)
  } finally {
    onePass.close()
    incremental.close()
  }
})

test("a follow-up run after one new part reprocesses one message, not the history", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const messages: ReturnType<typeof assistant>[] = history(2_000, 4)
    recorder.reconcileMessages(workerSession, messages)
    expect(recorder.reconcileStats.messages).toBe(2_000)
    expect(recorder.reconcileStats.parts).toBe(2_000 * 5)

    const before = { ...recorder.reconcileStats }
    const last = messages[1_999]!
    messages[1_999] = {
      ...last,
      content: [...last.content, toolPart("call-new", "running", 1_999)],
    }
    recorder.reconcileMessages(workerSession, structuredClone(messages))
    expect(recorder.reconcileStats.messages - before.messages).toBe(1)
    expect(recorder.reconcileStats.parts - before.parts).toBe(6)

    // Nothing changed: no message is reprocessed.
    const settled = { ...recorder.reconcileStats }
    recorder.reconcileMessages(workerSession, structuredClone(messages))
    expect(recorder.reconcileStats.messages).toBe(settled.messages)
    expect(recorder.reconcileStats.parts).toBe(settled.parts)

    // Restart: a fresh recorder on the same database reuses the durable stamps.
    const restarted = new ProgressRecorder(fixture.store, "project")
    restarted.reconcileMessages(workerSession, structuredClone(messages))
    expect(restarted.reconcileStats.messages).toBe(0)
    expect(restarted.reconcileStats.parts).toBe(0)
  } finally {
    fixture.close()
  }
})

test("a changed message is reprocessed after a restart", () => {
  const fixture = makeFixture()
  try {
    const messages: ReturnType<typeof assistant>[] = history(50, 2)
    new ProgressRecorder(fixture.store, "project").reconcileMessages(workerSession, messages)
    messages[10] = assistant(10, 3)
    const restarted = new ProgressRecorder(fixture.store, "project")
    restarted.reconcileMessages(workerSession, messages)
    expect(restarted.reconcileStats.messages).toBe(1)
    expect(rows(fixture).some((row) => row.call_id === "call-10-2")).toBe(true)
  } finally {
    fixture.close()
  }
})

test("secrets are redacted only for processed text and never stored raw", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    recorder.reconcileMessages(workerSession, history(5, 1))
    expect(rows(fixture).some((row) => JSON.stringify(row.payload).includes("sk-secret-"))).toBe(
      false,
    )
  } finally {
    fixture.close()
  }
})

test("a large first run yields to the event loop between short transactions", async () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    let transactions = 0
    const run = fixture.store.atomic.bind(fixture.store)
    fixture.store.atomic = ((fn: Parameters<typeof run>[0]) => {
      transactions++
      return run(fn)
    }) as typeof fixture.store.atomic

    let ticks = 0
    const timer = setInterval(() => ticks++, 1)
    try {
      await recorder.reconcileMessagesAsync(workerSession, history(1_500, 3))
    } finally {
      clearInterval(timer)
    }
    expect(recorder.reconcileStats.messages).toBe(1_500)
    // At most 25 messages per transaction.
    expect(transactions).toBeGreaterThanOrEqual(1_500 / 25)
    expect(ticks).toBeGreaterThan(5)
  } finally {
    fixture.close()
  }
})
