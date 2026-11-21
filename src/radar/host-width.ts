import { createSignal, onCleanup, onMount, type Accessor } from "solid-js"

/**
 * The width of the element `host` returns, read when the view mounts (at least 240, 480 when it
 * has no width yet) and followed as the element is resized.
 */
export function hostWidth(host: () => HTMLDivElement | undefined): Accessor<number> {
  const [width, setWidth] = createSignal(480)
  onMount(() => {
    const element = host()
    if (!element) return
    setWidth(Math.max(240, Math.floor(element.clientWidth)) || 480)
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0)
      if (next > 0) setWidth(next)
    })
    observer.observe(element)
    onCleanup(() => observer.disconnect())
  })
  return width
}
