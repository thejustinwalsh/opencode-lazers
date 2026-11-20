import { useEffect, useRef, useState } from "preact/hooks"
import type { ComponentType } from "preact"

/** The only part of the chat in the homepage bundle: it renders an empty frame of the chat's size
 *  and imports the chat (UI, state machine, styles) once the section is near the viewport. The
 *  model runtime is a further, separate import on the visitor's first action. */
export function LiveChat() {
  const host = useRef<HTMLDivElement>(null)
  const [Chat, setChat] = useState<ComponentType | null>(null)
  useEffect(() => {
    const el = host.current
    if (!el) return
    const load = () => void import("./Chat").then((m) => setChat(() => m.LiveChat))
    if (!("IntersectionObserver" in window)) return load()
    const watcher = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        watcher.disconnect()
        load()
      },
      { rootMargin: "800px 0px" },
    )
    watcher.observe(el)
    return () => watcher.disconnect()
  }, [])
  return Chat ? (
    <Chat />
  ) : (
    <div
      ref={host}
      class="lc-hold"
      aria-hidden="true"
      style={{ height: "clamp(480px, 74svh, 660px)" }}
    />
  )
}
