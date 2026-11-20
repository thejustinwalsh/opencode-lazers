import type { ComponentChildren } from "preact"
import { useLayoutEffect, useRef } from "preact/hooks"
import { loadActive, workingLabel } from "./machine"
import type { ChatState, FileProgress } from "./machine"
import "./live.css"

/** The OpenCode-style chat chrome, shared by the live chat and the recorded session. */
export type Meter = { bars: string; seconds: number } | null

export type FrameProps = {
  state: ChatState
  meter: Meter
  title?: string
  tag?: string
  /** Dims the whole chat (the poster state). */
  dim?: boolean
  /** The recorded session cannot take typed input. */
  readOnly?: boolean
  placeholder?: string
  overlay?: ComponentChildren
  barExtra?: ComponentChildren
  recordedOffer?: boolean
  /** The recording has no model state to report. */
  hideStatus?: boolean
  speakerTitle?: string
  onDraft?: (text: string) => void
  onSend?: () => void
  onMic?: () => void
  onSpeaker?: (shift: boolean) => void
  onStop?: () => void
  onRetry?: () => void
  onRecording?: () => void
  /** Called before state changes so the list can keep following the bottom. */
  listRef?: { current: HTMLDivElement | null }
}

const mb = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(0)} MB`

function Icon({ name }: { name: "speaker" | "waveform" | "stop" | "spinner" | "mic" }) {
  switch (name) {
    case "speaker":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M11 5 6 9H3v6h3l5 4V5ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
        </svg>
      )
    case "waveform":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M11 5 6 9H3v6h3l5 4V5Z" />
          <path d="M15 9v6m3-9v12m3-8v4" />
        </svg>
      )
    case "stop":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect class="solid" x="7" y="7" width="10" height="10" rx="2" />
        </svg>
      )
    case "spinner":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4a8 8 0 1 1-8 8" />
        </svg>
      )
    case "mic":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="9" y="3" width="6" height="12" rx="3" />
          <path d="M6 11v1a6 6 0 0 0 12 0v-1m-6 7v3m-3 0h6" />
        </svg>
      )
  }
}

function Files({ files }: { files: FileProgress[] }) {
  return (
    <>
      {files.map((file) => {
        const percent = file.total ? Math.floor((file.done / file.total) * 100) : 0
        return (
          <div class="lc-file" key={file.id}>
            <div class="lc-file-row">
              <span class="lc-file-name">{file.name}</span>
              <span>
                {mb(file.done)} of {mb(file.total)} · {percent}%
              </span>
            </div>
            <progress max={file.total} value={file.done} aria-label={`${file.name} download`} />
          </div>
        )
      })}
    </>
  )
}

export function ChatFrame(props: FrameProps) {
  const { state, meter } = props
  const input = useRef<HTMLTextAreaElement>(null)
  const own = useRef<HTMLDivElement>(null)
  const list = props.listRef ?? own
  const stick = useRef(true)

  // The list follows new content only while the reader is at the bottom. Geometry is read when
  // the content changes, not from a scroll listener.
  useLayoutEffect(() => {
    const el = list.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })
  const before = () => {
    const el = list.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96
  }
  before()

  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [state.draft])

  const { phase } = state
  const reply = state.current
    ? state.messages.find((m) => m.replyTo === state.current?.id)
    : undefined
  const working =
    loadActive(phase) ||
    (state.current?.kind === "message" && reply !== undefined && reply.text === "")
  const stoppable =
    loadActive(phase) ||
    state.current !== null ||
    state.jobs.length > 0 ||
    state.speech.name !== "idle" ||
    state.mic !== "idle"
  const disabled = phase.name === "unsupported" || props.readOnly

  /* speaker pill */
  const speaking = state.speech
  const hasAnswer = state.messages.some(
    (m) => m.kind === "chat" && m.role === "assistant" && m.status === "done" && m.text,
  )
  const speakerStatus =
    speaking.name === "preparing"
      ? "preparing speech; click to stop"
      : speaking.name === "playing"
        ? "reading response; click to stop"
        : hasAnswer
          ? "read the last response"
          : "no response to read yet"
  const speakerIcon =
    speaking.name === "preparing"
      ? "spinner"
      : speaking.name === "playing"
        ? "stop"
        : state.autoRead
          ? "waveform"
          : "speaker"
  const speakerTitle = `LAZERS speaker: ${speakerStatus}. Shift-click: automatic read aloud is ${state.autoRead ? "on" : "off"}.`

  /* microphone pill */
  const seconds = meter?.seconds ?? 0
  const micStatus =
    state.mic === "recording"
      ? `recording ${seconds}s; click to stop`
      : state.mic === "transcribing"
        ? "transcribing; click to cancel"
        : state.mic === "permission"
          ? "requesting access; click to cancel"
          : "start dictation"
  const micTitle = `LAZERS microphone: ${micStatus}. Click to record, click again to stop; your words land in the message box. Escape cancels.`
  const micIcon = state.mic === "recording" ? "stop" : state.mic === "idle" ? "mic" : "spinner"
  const micLabel =
    state.mic === "recording" && meter
      ? `${meter.bars} 0:${String(meter.seconds).padStart(2, "0")}`
      : ""

  const statusText = props.hideStatus
    ? ""
    : state.notice ||
      (phase.name === "ready"
        ? phase.fromCache
          ? "Loaded from this browser's cache"
          : "Loaded · running on this device's GPU"
        : phase.name === "idle" && state.messages.length > 1
          ? "Model unloaded · weights stay in browser storage"
          : "")

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      props.onSend?.()
    } else if (event.key === "Escape" && stoppable) {
      props.onStop?.()
    }
  }

  return (
    <div class={`lc${props.dim ? " lc-dim" : ""}`} data-phase={phase.name}>
      <div class="lc-bar">
        <span
          class="lc-dot"
          data-on={String(phase.name === "ready" && !props.readOnly)}
          aria-hidden="true"
        />
        <span class="lc-title">{props.title ?? "Local model · LAZERS demo"}</span>
        {props.tag ? <span class="lc-tag">{props.tag}</span> : null}
        {props.barExtra}
      </div>

      <div
        class="lc-list"
        ref={list}
        role="log"
        aria-label="Conversation"
        aria-live="off"
        aria-busy={working}
        tabIndex={0}
      >
        {state.messages.map((m) => (
          <div
            key={m.id}
            class={`lc-msg${m.status === "streaming" && m.text ? " lc-caret" : ""}`}
            data-role={m.role}
            data-kind={m.kind}
            data-status={m.status}
            hidden={m.status === "streaming" && !m.text}
          >
            {m.text}
            {m.status === "queued" ? (
              <span class="lc-meta">Queued until the model is ready</span>
            ) : null}
          </div>
        ))}
        {working ? (
          <div class="lc-work" data-testid="working">
            <div class="lc-work-head">
              <span class="lc-spin" aria-hidden="true" />
              <span class="lc-shimmer">{workingLabel(state)}</span>
            </div>
            {phase.name === "downloading" ? <Files files={phase.files} /> : null}
            {phase.name === "starting" || phase.name === "downloading" ? (
              <span class="lc-meta">
                One-time download into this browser's storage. Nothing you type leaves this tab.
              </span>
            ) : null}
          </div>
        ) : null}
        {phase.name === "failed" ? (
          <div class="lc-msg" data-role="assistant" data-kind="notice" data-status="done">
            {phase.message}
            <div class="lc-actions">
              <button type="button" class="lc-button" data-primary="true" onClick={props.onRetry}>
                {phase.reason === "cancelled" ? "Resume download" : "Retry"}
              </button>
              {props.recordedOffer && phase.reason !== "cancelled" ? (
                <button type="button" class="lc-button" onClick={props.onRecording}>
                  Watch the recording instead
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        <div class="lc-end" aria-hidden="true" />
      </div>

      <div class="lc-foot">
        <div class="lc-pills">
          <button
            type="button"
            class="lc-pill"
            aria-label={micTitle}
            data-tone={state.mic === "recording" ? "critical" : undefined}
            data-spin={String(state.mic === "permission" || state.mic === "transcribing")}
            disabled={phase.name === "unsupported"}
            onClick={props.onMic}
          >
            <Icon name={micIcon} />
            <span class="lc-pill-label" aria-hidden="true">
              {micLabel}
            </span>
          </button>
          <button
            type="button"
            class="lc-pill"
            aria-label={props.speakerTitle ?? speakerTitle}
            data-tone={state.autoRead && speaking.name === "idle" ? "success" : undefined}
            data-spin={String(speaking.name === "preparing")}
            disabled={phase.name === "unsupported"}
            onClick={(event) => props.onSpeaker?.(event.shiftKey)}
          >
            <Icon name={speakerIcon} />
          </button>
          <span class="lc-status" aria-hidden="true">
            {statusText}
          </span>
        </div>
        <form
          class="lc-box"
          onSubmit={(event) => {
            event.preventDefault()
            props.onSend?.()
          }}
        >
          <textarea
            ref={input}
            class="lc-input"
            rows={1}
            value={state.draft}
            disabled={disabled}
            placeholder={
              props.placeholder ??
              (phase.name === "unsupported"
                ? "WebGPU is not available in this browser"
                : "Message the local model")
            }
            aria-label="Message the local model"
            enterkeyhint="send"
            onInput={(event) => props.onDraft?.(event.currentTarget.value)}
            onKeyDown={onKey}
          />
          {stoppable && !props.readOnly ? (
            <button
              type="button"
              class="lc-send"
              data-stop="true"
              aria-label="Stop"
              onClick={props.onStop}
            >
              Stop
            </button>
          ) : null}
          <button type="submit" class="lc-send" disabled={disabled || !state.draft.trim()}>
            Send
          </button>
        </form>
      </div>
      {props.overlay}
    </div>
  )
}
