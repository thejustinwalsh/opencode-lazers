type KeyHandler = (event: KeyboardEvent) => void

export type ModifierTracker = {
  /** True while Shift is held. Cleared on window blur or when the page is hidden. */
  shift(): boolean
  /** Capture-phase window keydown, run after the modifier state updates. */
  onKeyDown(handler: KeyHandler): void
  /** Capture-phase window keyup, run after the modifier state updates. */
  onKeyUp(handler: KeyHandler): void
  /** Window blur, run after the modifier state resets. */
  onBlur(handler: () => void): void
}

const trackers = new WeakMap<AbortSignal, ModifierTracker>()

/**
 * One set of window key listeners per plugin lifetime, shared by every control that reads
 * modifiers or hold-to-talk keys. The host calls a composer pill's `run()` without the click
 * event, so a pill learns about Shift from here.
 */
export function modifierTracker(owner: { readonly signal: AbortSignal }): ModifierTracker {
  const existing = trackers.get(owner.signal)
  if (existing) return existing
  let shift = false
  const down: KeyHandler[] = []
  const up: KeyHandler[] = []
  const blur: Array<() => void> = []
  const tracker: ModifierTracker = {
    shift: () => shift,
    onKeyDown: (handler) => void down.push(handler),
    onKeyUp: (handler) => void up.push(handler),
    onBlur: (handler) => void blur.push(handler),
  }
  trackers.set(owner.signal, tracker)
  if (typeof window === "undefined") return tracker
  const options = { signal: owner.signal }
  const reset = () => {
    shift = false
  }
  window.addEventListener(
    "keydown",
    (event) => {
      shift = event.shiftKey
      for (const handler of down) handler(event)
    },
    { capture: true, ...options },
  )
  window.addEventListener(
    "keyup",
    (event) => {
      shift = event.shiftKey
      for (const handler of up) handler(event)
    },
    { capture: true, ...options },
  )
  window.addEventListener(
    "blur",
    () => {
      reset()
      for (const handler of blur) handler()
    },
    options,
  )
  if (typeof document !== "undefined")
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "hidden") reset()
      },
      options,
    )
  return tracker
}
