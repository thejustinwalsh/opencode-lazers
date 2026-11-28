// A small Solid adapter over the Pierre fork's imperative `CodeView`: one virtualized scroll
// container for every file. Pierre owns rows, highlighting, windowing and line selection; Solid
// renders only each file's header into the element Pierre asks for.
import { CodeView } from "@pierre/diffs"
import type {
  CodeViewDiffItem,
  CodeViewLineSelection,
  CodeViewOptions,
  CodeViewScrollTarget,
} from "@pierre/diffs"
import type { WorkerPoolManager } from "@pierre/diffs/worker"
import { createEffect, createRoot, on, onCleanup, onMount, untrack } from "solid-js"
import type { JSX } from "solid-js"
import { FALLBACK_ATTRIBUTE, HOST_SYNTAX_THEME, bridgeStyle, reviewShadowCSS } from "./theme.ts"

export type ReviewItem = CodeViewDiffItem<undefined>

/** Height of a file header row, in px; Pierre reserves it for each file before it mounts. */
export const FILE_HEADER_HEIGHT = 32
/** Height of a collapsed unchanged region (the shadow CSS sets the same). */
export const SEPARATOR_HEIGHT = 22
/** Code row height, in px (`--diffs-line-height`). */
export const LINE_HEIGHT = 18
/** Pixels mounted beyond the viewport, so highlighting lands before rows show (Oaink metrics.ts). */
const OVERSCAN = 600

export interface ReviewCodeViewHandle {
  scrollTo(target: CodeViewScrollTarget): void
  /** Replaces one file; `hold` keeps the row at the top of the view where it is. */
  updateItem(item: ReviewItem): void
  select(selection: CodeViewLineSelection | null): void
  selection(): CodeViewLineSelection | null
  /** Ids of the files mounted now, viewport and overscan. */
  renderedIDs(): string[]
  /** The scroll element; the code's shadow roots are under it. */
  container(): HTMLElement | undefined
  topOf(id: string): number | undefined
  scrollTop(): number
}

export function ReviewCodeView(props: {
  items: readonly ReviewItem[]
  mode: "light" | "dark"
  mono: string
  split: boolean
  wrap: boolean
  pool: WorkerPoolManager | undefined
  /** Files drawn as a line diff, not a structural comparison: they keep the theme's colors. */
  fallback: ReadonlySet<string>
  header(id: string): JSX.Element
  onSelection(selection: CodeViewLineSelection | null): void
  /** After Pierre drew: which files are mounted now. */
  onRendered(ids: string[]): void
  onScroll?(scrollTop: number): void
  ref(handle: ReviewCodeViewHandle | undefined): void
  class?: string
  label: string
}): JSX.Element {
  let host: HTMLDivElement | undefined
  let view: CodeView<undefined, undefined> | undefined
  const headers = new Map<string, { element: HTMLElement; dispose(): void }>()

  const headerFor = (id: string) => {
    let entry = headers.get(id)
    if (!entry) {
      entry = createRoot((dispose) => {
        const element = document.createElement("div")
        element.className = "lz-review-file-header-slot"
        const content = untrack(() => props.header(id))
        if (content instanceof Node) element.append(content)
        else if (Array.isArray(content))
          element.append(...content.filter((node): node is Node => node instanceof Node))
        return { element, dispose }
      })
      headers.set(id, entry)
    }
    return entry.element
  }
  const dropHeaders = (keep: ReadonlySet<string>) => {
    for (const [id, entry] of headers)
      if (!keep.has(id)) {
        entry.dispose()
        headers.delete(id)
      }
  }
  /** Marks mounted file hosts whose rows are a line diff, so the shadow CSS keeps theme colors. */
  const markFallback = () => {
    for (const rendered of view?.getRenderedItems() ?? []) {
      const fallback = props.fallback.has(rendered.id)
      if (rendered.element.hasAttribute(FALLBACK_ATTRIBUTE) !== fallback)
        rendered.element.toggleAttribute(FALLBACK_ATTRIBUTE, fallback)
    }
  }

  const options = (): CodeViewOptions<undefined, undefined> => ({
    theme: { dark: HOST_SYNTAX_THEME, light: HOST_SYNTAX_THEME },
    themeType: props.mode,
    preferredHighlighter: "shiki-js",
    diffStyle: props.split ? "split" : "unified",
    // The gutter bar and the pane say which side; no +/- signs.
    diffIndicators: "none",
    // Token marks come from Difftastic; Pierre's own word diff never runs.
    lineDiffType: "none",
    hunkSeparators: "line-info",
    expansionLineCount: 20,
    overflow: props.wrap ? "wrap" : "scroll",
    stickyHeaders: true,
    overscrollSize: OVERSCAN,
    enableLineSelection: true,
    lineHoverHighlight: "both",
    unsafeCSS: reviewShadowCSS(props.mode),
    renderCustomHeader: (_fileDiff, context) => headerFor(context.item.id),
    onSelectedLinesChange: (selection) => props.onSelection(selection),
    onPostRender: () => {
      markFallback()
      props.onRendered(view?.getRenderedItems().map((item) => item.id) ?? [])
    },
    layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
    itemMetrics: {
      lineHeight: LINE_HEIGHT,
      diffHeaderHeight: FILE_HEADER_HEIGHT,
      hunkSeparatorHeight: SEPARATOR_HEIGHT,
      spacing: 0,
    },
  })

  onMount(() => {
    if (!host) return
    view = new CodeView<undefined, undefined>(options(), props.pool)
    view.setup(host)
    view.setItems(untrack(() => props.items))
    view.render(true)
    const off = view.subscribeToScroll((top) => props.onScroll?.(top))
    props.ref({
      scrollTo: (target) => view?.scrollTo(target),
      updateItem: (item) => {
        if (!view) return
        view.updateItem(item)
        // An item on screen draws now, so a reader's scroll before the next frame is not undone.
        if (view.getRenderedItems().some((rendered) => rendered.id === item.id)) view.render(true)
      },
      select: (selection) =>
        selection ? view?.setSelectedLines(selection) : view?.clearSelectedLines(),
      selection: () => view?.getSelectedLines() ?? null,
      renderedIDs: () => view?.getRenderedItems().map((item) => item.id) ?? [],
      container: () => view?.getContainerElement() ?? host,
      topOf: (id) => view?.getTopForItem(id),
      scrollTop: () => view?.getScrollTop() ?? 0,
    })
    onCleanup(() => {
      off()
      props.ref(undefined)
      view?.cleanUp()
      view = undefined
      dropHeaders(new Set())
    })
  })

  // A new list (another comparison, a file added): reconcile by id, keep mounted headers that stay.
  createEffect(
    on(
      () => props.items,
      (items) => {
        if (!view) return
        dropHeaders(new Set(items.map((item) => item.id)))
        view.setItems(items)
        view.render(true)
      },
      { defer: true },
    ),
  )
  // Mode, layout or wrap: new options; Pierre redraws mounted files in place.
  createEffect(
    on(
      () => [props.mode, props.split, props.wrap] as const,
      () => {
        if (!view) return
        view.setOptions(options())
        view.render(true)
      },
      { defer: true },
    ),
  )
  createEffect(on(() => props.fallback, markFallback, { defer: true }))

  return (
    <div
      ref={(element) => (host = element)}
      class={props.class}
      role="region"
      aria-label={props.label}
      tabIndex={0}
      style={bridgeStyle(props.mode, props.mono)}
    />
  )
}
