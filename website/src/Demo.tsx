import * as stylex from "@stylexjs/stylex"
import { useEffect, useRef, useState } from "preact/hooks"
import type { DemoDef } from "./demos"
import { isDemoMessage } from "./lib/demo-protocol"
import type { ChapterInfo, DemoCommandBody } from "./lib/demo-protocol"
import { color, type } from "./tokens.stylex"

/**
 * A live demo: the real LAZERS panel running in an iframe (/demo/) that replays a recorded story.
 * The page owns only the frame: it creates the iframe when it is near the viewport, plays while at
 * least a third of the frame is visible, pauses otherwise, scales the design-size iframe to fit,
 * draws the replayed pointer above it and lists the story's chapters. No scroll or wheel
 * listeners: IntersectionObserver and ResizeObserver only.
 */
const s = stylex.create({
  figure: { margin: 0, display: "grid", gap: 16, minWidth: 0, justifyItems: "stretch" },
  plate: {
    position: "relative",
    overflow: "hidden",
    width: "100%",
    maxWidth: "var(--demo-max, 100%)",
    marginInline: "auto",
    backgroundColor: "#14131c",
    border: `3px solid ${color.ink}`,
    boxShadow: "8px 10px 0 #A3A5F9",
    containerType: "inline-size",
  },
  plateOnInk: { borderColor: color.peri, boxShadow: `8px 10px 0 ${color.magenta}` },
  placeholder: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    padding: 16,
    textAlign: "center",
    color: "#cfcde0",
    fontFamily: type.face,
    fontStretch: "75%",
    fontStyle: "italic",
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    fontSize: 15,
  },
  frame: {
    position: "absolute",
    top: 0,
    left: 0,
    borderWidth: 0,
    transformOrigin: "top left",
    backgroundColor: "#14131c",
    colorScheme: "dark",
  },
  pointer: {
    position: "absolute",
    top: 0,
    left: 0,
    width: 0,
    height: 0,
    pointerEvents: "none",
    zIndex: 2,
    willChange: "transform",
  },
  cursor: {
    position: "absolute",
    top: 0,
    left: 0,
    width: 22,
    height: 22,
  },
  ripple: {
    position: "absolute",
    top: -14,
    left: -14,
    width: 28,
    height: 28,
    borderRadius: "50%",
    backgroundColor: "rgba(25, 235, 241, 0.55)",
    opacity: 0,
    transform: "scale(0.4)",
  },
  steps: { margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 8 },
  step: { display: "block" },
  stepButton: {
    appearance: "none",
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: 12,
    alignItems: "baseline",
    width: "100%",
    minHeight: 44,
    paddingBlock: 8,
    paddingInline: 12,
    textAlign: "start",
    cursor: "pointer",
    color: "inherit",
    font: "inherit",
    fontSize: 15,
    lineHeight: 1.4,
    backgroundColor: { default: "transparent", ":hover": "rgba(163, 165, 249, 0.18)" },
    borderWidth: 0,
    borderInlineStart: "4px solid transparent",
    position: "relative",
    overflow: "hidden",
  },
  stepActive: { borderInlineStartColor: color.magenta, fontWeight: 650 },
  stepNum: {
    fontFamily: type.face,
    fontStretch: "110%",
    fontStyle: "italic",
    fontWeight: 900,
    color: color.magenta,
  },
  bar: {
    position: "absolute",
    insetInline: 0,
    insetBlockEnd: 0,
    height: 3,
    backgroundColor: color.cyan,
    transformOrigin: "left center",
    transform: "scaleX(0)",
  },
  summary: { fontSize: 15, lineHeight: 1.5, opacity: 0.82, maxWidth: "62ch" },
})

const stepAnimation = stylex.keyframes({
  from: { transform: "scaleX(0)" },
  to: { transform: "scaleX(1)" },
})
const barRun = stylex.create({
  run: {
    animationName: stepAnimation,
    animationTimingFunction: "linear",
    animationFillMode: "forwards",
    animationDuration: "var(--ms, 0ms)",
  },
  full: { transform: "scaleX(1)" },
})

const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)")

function demoURL(def: DemoDef, at?: string) {
  const params = new URLSearchParams({ panel: def.panel, story: def.story })
  if (at) params.set("at", at)
  return `${new URL("demo/index.html", document.baseURI).href}#${params}`
}

export function Demo({
  def,
  label,
  tone = "paper",
  maxWidth,
}: {
  def: DemoDef
  /** Names the figure for assistive technology. */
  label: string
  tone?: "paper" | "ink"
  /** Caps the frame's CSS width; the panel scales down with it. */
  maxWidth?: number
}) {
  const plate = useRef<HTMLDivElement>(null)
  const pointer = useRef<HTMLDivElement>(null)
  const ripple = useRef<HTMLSpanElement>(null)
  const iframe = useRef<HTMLIFrameElement | null>(null)
  const [mounted, setMounted] = useState(false)
  const [scale, setScale] = useState(0)
  const [chapters, setChapters] = useState<ChapterInfo[]>([])
  const [active, setActive] = useState(-1)
  const [reduced, setReduced] = useState(reducedQuery.matches)
  const live = useRef({ visible: false, ready: false, reduced: reducedQuery.matches })
  live.current.reduced = reduced

  const send = (command: DemoCommandBody) =>
    iframe.current?.contentWindow?.postMessage({ demo: true, ...command }, location.origin)
  const sync = () => {
    if (!live.current.ready || live.current.reduced) return
    send({ type: live.current.visible ? "play" : "pause" })
  }

  useEffect(() => {
    const onChange = () => setReduced(reducedQuery.matches)
    reducedQuery.addEventListener("change", onChange)
    return () => reducedQuery.removeEventListener("change", onChange)
  }, [])

  // Scale the design-size iframe to the plate.
  useEffect(() => {
    const el = plate.current
    if (!el) return
    const ro = new ResizeObserver(() => setScale(el.clientWidth / def.size.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [def.size.width])

  // Create the iframe one viewport early; play only while a third of the plate is visible.
  useEffect(() => {
    const el = plate.current
    if (!el) return
    const near = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setMounted(true)
          near.disconnect()
        }
      },
      { rootMargin: "100% 0px" },
    )
    const seen = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        live.current.visible = Boolean(entry?.isIntersecting)
        sync()
      },
      { threshold: 0.35 },
    )
    near.observe(el)
    seen.observe(el)
    return () => {
      near.disconnect()
      seen.disconnect()
    }
  }, [])

  // The iframe's messages: origin, source and tag are all checked.
  useEffect(() => {
    let restart = 0
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== iframe.current?.contentWindow) return
      const message = event.data
      if (!isDemoMessage(message) || message.story !== def.story) return
      switch (message.type) {
        case "ready":
          live.current.ready = true
          setChapters(message.chapters)
          sync()
          break
        case "chapter":
          setActive(message.index)
          break
        case "pointer": {
          const node = pointer.current
          if (!node) break
          node.style.transform = `translate(${message.x * scale}px, ${message.y * scale}px)`
          node.style.opacity = message.off ? "0" : "1"
          if (message.down) {
            ripple.current?.animate(
              [
                { opacity: 0.9, transform: "scale(0.4)" },
                { opacity: 0, transform: "scale(1.6)" },
              ],
              { duration: 420, easing: "ease-out" },
            )
          }
          break
        }
        case "view":
          break
        case "end":
          // Replay from the first chapter once the story has finished.
          restart = window.setTimeout(() => {
            live.current.ready = false
            setActive(-1)
            send({ type: "seek", chapter: def.steps[0]!.name })
          }, 350)
          break
      }
    }
    window.addEventListener("message", onMessage)
    return () => {
      window.removeEventListener("message", onMessage)
      window.clearTimeout(restart)
    }
  }, [def.story, scale])

  const seek = (name: string) => {
    live.current.ready = false
    setActive(def.steps.findIndex((step) => step.name === name))
    send({ type: "seek", chapter: name })
  }

  const steps = chapters.length
    ? chapters
    : def.steps.map((step, index) => ({ ...step, at: index, ms: 0 }))
  const aspect = `${def.size.width} / ${def.size.height}`
  const finalChapter = def.steps[def.steps.length - 1]!.name

  return (
    <figure role="group" aria-label={label} {...stylex.props(s.figure)}>
      <div
        ref={plate}
        style={{ aspectRatio: aspect, "--demo-max": maxWidth ? `${maxWidth}px` : undefined }}
        {...stylex.props(s.plate, tone === "ink" && s.plateOnInk)}
      >
        {!mounted || scale === 0 ? (
          <div aria-hidden="true" {...stylex.props(s.placeholder)}>
            {def.panel} panel
          </div>
        ) : (
          <>
            <iframe
              ref={(node) => {
                iframe.current = node
              }}
              title={`${label}: replay of the real panel`}
              src={demoURL(def, reduced ? "final" : undefined)}
              tabIndex={-1}
              // The panel is a replay, not a control: out of the tab order and the accessibility tree.
              inert
              aria-hidden="true"
              style={{
                width: def.size.width,
                height: def.size.height,
                transform: `scale(${scale})`,
              }}
              {...stylex.props(s.frame)}
            />
            {!reduced && (
              <div
                ref={pointer}
                style={{ opacity: 0 }}
                aria-hidden="true"
                {...stylex.props(s.pointer)}
              >
                <span ref={ripple} {...stylex.props(s.ripple)} />
                <svg viewBox="0 0 22 22" {...stylex.props(s.cursor)}>
                  <path
                    d="M2 2 L2 17 L6 13 L9 20 L12 19 L9 12 L15 12 Z"
                    fill="#fff"
                    stroke="#13095e"
                    stroke-width="1.4"
                    stroke-linejoin="round"
                  />
                </svg>
              </div>
            )}
          </>
        )}
      </div>
      <ol aria-label="Steps in this demo" {...stylex.props(s.steps)}>
        {steps.map((step, index) => (
          <li key={step.name} {...stylex.props(s.step)}>
            <button
              type="button"
              aria-current={index === active ? "step" : undefined}
              onClick={() => seek(step.name)}
              {...stylex.props(s.stepButton, index === active && s.stepActive)}
            >
              <span aria-hidden="true" {...stylex.props(s.stepNum)}>
                {index + 1}
              </span>
              <span>{step.caption}</span>
              {!reduced && (
                <span
                  key={index === active ? `run-${active}` : `idle-${index}`}
                  aria-hidden="true"
                  style={{ "--ms": `${"ms" in step ? step.ms : 0}ms` }}
                  {...stylex.props(s.bar, index === active && barRun.run)}
                />
              )}
            </button>
          </li>
        ))}
      </ol>
      <figcaption {...stylex.props(s.summary)}>
        {def.summary}
        {reduced &&
          ` Showing the end of the final step (${finalChapter}); choose a step to jump to its result.`}
      </figcaption>
    </figure>
  )
}
