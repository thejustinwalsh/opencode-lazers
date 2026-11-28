import type { CodeViewLineSelection } from "@pierre/diffs"

/**
 * What the reader selected, bound to one file, one side and an inclusive line range. `startChar`
 * and `endChar` are UTF-16 columns on the first and last line when characters, not lines, were
 * selected.
 */
export type CodeSelection = {
  path: string
  side: "base" | "head"
  startLine: number
  endLine: number
  startChar?: number
  endChar?: number
}

/** Pierre's gutter selection (click or drag on line numbers). A range across both sides is not one. */
export function fromLineSelection(
  selection: CodeViewLineSelection | null,
): CodeSelection | undefined {
  if (!selection) return undefined
  const { range } = selection
  const side = range.side ?? range.endSide
  if (range.endSide && range.side && range.endSide !== range.side) return undefined
  const [startLine, endLine] = [range.start, range.end].sort((a, b) => a - b) as [number, number]
  if (!Number.isSafeInteger(startLine) || startLine < 1) return undefined
  return {
    path: selection.id,
    side: side === "deletions" ? "base" : "head",
    startLine,
    endLine,
  }
}

type ComposedSelection = Selection & {
  getComposedRanges?(options: { shadowRoots: ShadowRoot[] }): StaticRange[]
}

const rowOf = (node: Node) =>
  (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-line]")

/** Column of a boundary point inside its code row: the length of the row's text before it. */
function columnIn(row: HTMLElement, node: Node, offset: number): number {
  const content = row.querySelector<HTMLElement>("[data-content]") ?? row
  const range = row.ownerDocument.createRange()
  range.setStart(content, 0)
  try {
    range.setEnd(node, offset)
  } catch {
    return 0
  }
  return range.toString().length
}

/**
 * The code a DOM text selection covers. Pierre's rows live in shadow roots, so the selection is
 * read as a composed range; each row carries its line and sits in a side's column. A selection
 * across files or across sides is not one source selection.
 */
export function fromTextSelection(
  root: ParentNode,
  idOf: (host: Element) => string | undefined,
): CodeSelection | undefined {
  const selection = (root as Node).ownerDocument?.getSelection() as ComposedSelection | null
  if (!selection || selection.isCollapsed) return undefined
  const shadowRoots = [...root.querySelectorAll("*")].flatMap((element) =>
    element.shadowRoot ? [element.shadowRoot] : [],
  )
  const range = selection.getComposedRanges?.({ shadowRoots })[0]
  if (!range) return undefined
  const first = rowOf(range.startContainer)
  const last = rowOf(range.endContainer)
  if (!first || !last) return undefined
  const shadow = first.getRootNode()
  if (!(shadow instanceof ShadowRoot) || last.getRootNode() !== shadow) return undefined
  // Split view: a side's column. Unified view: a removed row is the base's; others are the head's.
  const sideOf = (row: HTMLElement) =>
    row.closest("[data-deletions]") || row.dataset.lineType === "change-deletion" ? "base" : "head"
  if (sideOf(first) !== sideOf(last)) return undefined
  const path = idOf(shadow.host)
  const startLine = Number(first.dataset.line)
  const endLine = Number(last.dataset.line)
  if (!path || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)) return undefined
  // A range's start precedes its end in document order, and a side's rows are in line order.
  if (endLine < startLine) return undefined
  return {
    path,
    side: sideOf(first),
    startLine,
    endLine,
    startChar: columnIn(first, range.startContainer, range.startOffset),
    endChar: columnIn(last, range.endContainer, range.endOffset),
  }
}
