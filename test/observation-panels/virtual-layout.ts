import type { Window } from "happy-dom"

/**
 * Happy DOM has no layout: every box is 0x0, so a virtualizer would mount nothing. This gives the
 * Tasks list a viewport, virtual items a fixed height per kind, and the tree an origin below a
 * fixed-height header block (Now/Attention/Next), the way a browser would. Test-only.
 */
export type TasksLayout = {
  viewportHeight: number
  /** Height of everything above the tree inside the scrolling list. */
  headHeight: number
  itemHeights: Record<string, number>
  /** Height of the whole panel; 0 leaves the list/inspector split at its default share. */
  paneHeight: number
}

export const defaultTasksLayout: TasksLayout = {
  viewportHeight: 320,
  headHeight: 80,
  itemHeights: { task: 32, plan: 40, note: 28, loader: 32 },
  paneHeight: 0,
}

/** Returns `uninstall()`, which restores every overridden own property (or its absence) exactly. */
export function installTasksLayout(dom: Window, overrides: Partial<TasksLayout> = {}) {
  const layout = { ...defaultTasksLayout, ...overrides }
  const proto = dom.window.HTMLElement.prototype as unknown as HTMLElement
  const saved: Array<{ target: object; name: string; original?: PropertyDescriptor }> = []
  const override = (target: object, name: string, descriptor: PropertyDescriptor) => {
    saved.push({ target, name, original: Object.getOwnPropertyDescriptor(target, name) })
    Object.defineProperty(target, name, { configurable: true, ...descriptor })
  }
  const define = (name: string, get: (this: HTMLElement) => unknown) =>
    override(proto, name, { get })
  const isList = (element: Element) => element.classList.contains("lazers-tasks-list")
  define("clientHeight", function () {
    return isList(this) ? layout.viewportHeight : 0
  })
  define("clientWidth", function () {
    return isList(this) ? 320 : 0
  })
  define("scrollHeight", function () {
    if (!isList(this)) return 0
    const tree = this.querySelector<HTMLElement>(".lazers-tasks-tree")
    return layout.headHeight + (tree ? Number.parseFloat(tree.style.height) || 0 : 0) + 8
  })
  define("offsetHeight", function () {
    return this.classList.contains("lazers-tasks-virtual-item")
      ? (layout.itemHeights[this.dataset.kind ?? "task"] ?? 32)
      : 0
  })
  const rect = (top: number, height: number) =>
    ({
      top,
      bottom: top + height,
      left: 0,
      right: 320,
      width: 320,
      height,
      x: 0,
      y: top,
    }) as DOMRect
  override(proto, "getBoundingClientRect", {
    writable: true,
    value(this: HTMLElement) {
      if (isList(this)) return rect(0, layout.viewportHeight)
      if (this.classList.contains("lazers-tasks")) return rect(0, layout.paneHeight)
      if (this.classList.contains("lazers-tasks-tree"))
        return rect(layout.headHeight - (this.closest(".lazers-tasks-list")?.scrollTop ?? 0), 0)
      return rect(0, 0)
    },
  })
  // The browser clamps and announces programmatic scrolls; Happy DOM only stores scrollTop.
  override(proto, "scrollTo", {
    writable: true,
    value(this: HTMLElement, options?: ScrollToOptions | number) {
      if (!isList(this)) return
      const top = typeof options === "number" ? options : (options?.top ?? this.scrollTop)
      this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight))
      this.dispatchEvent(new dom.window.Event("scroll") as unknown as Event)
    },
  })
  // Browsers report an element's size when it starts being observed; Happy DOM never does.
  class TestResizeObserver {
    constructor(private readonly callback: (entries: ResizeObserverEntry[]) => void) {}
    observe(target: HTMLElement) {
      queueMicrotask(() => {
        if (!target.isConnected) return
        const size = {
          blockSize: target.offsetHeight || target.clientHeight,
          inlineSize: target.clientWidth || 320,
        }
        this.callback([{ target, borderBoxSize: [size] } as unknown as ResizeObserverEntry])
      })
    }
    unobserve() {}
    disconnect() {}
  }
  override(dom.window, "ResizeObserver", { writable: true, value: TestResizeObserver })
  return () => {
    for (const { target, name, original } of saved.toReversed()) {
      if (original) Object.defineProperty(target, name, original)
      else Reflect.deleteProperty(target, name)
    }
  }
}
