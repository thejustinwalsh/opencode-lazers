import type { OpenCodeEvent } from "@opencode/client"
import { speechSegments } from "./speech.ts"

type SpeechEventType =
  | "session.execution.started"
  | "session.execution.succeeded"
  | "session.execution.failed"
  | "session.execution.interrupted"
  | "session.step.ended"
  | "session.step.failed"
  | "session.text.ended"

export type SpeechEvent = Extract<OpenCodeEvent, { type: SpeechEventType }>

type TextPartEvent = Extract<SpeechEvent, { type: "session.text.ended" }>

type MessageParts = {
  parser: SpeechMarkdownParser
  parts: Map<number, string>
  phaseSeen: boolean
  finalPhaseSeen: boolean
}

/** Incremental fence/comment filtering so a code block split across text parts stays private. */
export class SpeechMarkdownParser {
  private fence: { marker: "`" | "~"; length: number } | undefined
  private line = ""
  private proseStarted = false
  private comments = new HtmlCommentFilter()

  push(text: string, final = false): string {
    this.line += text
    let prose = ""
    let newline = this.line.indexOf("\n")
    while (newline >= 0) {
      prose += this.processLine(this.line.slice(0, newline))
      this.proseStarted = false
      if (!this.fence) prose += "\n"
      this.line = this.line.slice(newline + 1)
      newline = this.line.indexOf("\n")
    }

    if (final) {
      prose += this.processLine(this.line)
      this.line = ""
      this.proseStarted = false
    } else if (this.line) {
      if (!this.fence && (this.proseStarted || !couldBeFenceOpening(this.line))) {
        prose += this.line
        this.proseStarted = true
        this.line = ""
      }
    }
    return this.comments.push(prose, final)
  }

  private processLine(line: string): string {
    if (this.fence) {
      if (fenceClosing(line, this.fence)) this.fence = undefined
      return ""
    }
    const opening = !this.proseStarted && fenceOpening(line)
    if (opening) {
      this.fence = opening
      return ""
    }
    return line
  }
}

function fenceOpening(line: string): { marker: "`" | "~"; length: number } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line)
  const run = match?.[1]
  const info = match?.[2]
  if (!run || info === undefined || (run[0] === "`" && info.includes("`"))) return undefined
  return { marker: run[0] as "`" | "~", length: run.length }
}

function couldBeFenceOpening(line: string): boolean {
  if (/^ {0,3}$/.test(line)) return true
  const match = /^ {0,3}([`~]+)(.*)$/.exec(line)
  const run = match?.[1]
  const remainder = match?.[2]
  if (!run || remainder === undefined) return false
  if (run.length < 3) return remainder.length === 0
  return (
    run.split("").every((character) => character === run[0]) &&
    (run[0] !== "`" || !remainder.includes("`"))
  )
}

function fenceClosing(line: string, fence: { marker: "`" | "~"; length: number }): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)
  const run = match?.[1]
  return Boolean(run && run[0] === fence.marker && run.length >= fence.length)
}

class HtmlCommentFilter {
  private pending = ""
  private inside = false

  push(text: string, final: boolean): string {
    let input = this.pending + text
    this.pending = ""
    let output = ""
    while (input) {
      if (this.inside) {
        const end = input.indexOf("-->")
        if (end < 0) {
          this.pending = input
          input = ""
        } else {
          input = input.slice(end + 3)
          this.inside = false
        }
        continue
      }
      const start = input.indexOf("<!--")
      if (start >= 0) {
        output += input.slice(0, start)
        input = input.slice(start + 4)
        this.inside = true
        continue
      }
      const overlap =
        [...Array(Math.min(3, input.length))]
          .map((_, index) => input.slice(input.length - index - 1))
          .find((suffix) => "<!--".startsWith(suffix))?.length ?? 0
      output += input.slice(0, input.length - overlap)
      this.pending = input.slice(input.length - overlap)
      input = ""
    }
    if (final) {
      if (!this.inside) output += this.pending
      this.pending = ""
      this.inside = false
    }
    return output
  }
}

/** Coordinates durable native events; deltas and lossy message projections are never speech input. */
export function createSpeechEventCoordinator(options: {
  sessionID: string
  isCurrent(): boolean
  enabled(): boolean
  speak(segments: readonly string[], messageID: string): void
}) {
  const messages = new Map<string, MessageParts>()
  const seenParts = new Map<string, Set<number>>()
  let finalMessageID: string | undefined
  let suppressed = false
  let disposed = false
  let lastStartSequence = -1
  let finished = false

  const allowed = () => !disposed && !suppressed && options.enabled() && options.isCurrent()
  const remember = (messageID: string, ordinal: number) => {
    let ordinals = seenParts.get(messageID)
    if (!ordinals) {
      ordinals = new Set()
      seenParts.set(messageID, ordinals)
    }
    if (ordinals.has(ordinal)) return false
    ordinals.add(ordinal)
    return true
  }
  const group = (messageID: string) => {
    let value = messages.get(messageID)
    if (!value) {
      value = {
        parser: new SpeechMarkdownParser(),
        parts: new Map(),
        phaseSeen: false,
        finalPhaseSeen: false,
      }
      messages.set(messageID, value)
    }
    return value
  }
  const speak = (text: string, messageID: string) => {
    if (!allowed()) return
    const segments = speechSegments(text)
    if (segments.length) options.speak(segments, messageID)
  }
  const onText = (event: TextPartEvent) => {
    if (finished) return
    const { assistantMessageID: messageID, ordinal, text, native } = event.data
    if (!remember(messageID, ordinal)) return
    const value = group(messageID)
    value.parts.set(ordinal, text)
    const phase = native?.phase
    if (typeof phase === "string") value.phaseSeen = true
    if (phase !== "final_answer") return
    value.finalPhaseSeen = true
    speak(value.parser.push(text), messageID)
  }
  const finish = () => {
    if (!allowed() || !finalMessageID) return
    const messageID = finalMessageID
    const value = messages.get(messageID)
    if (!value) return
    if (value.finalPhaseSeen) {
      speak(value.parser.push("", true), messageID)
      return
    }
    // Missing phase metadata is not guessed from deltas: wait for a successful final step.
    if (value.phaseSeen || !value.parts.size) return
    const parser = new SpeechMarkdownParser()
    let prose = ""
    for (const [, part] of [...value.parts].sort(([a], [b]) => a - b)) prose += parser.push(part)
    prose += parser.push("", true)
    speak(prose, messageID)
  }

  return {
    handle(event: OpenCodeEvent) {
      if (
        disposed ||
        !isSpeechEvent(event) ||
        !options.isCurrent() ||
        event.data.sessionID !== options.sessionID
      )
        return
      if (event.durable.seq < lastStartSequence) return
      switch (event.type) {
        case "session.execution.started":
          if (event.durable.seq <= lastStartSequence) return
          lastStartSequence = event.durable.seq
          finished = false
          suppressed = false
          finalMessageID = undefined
          messages.clear()
          seenParts.clear()
          break
        case "session.text.ended":
          onText(event)
          break
        case "session.step.ended":
          finalMessageID = event.data.finish === "stop" ? event.data.assistantMessageID : undefined
          break
        case "session.step.failed":
          if (finalMessageID === event.data.assistantMessageID) finalMessageID = undefined
          break
        case "session.execution.succeeded":
          if (finished) return
          finished = true
          finish()
          break
        case "session.execution.failed":
        case "session.execution.interrupted":
          finished = true
          finalMessageID = undefined
          messages.clear()
          break
        default:
          break
      }
    },
    suppressCurrent() {
      suppressed = true
    },
    dispose() {
      disposed = true
      messages.clear()
      seenParts.clear()
      finalMessageID = undefined
    },
  }
}

function isSpeechEvent(event: OpenCodeEvent): event is SpeechEvent {
  return (
    event.type === "session.execution.started" ||
    event.type === "session.execution.succeeded" ||
    event.type === "session.execution.failed" ||
    event.type === "session.execution.interrupted" ||
    event.type === "session.step.ended" ||
    event.type === "session.step.failed" ||
    event.type === "session.text.ended"
  )
}
