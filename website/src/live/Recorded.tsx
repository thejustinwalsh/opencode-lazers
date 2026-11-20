import { useCallback, useEffect, useRef, useState } from "preact/hooks"
import { ChatFrame } from "./ChatFrame"
import type { Meter } from "./ChatFrame"
import { initialState } from "./machine"
import type { ChatState, Message } from "./machine"
import { FLAT_METER } from "./meter"

/**
 * The recorded session: the same chat chrome playing back a real run of the model (its actual
 * answers and its actual speech, captured in a browser with WebGPU). It is shown when this browser
 * has no WebGPU, or when the visitor picks it after a failure. Until it is clicked the page shows
 * the dimmed chat and a play button only; the reason is read to assistive technology. Nothing is
 * fetched until the visitor clicks play.
 */
export type Step =
  | { type: "user"; text: string }
  | { type: "answer"; text: string; audio?: string; seconds: number }
  | { type: "dictate"; text: string; seconds: number }

export type Session = {
  version: 1
  steps: Step[]
  audio: Record<string, { webm: string; m4a: string }>
}

type Cut = { cancelled: boolean }

const BARS = "▁▂▃▄▅▆▇█"
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches

type View = {
  messages: Message[]
  draft: string
  working: boolean
  speaking: boolean
  recording: boolean
  transcribing: boolean
}
const START: View = {
  messages: [],
  draft: "",
  working: false,
  speaking: false,
  recording: false,
  transcribing: false,
}

/** A clock whose sleeps stop while the recording is paused. */
class Clock {
  paused = false
  #wake: (() => void) | undefined
  async sleep(ms: number, cut: Cut) {
    let left = ms
    let last = performance.now()
    while (left > 0 && !cut.cancelled) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(left, 40)))
      if (this.paused) {
        await new Promise<void>((resolve) => (this.#wake = resolve))
        last = performance.now()
        continue
      }
      const now = performance.now()
      left -= now - last
      last = now
    }
  }
  setPaused(value: boolean) {
    this.paused = value
    if (!value) this.#wake?.()
  }
}

function pickSource(entry: { webm: string; m4a: string }): string {
  const probe = document.createElement("audio")
  return probe.canPlayType('audio/webm; codecs="opus"') ? entry.webm : entry.m4a
}

export default function Recorded(props: { reason?: string; onLive?: () => void }) {
  const [phase, setPhase] = useState<"poster" | "playing" | "paused" | "ended" | "error">("poster")
  const [view, setView] = useState<View>(START)
  const [meter, setMeter] = useState<Meter>(null)
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState("")
  const clock = useRef(new Clock())
  const cut = useRef<Cut>({ cancelled: false })
  const audio = useRef<HTMLAudioElement | undefined>(undefined)
  const mutedRef = useRef(false)
  const session = useRef<Session | undefined>(undefined)
  const nextId = useRef(1)

  useEffect(
    () => () => {
      cut.current.cancelled = true
      audio.current?.pause()
    },
    [],
  )

  const play = useCallback(async () => {
    cut.current.cancelled = true
    const mine: Cut = (cut.current = { cancelled: false })
    clock.current = new Clock()
    nextId.current = 1
    setView(START)
    setPhase("playing")
    // Playing starts inside the click; the data is fetched now and only now.
    const element = (audio.current = new Audio())
    element.muted = mutedRef.current
    void element.play().catch(() => undefined)
    try {
      session.current ??= (await (
        await fetch(new URL("live/session.json", document.baseURI))
      ).json()) as Session
    } catch {
      setError("The recorded session could not be loaded. Check the connection and try again.")
      setPhase("error")
      return
    }
    const data = session.current
    const quick = reduceMotion()
    const update = (patch: Partial<View>) => !mine.cancelled && setView((v) => ({ ...v, ...patch }))
    const addMessage = (m: Omit<Message, "id">) => {
      const id = nextId.current++
      setView((v) => ({ ...v, messages: [...v.messages, { ...m, id }] }))
      return id
    }
    const patchMessage = (id: number, patch: Partial<Message>) =>
      setView((v) => ({
        ...v,
        messages: v.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      }))
    const sleep = (ms: number) => clock.current.sleep(ms, mine)

    for (const step of data.steps) {
      if (mine.cancelled) return
      if (step.type === "user") {
        addMessage({ role: "user", kind: "chat", text: step.text, status: "sent" })
        await sleep(700)
      } else if (step.type === "dictate") {
        update({ recording: true })
        const begin = performance.now()
        let bars = FLAT_METER
        let elapsed = 0
        while (elapsed < step.seconds * 1000 && !mine.cancelled) {
          await sleep(80)
          elapsed += 80
          const level =
            Math.abs(Math.sin(elapsed / 170)) * 0.6 + Math.abs(Math.sin(elapsed / 53)) * 0.4
          bars = bars.slice(1) + BARS[Math.min(7, Math.floor(level * 8))]
          if (!mine.cancelled) setMeter({ bars, seconds: Math.floor(elapsed / 1000) })
        }
        void begin
        setMeter(null)
        update({ recording: false, transcribing: true })
        await sleep(quick ? 300 : 1100)
        update({ transcribing: false, draft: step.text })
        await sleep(900)
        update({ draft: "" })
        addMessage({ role: "user", kind: "chat", text: step.text, status: "sent" })
        await sleep(500)
      } else {
        update({ working: true })
        await sleep(quick ? 300 : 1400)
        update({ working: false })
        const id = addMessage({ role: "assistant", kind: "chat", text: "", status: "streaming" })
        if (quick) patchMessage(id, { text: step.text, status: "done" })
        else {
          const words = step.text.split(/(\s+)/)
          let shown = ""
          for (const word of words) {
            if (mine.cancelled) return
            shown += word
            patchMessage(id, { text: shown })
            await sleep(word.trim() ? 55 : 0)
          }
          patchMessage(id, { status: "done" })
        }
        const entry = step.audio ? data.audio[step.audio] : undefined
        if (entry) {
          update({ speaking: true })
          const sound = element
          sound.src = new URL(pickSource(entry), document.baseURI).href
          sound.muted = mutedRef.current
          const ended = new Promise<void>((resolve) => {
            sound.onended = () => resolve()
            sound.onerror = () => resolve()
          })
          await sound.play().catch(() => undefined)
          // Poll so a pause in the clock pauses the sound too.
          while (!mine.cancelled && !sound.ended && !sound.error) {
            if (clock.current.paused && !sound.paused) sound.pause()
            else if (!clock.current.paused && sound.paused)
              await sound.play().catch(() => undefined)
            await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 100))])
            if (sound.ended) break
          }
        } else await sleep(1200)
        update({ speaking: false })
        await sleep(600)
      }
    }
    if (!mine.cancelled) setPhase("ended")
  }, [])

  const toggle = () => {
    if (phase === "playing") {
      clock.current.setPaused(true)
      setPhase("paused")
    } else if (phase === "paused") {
      clock.current.setPaused(false)
      setPhase("playing")
    }
  }

  const state: ChatState = (() => {
    const base = initialState()
    const messages = [...base.messages, ...view.messages]
    const last = view.messages.at(-1)
    const pending = view.working
    const current = pending ? ({ kind: "message", id: last?.id ?? 0 } as const) : null
    if (pending) {
      messages.push({
        id: 9_999,
        role: "assistant",
        kind: "chat",
        text: "",
        status: "streaming",
        replyTo: last?.id ?? 0,
      })
    }
    return {
      ...base,
      phase: { name: "ready", fromCache: true },
      messages,
      draft: view.draft,
      current,
      autoRead: !muted,
      speech: view.speaking ? { name: "playing", mode: "auto", id: 0 } : { name: "idle" },
      mic: view.recording ? "recording" : view.transcribing ? "transcribing" : "idle",
    }
  })()

  const poster = phase === "poster" || phase === "error"
  // Said to assistive technology only: the poster itself shows nothing but the play button.
  const short =
    props.reason?.split(/(?<=\.)\s/)[0] ??
    "A recording of the chat. Nothing is running in this page."
  return (
    <div
      onKeyDown={(event) =>
        event.key === " " &&
        (event.target as HTMLElement).closest(".lc-bar") === null &&
        (event.target as HTMLElement).tagName !== "BUTTON" &&
        (event.preventDefault(), toggle())
      }
    >
      <ChatFrame
        state={state}
        meter={meter}
        readOnly
        hideStatus
        dim={poster}
        placeholder="Message the local model"
        barExtra={
          phase === "playing" || phase === "paused" ? (
            <button type="button" class="lc-link" onClick={toggle}>
              {phase === "paused" ? "Resume" : "Pause"}
            </button>
          ) : phase === "ended" ? (
            <button type="button" class="lc-link" onClick={() => void play()}>
              Replay
            </button>
          ) : props.onLive ? (
            <button type="button" class="lc-link" onClick={props.onLive}>
              Back to live
            </button>
          ) : null
        }
        speakerTitle={`LAZERS speaker: ${muted ? "muted" : "sound on"}. Click to ${muted ? "unmute" : "mute"} the recording.`}
        onSpeaker={() => {
          const next = !mutedRef.current
          mutedRef.current = next
          setMuted(next)
          if (audio.current) audio.current.muted = next
        }}
        overlay={
          poster ? (
            <div class="lc-poster">
              <button
                type="button"
                class="lc-play"
                aria-label="Play the demo"
                onClick={() => void play()}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </button>
              {error ? <p class="lc-poster-text">{error}</p> : null}
              <span id="lc-poster-why" class="lc-sr">
                {short}
              </span>
            </div>
          ) : null
        }
      />
    </div>
  )
}
