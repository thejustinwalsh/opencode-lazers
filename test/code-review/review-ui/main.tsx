// Verification harness for the Review renderer: the real Solid adapter, Pierre fork, highlight
// workers, host-token theme and selection code over real Difftastic results (generate.ts).
// Hash parameters: w=<px> panel width, mode=light|dark, split=1, wrap=1, fallback=<path>.
import "./host-tokens.css"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { ReviewCodeView } from "../../../src/code-review/ui/renderer/code-view.tsx"
import type {
  ReviewCodeViewHandle,
  ReviewItem,
} from "../../../src/code-review/ui/renderer/code-view.tsx"
import { acquireHighlighter } from "../../../src/code-review/ui/renderer/highlighter.ts"
import {
  lineCounts,
  toLineDiff,
  toPierreDiff,
} from "../../../src/code-review/ui/renderer/structural.ts"
import {
  fromLineSelection,
  fromTextSelection,
} from "../../../src/code-review/ui/model/selection.ts"
import type { StructuralDiff } from "../../../src/code-review/structural/contract.ts"

type HarnessFile = {
  path: string
  status: string
  base: string | null
  head: string | null
  diff?: StructuralDiff
}
const params = () => new URLSearchParams(location.hash.slice(1))
const { files } = (await (await fetch("/data.json")).json()) as { files: HarnessFile[] }

const [mode, setMode] = createSignal<"light" | "dark">(
  params().get("mode") === "light" ? "light" : "dark",
)
const [split, setSplit] = createSignal(params().get("split") === "1")
const [wrap, setWrap] = createSignal(params().get("wrap") === "1")
const fallbackPaths = new Set(params().getAll("fallback"))
document.documentElement.dataset.mode = mode()

const build = (file: HarnessFile) =>
  file.diff && !fallbackPaths.has(file.path)
    ? toPierreDiff(file.diff, file)
    : toLineDiff(file.path, undefined, file)
const items: ReviewItem[] = files.map((file, index) => ({
  id: file.path,
  type: "diff",
  fileDiff: build(file),
  version: index,
}))
const fallback = new Set(
  files
    .filter(
      (file) =>
        !file.diff ||
        file.diff.engine !== "difftastic" ||
        file.diff.degraded ||
        fallbackPaths.has(file.path),
    )
    .map((file) => file.path),
)

let handle: ReviewCodeViewHandle | undefined
const state = { rendered: [] as string[], selection: null as unknown, scrolls: 0 }
const highlighter = acquireHighlighter()
const root = document.getElementById("root")!
root.style.width = `${params().get("w") ?? "420"}px`
const dispose = render(
  () => (
    <div class="shell">
      <ReviewCodeView
        class="scroller"
        label="Harness"
        items={items}
        fallback={fallback}
        mode={mode()}
        mono={"ui-monospace, SFMono-Regular, Menlo, monospace"}
        split={split()}
        wrap={wrap()}
        pool={highlighter.pool}
        header={(id) => {
          const file = files.find((each) => each.path === id)!
          const counts = lineCounts(items.find((item) => item.id === id)!.fileDiff)
          return (
            <div class="hdr" data-lz-review-header={id}>
              <span>{file.status}</span>
              <span>{id.split("/").at(-1)}</span>
              <small>
                {file.diff?.engine}
                {file.diff?.degraded ? ` ${file.diff.degraded}` : ""} +{counts.added} −
                {counts.removed}
              </small>
            </div>
          )
        }}
        onSelection={(selection) => (state.selection = fromLineSelection(selection) ?? null)}
        onRendered={(ids) => (state.rendered = ids)}
        onScroll={() => state.scrolls++}
        ref={(value) => (handle = value)}
      />
    </div>
  ),
  root,
)

Object.assign(window, {
  __review: {
    state,
    workers: () => ({
      working: highlighter.pool?.isWorkingPool() ?? false,
      initialized: highlighter.pool?.isInitialized() ?? false,
    }),
    files: files.map((file) => ({
      path: file.path,
      status: file.status,
      engine: file.diff?.engine,
      degraded: file.diff?.degraded,
    })),
    handle: () => handle,
    /** Replaces a file with a rendering that keeps `context` unchanged rows around each change. */
    expand: (id: string, context: number) => {
      const file = files.find((each) => each.path === id)
      if (!file?.diff || !handle) return false
      const index = items.findIndex((item) => item.id === id)
      items[index] = {
        id,
        type: "diff",
        fileDiff: toPierreDiff(file.diff, file, context),
        version: (items[index]!.version ?? 0) + 1000,
      }
      handle.updateItem(items[index]!)
      return true
    },
    setMode: (next: "light" | "dark") => {
      document.documentElement.dataset.mode = next
      setMode(next)
    },
    setSplit,
    setWrap,
    textSelection: () => {
      const container = handle?.container()
      if (!container) return undefined
      return fromTextSelection(container, (host) => {
        for (const id of handle?.renderedIDs() ?? []) {
          const header = container.querySelector(`[data-lz-review-header="${CSS.escape(id)}"]`)
          if (header && host.contains(header)) return id
        }
        return undefined
      })
    },
    dispose: () => {
      dispose()
      highlighter.release()
      return { children: root.childElementCount }
    },
  },
})
