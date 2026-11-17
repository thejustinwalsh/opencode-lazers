import Lenis from "lenis"
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
      for (const s of states.values()) clear(s)
    },
  }
}

function sizeCanvas(s: State) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = s.section.clientWidth
  const h = s.section.clientHeight
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

/** Eye origin = normalized pupil anchor x the sprite's current rendered rect. */
function origin(s: State, anchor: readonly [number, number]) {
  const r = s.sprite.getBoundingClientRect()
  const c = s.canvas.getBoundingClientRect()
  return {
    x: r.left + anchor[0] * r.width - c.left,
    y: r.top + anchor[1] * r.height - c.top,
    scale: Math.min(1.4, Math.max(0.3, r.width / REF_CAT_WIDTH)),
  }
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

function drawPair(s: State, k: number, strength: number, glow: boolean, flash: boolean) {
  const c = origin(s, CAT_CYAN_EYE)
  const m = origin(s, CAT_MAGENTA_EYE)
  const length = Math.hypot(s.canvas.clientWidth, s.canvas.clientHeight)
  beam(s.ctx, c, ANGLE.cyan, CYAN, k, length, strength, glow)
  beam(s.ctx, m, ANGLE.magenta, MAGENTA, k, length, strength, glow)
  if (flash && k < 0.4) {
    for (const [o, rgb] of [
      [c, CYAN],
      [m, MAGENTA],
    ] as const) {
      const r = 20 * o.scale * (1 + k)
      const g = s.ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, r)
      g.addColorStop(0, "rgba(255,255,255,0.95)")
      g.addColorStop(0.35, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.6)`)
      g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`)
      s.ctx.fillStyle = g
      s.ctx.beginPath()
      s.ctx.arc(o.x, o.y, r, 0, Math.PI * 2)
      s.ctx.fill()
    }
  }
}

function drawFrame(s: State, now: number) {
  clear(s)
  if (frozen && frozen.id === s.id) {
    drawPair(s, frozen.k, 1, true, true)
    return
  }
  s.queue = s.queue.filter((t0) => now - t0 < LIFE)
  for (const t0 of s.queue) {
    const k = (now - t0) / LIFE
    if (k >= 0) drawPair(s, k, 1, true, true)
  }
}

/** Reduced motion: one static, low-intensity pair per cat, part of the composition. */
function drawStatic(s: State) {
  clear(s)
  drawPair(s, 0.5, 0.5, false, false)
}

function tick(now: number) {
  raf = 0
  for (const s of active) {
    if (!s.visible) {
      s.queue = []
    }
    drawFrame(s, now)
    if (s.queue.length === 0) {
      active.delete(s)
      clear(s)
    }
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
      parallaxVisible.delete(s.section)
      continue
    }
    s.visible = true
    parallaxVisible.add(s.section)
    if (!isReduced()) s.section.style.setProperty("--p", progressOf(s.section))
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
    sizeCanvas(s)
    if (isReduced()) drawStatic(s)
  })
  const s: State = { ...t, armed: true, visible: false, queue: [], ctx, ro }
  const fireOnClick = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest("a, button")) return
    if (document.elementsFromPoint(event.clientX, event.clientY).includes(t.sprite)) fire(s, 1)
  }
  states.set(t.section, s)
  ro.observe(t.section)
  t.sprite.addEventListener("load", () => isReduced() && drawStatic(s))
  t.section.addEventListener("click", fireOnClick)
  sizeCanvas(s)
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
  }
}

/* ------------------------------------------------------------------ */
/* Parallax (transform only, driven by Lenis scroll)                   */
/* ------------------------------------------------------------------ */
interface Para {
  el: HTMLElement
  section: HTMLElement
  amp: number
}
const parallax = new Set<Para>()
const parallaxVisible = new Set<HTMLElement>()

export function registerParallax(el: HTMLElement, section: HTMLElement, amp: number) {
  const p: Para = { el, section, amp }
  parallax.add(p)
  return () => {
    parallax.delete(p)
    el.style.transform = ""
  }
}

/* ------------------------------------------------------------------ */
/* Section transitions: --p is a section's entry progress, 0..1.        */
/* 0 while its top edge sits at the viewport bottom, 1 once the top     */
/* reaches 30% of the viewport. Styles read var(--p, 1), so the static  */
/* (reduced motion or no-JS) composition is the finished state.         */
/* ------------------------------------------------------------------ */
const reveals = new Set<HTMLElement>()

function progressOf(el: HTMLElement) {
  const vh = window.innerHeight
  const t = (vh - el.getBoundingClientRect().top) / (vh * 0.7)
  return Math.max(0, Math.min(1, t)).toFixed(3)
}

export function registerReveal(section: HTMLElement) {
  reveals.add(section)
  section.style.setProperty("--p", isReduced() ? "1" : progressOf(section))
  return () => {
    reveals.delete(section)
    section.style.removeProperty("--p")
  }
}

function updateReveals() {
  for (const el of reveals) {
    // Only sections in view do layout reads; off-screen ones keep their last value.
    if (parallaxVisible.has(el)) el.style.setProperty("--p", progressOf(el))
  }
}

function settleReveals() {
  for (const el of reveals) el.style.setProperty("--p", "1")
}

function updateParallax() {
  if (isReduced()) return
  updateReveals()
  const vh = window.innerHeight
  for (const p of parallax) {
    if (!parallaxVisible.has(p.section)) continue
    const r = p.section.getBoundingClientRect()
    // -1 when the section centre sits a half-viewport+half-section below centre, +1 above.
    const t = (r.top + r.height / 2 - vh / 2) / (vh / 2 + r.height / 2)
    const y = Math.max(-1, Math.min(1, t)) * p.amp
    p.el.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`
  }
}

/* ------------------------------------------------------------------ */
/* Lenis + in-page focus                                               */
/* ------------------------------------------------------------------ */
let lenis: Lenis | null = null

function startLenis() {
  if (lenis || isReduced()) return
  lenis = new Lenis({ autoRaf: true, anchors: true })
  lenis.on("scroll", updateParallax)
  updateParallax()
}

function stopLenis() {
  lenis?.destroy()
  lenis = null
  for (const p of parallax) p.el.style.transform = ""
  settleReveals()
}

function onAnchorClick(e: MouseEvent) {
  const a = (e.target as Element).closest?.('a[href^="#"]') as HTMLAnchorElement | null
  if (!a || a.getAttribute("href") === "#") return
  const target = document.getElementById(a.getAttribute("href")!.slice(1))
  if (!target) return
  // Lenis does not move focus; land keyboard and screen reader users on the section heading.
  const heading = target.querySelector<HTMLElement>('[tabindex="-1"]') ?? target
  requestAnimationFrame(() => heading.focus({ preventScroll: true }))
}

export function startMotion() {
  document.addEventListener("click", onAnchorClick)
  startLenis()
  reducedQuery.addEventListener("change", () => {
    if (isReduced()) {
      stopLenis()
      for (const s of states.values()) {
        s.queue = []
        active.delete(s)
        drawStatic(s)
      }
    } else {
      startLenis()
      for (const s of states.values()) clear(s)
    }
  })
  window.addEventListener("resize", () => {
    for (const s of states.values()) if (isReduced()) drawStatic(s)
    updateParallax()
  })
}
