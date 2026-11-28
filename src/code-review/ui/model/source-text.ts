import type { CodeReviewSourceIdentity } from "../../contract.ts"
import type { ReviewTransport } from "../transport.ts"

/** The server's largest source window. */
export const SOURCE_WINDOW_LINES = 500

export type SourceText =
  | { kind: "text"; text: string; lineCount: number }
  /** Binary, a symlink or submodule, or content the server withholds: listed, not drawn. */
  | { kind: "opaque" }

/** The cache key of a pinned source: the same object on the same side of the same comparison. */
export const sourceKey = (source: CodeReviewSourceIdentity) =>
  `${source.comparisonID}\u0000${source.side}\u0000${source.path}\u0000${source.revision}`

/**
 * Reads one pinned source's whole text as consecutive windows. Windows are exact slices of the
 * file, so their concatenation is the file.
 */
export async function readSourceText(
  transport: Pick<ReviewTransport, "shape" | "source">,
  source: CodeReviewSourceIdentity,
  signal: AbortSignal,
): Promise<SourceText> {
  const shape = await transport.shape(source, signal)
  if (!shape.exists || shape.kind !== "text" || shape.lineCount === null) return { kind: "opaque" }
  const lineCount = shape.lineCount
  if (lineCount === 0) return { kind: "text", text: "", lineCount }
  const starts: number[] = []
  for (let start = 1; start <= lineCount; start += SOURCE_WINDOW_LINES) starts.push(start)
  const parts = await Promise.all(
    starts.map((start) =>
      transport
        .source(source, start, Math.min(lineCount, start + SOURCE_WINDOW_LINES - 1), signal)
        .then((window) => window.text),
    ),
  )
  return { kind: "text", text: parts.join(""), lineCount }
}

/**
 * Text of the lines `startLine..endLine` (1-based, inclusive) of a text, without the last newline.
 * The quote of a selection.
 */
export function linesOf(text: string, startLine: number, endLine: number): string {
  const lines = text.split("\n")
  return lines.slice(startLine - 1, endLine).join("\n")
}

/**
 * Text a selection covers: whole lines, or from `startChar` on the first line to `endChar` on the
 * last line when the reader selected characters.
 */
export function excerptOf(
  text: string,
  range: { startLine: number; endLine: number; startChar?: number; endChar?: number },
): string {
  const lines = text.split("\n").slice(range.startLine - 1, range.endLine)
  if (lines.length === 0) return ""
  if (range.startChar === undefined || range.endChar === undefined) return lines.join("\n")
  if (lines.length === 1) return lines[0]!.slice(range.startChar, range.endChar)
  lines[0] = lines[0]!.slice(range.startChar)
  lines[lines.length - 1] = lines.at(-1)!.slice(0, range.endChar)
  return lines.join("\n")
}
