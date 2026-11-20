import { useCallback, useEffect, useRef, useState } from "preact/hooks"
import { lazy, Suspense } from "preact/compat"
import { ChatFrame } from "./ChatFrame"
import type { Meter } from "./ChatFrame"
import { primeAudio } from "./audio-context"
import type { Controller } from "./controller"
import { initialState, reduce } from "./machine"
import type { ChatEvent, ChatState, Effect } from "./machine"

const Recorded = lazy(() => import("./Recorded"))

/** How long a hidden tab keeps the model in GPU memory. The product's "keep loaded" default is
 *  never; a public page should not hold ~2 GB of GPU memory for a tab nobody is looking at. */
export const HIDDEN_UNLOAD_MS = 120_000

/** Holds the transcript state, runs the machine's effects and loads the runtime on first use. */
function useChat() {
  const [state, setState] = useState<ChatState>(initialState)
  const [meter, setMeter] = useState<Meter>(null)
  const live = useRef(state)
  const controller = useRef<Promise<Controller> | undefined>(undefined)
  const list = useRef<HTMLDivElement>(null)

  const run = useCallback((effect: Effect) => {
    if (effect.t === "focusComposer") {
      document.querySelector<HTMLTextAreaElement>(".lc-input")?.focus()
      return
    }
    if (!controller.current) {
      // Only a request for work creates the runtime; stopping nothing creates nothing.
      if (effect.t !== "load" && effect.t !== "record") return
      controller.current = import("./controller").then((m) =>
        m.createController(
          (event) => dispatch(event),
          (next) => setMeter(next),
        ),
      )
    }
    controller.current
      .then((c) => c.perform(effect))
      .catch((error: unknown) =>
        dispatch({
          t: "loadFailed",
          reason: "error",
          message: `The model code could not be loaded: ${String(error)}`,
        }),
      )
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
  }, [])

  const dispatch = useCallback(
    (event: ChatEvent) => {
      const [next, effects] = reduce(live.current, event)
      live.current = next
      setState(next)
      for (const effect of effects) run(effect)
    },
    [run],
  )

  // WebGPU is a synchronous property check; no runtime code is needed to say it is missing.
  useEffect(() => {
    if (!("gpu" in navigator))
      dispatch({
        t: "unsupported",
        message: `${missingWebGPU()} This is a recording of the demo instead.`,
      })
  }, [])

  // A tab that stays hidden gives the GPU memory back; the weights stay on disk.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onVisibility = () => {
      clearTimeout(timer)
      if (document.visibilityState !== "hidden") return
      timer = setTimeout(() => {
        const s = live.current
        if (s.phase.name === "ready" && !s.current && s.mic === "idle") dispatch({ t: "unload" })
      }, HIDDEN_UNLOAD_MS)
    }
    document.addEventListener("visibilitychange", onVisibility)
    const leave = () => void controller.current?.then((c) => c.dispose())
    window.addEventListener("pagehide", leave)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pagehide", leave)
      leave()
    }
  }, [])

  return { state, meter, dispatch, list }
}

export function missingWebGPU(): string {
  const ua = navigator.userAgent
  const safari = /Safari\//.test(ua) && !/Chrom(e|ium)|CriOS|FxiOS|Edg\//.test(ua)
  if (safari)
    return "This Safari does not expose WebGPU. Safari 26 and later turn it on by default on macOS, iOS and iPadOS; earlier versions need the WebGPU feature flag."
  if (/Firefox\//.test(ua))
    return "This Firefox does not expose WebGPU here. Firefox ships it on Windows from version 141, and on macOS and Linux in later releases."
  return "This browser does not expose WebGPU (navigator.gpu is missing). Current Chrome and Edge on desktop support it."
}

/** A one-sentence announcement for screen readers, set only at state changes (never per token). */
function useAnnouncement(state: ChatState) {
  const [text, setText] = useState("")
  const previous = useRef({ phase: state.phase.name, done: 0 })
  useEffect(() => {
    const last = previous.current
    const answered = state.messages.filter(
      (m) => m.status === "done" && m.kind === "chat" && m.role === "assistant",
    )
    if (state.phase.name !== last.phase) {
      if (state.phase.name === "downloading")
        setText("Downloading the model. Progress is shown in the chat.")
      else if (state.phase.name === "loading") setText("Loading the model onto the GPU.")
      else if (state.phase.name === "ready") setText("The model is ready.")
      else if (state.phase.name === "failed") setText(state.phase.message)
    } else if (answered.length > last.done) {
      setText(`Answer: ${answered.at(-1)?.text ?? ""}`)
    }
    previous.current = { phase: state.phase.name, done: answered.length }
  }, [state.phase.name, state.messages])
  return text
}

const LONG_PRESS_MS = 600

export function LiveChat() {
  return (
    <figure class="lc-figure">
      <LiveChatBody />
      <figcaption class="lc-note">
        Nothing you type or say leaves this tab: the page only downloads the model, once, from
        Hugging Face. The microphone is used only after you click it, only here.
      </figcaption>
    </figure>
  )
}

function LiveChatBody() {
  const { state, meter, dispatch, list } = useChat()
  const announcement = useAnnouncement(state)
  const [recorded, setRecorded] = useState(false)
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const longPressed = useRef(false)

  if (recorded || state.phase.name === "unsupported")
    return (
      <Suspense fallback={<div class="lc" aria-busy="true" />}>
        <Recorded
          reason={state.phase.name === "unsupported" ? state.phase.message : undefined}
          onLive={state.phase.name === "unsupported" ? undefined : () => setRecorded(false)}
        />
      </Suspense>
    )

  return (
    <div
      onPointerDown={(event) => {
        // Touch has no Shift key: pressing the speaker for a moment toggles automatic read aloud.
        const target = event.target as HTMLElement
        if (!target.closest?.("[aria-label^='LAZERS speaker']") || event.pointerType === "mouse")
          return
        longPressed.current = false
        press.current = setTimeout(() => {
          longPressed.current = true
          dispatch({ t: "speaker", shift: true })
        }, LONG_PRESS_MS)
      }}
      onPointerUp={() => clearTimeout(press.current)}
      onPointerCancel={() => clearTimeout(press.current)}
    >
      <ChatFrame
        state={state}
        meter={meter}
        listRef={list}
        recordedOffer
        barExtra={
          state.phase.name === "ready" ? (
            <button type="button" class="lc-link" onClick={() => dispatch({ t: "unload" })}>
              Unload
            </button>
          ) : null
        }
        onDraft={(text) => dispatch({ t: "draft", text })}
        onSend={() => {
          primeAudio()
          dispatch({ t: "send" })
        }}
        onMic={() => {
          primeAudio()
          dispatch({ t: "mic" })
        }}
        onSpeaker={(shift) => {
          if (longPressed.current) {
            longPressed.current = false
            return
          }
          primeAudio()
          dispatch({ t: "speaker", shift })
        }}
        onStop={() => dispatch({ t: "stop" })}
        onRetry={() => {
          primeAudio()
          dispatch({ t: "retry" })
        }}
        onRecording={() => setRecorded(true)}
      />
      <div class="lc-sr" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  )
}
