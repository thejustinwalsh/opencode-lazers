/**
 * The postMessage contract between the page and a demo iframe (`/demo/`). Both sides check
 * `event.origin === location.origin` and `event.source` before acting; `demo` is a fixed tag so
 * unrelated messages are ignored.
 */
export interface ChapterInfo {
  name: string
  caption: string
  /** Story time of the chapter's start, in ms. */
  at: number
  /** Length until the next chapter (or the end), in ms. */
  ms: number
}

/** The cursor shapes the page draws. */
export type PointerKind = "default" | "pointer" | "text"

/** iframe -> page */
export type DemoMessage =
  | {
      demo: true
      story: string
      type: "ready"
      chapters: ChapterInfo[]
      width: number
      height: number
    }
  | { demo: true; story: string; type: "chapter"; name: string; index: number; ms: number }
  | {
      demo: true
      story: string
      type: "pointer"
      x: number
      y: number
      down: boolean
      off: boolean
      /** The computed cursor kind under the pointer tip in the panel. */
      cursor: PointerKind
    }
  | { demo: true; story: string; type: "end" }

/** page -> iframe */
export type DemoCommand =
  | { demo: true; type: "play" }
  | { demo: true; type: "pause" }
  | { demo: true; type: "seek"; chapter: string }

export const isDemoMessage = (value: unknown): value is DemoMessage =>
  typeof value === "object" && value !== null && (value as { demo?: unknown }).demo === true

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** A message or command without its envelope tags, as the sender builds it. */
export type DemoMessageBody = DistributiveOmit<DemoMessage, "demo" | "story">
export type DemoCommandBody = DistributiveOmit<DemoCommand, "demo">
