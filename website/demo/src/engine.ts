import type { DemoMessageBody } from "../../src/lib/demo-protocol.ts"
import type { Action, Story } from "./story.ts"
import { dataAt, T0 } from "./story.ts"

type Post = (message: DemoMessageBody) => void

/** One virtual clock for steps, pointer travel and typing; it advances only while playing. */
export class Clock {
  t = 0
  playing = false
  private last = 0
  private raf = 0
  private waiters: { at: number; resolve: () => void }[] = []
  private parked: (() => void)[] = []

  play() {
    if (this.playing) return
    this.playing = true
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
    for (const wake of this.parked.splice(0)) requestAnimationFrame(() => wake())
  }
  pause() {
    this.playing = false
    cancelAnimationFrame(this.raf)
  }
  private frame = (now: number) => {
    if (!this.playing) return
    this.t += Math.min(100, now - this.last)
    this.last = now
    const due = this.waiters.filter((waiter) => waiter.at <= this.t)
    this.waiters = this.waiters.filter((waiter) => waiter.at > this.t)
    for (const waiter of due) waiter.resolve()
    this.raf = requestAnimationFrame(this.frame)
  }
  /**
   * The next animation frame of a playing clock. While paused nothing is scheduled: the caller
   * parks until `play`, so an offscreen demo's pointer and scroll loops cost no frames or messages.
   */
  nextFrame() {
    return new Promise<void>((resolve) =>
      this.playing ? requestAnimationFrame(() => resolve()) : this.parked.push(resolve),
    )
  }
  until(at: number) {
    return at <= this.t
      ? Promise.resolve()
      : new Promise<void>((resolve) => this.waiters.push({ at, resolve }))
  }
  sleep(ms: number) {
    return this.until(this.t + ms)
  }
}

const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2)
const frameDelay = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

export interface EngineOptions<D> {
  story: Story<D>
  root: HTMLElement
  post: Post
  applyData: (data: D) => void
  /** Reduced motion: no pointer, no travel, no typing delay; actions still run as real events. */
  reduced: boolean
}

export class Engine<D> {
  readonly clock = new Clock()
  private pointer = { x: -40, y: -40, off: true }
  private opts: EngineOptions<D>
  private data: D
  private started = false
  private run = 0
  private hovered: HTMLElement | undefined

  constructor(opts: EngineOptions<D>) {
    this.opts = opts
    this.data = opts.story.initial
    // The panel reads "now" from the story, so recorded timestamps stay in the past.
    const clock = this.clock
    // Whole milliseconds: contracts take integers and the clock advances by fractions.
    Date.now = () => Math.floor(T0 + clock.t)
    // The story owns every pointer, wheel, touch and key input: a visitor's own (trusted) events
    // are dropped before the panel sees them, so they can never move its scroll positions or focus.
    // The page also sets pointer-events: none on the iframe; this covers standalone use.
    for (const type of ["wheel", "touchmove", "keydown", "mousedown", "click"])
      opts.root.ownerDocument.addEventListener(
        type,
        (event) => {
          if (event.isTrusted) {
            event.stopImmediatePropagation()
            event.preventDefault()
          }
        },
        { capture: true, passive: false },
      )
  }

  private setData(data: D) {
    this.data = data
    this.opts.applyData(data)
  }

  /** Enter the story at a chapter's start, without playing. */
  async enter(chapterName: string | undefined, settled: boolean) {
    const { story } = this.opts
    const chapter = story.chapters.find((c) => c.name === chapterName) ?? story.chapters[0]!
    const from = chapter.at
    this.clock.t = from
    this.setData(dataAt(story, settled ? chapter.at + chapter.ms - 1 : from))
    await this.loaded()
    for (const action of chapter.setup ?? []) await this.perform(action, true)
    if (settled) {
      for (const step of story.steps)
        if (step.at >= chapter.at && step.at < chapter.at + chapter.ms)
          for (const action of step.actions ?? []) await this.perform(action, true)
      this.clock.t = chapter.at + chapter.ms - 1
    }
    return { chapter, from }
  }

  /** Play from the current clock to the end; resolves when the story ends. */
  async play(from: number) {
    const { story, post } = this.opts
    const token = ++this.run
    this.clock.play()
    this.started = true
    for (const step of story.steps) {
      if (step.at < from) continue
      await this.clock.until(step.at)
      if (token !== this.run) return
      if (step.chapter) {
        const index = story.chapters.findIndex((c) => c.name === step.chapter)
        post({ type: "chapter", name: step.chapter, index, ms: story.chapters[index]?.ms ?? 0 })
      }
      if (step.data) this.setData({ ...this.data, ...step.data })
      for (const action of step.actions ?? []) {
        await this.perform(action, false)
        if (token !== this.run) return
      }
    }
    await this.clock.until(story.end)
    if (token === this.run) post({ type: "end" })
  }

  resume() {
    if (this.started) this.clock.play()
  }
  pause() {
    this.clock.pause()
  }
  get playing() {
    return this.clock.playing
  }

  /* ------------------------------------------------------------------ */
  private async find(sel: string, nth = 0): Promise<HTMLElement | undefined> {
    const deadline = performance.now() + 8000
    for (;;) {
      const found = this.opts.root.querySelectorAll<HTMLElement>(sel)[nth]
      if (found) return found
      if (performance.now() > deadline) {
        console.warn(`[demo] no element for ${sel}`)
        return undefined
      }
      await frameDelay()
    }
  }

  /** Wait for the panel's first load: its skeleton is replaced, so earlier clicks would be lost. */
  private async loaded() {
    const deadline = performance.now() + 4000
    while (performance.now() < deadline) {
      const root = this.opts.root
      if (root.childElementCount > 0 && !root.querySelector('[aria-busy="true"]')) break
      await frameDelay()
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250))
  }

  /** What a real cursor would look like here: the computed `cursor`, else by element kind. */
  private cursorAt(x: number, y: number): "default" | "pointer" | "text" {
    const el = document.elementFromPoint(x, y)
    if (!el) return "default"
    const css = getComputedStyle(el).cursor
    if (css === "pointer") return "pointer"
    if (css === "text") return "text"
    if (css !== "auto") return "default"
    if (
      el.closest("input:not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]")
    )
      return "text"
    if (el.closest("button, a[href], summary, [role=button], [role=option], [role=tab], select"))
      return "pointer"
    return "default"
  }

  private emitPointer(down: boolean) {
    const { x, y, off } = this.pointer
    this.opts.post({ type: "pointer", x, y, down, off, cursor: this.cursorAt(x, y) })
  }

  private async moveTo(el: HTMLElement, instant: boolean) {
    el.scrollIntoView({ block: "nearest", inline: "nearest" })
    const rect = el.getBoundingClientRect()
    const x = rect.left + Math.min(rect.width / 2, 80)
    const y = rect.top + rect.height / 2
    if (instant || this.opts.reduced) {
      this.pointer = { x, y, off: true }
      return
    }
    if (this.pointer.off) this.pointer = { x: x + 120, y: y + 90, off: false }
    const start = { ...this.pointer }
    const distance = Math.hypot(x - start.x, y - start.y)
    const ms = Math.min(900, 320 + distance * 0.8)
    const begin = this.clock.t
    while (this.clock.t - begin < ms) {
      const k = ease(Math.min(1, (this.clock.t - begin) / ms))
      this.pointer = { x: start.x + (x - start.x) * k, y: start.y + (y - start.y) * k, off: false }
      this.emitPointer(false)
      await this.clock.nextFrame()
    }
    this.pointer = { x, y, off: false }
    this.emitPointer(false)
    this.leave()
    this.hovered = el
    el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, clientX: x, clientY: y }))
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: x, clientY: y }))
  }

  private leave() {
    this.hovered?.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }))
    this.hovered?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }))
    this.hovered = undefined
  }

  private async pause_(ms: number, instant: boolean) {
    if (!instant && !this.opts.reduced) await this.clock.sleep(ms)
  }

  async perform(action: Action, instant: boolean) {
    const opts = this.opts
    if (action.do === "wait") return this.pause_(action.ms, instant)
    if (action.do === "key") {
      const el = (action.sel ? await this.find(action.sel) : undefined) ?? document.activeElement
      const target = (el as HTMLElement | null) ?? document.body
      for (const type of ["keydown", "keyup"])
        target.dispatchEvent(new KeyboardEvent(type, { key: action.key, bubbles: true }))
      return this.pause_(160, instant)
    }
    const el = await this.find(action.sel, action.do === "click" ? (action.nth ?? 0) : 0)
    if (!el) return
    await this.moveTo(el, instant)
    const { x, y } = this.pointer
    const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }
    switch (action.do) {
      case "hover":
        return this.pause_(500, instant)
      case "click": {
        if (!opts.reduced && !instant) {
          this.emitPointer(true)
        }
        el.dispatchEvent(new PointerEvent("pointerdown", init))
        el.dispatchEvent(new MouseEvent("mousedown", init))
        el.focus?.({ preventScroll: true })
        await this.pause_(110, instant)
        el.dispatchEvent(new PointerEvent("pointerup", init))
        el.dispatchEvent(new MouseEvent("mouseup", init))
        el.dispatchEvent(new MouseEvent("click", init))
        if (!opts.reduced && !instant) this.emitPointer(false)
        return this.pause_(260, instant)
      }
      case "type": {
        el.focus({ preventScroll: true })
        const input = el as HTMLInputElement
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
        let text = ""
        for (const ch of action.text) {
          text += ch
          setter.call(input, text)
          input.dispatchEvent(new Event("input", { bubbles: true }))
          await this.pause_(60, instant)
        }
        return this.pause_(200, instant)
      }
      case "scroll": {
        const from = el.scrollTop
        const span = Math.abs(action.to - from)
        const ms = instant || opts.reduced ? 0 : Math.min(900, 240 + span)
        const begin = this.clock.t
        while (ms > 0 && this.clock.t - begin < ms) {
          el.scrollTop = from + (action.to - from) * ease((this.clock.t - begin) / ms)
          await this.clock.nextFrame()
        }
        el.scrollTop = action.to
        return this.pause_(160, instant)
      }
      case "wheel": {
        el.dispatchEvent(
          new WheelEvent("wheel", {
            ...init,
            deltaY: action.delta,
            ctrlKey: action.ctrl ?? false,
          }),
        )
        return this.pause_(260, instant)
      }
    }
  }
}
