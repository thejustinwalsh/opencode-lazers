import * as stylex from "@stylexjs/stylex"
import type { ComponentChildren } from "preact"
import { useEffect, useRef } from "preact/hooks"
import catUrl from "./assets/cat.png"
import { CAT_SIZE } from "./assets/cat-geometry"
import { registerBeams, registerParallax, registerReveal } from "./lib/motion"
import { color, type } from "./tokens.stylex"

/* ---------------- beam kit: one cat, one canvas, one section ---------------- */
export function useBeamKit(id: string, pairs = 1, catDrift = 14) {
  const section = useRef<HTMLElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const sprite = useRef<HTMLImageElement>(null)
  const drift = useRef<HTMLDivElement>(null)
  const rest = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const undo = [
      registerBeams({
        id,
        section: section.current!,
        canvas: canvas.current!,
        sprite: sprite.current!,
        pairs,
      }),
      registerParallax(drift.current!, section.current!, catDrift),
      registerReveal(section.current!),
    ]
    return () => undo.forEach((u) => u())
  }, [])
  return { section, canvas, sprite, drift, rest }
}
export type BeamKit = ReturnType<typeof useBeamKit>

const s = stylex.create({
  canvas: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    zIndex: 2,
  },
  rest: { position: "absolute", zIndex: 1, pointerEvents: "none" },
  drift: { width: "100%", height: "100%", willChange: "transform" },
  sprite: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
    imageRendering: "pixelated",
    userSelect: "none",
    pointerEvents: "auto",
    cursor: "default",
  },
  field: { position: "absolute", pointerEvents: "none", zIndex: 0 },
  fieldInner: { width: "100%", height: "100%" },
})

export function BeamCanvas({ kit }: { kit: BeamKit }) {
  return <canvas ref={kit.canvas} aria-hidden="true" {...stylex.props(s.canvas)} />
}

/** The shared cat sprite. `sx` places and sizes the rest frame; drift moves inside it. */
export function Cat({ kit, sx }: { kit: BeamKit; sx: stylex.StyleXStyles }) {
  return (
    <div ref={kit.rest} aria-hidden="true" {...stylex.props(s.rest, sx)}>
      <div ref={kit.drift} {...stylex.props(s.drift)}>
        <img
          ref={kit.sprite}
          src={catUrl}
          width={CAT_SIZE.width}
          height={CAT_SIZE.height}
          alt=""
          draggable={false}
          {...stylex.props(s.sprite)}
        />
      </div>
    </div>
  )
}

/** Halftone dot field that drifts slower than the cat. */
export function Field({
  kit,
  sx,
  amp = 8,
  children,
}: {
  kit: BeamKit
  sx: stylex.StyleXStyles
  amp?: number
  children?: ComponentChildren
}) {
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => registerParallax(el.current!, kit.section.current!, amp), [])
  return (
    <div aria-hidden="true" {...stylex.props(s.field, sx)}>
      <div ref={el} {...stylex.props(s.fieldInner)}>
        {children}
      </div>
    </div>
  )
}

/* ---------------- stripes: signal bars, stand in for an eyebrow ---------------- */
const st = stylex.create({
  stripes: { display: "flex", flexDirection: "column", gap: "0.22em", width: "7em" },
  bar: {
    display: "block",
    height: "0.42em",
    transform: "skewX(-24deg)",
    transformOrigin: "left bottom",
  },
  m: { backgroundColor: color.magenta, width: "86%" },
  c: { backgroundColor: color.cyan },
  c2: { backgroundColor: color.cyan, width: "72%", marginInlineStart: "-6%" },
})

export function Stripes({ sx }: { sx?: stylex.StyleXStyles }) {
  return (
    <span aria-hidden="true" {...stylex.props(st.stripes, sx)}>
      <i {...stylex.props(st.bar, st.m)} />
      <i {...stylex.props(st.bar, st.c)} />
      <i {...stylex.props(st.bar, st.c2)} />
    </span>
  )
}

/* ---------------- common type ---------------- */
export const t = stylex.create({
  display: {
    fontFamily: type.face,
    fontStretch: "66%",
    fontWeight: 900,
    fontStyle: "italic",
    textTransform: "uppercase",
    lineHeight: 0.88,
    letterSpacing: "0.002em",
    textWrap: "balance",
  },
  inkLink: {
    color: "inherit",
    textDecorationColor: color.magenta,
    textDecorationThickness: "0.14em",
    textUnderlineOffset: "0.22em",
    ":hover": { textDecorationColor: color.cyan, backgroundColor: color.ink, color: color.paper },
  },
  mono: { fontFamily: type.mono, fontSize: "0.92rem", lineHeight: 1.6 },
  body: { maxWidth: "68ch", textWrap: "pretty" },
})

export const links = {
  docs: "https://github.com/thejustinwalsh/opencode-lazers/tree/main/docs",
  github: "https://github.com/thejustinwalsh/opencode-lazers",
  install: "https://github.com/thejustinwalsh/opencode-lazers/blob/main/docs/how-to/install.md",
  firstTask:
    "https://github.com/thejustinwalsh/opencode-lazers/blob/main/docs/tutorials/first-task.md",
  controls:
    "https://github.com/thejustinwalsh/opencode-lazers/blob/main/docs/reference/user-controls.md",
  releases: "https://github.com/thejustinwalsh/opencode-lazers/releases",
}

export const srOnly = {
  position: "absolute",
  width: "1px",
  height: "1px",
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const
