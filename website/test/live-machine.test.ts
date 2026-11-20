import { describe, expect, test } from "bun:test"
import {
  initialState,
  reduce,
  workingLabel,
  type ChatEvent,
  type ChatState,
  type Effect,
} from "../src/live/machine"

function run(state: ChatState, ...events: ChatEvent[]) {
  const effects: Effect[] = []
  for (const event of events) {
    const [next, out] = reduce(state, event)
    state = next
    effects.push(...out)
  }
  return { state, effects }
}
const type = (text: string): ChatEvent[] => [{ t: "draft", text }, { t: "send" }]
const files = (done: number): ChatEvent => ({
  t: "download",
  files: [
    { id: "model", name: "model.gguf", done, total: 1000 },
    { id: "projector", name: "mmproj.gguf", done: 0, total: 500 },
  ],
})
const kinds = (effects: Effect[]) => effects.map((e) => e.t)

describe("first use", () => {
  test("the opening message explains the demo and nothing is requested", () => {
    expect(initialState().messages[0]?.kind).toBe("intro")
    expect(initialState().phase.name).toBe("idle")
  })

  test("the first send queues the message and starts the load once", () => {
    const { state, effects } = run(initialState(), ...type("hello"), ...type("again"))
    expect(kinds(effects)).toEqual(["load"])
    expect(state.phase.name).toBe("starting")
    expect(state.messages.filter((m) => m.role === "user").map((m) => m.status)).toEqual([
      "queued",
      "queued",
    ])
    expect(state.jobs).toHaveLength(2)
    expect(state.draft).toBe("")
  })

  test("blank drafts are not sent", () => {
    expect(run(initialState(), ...type("   ")).effects).toEqual([])
  })

  test("download progress is the working state, then GPU load, then the answer", () => {
    let r = run(initialState(), ...type("hi"), files(250))
    expect(r.state.phase.name).toBe("downloading")
    expect(workingLabel(r.state)).toMatch(/Downloading/)
    r = run(r.state, { t: "loading", fromCache: false })
    expect(workingLabel(r.state)).toMatch(/GPU/)
    r = run(r.state, { t: "loaded", fromCache: false })
    expect(r.state.phase.name).toBe("ready")
    const generate = r.effects.find((e) => e.t === "generate")
    expect(generate).toMatchObject({ t: "generate" })
    expect(generate && generate.t === "generate" && generate.history.at(-1)).toEqual({
      role: "user",
      content: "hi",
    })
    r = run(r.state, { t: "token", id: r.state.current!.id, text: "Hel" })
    r = run(r.state, { t: "token", id: r.state.current!.id, text: "lo" })
    expect(r.state.messages.at(-1)).toMatchObject({ role: "assistant", text: "Hello" })
  })

  test("a cached load goes straight to loading and says so", () => {
    const r = run(initialState(), ...type("hi"), { t: "loading", fromCache: true })
    expect(r.state.phase).toEqual({ name: "loading", fromCache: true })
    const done = run(r.state, { t: "loaded", fromCache: true })
    expect(done.state.phase).toEqual({ name: "ready", fromCache: true })
  })
})

describe("queue", () => {
  const ready = () =>
    run(initialState(), ...type("one"), ...type("two"), { t: "loaded", fromCache: true })

  test("messages queued during the load run in order", () => {
    let r = ready()
    expect(r.state.current).toMatchObject({ kind: "message" })
    const first = r.state.current!.id
    r = run(r.state, { t: "genDone", id: first, text: "A" })
    const second = r.effects.find((e) => e.t === "generate")
    expect(second).toBeDefined()
    expect(second?.t === "generate" && second.history.map((m) => m.content)).toEqual([
      "one",
      "A",
      "two",
    ])
  })

  test("a message sent while generating waits its turn", () => {
    let r = ready()
    r = run(r.state, ...type("three"))
    expect(r.effects).toEqual([])
    expect(r.state.jobs).toHaveLength(2)
  })

  test("auto read aloud speaks only when nothing else is waiting", () => {
    let r = ready()
    const first = r.state.current!.id
    r = run(r.state, { t: "genDone", id: first, text: "A" })
    expect(kinds(r.effects)).not.toContain("speak")
    const second = r.state.current!.id
    r = run(r.state, { t: "genDone", id: second, text: "B. Done." })
    const speak = r.effects.find((e) => e.t === "speak")
    expect(speak).toMatchObject({ text: "B. Done." })
    expect(r.state.speech).toMatchObject({ name: "preparing", mode: "auto" })
    expect(r.state.messages.find((m) => m.replyTo === second)?.id).toBe(
      r.state.speech.name === "idle" ? -1 : r.state.speech.id,
    )
  })

  test("starting the next turn stops speech", () => {
    let r = run(initialState(), ...type("one"), { t: "loaded", fromCache: true })
    const id = r.state.current!.id
    r = run(r.state, { t: "genDone", id, text: "A" }, { t: "speechPlaying" })
    expect(r.state.speech.name).toBe("playing")
    r = run(r.state, ...type("two"))
    expect(kinds(r.effects)).toEqual(["stopSpeech", "generate"])
    expect(r.state.speech.name).toBe("idle")
  })
})

describe("stop, retry and errors", () => {
  test("stop during the download pauses it and keeps the queue", () => {
    let r = run(initialState(), ...type("hi"), files(100), { t: "stop" })
    expect(kinds(r.effects)).toContain("cancelLoad")
    expect(r.state.phase).toMatchObject({ name: "failed", reason: "cancelled" })
    expect(r.state.jobs).toHaveLength(1)
    r = run(r.state, { t: "retry" })
    expect(kinds(r.effects)).toEqual(["load"])
    expect(r.state.phase.name).toBe("starting")
  })

  test("sending after a pause restarts the load", () => {
    const r = run(initialState(), ...type("hi"), { t: "stop" }, ...type("again"))
    expect(kinds(r.effects).filter((k) => k === "load")).toHaveLength(2)
    expect(r.state.jobs).toHaveLength(2)
  })

  test("a failed download offers retry and keeps the message", () => {
    let r = run(initialState(), ...type("hi"), files(100), {
      t: "loadFailed",
      reason: "offline",
      message: "The network dropped.",
    })
    expect(r.state.phase).toMatchObject({ name: "failed", reason: "offline" })
    expect(r.state.messages.filter((m) => m.status === "queued")).toHaveLength(1)
    r = run(r.state, { t: "retry" })
    expect(kinds(r.effects)).toEqual(["load"])
  })

  test("retry is ignored unless the load failed", () => {
    expect(run(initialState(), { t: "retry" }).effects).toEqual([])
  })

  test("stop during generation keeps the partial answer and stops the queue", () => {
    let r = run(initialState(), ...type("one"), ...type("two"), { t: "loaded", fromCache: true })
    const id = r.state.current!.id
    r = run(r.state, { t: "token", id, text: "Par" }, { t: "stop" })
    expect(kinds(r.effects)).toContain("cancelJob")
    expect(r.state.current).toBeNull()
    expect(r.state.jobs).toEqual([])
    expect(r.state.messages.filter((m) => m.role === "assistant").at(-1)).toMatchObject({
      text: "Par",
      status: "stopped",
    })
    expect(r.state.messages.filter((m) => m.role === "user").map((m) => m.status)).toEqual([
      "sent",
      "stopped",
    ])
  })

  test("stop while speaking only stops speech", () => {
    let r = run(initialState(), ...type("one"), { t: "loaded", fromCache: true })
    const id = r.state.current!.id
    r = run(r.state, { t: "genDone", id, text: "A" }, { t: "speechPlaying" })
    r = run(r.state, { t: "stop" })
    expect(kinds(r.effects)).toEqual(["stopSpeech"])
  })

  test("a failed generation shows the error and the next message still runs", () => {
    let r = run(initialState(), ...type("one"), ...type("two"), { t: "loaded", fromCache: true })
    const id = r.state.current!.id
    r = run(r.state, { t: "genFailed", id, message: "Out of GPU memory." })
    expect(r.state.messages.find((m) => m.status === "failed")?.text).toContain("Out of GPU")
    expect(kinds(r.effects)).toContain("generate")
  })

  test("device loss fails the load state and a retry reloads", () => {
    let r = run(initialState(), ...type("one"), { t: "loaded", fromCache: true })
    r = run(r.state, { t: "deviceLost", message: "The GPU was reset." })
    expect(r.state.phase).toMatchObject({ name: "failed", reason: "gpu" })
    expect(r.state.current).toBeNull()
    r = run(r.state, { t: "retry" })
    expect(kinds(r.effects)).toEqual(["load"])
  })

  test("unsupported browsers disable everything and say so", () => {
    let r = run(initialState(), { t: "unsupported", message: "No WebGPU." })
    expect(r.state.phase.name).toBe("unsupported")
    expect(r.state.messages.at(-1)?.kind).toBe("notice")
    r = run(r.state, ...type("hi"), { t: "mic" })
    expect(r.effects).toEqual([])
  })

  test("unload releases the model, keeps the transcript and reloads on the next send", () => {
    let r = run(initialState(), ...type("one"), { t: "loaded", fromCache: true })
    const id = r.state.current!.id
    r = run(r.state, { t: "genDone", id, text: "A" }, { t: "unload" })
    expect(kinds(r.effects)).toContain("unload")
    expect(r.state.phase.name).toBe("idle")
    expect(r.state.messages.length).toBeGreaterThan(2)
    r = run(r.state, ...type("two"))
    expect(kinds(r.effects)).toEqual(["load"])
  })
})

describe("speaker pill", () => {
  const answered = () => {
    const r = run(initialState(), ...type("one"), { t: "loaded", fromCache: true })
    const id = r.state.current!.id
    return run(r.state, { t: "genDone", id, text: "A" }, { t: "speechDone" })
  }
  test("auto is on by default; shift toggles it and stops auto speech", () => {
    let r = answered()
    expect(r.state.autoRead).toBe(true)
    r = run(r.state, { t: "speaker", shift: true })
    expect(r.state.autoRead).toBe(false)
    r = run(r.state, { t: "speaker", shift: true }, { t: "speechPlaying" })
    expect(r.state.autoRead).toBe(true)
  })
  test("turning auto off while it speaks stops the speech", () => {
    let r = run(initialState(), ...type("one"), { t: "loaded", fromCache: true })
    r = run(r.state, { t: "genDone", id: r.state.current!.id, text: "A" }, { t: "speechPlaying" })
    r = run(r.state, { t: "speaker", shift: true })
    expect(kinds(r.effects)).toEqual(["stopSpeech"])
    expect(r.state.autoRead).toBe(false)
  })
  test("a plain click re-reads the last answer, and stops it when speaking", () => {
    let r = run(answered().state, { t: "speaker", shift: false })
    expect(kinds(r.effects)).toEqual(["speak"])
    expect(r.state.speech).toMatchObject({ name: "preparing", mode: "manual" })
    r = run(r.state, { t: "speaker", shift: false })
    expect(kinds(r.effects)).toEqual(["stopSpeech"])
    expect(r.state.speech.name).toBe("idle")
  })
  test("a plain click with nothing to read does nothing", () => {
    expect(run(initialState(), { t: "speaker", shift: false }).effects).toEqual([])
  })
  test("speech failure is reported without touching the transcript", () => {
    const r = run(
      answered().state,
      { t: "speaker", shift: false },
      { t: "speechFailed", message: "x" },
    )
    expect(r.state.speech.name).toBe("idle")
    expect(r.state.notice).toContain("x")
  })
})

describe("microphone pill", () => {
  test("the first click records and starts the load", () => {
    const r = run(initialState(), { t: "mic" })
    expect(kinds(r.effects)).toEqual(["record", "load"])
    expect(r.state.mic).toBe("permission")
    expect(r.state.phase.name).toBe("starting")
  })
  test("click again while recording stops and queues the transcription until ready", () => {
    let r = run(initialState(), { t: "mic" }, { t: "recording" })
    expect(r.state.mic).toBe("recording")
    r = run(r.state, { t: "mic" })
    expect(kinds(r.effects)).toEqual(["stopRecording"])
    r = run(r.state, { t: "recorded", audioId: 1, silent: false })
    expect(r.state.mic).toBe("transcribing")
    expect(r.effects).toEqual([])
    r = run(r.state, { t: "loaded", fromCache: false })
    expect(r.effects).toContainEqual({ t: "transcribe", audioId: 1 })
  })
  test("the transcript lands in the composer, not sent", () => {
    let r = run(
      initialState(),
      { t: "draft", text: "hello" },
      { t: "mic" },
      { t: "recording" },
      { t: "mic" },
      { t: "loaded", fromCache: true },
      { t: "recorded", audioId: 2, silent: false },
    )
    r = run(r.state, { t: "transcribed", text: "world" })
    expect(r.state.draft).toBe("hello world")
    expect(r.state.mic).toBe("idle")
    expect(kinds(r.effects)).toEqual(["focusComposer"])
    expect(r.state.messages.filter((m) => m.role === "user")).toEqual([])
  })
  test("permission denied explains itself", () => {
    const r = run(initialState(), { t: "mic" }, { t: "micDenied", message: "Blocked." })
    expect(r.state.mic).toBe("idle")
    expect(r.state.messages.at(-1)).toMatchObject({ kind: "notice" })
    expect(r.state.messages.at(-1)?.text).toContain("microphone")
  })
  test("a silent recording is dropped with a notice", () => {
    const r = run(
      initialState(),
      { t: "mic" },
      { t: "recording" },
      { t: "mic" },
      { t: "recorded", audioId: 3, silent: true },
    )
    expect(r.state.mic).toBe("idle")
    expect(r.state.jobs).toEqual([])
    expect(r.state.notice).toMatch(/No audio/)
  })
  test("stop while recording discards it", () => {
    const r = run(initialState(), { t: "mic" }, { t: "recording" }, { t: "stop" })
    expect(kinds(r.effects)).toContain("cancelRecording")
    expect(r.state.mic).toBe("idle")
  })
})
