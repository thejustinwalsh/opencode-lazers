import type { SessionMessageInfo } from "@opencode/client"

// LiquidAI's documented TTS controls are language/locale and gender, not named speakers.
export const VOICES = {
  "american-female": {
    label: "American English · Female",
    language: "American English",
    gender: "female",
  },
  "american-male": {
    label: "American English · Male",
    language: "American English",
    gender: "male",
  },
  "british-female": {
    label: "British English · Female",
    language: "British English",
    gender: "female",
  },
  "british-male": { label: "British English · Male", language: "British English", gender: "male" },
} as const
export type SpeechVoice = keyof typeof VOICES
export const DEFAULT_VOICE: SpeechVoice = "american-female"
export const voiceKeys = Object.keys(VOICES) as SpeechVoice[]
export function speechInstruction(voice: SpeechVoice = DEFAULT_VOICE) {
  const selected = VOICES[voice]
  if (!selected) throw new Error("Unsupported local voice")
  return `Perform TTS in ${selected.language} using a ${selected.gender} voice.`
}

type AssistantMessage = Extract<SessionMessageInfo, { type: "assistant" }>

/** Shared final-answer/commentary filtering for assistant turns. */
function assistantReplyText(message: AssistantMessage): string {
  const finalPhase = message.content.some(
    (part) => part.type === "text" && part.native?.phase === "final_answer",
  )
  const lastTool = message.content.findLastIndex((part) => part.type === "tool")
  return message.content
    .flatMap((part, index) =>
      part.type === "text" &&
      (finalPhase
        ? part.native?.phase === "final_answer"
        : part.native?.phase !== "commentary" && index > lastTool)
        ? [part.text]
        : [],
    )
    .join("\n")
    .trim()
}

/** Native message lists are chronological; idle closes an execution, including steered inputs. */
export function latestResponse(messages: readonly SessionMessageInfo[]): string {
  const end = messages.findLastIndex((message) => message.type === "idle")
  const idle = messages[end]
  if (idle?.type !== "idle" || idle.outcome !== "succeeded") return ""
  // Do not speak an older answer while the latest prompt or tool step is still running.
  if (
    messages
      .slice(end + 1)
      .some((message) => ["user", "synthetic", "shell", "assistant"].includes(message.type))
  )
    return ""
  const start = messages.slice(0, end).findLastIndex((message) => message.type === "idle")
  const message = messages.slice(start + 1, end).findLast((item) => item.type === "assistant")
  if (
    message?.type !== "assistant" ||
    !message.time.completed ||
    message.error ||
    message.finish !== "stop"
  )
    return ""
  return assistantReplyText(message)
}

/** The last successful final reply, even after a newer prompt or failed turn has started. */
export function latestCompletedResponse(messages: readonly SessionMessageInfo[]): string {
  let end = messages.findLastIndex((message) => message.type === "idle")
  while (end >= 0) {
    const idle = messages[end]
    if (idle?.type === "idle" && idle.outcome === "succeeded") {
      const start = messages.slice(0, end).findLastIndex((message) => message.type === "idle")
      const reply = completedTurnResponse(messages.slice(start + 1, end))
      if (reply && speechSegments(reply).length) return reply
    }
    end = messages.slice(0, end).findLastIndex((message) => message.type === "idle")
  }
  return ""
}

function completedTurnResponse(messages: readonly SessionMessageInfo[]): string {
  const message = messages.findLast((item) => item.type === "assistant")
  if (
    message?.type !== "assistant" ||
    !message.time.completed ||
    message.error ||
    message.finish !== "stop"
  )
    return ""
  return assistantReplyText(message)
}

export const SPEECH_CHUNK_CHARS = 320
const SPEECH_CHUNK_WORDS = 48

/** Prefer complete sentences; oversized sentences split at clauses, then words as a bounded fallback. */
export function speechSegments(markdown: string): string[] {
  const text = markdown
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*(?:\n|$)|(?![\s\S]))/gm, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  const segments: string[] = []
  for (const sentence of new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)) {
    let remaining = sentence.segment.trim()
    while (remaining) {
      const words = [...remaining.slice(0, SPEECH_CHUNK_CHARS + 1).matchAll(/\S+/g)]
      if (remaining.length <= SPEECH_CHUNK_CHARS && words.length <= SPEECH_CHUNK_WORDS) {
        segments.push(remaining)
        break
      }
      const limit = Math.min(SPEECH_CHUNK_CHARS, words[SPEECH_CHUNK_WORDS]?.index ?? Infinity)
      const prefix = remaining.slice(0, limit + 1)
      const clause = [...prefix.matchAll(/[,;:—–]\s/g)].at(-1)?.index
      const end = clause !== undefined && clause >= 60 ? clause + 1 : prefix.lastIndexOf(" ")
      const split = end > 0 ? end : limit
      segments.push(remaining.slice(0, split).trim())
      remaining = remaining.slice(split).trim()
    }
  }
  return segments
}

/** Maps a LAZERS voice key to ruNNtime's typed `Lfm3SpeechOptions.voice`. */
export function runntimeSpeechVoice(voice: SpeechVoice): {
  language: string
  gender: "female" | "male"
} {
  const selected = VOICES[voice]
  if (!selected) throw new Error("Unsupported local voice")
  return { language: selected.language, gender: selected.gender }
}
