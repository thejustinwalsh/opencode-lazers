import * as stylex from "@stylexjs/stylex"
import type { ComponentChildren } from "preact"
import { useState } from "preact/hooks"
import corner from "./assets/mark-corner.png"
import flag from "./assets/mark-flag.png"
import sparkle from "./assets/mark-sparkle.png"
import stripesMark from "./assets/mark-stripes.png"
import { bp, color, type } from "./tokens.stylex"
import { BeamCanvas, Cat, Field, Stripes, links, srOnly, t, useBeamKit } from "./ui"

/* Scroll-driven transitions read --p (0..1 section entry progress, set from Lenis scroll).
   Every rule falls back to the finished state, so reduced motion and no-JS read complete. */
const P = "var(--p, 1)"
const fx = stylex.create({
  growX: { transform: `scaleX(${P})`, transformOrigin: "left center" },
})

const s = stylex.create({
  section: {
    position: "relative",
    isolation: "isolate",
    overflow: "clip",
    backgroundColor: color.paper,
    color: color.ink,
    paddingInline: "clamp(18px, 4vw, 64px)",
    paddingBlockStart: "clamp(72px, 9vw, 140px)",
    paddingBlockEnd: "clamp(64px, 8vw, 128px)",
  },
  inner: {
    position: "relative",
    zIndex: 3,
    maxWidth: 1360,
    marginInline: "auto",
  },
  /* Seam: an ink rule with signal stripes that prints across as the section enters. */
  seam: {
    position: "absolute",
    zIndex: 3,
    top: 0,
    left: 0,
    right: 0,
    height: "clamp(14px, 1.4vw, 22px)",
    pointerEvents: "none",
    display: "grid",
    gridTemplateRows: "1fr auto",
    gap: 3,
  },
  seamInk: {
    backgroundColor: color.ink,
    clipPath: `polygon(0 0, calc(${P} * 100% + 2vw) 0, calc(${P} * 100%) 100%, 0 100%)`,
  },
  seamSignal: {
    height: 4,
    backgroundImage:
      "linear-gradient(90deg, #F81497 0 22%, transparent 22% 24%, #19EBF1 24% 40%, transparent 40%)",
    transform: `scaleX(${P})`,
    transformOrigin: "left center",
  },
  seamOnInk: { backgroundColor: color.peri },
  h2: {
    fontSize: "clamp(44px, 6.6vw, 96px)",
    color: color.ink,
    transform: "rotate(-2deg)",
    transformOrigin: "left bottom",
  },
  h2Wrap: { display: "flex", alignItems: "flex-end", gap: "clamp(12px, 1.6vw, 24px)" },
  h2Stripes: { fontSize: "clamp(9px, 1vw, 14px)", marginBlockEnd: "0.8em", flex: "none" },
  lead: {
    fontSize: "clamp(18px, 1.45vw, 22px)",
    lineHeight: 1.5,
    fontWeight: 500,
    maxWidth: "40ch",
    textWrap: "pretty",
  },
  body: { fontSize: "clamp(16px, 1.15vw, 18px)", lineHeight: 1.6, maxWidth: "62ch" },
  code: {
    fontFamily: type.mono,
    fontSize: "0.88em",
    fontStyle: "normal",
    backgroundColor: color.ink,
    color: color.paper,
    paddingInline: "0.4em",
    paddingBlock: "0.08em",
    whiteSpace: "nowrap",
  },
  strong: { fontWeight: 750 },
  dots: {
    width: "100%",
    height: "100%",
    backgroundImage: "radial-gradient(circle, #A3A5F9 0 34%, transparent 39%)",
    backgroundSize: "9px 9px",
  },
  dotsFade: {
    maskImage: "linear-gradient(35deg, #000 15%, transparent 70%)",
    WebkitMaskImage: "linear-gradient(35deg, #000 15%, transparent 70%)",
  },
})

function Seam({ onInk = false }: { onInk?: boolean }) {
  return (
    <div aria-hidden="true" {...stylex.props(s.seam)}>
      <div {...stylex.props(s.seamInk, onInk && s.seamOnInk)} />
      <div {...stylex.props(s.seamSignal)} />
    </div>
  )
}

function Heading({ id, children }: { id: string; children: ComponentChildren }) {
  return (
    <div {...stylex.props(s.h2Wrap)}>
      <h2 id={id} tabIndex={-1} {...stylex.props(t.display, s.h2)}>
        {children}
      </h2>
      <Stripes sx={s.h2Stripes} />
    </div>
  )
}

const Code = ({ children }: { children: string }) => (
  <code {...stylex.props(s.code)}>{children}</code>
)

/* ================================================================== */
/* The loop: how the four parts fit together                           */
/* ================================================================== */
const lp = stylex.create({
  top: {
    display: "grid",
    gridTemplateColumns: { default: "1fr", [bp.wide]: "7fr 5fr" },
    gap: { default: 24, [bp.wide]: "4vw" },
    alignItems: "end",
  },
  topCopy: {
    display: "grid",
    gap: 16,
    borderInlineStart: { default: "none", [bp.wide]: "3px solid #13095E" },
    paddingInlineStart: { default: 0, [bp.wide]: "2vw" },
  },
  track: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: { default: "1fr", [bp.wide]: "repeat(4, 1fr)" },
    columnGap: "5vw",
    rowGap: 46,
    marginBlockStart: "clamp(48px, 6vw, 96px)",
  },
  station: { position: "relative", display: "grid", alignContent: "start", gap: 10 },
  plate: {
    position: "relative",
    display: "grid",
    alignContent: "end",
    minHeight: "clamp(104px, 9vw, 140px)",
    paddingInline: "clamp(16px, 1.5vw, 24px)",
    paddingBlock: "clamp(12px, 1vw, 16px)",
    color: color.paper,
  },
  plateBg: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    backgroundColor: color.ink,
    transform: "skewX(-8deg)",
    boxShadow: "6px 8px 0 #A3A5F9",
  },
  plateYou: { backgroundColor: color.magenta, boxShadow: "6px 8px 0 #13095E" },
  name: { fontSize: "clamp(34px, 3.2vw, 50px)", textTransform: "none" },
  verb: {
    fontFamily: type.face,
    fontStretch: "75%",
    fontStyle: "italic",
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    fontSize: "clamp(14px, 1.05vw, 16px)",
    color: color.cyan,
  },
  verbYou: { color: color.paper },
  detail: { fontSize: "clamp(15px, 1.05vw, 17px)", lineHeight: 1.5, paddingInlineEnd: "1vw" },
  /* connectors between stations */
  link: {
    position: "absolute",
    display: "flex",
    alignItems: "center",
    pointerEvents: "none",
    top: { default: "auto", [bp.wide]: "clamp(44px, 4vw, 62px)" },
    bottom: { default: -40, [bp.wide]: "auto" },
    left: { default: 22, [bp.wide]: "calc(100% + 0.6vw)" },
    width: { default: 34, [bp.wide]: "3.8vw" },
    height: { default: 34, [bp.wide]: 14 },
    transform: { default: "rotate(90deg)", [bp.wide]: "none" },
  },
  shaft: { flex: 1, height: 6, backgroundColor: color.ink },
  head: {
    width: 14,
    height: 14,
    backgroundColor: color.ink,
    clipPath: "polygon(0 0, 100% 50%, 0 100%)",
  },
  /* the return lane */
  back: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    alignItems: "center",
    gap: 0,
    marginBlockStart: "clamp(40px, 4vw, 64px)",
  },
  backHead: {
    width: 18,
    height: 22,
    backgroundColor: color.magenta,
    clipPath: "polygon(100% 0, 0 50%, 100% 100%)",
  },
  backShaft: { height: 6, backgroundColor: color.magenta },
  backText: {
    marginBlockStart: 14,
    fontSize: "clamp(16px, 1.2vw, 19px)",
    lineHeight: 1.55,
    maxWidth: "72ch",
  },
  /* observers: Radar and Trajectory sit across every lane */
  observers: {
    display: "grid",
    gridTemplateColumns: { default: "1fr", [bp.mid]: "1fr 1fr" },
    gap: { default: 18, [bp.mid]: "3vw" },
    marginBlockStart: "clamp(40px, 5vw, 72px)",
  },
  observer: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    gap: "clamp(12px, 1.4vw, 20px)",
    alignItems: "center",
    paddingBlock: "clamp(14px, 1.4vw, 20px)",
    paddingInline: "clamp(14px, 1.6vw, 24px)",
    backgroundColor: "rgba(163,165,249,0.26)",
    borderBlockStart: "3px solid #13095E",
  },
  obsMark: { height: "clamp(34px, 3vw, 46px)", width: "auto", imageRendering: "pixelated" },
  obsName: { fontSize: "clamp(26px, 2.2vw, 34px)", textTransform: "none" },
  obsText: { fontSize: "clamp(15px, 1.05vw, 17px)", lineHeight: 1.45 },
  cat: {
    left: { default: "-16vw", [bp.wide]: "-4vw" },
    bottom: { default: "-6vw", [bp.wide]: "-3vw" },
    width: { default: "44vw", [bp.wide]: "15vw" },
    height: { default: "42vw", [bp.wide]: "14.4vw" },
  },
  field: { left: 0, bottom: 0, width: "40vw", height: "26vw" },
  /* Leave the peeking cat its own band so it never sits under copy. */
  section: { paddingBlockEnd: { default: "40vw", [bp.wide]: "13vw" } },
})

const stations = [
  {
    name: "You",
    verb: "Request and review",
    detail: "Describe the behavior and its limits. You review the result and decide what ships.",
    you: true,
  },
  {
    name: "Architect",
    verb: "Plan and decide",
    detail: "Reads the repository, settles the questions that matter and defines acceptance.",
    you: false,
  },
  {
    name: "Scheduler",
    verb: "Admit and schedule",
    detail: "The runtime admits the plan, resolves workers and dispatches eligible tasks.",
    you: false,
  },
  {
    name: "Worker",
    verb: "Implement and report",
    detail: "A native OpenCode session does the task, runs its checks and reports evidence.",
    you: false,
  },
] as const

export function Loop() {
  const kit = useBeamKit("loop", 1, 12)
  return (
    <section
      ref={kit.section}
      id="loop"
      aria-labelledby="loop-title"
      {...stylex.props(s.section, lp.section)}
    >
      <Seam />
      <Field kit={kit} sx={lp.field} amp={6}>
        <div {...stylex.props(s.dots, s.dotsFade)} />
      </Field>
      <Cat kit={kit} sx={lp.cat} />
      <BeamCanvas kit={kit} />
      <div {...stylex.props(s.inner)}>
        <div {...stylex.props(lp.top)}>
          <Heading id="loop-title">Judgment and state live apart</Heading>
          <div {...stylex.props(lp.topCopy)}>
            <p {...stylex.props(s.lead)}>
              Architect makes the calls that need context. The runtime owns scheduling and every
              lifecycle transition.
            </p>
            <p {...stylex.props(s.body)}>
              Routine transitions do not call a model, so a retry or a queued task never waits on
              one.
            </p>
          </div>
        </div>

        <ol aria-label="How a request moves" {...stylex.props(lp.track)}>
          {stations.map((st, i) => (
            <li key={st.name} {...stylex.props(lp.station)}>
              <div {...stylex.props(lp.plate)}>
                <span aria-hidden="true" {...stylex.props(lp.plateBg, st.you && lp.plateYou)} />
                <span {...stylex.props(lp.verb, st.you && lp.verbYou)}>{st.verb}</span>
                <h3 {...stylex.props(t.display, lp.name)}>{st.name}</h3>
              </div>
              <p {...stylex.props(lp.detail)}>{st.detail}</p>
              {i < stations.length - 1 && (
                <span aria-hidden="true" {...stylex.props(lp.link)}>
                  <span {...stylex.props(lp.shaft, fx.growX)} />
                  <span {...stylex.props(lp.head)} />
                </span>
              )}
            </li>
          ))}
        </ol>

        <div aria-hidden="true" {...stylex.props(lp.back)}>
          <span {...stylex.props(lp.backHead)} />
          <span {...stylex.props(lp.backShaft, fx.growX)} />
        </div>
        <p {...stylex.props(lp.backText)}>
          <strong {...stylex.props(s.strong)}>Results travel back the same way.</strong> The runtime
          runs the required checks and records evidence. Architect reviews and chooses repair, retry
          or replanning when new evidence needs judgment. Then the work returns to you.
        </p>

        <div {...stylex.props(lp.observers)}>
          <a href="#radar" {...stylex.props(lp.observer, t.inkLink)}>
            <img src={corner} alt="" {...stylex.props(lp.obsMark)} />
            <span>
              <span {...stylex.props(t.display, lp.obsName)}>Radar</span>
              <span {...stylex.props(lp.obsText)}> watches every lane while it runs.</span>
            </span>
          </a>
          <a href="#trajectory" {...stylex.props(lp.observer, t.inkLink)}>
            <img src={stripesMark} alt="" {...stylex.props(lp.obsMark)} />
            <span>
              <span {...stylex.props(t.display, lp.obsName)}>Trajectory</span>
              <span {...stylex.props(lp.obsText)}> keeps what each attempt did.</span>
            </span>
          </a>
        </div>
      </div>
    </section>
  )
}

/* ================================================================== */
/* Feature spreads                                                      */
/* ================================================================== */
const pt = stylex.create({
  grid: {
    display: "grid",
    gridTemplateColumns: { default: "1fr", [bp.wide]: "repeat(12, 1fr)" },
    columnGap: "3vw",
    rowGap: { default: 56, [bp.wide]: "5vw" },
    marginBlockStart: "clamp(40px, 5vw, 80px)",
  },
  spread: {
    position: "relative",
    display: "grid",
    alignContent: "start",
    gap: 18,
    paddingBlockStart: 20,
    borderBlockStart: "3px solid #13095E",
  },
  wideL: { gridColumn: { default: "auto", [bp.wide]: "1 / span 7" } },
  narrowR: { gridColumn: { default: "auto", [bp.wide]: "9 / span 4" } },
  narrowL: { gridColumn: { default: "auto", [bp.wide]: "1 / span 4" } },
  wideR: { gridColumn: { default: "auto", [bp.wide]: "6 / span 7" } },
  rule: {
    display: { default: "none", [bp.wide]: "block" },
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: color.ink,
  },
  ruleR: { left: "-1.5vw" },
  ruleL: { right: "-1.5vw" },
  nameRow: { display: "flex", alignItems: "flex-end", gap: 14 },
  mark: {
    height: "clamp(36px, 3.4vw, 54px)",
    width: "auto",
    imageRendering: "pixelated",
    flex: "none",
  },
  name: { fontSize: "clamp(46px, 5.4vw, 84px)", textTransform: "none" },
  deck: {
    fontFamily: type.face,
    fontStretch: "88%",
    fontWeight: 800,
    fontSize: "clamp(22px, 2vw, 30px)",
    lineHeight: 1.15,
    maxWidth: "26ch",
    textWrap: "balance",
  },
  rule2: { height: 5, width: "clamp(56px, 6vw, 96px)" },
  ruleM: { backgroundColor: color.magenta },
  ruleC: { backgroundColor: color.cyan },
  /* Architect: the example request, set as a pull quote */
  quote: {
    position: "relative",
    marginBlockStart: 8,
    paddingBlock: "clamp(18px, 1.6vw, 26px)",
    paddingInline: "clamp(18px, 2vw, 32px)",
    backgroundColor: color.ink,
    color: color.paper,
    fontFamily: type.face,
    fontStretch: "92%",
    fontStyle: "italic",
    fontWeight: 600,
    fontSize: "clamp(19px, 1.6vw, 24px)",
    lineHeight: 1.4,
    maxWidth: "40ch",
    boxShadow: "8px 10px 0 #F81497",
  },
  quoteCite: {
    display: "block",
    marginBlockStart: 12,
    fontStyle: "normal",
    fontWeight: 700,
    fontStretch: "75%",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    fontSize: 14,
    color: color.cyan,
  },
  /* Scheduler: the real task-state filters */
  states: { display: "flex", flexWrap: "wrap", gap: 8 },
  state: {
    fontFamily: type.face,
    fontStretch: "75%",
    fontStyle: "italic",
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    fontSize: 15,
    paddingInline: 10,
    paddingBlock: 4,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: color.ink,
  },
  stateLive: { backgroundColor: color.ink, color: color.paper },
  stateDone: { backgroundColor: color.cyan },
  stateBad: { backgroundColor: color.magenta, color: color.paper, borderColor: color.magenta },
  /* Radar: fields and scopes as a spec table */
  spec: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: 18,
    rowGap: 0,
    fontSize: "clamp(15px, 1.05vw, 17px)",
  },
  specTerm: {
    fontFamily: type.face,
    fontStretch: "75%",
    fontStyle: "italic",
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    paddingBlock: 9,
    borderBlockEnd: "2px solid #A3A5F9",
  },
  specDef: { paddingBlock: 9, borderBlockEnd: "2px solid #A3A5F9", lineHeight: 1.45 },
  /* Trajectory: task -> attempts -> checks */
  tree: { display: "grid", gap: 10, fontSize: "clamp(15px, 1.05vw, 17px)" },
  treeRow: { display: "grid", gridTemplateColumns: "auto 1fr", gap: 14, alignItems: "baseline" },
  treeKey: {
    fontFamily: type.face,
    fontStretch: "75%",
    fontStyle: "italic",
    fontWeight: 900,
    textTransform: "uppercase",
    fontSize: 15,
    minWidth: "6.5em",
    paddingInline: 8,
    paddingBlock: 3,
    backgroundColor: color.peri,
    color: color.ink,
  },
  indent1: { marginInlineStart: "1.5em" },
  indent2: { marginInlineStart: "3em" },
  cat: {
    left: { default: "-14vw", [bp.wide]: "-3.6vw" },
    top: { default: "auto", [bp.wide]: "46%" },
    bottom: { default: "-4vw", [bp.wide]: "auto" },
    width: { default: "36vw", [bp.wide]: "10.5vw" },
    height: { default: "34vw", [bp.wide]: "10vw" },
  },
  field: { right: 0, top: 0, width: "34vw", height: "22vw" },
  section: { paddingBlockEnd: { default: "33vw", [bp.wide]: "clamp(64px, 8vw, 128px)" } },
  dotsTR: {
    maskImage: "linear-gradient(215deg, #000 10%, transparent 65%)",
    WebkitMaskImage: "linear-gradient(215deg, #000 10%, transparent 65%)",
  },
})

export function Parts() {
  const kit = useBeamKit("parts", 1, 10)
  return (
    <section
      ref={kit.section}
      id="parts"
      aria-labelledby="parts-title"
      {...stylex.props(s.section, pt.section)}
    >
      <Seam />
      <Field kit={kit} sx={pt.field} amp={6}>
        <div {...stylex.props(s.dots, pt.dotsTR)} />
      </Field>
      <Cat kit={kit} sx={pt.cat} />
      <BeamCanvas kit={kit} />
      <div {...stylex.props(s.inner)}>
        <Heading id="parts-title">Four parts, one record</Heading>

        <div {...stylex.props(pt.grid)}>
          <article
            id="architect"
            aria-labelledby="architect-title"
            {...stylex.props(pt.spread, pt.wideL)}
          >
            <span aria-hidden="true" {...stylex.props(pt.rule, pt.ruleL)} />
            <div {...stylex.props(pt.nameRow)}>
              <img src={sparkle} alt="" {...stylex.props(pt.mark)} />
              <h3 id="architect-title" tabIndex={-1} {...stylex.props(t.display, pt.name)}>
                Architect
              </h3>
            </div>
            <p {...stylex.props(pt.deck)}>Asks before it guesses.</p>
            <span aria-hidden="true" {...stylex.props(pt.rule2, pt.ruleM)} />
            <p {...stylex.props(s.body)}>
              Select <strong {...stylex.props(s.strong)}>Architect</strong> from OpenCode
              Desktop&rsquo;s agent list and describe one change with its expected result. It
              inspects the project and asks a focused question only when a missing choice changes
              requirements, scope, acceptance or checks. One task covers one coherent change; a plan
              can split independent work and record its dependencies.
            </p>
            <blockquote {...stylex.props(pt.quote)}>
              &ldquo;Add a clear empty state to a list. Show &lsquo;No tasks yet.&rsquo; Keep the
              existing actions. Add a focused behavior check.&rdquo;
              <cite {...stylex.props(pt.quoteCite)}>A first request, from the tutorial</cite>
            </blockquote>
          </article>

          <article
            id="scheduler"
            aria-labelledby="scheduler-title"
            {...stylex.props(pt.spread, pt.narrowR)}
          >
            <span aria-hidden="true" {...stylex.props(pt.rule, pt.ruleR)} />
            <div {...stylex.props(pt.nameRow)}>
              <img src={flag} alt="" {...stylex.props(pt.mark)} />
              <h3 id="scheduler-title" tabIndex={-1} {...stylex.props(t.display, pt.name)}>
                Scheduler
              </h3>
            </div>
            <p {...stylex.props(pt.deck)}>Parallel where it is safe. Serial where it must be.</p>
            <span aria-hidden="true" {...stylex.props(pt.rule2, pt.ruleC)} />
            <p {...stylex.props(s.body)}>
              Independent tasks can run in OpenCode-managed worktrees. Conflicting write scopes
              serialize. Verification timeouts come from your configuration, and task and attempt
              history survive retries.
            </p>
            <p {...stylex.props(s.body)}>
              Follow it in <strong {...stylex.props(s.strong)}>Tasks</strong>, or run{" "}
              <Code>/lz-tasks</Code>. The panel offers Start only when a plan can start under the
              runtime&rsquo;s rules.
            </p>
            <ul aria-label="Task state filters" {...stylex.props(pt.states)}>
              <li {...stylex.props(pt.state)}>Open</li>
              <li {...stylex.props(pt.state)}>Queued</li>
              <li {...stylex.props(pt.state, pt.stateLive)}>Running</li>
              <li {...stylex.props(pt.state)}>Blocked</li>
              <li {...stylex.props(pt.state)}>Paused</li>
              <li {...stylex.props(pt.state, pt.stateDone)}>Completed</li>
              <li {...stylex.props(pt.state, pt.stateBad)}>Failed</li>
              <li {...stylex.props(pt.state)}>Cancelled</li>
            </ul>
          </article>

          <article
            id="radar"
            aria-labelledby="radar-title"
            {...stylex.props(pt.spread, pt.narrowL)}
          >
            <span aria-hidden="true" {...stylex.props(pt.rule, pt.ruleL)} />
            <div {...stylex.props(pt.nameRow)}>
              <img src={corner} alt="" {...stylex.props(pt.mark)} />
              <h3 id="radar-title" tabIndex={-1} {...stylex.props(t.display, pt.name)}>
                Radar
              </h3>
            </div>
            <p {...stylex.props(pt.deck)}>Every session, live.</p>
            <span aria-hidden="true" {...stylex.props(pt.rule2, pt.ruleC)} />
            <p {...stylex.props(s.body)}>
              Open it from the session panel menu or run <Code>/lz-radar</Code>. Select a session,
              call or event to inspect it, then jump to its worker, task or trajectory.
            </p>
            <dl {...stylex.props(pt.spec)}>
              <dt {...stylex.props(pt.specTerm)}>Shows</dt>
              <dd {...stylex.props(pt.specDef)}>
                Role, task, model and effort; current tool calls with targets and durations; recent
                model and tool events
              </dd>
              <dt {...stylex.props(pt.specTerm)}>Scope</dt>
              <dd {...stylex.props(pt.specDef)}>This session, Project, Project · all sessions</dd>
              <dt {...stylex.props(pt.specTerm)}>Diagnostics</dt>
              <dd {...stylex.props(pt.specDef)}>The Map and Flow state chart</dd>
            </dl>
          </article>

          <article
            id="trajectory"
            aria-labelledby="trajectory-title"
            {...stylex.props(pt.spread, pt.wideR)}
          >
            <span aria-hidden="true" {...stylex.props(pt.rule, pt.ruleR)} />
            <div {...stylex.props(pt.nameRow)}>
              <img src={stripesMark} alt="" {...stylex.props(pt.mark)} />
              <h3 id="trajectory-title" tabIndex={-1} {...stylex.props(t.display, pt.name)}>
                Trajectory
              </h3>
            </div>
            <p {...stylex.props(pt.deck)}>The record of what was tried.</p>
            <span aria-hidden="true" {...stylex.props(pt.rule2, pt.ruleM)} />
            <p {...stylex.props(s.body)}>
              Run <Code>/lz-trajectory</Code> and choose a task and scope. Select an attempt or a
              check to inspect its details. Task links in the other LAZERS panels open the matching
              trajectory, so a failed check in Tasks is one click from its history.
            </p>
            <ul aria-label="What a trajectory holds" {...stylex.props(pt.tree)}>
              <li {...stylex.props(pt.treeRow)}>
                <span {...stylex.props(pt.treeKey)}>Task</span>
                <span>Objective, dependencies and the plan it belongs to</span>
              </li>
              <li {...stylex.props(pt.treeRow, pt.indent1)}>
                <span {...stylex.props(pt.treeKey)}>Attempt</span>
                <span>Each try, kept across retries</span>
              </li>
              <li {...stylex.props(pt.treeRow, pt.indent2)}>
                <span {...stylex.props(pt.treeKey)}>Check</span>
                <span>What ran and what it found</span>
              </li>
              <li {...stylex.props(pt.treeRow, pt.indent2)}>
                <span {...stylex.props(pt.treeKey)}>Usage</span>
                <span>Recorded tokens; missing usage stays unknown</span>
              </li>
            </ul>
          </article>
        </div>
      </div>
    </section>
  )
}

/* ================================================================== */
/* Done means checked (+ Models)                                        */
/* ================================================================== */
const ck = stylex.create({
  section: {
    backgroundColor: color.ink,
    color: color.paper,
    paddingBlockEnd: { default: "30vw", [bp.wide]: "clamp(64px, 8vw, 128px)" },
  },
  h2: { color: color.paper },
  grid: {
    display: "grid",
    gridTemplateColumns: { default: "1fr", [bp.wide]: "7fr 5fr" },
    gap: { default: 48, [bp.wide]: "5vw" },
    marginBlockStart: "clamp(32px, 4vw, 64px)",
  },
  statement: {
    fontFamily: type.face,
    fontStretch: "70%",
    fontStyle: "italic",
    fontWeight: 900,
    textTransform: "uppercase",
    fontSize: "clamp(38px, 4.6vw, 72px)",
    lineHeight: 0.95,
    color: color.cyan,
    maxWidth: "12ch",
    textWrap: "balance",
  },
  copy: { display: "grid", gap: 18, marginBlockStart: 28, color: color.periSoft },
  side: {
    display: "grid",
    alignContent: "start",
    gap: 16,
    paddingBlockStart: 20,
    borderBlockStart: "3px solid #A3A5F9",
  },
  sideName: { fontSize: "clamp(40px, 4vw, 60px)", textTransform: "none", color: color.paper },
  sideBody: { color: color.periSoft },
  levels: { display: "grid", gap: 0 },
  level: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    paddingBlock: 9,
    borderBlockEnd: "2px solid rgba(163,165,249,0.4)",
    fontSize: 16,
  },
  levelKey: {
    fontFamily: type.face,
    fontStretch: "75%",
    fontStyle: "italic",
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    color: color.paper,
  },
  code: { backgroundColor: color.magenta, color: color.paper },
  note: { fontSize: 15, lineHeight: 1.5, color: color.peri },
  cat: {
    left: { default: "auto", [bp.wide]: "auto" },
    right: { default: "-10vw", [bp.wide]: "-1.4vw" },
    bottom: { default: "-5vw", [bp.wide]: "-2vw" },
    width: { default: "34vw", [bp.wide]: "9vw" },
    height: { default: "32vw", [bp.wide]: "8.6vw" },
  },
})

export function Checked() {
  const kit = useBeamKit("checked", 1, 8)
  return (
    <section
      ref={kit.section}
      id="checked"
      aria-labelledby="checked-title"
      {...stylex.props(s.section, ck.section)}
    >
      <Seam onInk />
      <Cat kit={kit} sx={ck.cat} />
      <BeamCanvas kit={kit} />
      <div {...stylex.props(s.inner)}>
        <div {...stylex.props(s.h2Wrap)}>
          <h2 id="checked-title" tabIndex={-1} {...stylex.props(t.display, s.h2, ck.h2)}>
            Done means checked
          </h2>
          <Stripes sx={s.h2Stripes} />
        </div>
        <div {...stylex.props(ck.grid)}>
          <div>
            <p {...stylex.props(ck.statement)}>A worker report is not acceptance.</p>
            <div {...stylex.props(ck.copy)}>
              <p {...stylex.props(s.lead)}>
                Acceptance records whether the task meets its checks and decisions. Architect
                reviews accepted work and handles integration.
              </p>
              <p {...stylex.props(s.body)}>
                LAZERS does not merge or publish a change because a worker says it is done. OpenCode
                permissions still govern every tool call and workspace, and you decide when the
                result goes out.
              </p>
            </div>
          </div>
          <aside aria-labelledby="models-title" {...stylex.props(ck.side)}>
            <h3 id="models-title" {...stylex.props(t.display, ck.sideName)}>
              Models
            </h3>
            <p {...stylex.props(s.body, ck.sideBody)}>
              Run <code {...stylex.props(s.code, ck.code)}>/lz-models</code> to set the provider,
              model and optional effort for the UI, Systems and Small task / refactoring personas.
            </p>
            <ul aria-label="Assignment levels" {...stylex.props(ck.levels)}>
              <li {...stylex.props(ck.level)}>
                <span {...stylex.props(ck.levelKey)}>Shared default</span>
                <span>every project</span>
              </li>
              <li {...stylex.props(ck.level)}>
                <span {...stylex.props(ck.levelKey)}>Project override</span>
                <span>this project</span>
              </li>
              <li {...stylex.props(ck.level)}>
                <span {...stylex.props(ck.levelKey)}>Task override</span>
                <span>one task</span>
              </li>
            </ul>
            <p {...stylex.props(s.body, ck.sideBody)}>
              Compare shows task histories, measured usage and configured price evidence. Missing
              usage or prices stay unknown, and a price lookup never starts inference.
            </p>
            <p {...stylex.props(ck.note)}>
              Local WebGPU inference is optional and off by default. The task workflow uses your
              selected OpenCode model.
            </p>
          </aside>
        </div>
      </div>
    </section>
  )
}

/* ================================================================== */
/* Install: the back cover                                             */
/* ================================================================== */
const INSTALL_SH = `(
  set -e
  install_dir="$HOME/.local/share/opencode/lazers-plugin"
  mkdir -p "$install_dir"
  cd "$install_dir"
  curl --fail --location \\
    --output opencode-lazers-0.1.0.tgz \\
    "https://github.com/thejustinwalsh/opencode-lazers/releases/download/v0.1.0/opencode-lazers-0.1.0.tgz"
  bun add --ignore-scripts ./opencode-lazers-0.1.0.tgz
  printf '%s/node_modules/opencode-lazers\\n' "$PWD"
)`

const CONFIG_JSON = `{
  "plugins": ["/absolute/path/from-the-last-command/node_modules/opencode-lazers"]
}`

const in_ = stylex.create({
  top: {
    display: "grid",
    gridTemplateColumns: { default: "1fr", [bp.wide]: "1fr auto" },
    alignItems: "end",
    gap: 20,
  },
  facts: {
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
    justifyContent: { default: "flex-start", [bp.wide]: "flex-end" },
  },
  fact: {
    fontFamily: type.face,
    fontStretch: "75%",
    fontStyle: "italic",
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    fontSize: 15,
    paddingInline: 10,
    paddingBlock: 5,
    backgroundColor: color.ink,
    color: color.paper,
  },
  steps: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr)", [bp.wide]: "minmax(0, 7fr) minmax(0, 5fr)" },
    columnGap: "4vw",
    rowGap: 40,
    marginBlockStart: "clamp(36px, 4vw, 64px)",
    counterReset: "step",
  },
  step: { display: "grid", alignContent: "start", gap: 14, minWidth: 0 },
  stepWide: { gridRow: { default: "auto", [bp.wide]: "span 2" } },
  stepHead: { display: "flex", alignItems: "baseline", gap: 14 },
  stepNum: {
    fontFamily: type.face,
    fontStretch: "110%",
    fontStyle: "italic",
    fontWeight: 900,
    fontSize: "clamp(30px, 2.6vw, 40px)",
    lineHeight: 1,
    color: color.magenta,
    flex: "none",
  },
  stepTitle: {
    fontFamily: type.face,
    fontStretch: "80%",
    fontWeight: 800,
    fontSize: "clamp(22px, 1.8vw, 28px)",
    lineHeight: 1.15,
  },
  block: { position: "relative", minWidth: 0 },
  pre: {
    margin: 0,
    overflowX: "auto",
    backgroundColor: color.ink,
    color: color.paper,
    fontFamily: type.mono,
    fontSize: "clamp(13px, 0.95vw, 15px)",
    lineHeight: 1.65,
    paddingInline: "clamp(16px, 1.6vw, 24px)",
    paddingBlockStart: 52,
    paddingBlockEnd: 20,
    boxShadow: "8px 10px 0 #A3A5F9",
    tabSize: 2,
    scrollbarColor: "#A3A5F9 #13095E",
  },
  copy: {
    position: "absolute",
    top: 10,
    right: 10,
    zIndex: 1,
    minHeight: 34,
    minWidth: 92,
    paddingInline: 14,
    borderWidth: 0,
    cursor: "pointer",
    fontFamily: type.face,
    fontStretch: "75%",
    fontStyle: "italic",
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    fontSize: 15,
    color: color.ink,
    backgroundColor: { default: color.cyan, ":hover": color.paper },
  },
  copied: { backgroundColor: color.magenta, color: color.paper },
  note: { fontSize: "clamp(15px, 1.05vw, 17px)", lineHeight: 1.55, maxWidth: "60ch" },
  links: {
    display: "flex",
    flexWrap: "wrap",
    gap: "14px 28px",
    marginBlockStart: "clamp(40px, 4vw, 64px)",
    paddingBlockStart: 20,
    borderBlockStart: "3px solid #13095E",
  },
  bigLink: {
    fontFamily: type.face,
    fontStretch: "72%",
    fontStyle: "italic",
    fontWeight: 900,
    textTransform: "uppercase",
    fontSize: "clamp(24px, 2.2vw, 34px)",
    lineHeight: 1.1,
    minHeight: 44,
    display: "inline-flex",
    alignItems: "center",
  },
  cat: {
    left: { default: "-18vw", [bp.wide]: "-5vw" },
    bottom: { default: "-8vw", [bp.wide]: "-4vw" },
    width: { default: "56vw", [bp.wide]: "18vw" },
    height: { default: "54vw", [bp.wide]: "17.3vw" },
  },
  field: { left: 0, bottom: 0, width: "46vw", height: "30vw" },
  section: { paddingBlockEnd: { default: "52vw", [bp.wide]: "clamp(120px, 14vw, 220px)" } },
})

function CodeBlock({ code, label }: { code: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle")
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setState("copied")
    } catch {
      setState("failed")
    }
    window.setTimeout(() => setState("idle"), 2200)
  }
  return (
    <div {...stylex.props(in_.block)}>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${label}`}
        {...stylex.props(in_.copy, state === "copied" && in_.copied)}
      >
        {state === "copied" ? "Copied" : state === "failed" ? "Select it" : "Copy"}
      </button>
      <span role="status" style={srOnly}>
        {state === "copied" ? `${label} copied` : state === "failed" ? "Copy failed" : ""}
      </span>
      <pre tabIndex={0} aria-label={label} {...stylex.props(in_.pre)}>
        <code>{code}</code>
      </pre>
    </div>
  )
}

export function Install() {
  const kit = useBeamKit("install", 1, 14)
  return (
    <section
      ref={kit.section}
      id="install"
      aria-labelledby="install-title"
      {...stylex.props(s.section, in_.section)}
    >
      <Seam />
      <Field kit={kit} sx={in_.field} amp={8}>
        <div {...stylex.props(s.dots, s.dotsFade)} />
      </Field>
      <Cat kit={kit} sx={in_.cat} />
      <BeamCanvas kit={kit} />
      <div {...stylex.props(s.inner)}>
        <div {...stylex.props(in_.top)}>
          <Heading id="install-title">Install v0.1.0</Heading>
          <ul aria-label="Requirements" {...stylex.props(in_.facts)}>
            <li {...stylex.props(in_.fact)}>Bun</li>
            <li {...stylex.props(in_.fact)}>OpenCode Desktop 2.2.6</li>
            <li {...stylex.props(in_.fact)}>No build step</li>
          </ul>
        </div>

        <ol {...stylex.props(in_.steps)}>
          <li {...stylex.props(in_.step, in_.stepWide)}>
            <div {...stylex.props(in_.stepHead)}>
              <span aria-hidden="true" {...stylex.props(in_.stepNum)}>
                1
              </span>
              <h3 {...stylex.props(in_.stepTitle)}>Install the release archive</h3>
            </div>
            <p {...stylex.props(in_.note)}>
              Run this in a terminal. It installs into a dedicated directory, skips lifecycle
              scripts and prints the plugin path.
            </p>
            <CodeBlock code={INSTALL_SH} label="install commands" />
          </li>
          <li {...stylex.props(in_.step)}>
            <div {...stylex.props(in_.stepHead)}>
              <span aria-hidden="true" {...stylex.props(in_.stepNum)}>
                2
              </span>
              <h3 {...stylex.props(in_.stepTitle)}>Add the printed path to OpenCode</h3>
            </div>
            <p {...stylex.props(in_.note)}>
              Merge it into the global <Code>plugins</Code> list, usually in{" "}
              <Code>~/.config/opencode/opencode.json</Code>. Remove older LAZERS paths and keep one
              LAZERS load path in total.
            </p>
            <CodeBlock code={CONFIG_JSON} label="plugins entry" />
          </li>
          <li {...stylex.props(in_.step)}>
            <div {...stylex.props(in_.stepHead)}>
              <span aria-hidden="true" {...stylex.props(in_.stepNum)}>
                3
              </span>
              <h3 {...stylex.props(in_.stepTitle)}>Restart and pick Architect</h3>
            </div>
            <p {...stylex.props(in_.note)}>
              Restart OpenCode Desktop and its background service. Select{" "}
              <strong {...stylex.props(s.strong)}>Architect</strong> from the agent list, then open
              Tasks or run <Code>/lz-tasks</Code> to check that the panel loads.
            </p>
          </li>
        </ol>

        <nav aria-label="Install resources" {...stylex.props(in_.links)}>
          <a href={links.install} {...stylex.props(in_.bigLink, t.inkLink)}>
            Full install guide
          </a>
          <a href={links.firstTask} {...stylex.props(in_.bigLink, t.inkLink)}>
            Your first task
          </a>
          <a href={links.releases} {...stylex.props(in_.bigLink, t.inkLink)}>
            Releases
          </a>
        </nav>
      </div>
    </section>
  )
}

/* ================================================================== */
/* Footer                                                               */
/* ================================================================== */
const ft = stylex.create({
  footer: {
    position: "relative",
    zIndex: 3,
    backgroundColor: color.ink,
    color: color.paper,
    paddingInline: "clamp(18px, 4vw, 64px)",
    paddingBlock: "clamp(28px, 3vw, 44px)",
  },
  inner: {
    maxWidth: 1360,
    marginInline: "auto",
    display: "grid",
    gridTemplateColumns: { default: "1fr", [bp.wide]: "auto 1fr auto" },
    alignItems: "center",
    gap: { default: 18, [bp.wide]: "3vw" },
  },
  mark: {
    fontFamily: type.face,
    fontStretch: "125%",
    fontStyle: "italic",
    fontWeight: 900,
    fontSize: 34,
    lineHeight: 1,
    color: color.magenta,
    transform: "rotate(-3deg)",
  },
  nav: { display: "flex", gap: 24, flexWrap: "wrap" },
  link: {
    fontFamily: type.face,
    fontStretch: "72%",
    fontStyle: "italic",
    fontWeight: 800,
    textTransform: "uppercase",
    fontSize: 20,
    minHeight: 44,
    display: "inline-flex",
    alignItems: "center",
  },
  note: { fontSize: 14, lineHeight: 1.5, color: color.peri, maxWidth: "52ch" },
})

export function Footer() {
  return (
    <footer {...stylex.props(ft.footer)}>
      <div {...stylex.props(ft.inner)}>
        <p aria-hidden="true" {...stylex.props(ft.mark)}>
          LAZERS
        </p>
        <nav aria-label="Footer" {...stylex.props(ft.nav)}>
          <a href={links.docs} {...stylex.props(ft.link, t.inkLink)}>
            Docs
          </a>
          <a href={links.github} {...stylex.props(ft.link, t.inkLink)}>
            GitHub
          </a>
          <a href="#install" {...stylex.props(ft.link, t.inkLink)}>
            Install
          </a>
          <a href="#top" {...stylex.props(ft.link, t.inkLink)}>
            Back to cover
          </a>
        </nav>
        <p {...stylex.props(ft.note)}>
          v0.1.0 was tested with OpenCode Desktop 2.2.6. This test does not promise compatibility
          with other versions.
        </p>
      </div>
    </footer>
  )
}
