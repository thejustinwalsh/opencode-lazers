/**
 * The live chat's state machine: a pure reducer, `reduce(state, event) -> [state, effects]`.
 * It owns every workflow state of the demo (load, queue, generation, speech, microphone); the
 * controller only performs the returned effects and reports results back as events. Nothing here
 * touches the DOM, the worker or the network, so the whole flow is unit-tested.
 *
 * It is a hand-written reducer rather than XState because the website takes no runtime dependency
 * beyond ruNNtime. Every non-terminal state has an exit: stop, retry, unload or an event from the
 * controller.
 */
import { MODEL_BYTES } from "../../../src/webgpu/manifest"

export type FileProgress = { id: string; name: string; done: number; total: number }

export type FailureReason = "cancelled" | "offline" | "storage" | "gpu" | "error"

export type Phase =
  | { name: "idle" }
  /** The load was requested; the worker is checking WebGPU and the browser cache. */
  | { name: "starting" }
  | { name: "downloading"; files: FileProgress[] }
  /** Weights are being read from browser storage onto the GPU. */
  | { name: "loading"; fromCache: boolean }
  | { name: "ready"; fromCache: boolean }
  | { name: "failed"; reason: FailureReason; message: string }
  | { name: "unsupported"; message: string }

export type MessageKind = "intro" | "notice" | "chat"
export type MessageStatus = "queued" | "sent" | "streaming" | "done" | "stopped" | "failed"
export type Message = {
  id: number
  role: "user" | "assistant"
  kind: MessageKind
  text: string
  status: MessageStatus
  /** For a reply: the id of the user message (or job) it answers. */
  replyTo?: number
}

export type Job = { kind: "message"; id: number } | { kind: "transcribe"; id: number }
export type Speech =
  { name: "idle" } | { name: "preparing" | "playing"; mode: "auto" | "manual"; id: number }
export type Mic = "idle" | "permission" | "recording" | "transcribing"

export type ChatState = {
  phase: Phase
  messages: Message[]
  draft: string
  /** Waiting work, oldest first; `current` is the job the GPU is running. */
  jobs: Job[]
  current: Job | null
  speech: Speech
  mic: Mic
  autoRead: boolean
  /** A short status line under the chat (speech failed, no audio heard). */
  notice: string
  nextId: number
}

export type HistoryMessage = { role: "user" | "assistant"; content: string }

export type Effect =
  | { t: "load" }
  | { t: "cancelLoad" }
  | { t: "generate"; id: number; history: HistoryMessage[] }
  | { t: "transcribe"; audioId: number }
  | { t: "cancelJob" }
  | { t: "speak"; id: number; text: string }
  | { t: "stopSpeech" }
  | { t: "record" }
  | { t: "stopRecording" }
  | { t: "cancelRecording" }
  | { t: "unload" }
  | { t: "focusComposer" }

export type ChatEvent =
  | { t: "draft"; text: string }
  | { t: "send" }
  | { t: "mic" }
  | { t: "speaker"; shift: boolean }
  | { t: "stop" }
  | { t: "retry" }
  | { t: "unload" }
  | { t: "unsupported"; message: string }
  // From the controller:
  | { t: "download"; files: FileProgress[] }
  | { t: "loading"; fromCache: boolean }
  | { t: "loaded"; fromCache: boolean }
  | { t: "loadFailed"; reason: FailureReason; message: string }
  | { t: "deviceLost"; message: string }
  | { t: "unloaded" }
  | { t: "token"; id: number; text: string }
  | { t: "genDone"; id: number; text: string }
  | { t: "genFailed"; id: number; message: string }
  | { t: "speechPlaying" }
  | { t: "speechDone" }
  | { t: "speechFailed"; message: string }
  | { t: "recording" }
  | { t: "micDenied"; message: string }
  | { t: "recorded"; audioId: number; silent: boolean }
  | { t: "recordFailed"; message: string }
  | { t: "transcribed"; text: string }
  | { t: "transcribeFailed"; message: string }

export const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`
export const MODEL_SIZE_LABEL = gigabytes(MODEL_BYTES)

/** Oldest messages leave the prompt first once the chat grows past what a small model's context
 *  is useful for; the transcript on screen is never trimmed. */
export const CONTEXT_MESSAGES = 12

export const INTRO_TEXT = `This is the local model running for real, in this tab. It is a small model, about 2 billion parameters, so expect short, plain answers and the odd mistake.

Type a message below, or click the microphone, talk, and click it again: your words are transcribed on this device and put in the message box. Replies are read aloud. Shift-click the speaker to turn that off.

The first message downloads the model weights, ${MODEL_SIZE_LABEL}, once into this browser's storage. After that everything runs on this device's GPU. Nothing you type or say is sent to a server.`

export function initialState(): ChatState {
  return {
    phase: { name: "idle" },
    messages: [{ id: 0, role: "assistant", kind: "intro", text: INTRO_TEXT, status: "done" }],
    draft: "",
    jobs: [],
    current: null,
    speech: { name: "idle" },
    mic: "idle",
    autoRead: true,
    notice: "",
    nextId: 1,
  }
}

type Result = [ChatState, Effect[]]

const patch = (state: ChatState, changes: Partial<ChatState>): ChatState => ({
  ...state,
  ...changes,
})
const setMessage = (state: ChatState, id: number, changes: Partial<Message>): ChatState =>
  patch(state, { messages: state.messages.map((m) => (m.id === id ? { ...m, ...changes } : m)) })
const append = (state: ChatState, message: Omit<Message, "id">): ChatState =>
  patch(state, {
    messages: [...state.messages, { ...message, id: state.nextId }],
    nextId: state.nextId + 1,
  })

export const loadActive = (phase: Phase) =>
  phase.name === "starting" || phase.name === "downloading" || phase.name === "loading"

const speaking = (speech: Speech) => speech.name !== "idle"

/** The model's view of the conversation up to and including `id`, minus notices and failures. */
function historyThrough(state: ChatState, id: number): HistoryMessage[] {
  const history: HistoryMessage[] = []
  for (const m of state.messages) {
    if (m.kind !== "chat") continue
    if (m.role === "user" && m.status !== "stopped") history.push({ role: "user", content: m.text })
    if (m.role === "assistant" && m.status === "done" && m.text)
      history.push({ role: "assistant", content: m.text })
    if (m.id === id) break
  }
  return history.slice(-CONTEXT_MESSAGES)
}

/** Start the next job when the model is ready and idle; ask for the load when it is not requested. */
function pump(state: ChatState, effects: Effect[]): Result {
  const { phase } = state
  if (phase.name === "idle" && state.jobs.length) {
    return [patch(state, { phase: { name: "starting" } }), [...effects, { t: "load" }]]
  }
  if (phase.name !== "ready" || state.current || !state.jobs.length) return [state, effects]
  const [job, ...rest] = state.jobs
  if (!job) return [state, effects]
  const out = [...effects]
  let next = patch(state, { jobs: rest, current: job })
  if (speaking(next.speech)) {
    out.push({ t: "stopSpeech" })
    next = patch(next, { speech: { name: "idle" } })
  }
  if (job.kind === "transcribe") {
    out.push({ t: "transcribe", audioId: job.id })
    return [next, out]
  }
  next = setMessage(next, job.id, { status: "sent" })
  // The reply sits right under the message it answers, ahead of later queued messages.
  const at = next.messages.findIndex((m) => m.id === job.id)
  const reply: Message = {
    id: next.nextId,
    role: "assistant",
    kind: "chat",
    text: "",
    status: "streaming",
    replyTo: job.id,
  }
  next = patch(next, {
    messages: [...next.messages.slice(0, at + 1), reply, ...next.messages.slice(at + 1)],
    nextId: next.nextId + 1,
  })
  out.push({ t: "generate", id: job.id, history: historyThrough(next, job.id) })
  return [next, out]
}

const replyOf = (state: ChatState) =>
  state.current ? state.messages.find((m) => m.replyTo === state.current?.id) : undefined

function lastAnswer(state: ChatState): Message | undefined {
  return state.messages
    .filter((m) => m.role === "assistant" && m.kind === "chat" && m.status === "done" && m.text)
    .at(-1)
}

export function reduce(state: ChatState, event: ChatEvent): Result {
  switch (event.t) {
    case "draft":
      return [patch(state, { draft: event.text }), []]

    case "send": {
      const text = state.draft.trim()
      if (!text || state.phase.name === "unsupported") return [state, []]
      let next = append(state, { role: "user", kind: "chat", text, status: "queued" })
      const id = state.nextId
      next = patch(next, { draft: "", notice: "", jobs: [...next.jobs, { kind: "message", id }] })
      // Sending after a pause or a failure is a request to try again.
      if (next.phase.name === "failed") return pump(patch(next, { phase: { name: "idle" } }), [])
      return pump(next, [])
    }

    case "mic": {
      if (state.phase.name === "unsupported") return [state, []]
      if (state.mic === "permission")
        return [patch(state, { mic: "idle" }), [{ t: "cancelRecording" }]]
      if (state.mic === "recording") return [state, [{ t: "stopRecording" }]]
      if (state.mic === "transcribing") return cancelEverything(state, "Transcription stopped.")
      const next = patch(state, { mic: "permission", notice: "" })
      const effects: Effect[] = [{ t: "record" }]
      if (state.phase.name === "idle" || state.phase.name === "failed") {
        return [patch(next, { phase: { name: "starting" } }), [...effects, { t: "load" }]]
      }
      return [next, effects]
    }

    case "recording":
      return [patch(state, { mic: "recording" }), []]

    case "micDenied": {
      const next = append(patch(state, { mic: "idle" }), {
        role: "assistant",
        kind: "notice",
        status: "done",
        text: `The browser did not give this page the microphone (${event.message}). Allow microphone access for this site in the address bar or site settings, then click the microphone again. You can keep typing; nothing was recorded.`,
      })
      return [next, []]
    }

    case "recordFailed":
      return [patch(state, { mic: "idle", notice: event.message }), []]

    case "recorded": {
      if (event.silent) {
        return [patch(state, { mic: "idle", notice: "No audio detected. Nothing was added." }), []]
      }
      const next = patch(state, {
        mic: "transcribing",
        jobs: [...state.jobs, { kind: "transcribe", id: event.audioId }],
      })
      return pump(next, [])
    }

    case "transcribed": {
      const text = event.text.trim()
      const finished = patch(state, { mic: "idle", current: null })
      const next = text
        ? patch(finished, {
            draft: finished.draft ? `${finished.draft} ${text}` : text,
            notice: "",
          })
        : patch(finished, { notice: "No speech was heard in that recording." })
      return pump(next, text ? [{ t: "focusComposer" }] : [])
    }

    case "transcribeFailed":
      return pump(patch(state, { mic: "idle", current: null, notice: event.message }), [])

    case "speaker": {
      if (event.shift) {
        const autoRead = !state.autoRead
        const stopping = !autoRead && state.speech.name !== "idle" && state.speech.mode === "auto"
        return [
          patch(state, { autoRead, speech: stopping ? { name: "idle" } : state.speech }),
          stopping ? [{ t: "stopSpeech" }] : [],
        ]
      }
      if (speaking(state.speech))
        return [patch(state, { speech: { name: "idle" } }), [{ t: "stopSpeech" }]]
      const answer = lastAnswer(state)
      if (!answer || state.phase.name !== "ready" || state.current) return [state, []]
      return [
        patch(state, { speech: { name: "preparing", mode: "manual", id: answer.id } }),
        [{ t: "speak", id: answer.id, text: answer.text }],
      ]
    }

    case "stop":
      return stop(state)

    case "retry": {
      if (state.phase.name !== "failed") return [state, []]
      return [patch(state, { phase: { name: "starting" } }), [{ t: "load" }]]
    }

    case "unload": {
      if (state.phase.name === "unsupported") return [state, []]
      const effects: Effect[] = []
      if (loadActive(state.phase)) effects.push({ t: "cancelLoad" })
      if (state.current) effects.push({ t: "cancelJob" })
      if (speaking(state.speech)) effects.push({ t: "stopSpeech" })
      effects.push({ t: "unload" })
      let next = patch(state, {
        phase: { name: "idle" },
        speech: { name: "idle" },
        current: null,
        mic: state.mic === "transcribing" ? "idle" : state.mic,
      })
      next = markCurrentStopped(state, next)
      return [next, effects]
    }

    case "unsupported":
      return [
        append(patch(state, { phase: { name: "unsupported", message: event.message } }), {
          role: "assistant",
          kind: "notice",
          status: "done",
          text: event.message,
        }),
        [],
      ]

    case "download":
      if (state.phase.name !== "starting" && state.phase.name !== "downloading") return [state, []]
      return [patch(state, { phase: { name: "downloading", files: event.files } }), []]

    case "loading":
      if (!loadActive(state.phase)) return [state, []]
      return [patch(state, { phase: { name: "loading", fromCache: event.fromCache } }), []]

    case "loaded":
      if (!loadActive(state.phase)) return [state, []]
      return pump(patch(state, { phase: { name: "ready", fromCache: event.fromCache } }), [])

    case "loadFailed":
      if (!loadActive(state.phase)) return [state, []]
      return [
        patch(state, { phase: { name: "failed", reason: event.reason, message: event.message } }),
        [],
      ]

    case "deviceLost": {
      const next = markCurrentStopped(state, patch(state, { current: null }), "failed")
      return [
        patch(next, {
          phase: { name: "failed", reason: "gpu", message: event.message },
          speech: { name: "idle" },
          mic: next.mic === "transcribing" ? "idle" : next.mic,
        }),
        [],
      ]
    }

    case "unloaded":
      return [state, []]

    case "token":
      if (state.current?.id !== event.id) return [state, []]
      return [patch(state, { messages: appendToReply(state, event.text) }), []]

    case "genDone": {
      if (state.current?.id !== event.id) return [state, []]
      const reply = replyOf(state)
      let next = patch(state, { current: null })
      if (reply?.status === "streaming")
        next = setMessage(next, reply.id, { text: event.text, status: "done" })
      const [pumped, effects] = pump(next, [])
      if (effects.length === 0 && next.autoRead && reply && event.text.trim()) {
        return [
          patch(pumped, { speech: { name: "preparing", mode: "auto", id: reply.id } }),
          [{ t: "speak", id: reply.id, text: event.text }],
        ]
      }
      return [pumped, effects]
    }

    case "genFailed": {
      if (state.current?.id !== event.id) return [state, []]
      const reply = replyOf(state)
      let next = patch(state, { current: null })
      if (reply?.status === "streaming")
        next = setMessage(next, reply.id, {
          status: "failed",
          text: reply.text ? `${reply.text}\n\n${event.message}` : event.message,
        })
      return pump(next, [])
    }

    case "speechPlaying":
      if (state.speech.name === "idle") return [state, []]
      return [patch(state, { speech: { ...state.speech, name: "playing" } }), []]

    case "speechDone":
      return [patch(state, { speech: { name: "idle" } }), []]

    case "speechFailed":
      return [
        patch(state, { speech: { name: "idle" }, notice: `Read aloud failed: ${event.message}` }),
        [],
      ]
  }
}

function appendToReply(state: ChatState, text: string): Message[] {
  return state.messages.map((m) =>
    m.replyTo !== undefined && m.replyTo === state.current?.id ? { ...m, text: m.text + text } : m,
  )
}

/** Marks the streaming reply of the running message job (if any) and its user message. */
function markCurrentStopped(
  before: ChatState,
  after: ChatState,
  status: "stopped" | "failed" = "stopped",
): ChatState {
  if (before.current?.kind !== "message") return after
  const reply = replyOf(before)
  return reply?.status === "streaming" ? setMessage(after, reply.id, { status }) : after
}

/** Stop is stop-everything: it ends the running job and drops the waiting ones as "stopped". */
function cancelEverything(state: ChatState, notice: string): Result {
  const effects: Effect[] = []
  if (state.current) effects.push({ t: "cancelJob" })
  if (speaking(state.speech)) effects.push({ t: "stopSpeech" })
  let next = markCurrentStopped(
    state,
    patch(state, { current: null, jobs: [], speech: { name: "idle" } }),
  )
  const dropped = new Set(state.jobs.filter((j) => j.kind === "message").map((j) => j.id))
  next = patch(next, {
    messages: next.messages.map((m) =>
      m.role === "user" && dropped.has(m.id) ? { ...m, status: "stopped" as const } : m,
    ),
    mic: state.mic === "transcribing" ? "idle" : state.mic,
    notice,
  })
  return [next, effects]
}

function stop(state: ChatState): Result {
  if (loadActive(state.phase)) {
    return [
      patch(state, {
        phase: {
          name: "failed",
          reason: "cancelled",
          message: "Stopped. The download keeps what it already has and resumes from there.",
        },
        mic: state.mic === "recording" || state.mic === "permission" ? "idle" : state.mic,
      }),
      [
        { t: "cancelLoad" },
        ...(state.mic === "recording" || state.mic === "permission"
          ? ([{ t: "cancelRecording" }] as Effect[])
          : []),
      ],
    ]
  }
  if (state.mic === "recording" || state.mic === "permission")
    return [patch(state, { mic: "idle" }), [{ t: "cancelRecording" }]]
  if (state.current || state.jobs.length) return cancelEverything(state, "")
  if (speaking(state.speech))
    return [patch(state, { speech: { name: "idle" } }), [{ t: "stopSpeech" }]]
  return [state, []]
}

/** The label of the assistant's in-progress turn while the model is not answering yet. */
export function workingLabel(state: ChatState): string {
  const { phase } = state
  switch (phase.name) {
    case "starting":
      return "Checking this browser's cache and WebGPU"
    case "downloading": {
      const done = phase.files.reduce((sum, f) => sum + f.done, 0)
      const total = phase.files.reduce((sum, f) => sum + f.total, 0)
      return total
        ? `Downloading the model: ${gigabytes(done)} of ${gigabytes(total)}, ${Math.floor((done / total) * 100)}%`
        : "Downloading the model"
    }
    case "loading":
      return phase.fromCache
        ? "Loading onto the GPU from this browser's cache"
        : "Loading onto the GPU"
    default:
      return "Thinking"
  }
}
