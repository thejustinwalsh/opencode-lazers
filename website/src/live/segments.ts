/** Splits an answer into speakable segments. Mirrors `speechSegments` in `src/webgpu/speech.ts`
 *  (the product's read aloud); `test/live-segments.test.ts` keeps the two in agreement. */
const SPEECH_CHUNK_CHARS = 320
const SPEECH_CHUNK_WORDS = 48

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
