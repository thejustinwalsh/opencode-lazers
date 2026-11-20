import * as stylex from "@stylexjs/stylex"
import { useEffect, useRef, useState } from "preact/hooks"
import type { DemoDef } from "./demos"
import { fitScale, frameStyle } from "./lib/demo-fit"
import { isDemoMessage } from "./lib/demo-protocol"
import type { ChapterInfo, DemoCommandBody, PointerKind } from "./lib/demo-protocol"
import { bp, color, type } from "./tokens.stylex"

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
    width: "100%",
    maxWidth: "var(--demo-max, 100%)",
    backgroundColor: "#14131c",
    border: `3px solid ${color.ink}`,
    boxShadow: "8px 10px 0 #A3A5F9",
  },
  /* The scaled iframe's box: the aspect ratio lives here, inside the border, so the content
     box matches the design size exactly. */
  view: { position: "relative", overflow: "hidden", width: "100%" },
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
  /* The pointer's origin is the hotspot: every shape is offset so its tip sits at (0, 0). */
  cursor: {
    position: "absolute",
    top: 0,
    left: 0,
    width: 0,
    height: 0,
    transformOrigin: "0 0",
    filter: "drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.4))",
  },
  shape: { position: "absolute", overflow: "visible" },
  /* Narrow: one row of numbered buttons and the active caption above them, so a demo stays
     shorter than the viewport. From 640px the buttons carry their captions in a column. */
  steps: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    display: "grid",
    gridTemplateColumns: { default: "repeat(4, minmax(0, 1fr))", [bp.mid]: "minmax(0, 1fr)" },
    gap: 8,
  },
  liveCaption: {
    display: { default: "block", [bp.mid]: "none" },
    margin: 0,
    minHeight: "3em",
    fontSize: 15,
    lineHeight: 1.45,
    fontWeight: 600,
  },
  stepText: {
    position: { default: "absolute", [bp.mid]: "static" },
    width: { default: 1, [bp.mid]: "auto" },
    height: { default: 1, [bp.mid]: "auto" },
    overflow: { default: "hidden", [bp.mid]: "visible" },
    clip: { default: "rect(0 0 0 0)", [bp.mid]: "auto" },
    whiteSpace: { default: "nowrap", [bp.mid]: "normal" },
  },
  step: { display: "block" },
  stepButton: {
    appearance: "none",
    display: "grid",
    gridTemplateColumns: { default: "1fr", [bp.mid]: "auto 1fr" },
    justifyItems: { default: "center", [bp.mid]: "stretch" },
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

/** The cursor shapes, vector and drawn here: black fill, white outline; tip or hotspot at (0, 0). */
const OUTLINE = {
  fill: "#fff",
  stroke: "#fff",
  "stroke-width": 2.6,
  "stroke-linejoin": "round",
} as const
function PointerShapes() {
  const arrow = "M0 0 L0 15.6 L3.9 12.2 L6.6 18.4 L9.1 17.3 L6.5 11.2 L11.6 11.2 Z"
  const hand =
    "M0 6.2 V-4.2 C0 -5.3 0.8 -6.1 1.8 -6.1 C2.8 -6.1 3.6 -5.3 3.6 -4.2 V0.6 C3.8 0.2 4.3 0 4.8 0 C5.6 0 6.2 0.6 6.2 1.3 C6.5 0.9 6.9 0.7 7.4 0.7 C8.2 0.7 8.8 1.3 8.8 2 C9.1 1.7 9.5 1.6 9.9 1.6 C10.7 1.6 11.3 2.2 11.3 3 V8 C11.3 11 9.5 13 7.5 14.4 H2.7 C1.5 13 0 10 -1.1 8.2 C-1.7 7.3 -2 6.6 -2 6 C-2 5.2 -1.2 4.8 -0.5 5.1 Z"
  const beam = "M-3 -8 H3 M0 -8 V8 M-3 8 H3"
  return (
    <>
      <svg data-kind="default" width="1" height="1" {...stylex.props(s.shape)}>
        <path d={arrow} {...OUTLINE} />
        <path d={arrow} fill="#000" />
      </svg>
      <svg
        data-kind="pointer"
        width="1"
        height="1"
        style={{ display: "none" }}
        {...stylex.props(s.shape)}
      >
        <path d={hand} transform="translate(-1.8 6.1)" {...OUTLINE} />
        <path
          d={hand}
          transform="translate(-1.8 6.1)"
          fill="#000"
          stroke="#000"
          stroke-width="0.6"
          stroke-linejoin="round"
        />
      </svg>
      <svg
        data-kind="text"
        width="1"
        height="1"
        style={{ display: "none" }}
        {...stylex.props(s.shape)}
      >
        <path d={beam} fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" />
        <path d={beam} fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round" />
      </svg>
    </>
  )
}

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
  /** Caps the frame's CSS width (default: the design width, so the panel is never scaled up). */
  maxWidth?: number
}) {
  const plate = useRef<HTMLDivElement>(null)
  const pointer = useRef<HTMLDivElement>(null)
  const cursor = useRef<HTMLDivElement>(null)
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
    const ro = new ResizeObserver(() => setScale(fitScale(el.clientWidth, def.size)))
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
          for (const shape of cursor.current?.children ?? [])
            (shape as SVGElement).style.display =
              shape.getAttribute("data-kind") === message.cursor ? "" : "none"
          // A brief press, like a real cursor: scale from the tip and back.
          if (message.down)
            cursor.current?.animate(
              [{ transform: "scale(1)" }, { transform: "scale(0.92)" }, { transform: "scale(1)" }],
              { duration: 160, easing: "ease-out" },
            )
          break
        }
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
        style={{ "--demo-max": `${maxWidth ?? def.size.width + 6}px` }}
        {...stylex.props(s.plate, tone === "ink" && s.plateOnInk)}
      >
        <div ref={plate} style={{ aspectRatio: aspect }} {...stylex.props(s.view)}>
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
                style={frameStyle(def.size, scale)}
                {...stylex.props(s.frame)}
              />
              {!reduced && (
                <div
                  ref={pointer}
                  style={{ opacity: 0 }}
                  aria-hidden="true"
                  {...stylex.props(s.pointer)}
                >
                  <div ref={cursor} {...stylex.props(s.cursor)}>
                    <PointerShapes />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <p aria-hidden="true" {...stylex.props(s.liveCaption)}>
        {steps[Math.max(active, 0)]?.caption}
      </p>
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
              <span {...stylex.props(s.stepText)}>{step.caption}</span>
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
