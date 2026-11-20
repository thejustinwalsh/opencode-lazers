/** UTF-16 offsets into the ask. */
export type Span = { start: number; end: number }
export type SliceKind =
  "whole" | "limit" | "heading" | "list-item" | "code" | "paragraph" | "sentences" | "sentence"
export type Slice = Span & { kind: SliceKind }
/** From the decision model's input bound: the longest state a request may carry. */
export type InputLimit = { maxChars: number }
export type SlicerStrategy = "windows" | "whole" | "pre-slice" | "uncertainty"

type Line = { start: number; end: number; text: string }

function lines(text: string, span: Span): Line[] {
  const out: Line[] = []
  let at = span.start
  while (at < span.end) {
    const nl = text.indexOf("\n", at)
    const end = nl === -1 || nl >= span.end ? span.end : nl
    out.push({ start: at, end, text: text.slice(at, end) })
    at = end + 1
  }
  return out
}

const HEADING = /^#{1,6} /
const ITEM = /^\s*(?:[-*+]|\d+\.) /
const FENCE = /^\s*(?:```|~~~)/

type Block = Slice

/**
 * Blocks of a span in order: a heading line, a list item with its continuation lines, a fenced
 * block (one unit, never split), a paragraph of consecutive plain lines.
 */
function blocks(text: string, span: Span): Block[] {
  const out: Block[] = []
  let current: { kind: SliceKind; start: number; end: number } | undefined
  let fence: string | undefined
  const close = () => {
    if (current) out.push({ kind: current.kind, start: current.start, end: current.end })
    current = undefined
  }
  for (const line of lines(text, span)) {
    if (fence !== undefined) {
      current!.end = line.end
      if (FENCE.test(line.text) && line.text.trim().startsWith(fence)) {
        fence = undefined
        close()
      }
      continue
    }
    if (!line.text.trim()) {
      close()
      continue
    }
    if (FENCE.test(line.text)) {
      close()
      fence = line.text.trim().slice(0, 3)
      current = { kind: "code", start: line.start, end: line.end }
      continue
    }
    if (HEADING.test(line.text)) {
      close()
      out.push({ kind: "heading", start: line.start, end: line.end })
      continue
    }
    if (ITEM.test(line.text)) {
      close()
      current = { kind: "list-item", start: line.start, end: line.end }
      continue
    }
    if (current) current.end = line.end
    else current = { kind: "paragraph", start: line.start, end: line.end }
  }
  close()
  return out
}

/** Sentence ends are `.`, `!` or `?` followed by whitespace, outside inline code. */
function sentences(text: string, span: Span): Slice[] {
  const out: Slice[] = []
  let start = -1
  let inline = false
  const push = (end: number) => {
    if (start !== -1) out.push({ kind: "sentence", start, end })
    start = -1
  }
  for (let i = span.start; i < span.end; i++) {
    const c = text[i]!
    if (start === -1) {
      if (/\s/.test(c)) continue
      start = i
    }
    if (c === "`") inline = !inline
    else if (!inline && (c === "." || c === "!" || c === "?")) {
      const next = text[i + 1]
      if (i + 1 >= span.end || (next !== undefined && /\s/.test(next))) push(i + 1)
    }
  }
  if (start !== -1) {
    let end = span.end
    while (end > start && /\s/.test(text[end - 1]!)) end--
    push(end)
  }
  return out
}

function trimmed(text: string, span: Span): Span {
  let { start, end } = span
  while (start < end && /\s/.test(text[start]!)) start++
  while (end > start && /\s/.test(text[end - 1]!)) end--
  return { start, end }
}

/**
 * Structural units of a span, in order: headings first, then list items / fenced code /
 * paragraphs, then sentences. A fenced block is one unit. `[]` when the span is one sentence or
 * one code block.
 */
export function structuralChildren(text: string, span: Span): Slice[] {
  const whole = trimmed(text, span)
  const found = blocks(text, whole)
  const headings = found.filter((b) => b.kind === "heading")
  const atStart = found[0]?.kind === "heading" && found[0].start === whole.start
  if (headings.length > 1 || (headings.length === 1 && !atStart)) {
    const sections: Slice[] = []
    let current: Slice | undefined
    for (const block of found) {
      if (block.kind === "heading") {
        if (current) sections.push(current)
        current = { kind: "heading", start: block.start, end: block.end }
      } else if (current) current.end = block.end
      else current = { kind: "paragraph", start: block.start, end: block.end }
    }
    if (current) sections.push(current)
    return sections.length > 1 ||
      sections[0]!.start !== whole.start ||
      sections[0]!.end !== whole.end
      ? sections
      : []
  }
  const body = atStart ? found.slice(1) : found
  if (body.length >= 2) return body
  if (body.length === 1 && body[0]!.kind !== "code") {
    const parts = sentences(text, body[0]!)
    if (parts.length >= 2) return parts
  }
  if (body.length === 1 && atStart) return []
  return []
}

/** Children for recursion: merged left to right into at most `max` groups of near-equal length. */
export function groupChildren(children: Slice[], max: number): Slice[] {
  if (children.length <= max) return children
  const total = children.at(-1)!.end - children[0]!.start
  const groups: Slice[][] = []
  let current: Slice[] = []
  for (const [index, child] of children.entries()) {
    const remainingGroups = max - groups.length
    const remainingChildren = children.length - index
    if (current.length && remainingGroups > 1) {
      const target = (total * (groups.length + 1)) / max
      if (child.end - children[0]!.start > target && remainingChildren >= remainingGroups) {
        groups.push(current)
        current = []
      }
    }
    current.push(child)
  }
  if (current.length) groups.push(current)
  return groups.map((group) => {
    if (group.length === 1) return group[0]!
    const kinds = new Set(group.map((c) => c.kind))
    const kind: SliceKind = kinds.size === 1 && kinds.has("sentence") ? "sentences" : "paragraph"
    return { kind, start: group[0]!.start, end: group.at(-1)!.end }
  })
}

/**
 * By necessity: pack consecutive structural units into slices of at most `limit.maxChars`. A
 * unit that cannot be split below the limit is returned with kind `limit` and listed in
 * `oversize`; it is never truncated.
 */
export function packToLimit(
  text: string,
  span: Span,
  limit: InputLimit,
): { slices: Slice[]; oversize: Slice[] } {
  const whole = trimmed(text, span)
  if (whole.end - whole.start <= limit.maxChars)
    return { slices: [{ kind: "whole", ...whole }], oversize: [] }
  const oversize: Slice[] = []
  const units: Slice[] = []
  const flatten = (unit: Slice) => {
    if (unit.end - unit.start <= limit.maxChars) return void units.push(unit)
    const children = structuralChildren(text, unit)
    if (!children.length) {
      const flagged: Slice = { kind: "limit", start: unit.start, end: unit.end }
      oversize.push(flagged)
      return void units.push(flagged)
    }
    for (const child of children) flatten(child)
  }
  for (const child of structuralChildren(text, whole)) flatten(child)
  const slices: Slice[] = []
  let group: Slice[] = []
  const flush = () => {
    if (!group.length) return
    slices.push(
      group.length === 1
        ? group[0]!
        : { kind: "limit", start: group[0]!.start, end: group.at(-1)!.end },
    )
    group = []
  }
  for (const unit of units) {
    if (oversize.includes(unit)) {
      flush()
      slices.push(unit)
      continue
    }
    if (group.length && unit.end - group[0]!.start > limit.maxChars) flush()
    group.push(unit)
  }
  flush()
  return { slices, oversize }
}

/** Sentence-level units of an ask: sentences of paragraphs, and each heading, item or code block whole. */
function units(text: string): Slice[] {
  const out: Slice[] = []
  for (const block of blocks(text, { start: 0, end: text.length })) {
    if (block.kind === "paragraph") out.push(...sentences(text, block))
    else out.push(block)
  }
  return out
}

function windowsOf(items: Slice[], size: number, overlap: number): Slice[] {
  if (items.length <= size) {
    return items.length ? [{ kind: "whole", start: items[0]!.start, end: items.at(-1)!.end }] : []
  }
  const step = Math.max(1, size - overlap)
  const out: Slice[] = []
  for (let at = 0; ; at += step) {
    const part = items.slice(at, at + size)
    out.push({ kind: "sentences", start: part[0]!.start, end: part.at(-1)!.end })
    if (at + size >= items.length) break
  }
  return out
}

/** The default: consecutive windows of `size` sentences (or units), each overlapping the last by `overlap`. */
export function sentenceWindows(text: string, size = 4, overlap = 1): Slice[] {
  return windowsOf(units(text), size, overlap)
}

/** Strategy (b) baseline: paragraphs; one of more than four sentences becomes windows of four with a one-sentence overlap. */
export function fixedSlices(text: string): Slice[] {
  const out: Slice[] = []
  for (const block of blocks(text, { start: 0, end: text.length })) {
    if (block.kind !== "paragraph") {
      out.push(block)
      continue
    }
    const parts = sentences(text, block)
    if (parts.length <= 4) out.push(block)
    else out.push(...windowsOf(parts, 4, 1))
  }
  return out
}
