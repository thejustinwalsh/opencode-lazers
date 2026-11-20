import { CAT_CYAN_EYE, CAT_MAGENTA_EYE } from "../assets/cat-geometry"

/* ------------------------------------------------------------------ */
/* Motion preference                                                    */
/* ------------------------------------------------------------------ */
const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
const isReduced = () => reducedQuery.matches

/* ------------------------------------------------------------------ */
/* Beams                                                                */
/* ------------------------------------------------------------------ */
export interface BeamTarget {
  id: string
  section: HTMLElement
  canvas: HTMLCanvasElement
  sprite: HTMLImageElement
  /** Paired volleys fired on entry. */
  pairs: number
}

interface State extends BeamTarget {
  armed: boolean
  visible: boolean
  /** Start timestamps (performance.now) of queued or running pairs. */
  queue: number[]
  ctx: CanvasRenderingContext2D
  ro: ResizeObserver
  /** Section CSS size, cached from ResizeObserver so frames never read layout for it. */
  w: number
  h: number
}

/** Eye origins and beam length for one frame, measured once. */
interface Geo {
  c: Origin
  m: Origin
  length: number
}
interface Origin {
  x: number
  y: number
  scale: number
}

const LIFE = 340 // ms: extend, hold, fade
const PAIR_GAP = 420 // ms between pairs: at most 3 flashes per second
const FIRE_AT = 0.35 // fraction visible before a section fires
const REF_CAT_WIDTH = 520 // cat width at which beam widths are authored

const CYAN = [25, 235, 241] as const
const MAGENTA = [248, 20, 151] as const
const ANGLE = { cyan: 22, magenta: 17 } // degrees above horizontal, diverging slightly

const states = new Map<HTMLElement, State>()
const active = new Set<State>()
let raf = 0
let observer: IntersectionObserver | null = null
let frozen: { id: string; k: number } | null = null

interface Debug {
  fired: { id: string; at: number }[]
  freeze: (id: string, k?: number) => void
  unfreeze: () => void
}
declare global {
  interface Window {
    __lazers?: Debug
  }
}
if (import.meta.env.DEV) {
  window.__lazers = {
    fired: [],
    freeze(id, k = 0.45) {
      frozen = { id, k }
      for (const s of states.values()) if (s.id === id) drawFrame(s, performance.now())
    },
    unfreeze() {
      frozen = null
      for (const s of states.values()) release(s)
    },
  }
}

function sizeCanvas(s: State) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const { w, h } = s
  if (s.canvas.width !== Math.round(w * dpr) || s.canvas.height !== Math.round(h * dpr)) {
    s.canvas.width = Math.round(w * dpr)
    s.canvas.height = Math.round(h * dpr)
  }
  s.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function clear(s: State) {
  s.ctx.setTransform(1, 0, 0, 1, 0, 0)
  s.ctx.clearRect(0, 0, s.canvas.width, s.canvas.height)
  sizeCanvas(s)
}

/** An idle canvas holds no backing store: a full-section bitmap per section is GPU memory
 *  Safari keeps composited over the scrolling page. Resized again when a volley starts. */
function release(s: State) {
  if (s.canvas.width !== 0) s.canvas.width = s.canvas.height = 0
}

/** Eye origin = normalized pupil anchor x the sprite's current rendered rect.
 *  Two rect reads per frame, taken before any drawing, not four plus size reads. */
function measureGeo(s: State): Geo {
  const r = s.sprite.getBoundingClientRect()
  const cv = s.canvas.getBoundingClientRect()
  const at = (a: readonly [number, number]): Origin => ({
    x: r.left + a[0] * r.width - cv.left,
    y: r.top + a[1] * r.height - cv.top,
    scale: Math.min(1.4, Math.max(0.3, r.width / REF_CAT_WIDTH)),
  })
  return { c: at(CAT_CYAN_EYE), m: at(CAT_MAGENTA_EYE), length: Math.hypot(s.w, s.h) }
}

const ease = (t: number) => 1 - Math.pow(1 - t, 3)

function beam(
  ctx: CanvasRenderingContext2D,
  o: { x: number; y: number; scale: number },
  deg: number,
  rgb: readonly [number, number, number],
  k: number,
  length: number,
  strength: number,
  glow: boolean,
) {
  const reach = length * ease(Math.min(1, k / 0.28))
  const fade = k < 0.62 ? 1 : 1 - (k - 0.62) / 0.38
  const a = Math.max(0, fade) * strength
  if (a <= 0) return
  const rad = (deg * Math.PI) / 180
  const dx = Math.cos(rad)
  const dy = -Math.sin(rad)
  const nx = -dy
  const ny = dx
  const ex = o.x + dx * reach
  const ey = o.y + dy * reach
  const col = (alpha: number) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`
  const layer = (w0: number, w1: number, fill: string | CanvasGradient, blur = 0) => {
    ctx.save()
    if (blur) {
      ctx.shadowColor = col(0.9 * a)
      ctx.shadowBlur = blur
    }
    ctx.fillStyle = fill
    ctx.beginPath()
    ctx.moveTo(o.x + (nx * w0) / 2, o.y + (ny * w0) / 2)
    ctx.lineTo(ex + (nx * w1) / 2, ey + (ny * w1) / 2)
    ctx.lineTo(ex - (nx * w1) / 2, ey - (ny * w1) / 2)
    ctx.lineTo(o.x - (nx * w0) / 2, o.y - (ny * w0) / 2)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }
  const grad = (alpha: number, core = false) => {
    const g = ctx.createLinearGradient(o.x, o.y, ex, ey)
    const c = core ? `rgba(255,255,255,${alpha})` : col(alpha)
    g.addColorStop(0, c)
    g.addColorStop(0.7, core ? `rgba(255,255,255,${alpha * 0.8})` : col(alpha * 0.85))
    g.addColorStop(1, core ? `rgba(255,255,255,0)` : col(0))
    return g
  }
  const s = o.scale
  layer(7 * s, 34 * s, grad(0.22 * a), glow ? 16 * s : 0)
  layer(4 * s, 18 * s, grad(0.9 * a))
  layer(1.6 * s, 6.5 * s, grad(0.95 * a, true))
}

function drawPair(s: State, g: Geo, k: number, strength: number, glow: boolean, flash: boolean) {
  const { c, m, length } = g
  beam(s.ctx, c, ANGLE.cyan, CYAN, k, length, strength, glow)
  beam(s.ctx, m, ANGLE.magenta, MAGENTA, k, length, strength, glow)
  if (flash && k < 0.4) {
    for (const [o, rgb] of [
      [c, CYAN],
      [m, MAGENTA],
    ] as const) {
      const r = 20 * o.scale * (1 + k)
      const rg = s.ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, r)
      rg.addColorStop(0, "rgba(255,255,255,0.95)")
      rg.addColorStop(0.35, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.6)`)
      rg.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`)
      s.ctx.fillStyle = rg
      s.ctx.beginPath()
      s.ctx.arc(o.x, o.y, r, 0, Math.PI * 2)
      s.ctx.fill()
    }
  }
}

function drawFrame(s: State, now: number) {
  const g = measureGeo(s) // reads first, then canvas writes
  clear(s)
  if (frozen && frozen.id === s.id) {
    drawPair(s, g, frozen.k, 1, true, true)
    return
  }
  for (const t0 of s.queue) {
    const k = (now - t0) / LIFE
    if (k >= 0) drawPair(s, g, k, 1, true, true)
  }
}

/** Reduced motion: one static, low-intensity pair per cat, part of the composition. */
function drawStatic(s: State) {
  const g = measureGeo(s)
  clear(s)
  drawPair(s, g, 0.5, 0.5, false, false)
}

function tick(now: number) {
  raf = 0
  for (const s of active) {
    s.queue = s.visible ? s.queue.filter((t0) => now - t0 < LIFE) : []
    if (s.queue.length === 0) {
      active.delete(s)
      release(s)
      continue
    }
    drawFrame(s, now)
  }
  if (active.size > 0) raf = requestAnimationFrame(tick)
}

function fire(s: State, pairs = s.pairs) {
  if (isReduced()) return
  const now = performance.now()
  s.queue = Array.from({ length: pairs }, (_, i) => now + 60 + i * PAIR_GAP)
  active.add(s)
  if (import.meta.env.DEV) window.__lazers?.fired.push({ id: s.id, at: Math.round(now) })
  if (!raf) raf = requestAnimationFrame(tick)
}

function onIntersect(entries: IntersectionObserverEntry[]) {
  for (const e of entries) {
    const s = states.get(e.target as HTMLElement)
    if (!s) continue
    const gone = !e.isIntersecting || e.intersectionRect.height === 0
    if (gone) {
      // Re-arm only after the section has fully left the viewport.
      s.visible = false
      s.armed = true
      s.queue = []
      setInView(s.section, false)
      continue
    }
    s.visible = true
    setInView(s.section, true)
    const share = Math.max(e.intersectionRatio, e.intersectionRect.height / window.innerHeight)
    if (s.armed && share >= FIRE_AT) {
      s.armed = false
      const go = () => fire(s)
      if (s.sprite.complete) go()
      else s.sprite.decode().then(go, go)
    }
  }
}

export function registerBeams(t: BeamTarget): () => void {
  const ctx = t.canvas.getContext("2d")!
  const ro = new ResizeObserver(() => {
    const s = states.get(t.section)
    if (!s) return
    s.w = t.section.clientWidth
    s.h = t.section.clientHeight
    if (isReduced()) drawStatic(s)
    else if (active.has(s)) sizeCanvas(s)
  })
  const s: State = {
    ...t,
    armed: true,
    visible: false,
    queue: [],
    ctx,
    ro,
    w: t.section.clientWidth,
    h: t.section.clientHeight,
  }
  const fireOnClick = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest("a, button")) return
    if (document.elementsFromPoint(event.clientX, event.clientY).includes(t.sprite)) fire(s, 1)
  }
  states.set(t.section, s)
  ro.observe(t.section)
  t.sprite.addEventListener("load", () => isReduced() && drawStatic(s))
  t.section.addEventListener("click", fireOnClick)
  if (isReduced()) {
    requestAnimationFrame(() => drawStatic(s))
    document.fonts?.ready.then(() => isReduced() && drawStatic(s))
  }
  observer ??= new IntersectionObserver(onIntersect, {
    threshold: Array.from({ length: 21 }, (_, i) => i / 20),
  })
  observer.observe(t.section)
  return () => {
    t.section.removeEventListener("click", fireOnClick)
    observer?.unobserve(t.section)
    ro.disconnect()
    states.delete(t.section)
    active.delete(s)
    release(s)
    setInView(t.section, false)
  }
}

/* ------------------------------------------------------------------ */
/* Scroll-linked motion: native scrolling, never script-driven.         */
/*                                                                      */
/* Parallax and the section "print-in" transitions are CSS scroll-driven */
/* animations (src/scroll.css, animation-timeline: view()), which run   */
/* off the main thread and need no scroll listener. This module only    */
/* marks the elements. Browsers without the feature get a fallback:     */
/* one passive scroll listener that schedules one rAF, which writes     */
/* transforms for sections currently in view from cached geometry.      */
/* Nothing in the scroll path reads layout.                             */
/*                                                                      */
/* --p is a section's entry progress, 0..1: 0 while its top edge sits   */
/* at the viewport bottom, 1 once the top reaches 30% of the viewport.  */
/* Styles read var(--p, 1), so the static (reduced motion or no-JS)     */
/* composition is the finished state.                                   */
/* ------------------------------------------------------------------ */
const NATIVE = typeof CSS !== "undefined" && CSS.supports("animation-timeline: view()")
const REVEAL_SPAN = 0.7 // viewport fractions of scroll over which --p goes 0 to 1

interface Section {
  el: HTMLElement
  /** Document-space geometry, cached; refreshed on resize, never read while scrolling. */
  top: number
  height: number
  parallax: Map<HTMLElement, number>
  reveal: boolean
  p: string
}
const sections = new Map<HTMLElement, Section>()
const inView = new Set<Section>()
let vh = window.innerHeight
let dirty = true
let scrollRaf = 0
let engaged = false
let sectionRo: ResizeObserver | null = null

function sectionFor(el: HTMLElement): Section {
  let sec = sections.get(el)
  if (!sec) {
    sec = { el, top: 0, height: 0, parallax: new Map(), reveal: false, p: "" }
    sections.set(el, sec)
    el.dataset.scrollSection = ""
    if (!NATIVE) {
      dirty = true
      sectionRo ??= new ResizeObserver(markDirty)
      sectionRo.observe(el)
      if (engaged) requestScrollFrame()
    }
  }
  return sec
}

function releaseSection(sec: Section) {
  if (sec.reveal || sec.parallax.size > 0) return
  sectionRo?.unobserve(sec.el)
  delete sec.el.dataset.scrollSection
  inView.delete(sec)
  sections.delete(sec.el)
}

export function registerParallax(el: HTMLElement, section: HTMLElement, amp: number) {
  const sec = sectionFor(section)
  sec.parallax.set(el, amp)
  el.dataset.parallax = ""
  el.style.setProperty("--amp", `${amp}px`)
  return () => {
    sec.parallax.delete(el)
    delete el.dataset.parallax
    el.style.removeProperty("--amp")
    el.style.transform = ""
    releaseSection(sec)
  }
}

export function registerReveal(section: HTMLElement) {
  const sec = sectionFor(section)
  sec.reveal = true
  return () => {
    sec.reveal = false
    section.style.removeProperty("--p")
    sec.p = ""
    releaseSection(sec)
  }
}

function markDirty() {
  dirty = true
  if (engaged) requestScrollFrame()
}

function requestScrollFrame() {
  if (!scrollRaf) scrollRaf = requestAnimationFrame(scrollFrame)
}

/** Reads layout once per invalidation (resize, content shift), never per scroll event. */
function measure() {
  vh = window.innerHeight
  const y = window.scrollY
  for (const sec of sections.values()) {
    const r = sec.el.getBoundingClientRect()
    sec.top = r.top + y
    sec.height = r.height
  }
  dirty = false
}

function scrollFrame() {
  scrollRaf = 0
  if (dirty) measure()
  const y = window.scrollY
  for (const sec of inView) {
    const top = sec.top - y
    if (sec.reveal) {
      const p = Math.max(0, Math.min(1, (vh - top) / (vh * REVEAL_SPAN))).toFixed(3)
      if (p !== sec.p) {
        sec.p = p
        sec.el.style.setProperty("--p", p)
      }
    }
    if (sec.parallax.size === 0) continue
    // +1 when the section centre sits a half-viewport+half-section below centre, -1 above.
    const t = (top + sec.height / 2 - vh / 2) / (vh / 2 + sec.height / 2)
    const k = Math.max(-1, Math.min(1, t))
    for (const [el, amp] of sec.parallax) {
      el.style.transform = `translate3d(0, ${(k * amp).toFixed(2)}px, 0)`
    }
  }
}

function setInView(el: HTMLElement, visible: boolean) {
  const sec = sections.get(el)
  if (!sec) return
  if (visible) {
    inView.add(sec)
    if (engaged) requestScrollFrame()
  } else inView.delete(sec)
}

/** Fallback only: start or stop the passive scroll path. */
function engageFallback() {
  if (NATIVE || engaged) return
  engaged = true
  window.addEventListener("scroll", requestScrollFrame, { passive: true })
  dirty = true
  requestScrollFrame()
}

function disengageFallback() {
  if (!engaged) return
  engaged = false
  window.removeEventListener("scroll", requestScrollFrame)
  cancelAnimationFrame(scrollRaf)
  scrollRaf = 0
  for (const sec of sections.values()) {
    for (const el of sec.parallax.keys()) el.style.transform = ""
    sec.el.style.removeProperty("--p")
    sec.p = ""
  }
}

/* ------------------------------------------------------------------ */
/* Anchors: native smooth scrolling (scroll.css); this only moves focus */
/* ------------------------------------------------------------------ */
function onAnchorClick(e: MouseEvent) {
  const a = (e.target as Element).closest?.('a[href^="#"]') as HTMLAnchorElement | null
  if (!a || a.getAttribute("href") === "#") return
  const target = document.getElementById(a.getAttribute("href")!.slice(1))
  if (!target) return
  // Land keyboard and screen reader users on the section heading without a second scroll.
  const heading = target.querySelector<HTMLElement>('[tabindex="-1"]') ?? target
  requestAnimationFrame(() => heading.focus({ preventScroll: true }))
}

export function startMotion() {
  document.addEventListener("click", onAnchorClick)
  if (!isReduced()) engageFallback()
  reducedQuery.addEventListener("change", () => {
    if (isReduced()) {
      disengageFallback()
      for (const s of states.values()) {
        s.queue = []
        active.delete(s)
        drawStatic(s)
      }
    } else {
      engageFallback()
      for (const s of states.values()) release(s)
    }
  })
  window.addEventListener("resize", () => {
    markDirty()
    for (const s of states.values()) if (isReduced()) drawStatic(s)
  })
}
