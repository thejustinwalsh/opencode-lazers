import * as stylex from "@stylexjs/stylex"
import { useEffect, useRef } from "preact/hooks"
import flag from "./assets/mark-flag.png"
import corner from "./assets/mark-corner.png"
import sparkle from "./assets/mark-sparkle.png"
import stripesMark from "./assets/mark-stripes.png"
import { enhanceLede } from "./lib/lede"
import { bp, color, type } from "./tokens.stylex"
import { BeamCanvas, Cat, Field, Stripes, links, srOnly, t, useBeamKit } from "./ui"

const u = (n: number) => `calc(var(--u) * ${n})`

const c = stylex.create({
  cover: {
    position: "relative",
    isolation: "isolate",
    backgroundColor: color.paper,
    overflow: "clip",
    display: { default: "flex", [bp.wide]: "block" },
    flexDirection: "column",
    height: { default: "auto", [bp.wide]: "clamp(600px, 100svh, 66vw)" },
    minHeight: { default: "auto", [bp.wide]: 600 },
  },
  /* ground */
  dots: {
    width: "100%",
    height: "100%",
    backgroundImage: `radial-gradient(circle, ${"#A3A5F9"} 0 34%, transparent 39%)`,
    backgroundSize: {
      default: "9px 9px",
      [bp.wide]: "max(7px, calc(var(--u) * 0.52)) max(7px, calc(var(--u) * 0.52))",
    },
  },
  dotsTop: {
    maskImage: "linear-gradient(105deg, #000 35%, transparent 92%)",
    WebkitMaskImage: "linear-gradient(105deg, #000 35%, transparent 92%)",
  },
  dotsCat: {
    maskImage: "linear-gradient(60deg, #000 20%, transparent 80%)",
    WebkitMaskImage: "linear-gradient(60deg, #000 20%, transparent 80%)",
  },
  fieldTop: {
    top: 0,
    left: 0,
    width: { default: "100%", [bp.wide]: u(40) },
    height: { default: 190, [bp.wide]: u(23) },
  },
  /* Mobile: behind the cat band under the nav slab, clear of the contents text. */
  fieldCat: {
    left: 0,
    top: { default: "calc(25vw + 160px)", [bp.wide]: "auto" },
    bottom: { default: "auto", [bp.wide]: 0 },
    width: { default: "90%", [bp.wide]: u(46) },
    height: { default: "70vw", [bp.wide]: u(40) },
  },
  /* wordmark: ink outer rule, ivory gap, ink outline, halftone magenta fill */
  wordmark: {
    display: "grid",
    position: { default: "relative", [bp.wide]: "absolute" },
    zIndex: 3,
    width: "fit-content",
    left: { default: 0, [bp.wide]: u(0.7) },
    top: { default: 0, [bp.wide]: u(3.4) },
    marginInlineStart: { default: "4.5vw", [bp.wide]: 0 },
    marginBlockStart: { default: "7vw", [bp.wide]: 0 },
    paddingInlineEnd: "0.3em",
    paddingBlockEnd: "0.12em",
    fontFamily: type.face,
    fontStretch: "125%",
    fontWeight: 900,
    fontStyle: "italic",
    textTransform: "uppercase",
    lineHeight: 1,
    letterSpacing: "-0.025em",
    fontSize: { default: "16.4vw", [bp.wide]: u(11.6) },
    transform: "rotate(-3.2deg)",
    transformOrigin: "left bottom",
    whiteSpace: "nowrap",
  },
  /* Layers stack by z-index: a transform alone would lift the rim above the fill. */
  wmLayer: {
    gridArea: "1 / 1",
    position: "relative",
    paintOrder: "stroke fill",
    strokeLinejoin: "round",
  },
  wmOuter: {
    zIndex: 0,
    color: color.ink,
    WebkitTextStroke: "0.2em #13095E",
    transform: "translate(0.025em, 0.035em)",
  },
  wmGap: { zIndex: 1, color: color.paper, WebkitTextStroke: "0.122em #F7F6EF" },
  wmFill: {
    zIndex: 2,
    color: "transparent",
    WebkitTextFillColor: "transparent",
    WebkitTextStroke: "0.04em #13095E",
    backgroundClip: "text",
    WebkitBackgroundClip: "text",
    backgroundColor: color.paper,
    backgroundRepeat: "repeat-x, repeat-x, repeat-x, repeat-x, no-repeat, repeat",
    backgroundImage: [
      "radial-gradient(circle, #F81497 0 49%, transparent 52%)",
      "radial-gradient(circle, #F81497 0 43%, transparent 46%)",
      "radial-gradient(circle, #F81497 0 37%, transparent 40%)",
      "radial-gradient(circle, #F81497 0 31%, transparent 34%)",
      "linear-gradient(#F81497, #F81497)",
      "radial-gradient(circle, #F81497 0 25%, transparent 28%)",
    ].join(", "),
    backgroundSize:
      "0.075em 0.075em, 0.075em 0.075em, 0.075em 0.075em, 0.075em 0.075em, 100% 36%, 0.075em 0.075em",
    backgroundPosition: "0 0.6em, 0 0.525em, 0 0.45em, 0 0.375em, 0 100%, 0 0",
  },
  /* slab top right */
  slab: {
    position: { default: "relative", [bp.wide]: "absolute" },
    zIndex: 3,
    top: 0,
    right: 0,
    width: { default: "auto", [bp.wide]: u(38.4) },
    height: { default: "auto", [bp.wide]: u(12.8) },
    marginBlockStart: { default: "2vw", [bp.wide]: 0 },
    backgroundColor: color.ink,
    color: color.paper,
    clipPath: { default: "none", [bp.wide]: "polygon(4.5% 0, 100% 0, 100% 100%, 0 100%)" },
    paddingInlineStart: { default: 16, [bp.wide]: u(5.6) },
    paddingInlineEnd: { default: 16, [bp.wide]: u(2.4) },
    paddingBlockStart: { default: 0, [bp.wide]: u(1.2) },
    paddingBlockEnd: { default: 18, [bp.wide]: 0 },
  },
  nav: {
    display: "flex",
    borderBottomWidth: { default: 3, [bp.wide]: u(0.2) },
    borderBottomStyle: "solid",
    borderBottomColor: color.peri,
    gap: { default: 0, [bp.wide]: u(3.4) },
    marginInline: { default: -16, [bp.wide]: 0 },
  },
  navLink: {
    flex: { default: 1, [bp.wide]: "none" },
    display: "flex",
    alignItems: "center",
    justifyContent: { default: "center", [bp.wide]: "flex-start" },
    minHeight: { default: 52, [bp.wide]: u(3.6) },
    fontFamily: type.face,
    fontStretch: "68%",
    fontWeight: 800,
    fontStyle: "italic",
    textTransform: "uppercase",
    fontSize: { default: 24, [bp.wide]: u(1.95) },
    letterSpacing: "0.01em",
    color: color.paper,
    textDecoration: "none",
    backgroundColor: { default: "transparent", ":hover": color.magenta },
    boxShadow: { default: "none", [bp.wide]: "none" },
    paddingInline: { default: 0, [bp.wide]: u(0.3) },
  },
  tagline: {
    display: "flex",
    alignItems: "center",
    gap: { default: 16, [bp.wide]: u(1.8) },
    marginBlockStart: { default: 16, [bp.wide]: u(1.5) },
    fontFamily: type.face,
    fontStretch: "70%",
    fontWeight: 800,
    fontStyle: "italic",
    textTransform: "uppercase",
    fontSize: { default: 24, [bp.wide]: u(2.05) },
    lineHeight: 1.02,
  },
  taglineStripes: { fontSize: { default: 16, [bp.wide]: u(1.45) } },
  /* headline */
  head: {
    position: { default: "relative", [bp.wide]: "absolute" },
    zIndex: 3,
    left: { default: 0, [bp.wide]: u(21) },
    top: { default: 0, [bp.wide]: u(15) },
    marginBlockStart: { default: 28, [bp.wide]: 0 },
    marginInlineStart: { default: 18, [bp.wide]: 0 },
    display: "flex",
    alignItems: "flex-end",
    gap: { default: 14, [bp.wide]: u(1.6) },
    transform: "rotate(-4deg)",
    transformOrigin: "left bottom",
  },
  headText: {
    fontSize: { default: "min(15vw, 84px)", [bp.wide]: u(5.5) },
    color: color.ink,
    lineHeight: 0.9,
    textWrap: "nowrap",
  },
  headLine: { display: "block" },
  headStripes: {
    fontSize: { default: 12, [bp.wide]: u(1.2) },
    marginBlockEnd: { default: 8, [bp.wide]: u(0.9) },
  },
  /* lede */
  ledeWrap: {
    position: { default: "relative", [bp.wide]: "absolute" },
    zIndex: 3,
    left: { default: 0, [bp.wide]: u(3.5) },
    top: { default: 0, [bp.wide]: u(33.8) },
    width: { default: "auto", [bp.wide]: u(49.2) },
    paddingInline: { default: 18, [bp.wide]: 0 },
    marginBlockStart: { default: 18, [bp.wide]: 0 },
  },
  ledeBox: { position: "relative" },
  lede: {
    fontSize: { default: 17, [bp.wide]: "max(16px, calc(var(--u) * 1.3))" },
    lineHeight: { default: "26px", [bp.wide]: "max(24px, calc(var(--u) * 1.9))" },
    fontWeight: 500,
    color: color.ink,
  },
  ledeLines: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    fontSize: { default: 17, [bp.wide]: "max(16px, calc(var(--u) * 1.3))" },
    lineHeight: { default: "26px", [bp.wide]: "max(24px, calc(var(--u) * 1.9))" },
    fontWeight: 500,
    color: color.ink,
  },
  /* cat zone + install */
  catZone: {
    display: { default: "block", [bp.wide]: "contents" },
    position: "relative",
    height: { default: "64vw", [bp.wide]: "auto" },
    marginBlockStart: { default: 4, [bp.wide]: 0 },
  },
  cat: {
    left: { default: "-15vw", [bp.wide]: u(-6.6) },
    bottom: { default: "-3vw", [bp.wide]: u(-2.6) },
    height: { default: "56vw", [bp.wide]: u(36) },
    width: { default: "58vw", [bp.wide]: u(37.4) },
  },
  install: {
    position: "absolute",
    zIndex: 3,
    display: "block",
    right: { default: "9vw", [bp.wide]: "auto" },
    top: { default: "14vw", [bp.wide]: u(45) },
    left: { default: "auto", [bp.wide]: u(56) },
    width: { default: "58vw", [bp.wide]: u(30.5) },
    height: { default: "20vw", [bp.wide]: u(8.8) },
    color: color.paper,
    textDecoration: "none",
    minHeight: 64,
    transform: { default: "rotate(-1deg)", ":hover": "rotate(-1deg) translate(-3px, -3px)" },
    transitionProperty: "transform",
    transitionDuration: "120ms",
  },
  plate: {
    position: "absolute",
    inset: 0,
    backgroundColor: color.magenta,
    clipPath: "polygon(6% 0, 100% 0, 94% 100%, 0 100%)",
  },
  plateShadow: {
    position: "absolute",
    inset: 0,
    backgroundColor: color.ink,
    clipPath: "polygon(6% 0, 100% 0, 94% 100%, 0 100%)",
    transform: "translate(0.55vw, 0.9vw)",
  },
  installLabel: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.3em",
    fontFamily: type.face,
    fontStretch: "104%",
    fontWeight: 900,
    fontStyle: "italic",
    textTransform: "uppercase",
    fontSize: { default: "clamp(26px, 8.2vw, 46px)", [bp.wide]: u(4.7) },
    letterSpacing: "-0.01em",
    lineHeight: 1,
    textShadow: "0.03em 0.04em 0 #13095E",
  },
  arrow: { width: "0.9em", height: "0.62em" },
  ticks: {
    position: "absolute",
    top: "50%",
    width: "1.1em",
    height: "1.1em",
    pointerEvents: "none",
  },
  ticksL: { left: "-1.6em", fontSize: { default: 12, [bp.wide]: u(1.1) } },
  ticksR: { right: "-1.6em", fontSize: { default: 12, [bp.wide]: u(1.1) } },
  tick: {
    position: "absolute",
    left: 0,
    width: "1.2em",
    height: "0.26em",
    backgroundColor: color.cyan,
  },
  /* contents grid */
  contents: {
    position: { default: "relative", [bp.wide]: "absolute" },
    zIndex: 3,
    left: { default: 0, [bp.wide]: u(54) },
    right: { default: 0, [bp.wide]: u(1.2) },
    top: { default: 0, [bp.wide]: u(14.6) },
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    marginBlockStart: { default: 14, [bp.wide]: 0 },
    marginInline: { default: 10, [bp.wide]: 0 },
  },
  cell: {
    display: "flex",
    flexDirection: "column",
    gap: { default: 6, [bp.wide]: u(0.35) },
    paddingBlock: { default: 12, [bp.wide]: u(0.8) },
    paddingInline: { default: 12, [bp.wide]: u(1.5) },
    borderInlineStart: { default: "2px solid #13095E", [bp.wide]: `${"0.14vw"} solid #13095E` },
    color: color.ink,
    textDecoration: "none",
    minHeight: { default: 0, [bp.wide]: u(11.9) },
    backgroundColor: { default: "transparent", ":hover": "rgba(163,165,249,0.28)" },
  },
  cellHead: { display: "flex", alignItems: "flex-end", gap: { default: 8, [bp.wide]: u(0.9) } },
  mark: {
    imageRendering: "pixelated",
    height: { default: 30, [bp.wide]: u(3.9) },
    width: "auto",
    maxWidth: { default: 56, [bp.wide]: u(6.2) },
    flex: "none",
  },
  cellName: {
    fontSize: { default: "clamp(26px, 7.4vw, 36px)", [bp.wide]: u(3.15) },
    lineHeight: 0.9,
    fontStretch: "70%",
    textTransform: "none",
  },
  cellText: {
    fontSize: { default: 16, [bp.wide]: "max(16px, calc(var(--u) * 1.2))" },
    lineHeight: 1.35,
    fontWeight: 500,
  },
  rule: {
    height: { default: 4, [bp.wide]: u(0.26) },
    width: { default: 56, [bp.wide]: u(6.4) },
    marginBlockStart: "auto",
  },
  ruleM: { backgroundColor: color.magenta },
  ruleC: { backgroundColor: color.cyan },
  /* release band */
  band: {
    position: { default: "relative", [bp.wide]: "absolute" },
    zIndex: 3,
    left: { default: 0, [bp.wide]: u(34.5) },
    right: 0,
    bottom: 0,
    height: { default: "auto", [bp.wide]: u(5.9) },
    marginBlockStart: { default: 20, [bp.wide]: 0 },
    backgroundColor: color.ink,
    color: color.paper,
    clipPath: { default: "none", [bp.wide]: "polygon(1.4% 0, 100% 0, 100% 100%, 0 100%)" },
    display: "flex",
    flexDirection: { default: "column", [bp.wide]: "row" },
    alignItems: { default: "flex-start", [bp.wide]: "center" },
    gap: { default: 8, [bp.wide]: u(2.2) },
    paddingInline: { default: 18, [bp.wide]: u(3.4) },
    paddingBlock: { default: 22, [bp.wide]: 0 },
    fontFamily: type.face,
    fontStretch: "70%",
    fontStyle: "italic",
    fontWeight: 700,
    textTransform: "uppercase",
    fontSize: { default: 18, [bp.wide]: "max(15px, calc(var(--u) * 1.4))" },
    letterSpacing: "0.02em",
    boxShadow: "inset 0 -0.6vw 0 -0.45vw #A3A5F9",
  },
  bandVersion: {
    fontStretch: "110%",
    fontWeight: 900,
    fontSize: { default: 34, [bp.wide]: u(2.7) },
    lineHeight: 1,
  },
  bandStripes: {
    fontSize: { default: 10, [bp.wide]: u(0.95) },
    display: { default: "none", [bp.wide]: "flex" },
  },
  bandText: { color: color.periSoft },
})

const parts = [
  {
    id: "architect",
    name: "Architect",
    text: "Scopes the plan, settles open questions, and integrates verified work.",
    mark: sparkle,
    rule: c.ruleM,
  },
  {
    id: "scheduler",
    name: "Scheduler",
    text: "Dispatches specialist workers in isolated git worktrees.",
    mark: flag,
    rule: c.ruleC,
  },
  {
    id: "radar",
    name: "Radar",
    text: "Streams every active worker, tool call, and state transition live.",
    mark: corner,
    rule: c.ruleC,
  },
  {
    id: "trajectory",
    name: "Trajectory",
    text: "Preserves every attempt, check output, diff, and token count.",
    mark: stripesMark,
    rule: c.ruleM,
  },
] as const

const LEDE =
  "LAZERS turns OpenCode from a single chat thread into a managed engineering loop. Describe what you want to ship: Architect maps the repo, settles open questions, and defines acceptance checks up front. The runtime dispatches specialist workers in isolated worktrees, runs the verification suite, and integrates the finished code."

export function Cover() {
  const kit = useBeamKit("cover", 3, 16)
  const box = useRef<HTMLDivElement>(null)
  const source = useRef<HTMLParagraphElement>(null)
  const lines = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let undo = () => {}
    let dead = false
    enhanceLede({
      box: box.current!,
      source: source.current!,
      lines: lines.current!,
      catFrame: kit.rest.current!,
    }).then(
      (u) => (dead ? u() : (undo = u)),
      () => {},
    )
    return () => {
      dead = true
      undo()
    }
  }, [])

  return (
    <header ref={kit.section} id="top" {...stylex.props(c.cover)}>
      <Field kit={kit} sx={c.fieldTop} amp={8}>
        <div {...stylex.props(c.dots, c.dotsTop)} />
      </Field>
      <Field kit={kit} sx={c.fieldCat} amp={10}>
        <div {...stylex.props(c.dots, c.dotsCat)} />
      </Field>

      <h1 tabIndex={-1} {...stylex.props(c.wordmark)}>
        <span aria-hidden="true" {...stylex.props(c.wmLayer, c.wmOuter)}>
          Lazers
        </span>
        <span aria-hidden="true" {...stylex.props(c.wmLayer, c.wmGap)}>
          Lazers
        </span>
        <span {...stylex.props(c.wmLayer, c.wmFill)}>Lazers</span>
        <span style={srOnly}>: an OpenCode plugin for tracked work</span>
      </h1>

      <div {...stylex.props(c.slab)}>
        <nav aria-label="Primary" {...stylex.props(c.nav)}>
          <a href={links.docs} {...stylex.props(c.navLink)}>
            Docs
          </a>
          <a href={links.github} {...stylex.props(c.navLink)}>
            GitHub
          </a>
          <a href="#install" {...stylex.props(c.navLink)}>
            Install
          </a>
        </nav>
        <p {...stylex.props(c.tagline)}>
          <Stripes sx={c.taglineStripes} />
          <span>
            An OpenCode
            <br />
            plugin for
            <br />
            tracked work
          </span>
        </p>
      </div>

      <div {...stylex.props(c.catZone)}>
        <Cat kit={kit} sx={c.cat} />
        <a href="#install" {...stylex.props(c.install)}>
          <span aria-hidden="true" {...stylex.props(c.plateShadow)} />
          <span aria-hidden="true" {...stylex.props(c.plate)} />
          <span {...stylex.props(c.installLabel)}>
            Install
            <svg viewBox="0 0 30 20" aria-hidden="true" {...stylex.props(c.arrow)}>
              <path d="M0 7h18V1l12 9-12 9v-6H0z" fill="currentColor" />
            </svg>
          </span>
          <span aria-hidden="true" {...stylex.props(c.ticks, c.ticksL)}>
            <i {...stylex.props(c.tick)} style={{ top: "-0.9em", transform: "rotate(-30deg)" }} />
            <i {...stylex.props(c.tick)} style={{ top: "0.2em" }} />
            <i {...stylex.props(c.tick)} style={{ top: "1.3em", transform: "rotate(30deg)" }} />
          </span>
          <span aria-hidden="true" {...stylex.props(c.ticks, c.ticksR)}>
            <i {...stylex.props(c.tick)} style={{ top: "-0.9em", transform: "rotate(30deg)" }} />
            <i {...stylex.props(c.tick)} style={{ top: "0.2em" }} />
            <i {...stylex.props(c.tick)} style={{ top: "1.3em", transform: "rotate(-30deg)" }} />
          </span>
        </a>
      </div>
      <BeamCanvas kit={kit} />

      <div {...stylex.props(c.head)}>
        <h2 {...stylex.props(t.display, c.headText)}>
          <span {...stylex.props(c.headLine)}>Feature</span>
          <span {...stylex.props(c.headLine)}>request in.</span>
          <span {...stylex.props(c.headLine)}>Tracked</span>
          <span {...stylex.props(c.headLine)}>work out.</span>
        </h2>
        <Stripes sx={c.headStripes} />
      </div>

      <div {...stylex.props(c.ledeWrap)}>
        <div ref={box} {...stylex.props(c.ledeBox)}>
          <p ref={source} {...stylex.props(c.lede)}>
            {LEDE}
          </p>
          <div ref={lines} aria-hidden="true" {...stylex.props(c.ledeLines)} />
        </div>
      </div>

      <nav aria-label="The four parts" {...stylex.props(c.contents)}>
        {parts.map((p) => (
          <a key={p.id} href={`#${p.id}`} {...stylex.props(c.cell)}>
            <span {...stylex.props(c.cellHead)}>
              <img src={p.mark} alt="" {...stylex.props(c.mark)} />
              <span {...stylex.props(t.display, c.cellName)}>{p.name}</span>
            </span>
            <span {...stylex.props(c.cellText)}>{p.text}</span>
            <span aria-hidden="true" {...stylex.props(c.rule, p.rule)} />
          </a>
        ))}
      </nav>

      <p {...stylex.props(c.band)}>
        <span {...stylex.props(c.bandVersion)}>v0.1.0</span>
        <Stripes sx={c.bandStripes} />
        <span {...stylex.props(c.bandText)}>Tested with OpenCode Desktop 2.2.6</span>
        <span {...stylex.props(c.bandText)}>Runs inside OpenCode. No separate service.</span>
      </p>
    </header>
  )
}
