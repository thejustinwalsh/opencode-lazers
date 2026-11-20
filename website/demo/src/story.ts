/**
 * A demo story: what a panel's host answers and what a "user" does, on one virtual clock.
 * Authored in TypeScript (website/demo/stories/*.ts), type-checked against each panel's read
 * contracts, validated against the contracts' schemas by scripts/build-website-demo.ts and
 * emitted as JSON (public/demo/stories/<id>.json).
 */
export type PanelID = "tasks" | "radar" | "trajectory" | "models"

/** One simulated user action, performed as real DOM events on the real panel. */
export type Action =
  /** Move the pointer to the element, no click. */
  | { do: "hover"; sel: string }
  /** Move to the element and click it (pointerdown, mousedown, pointerup, mouseup, click). */
  | { do: "click"; sel: string; nth?: number }
  /** Move to an input, focus it and type, one character at a time. */
  | { do: "type"; sel: string; text: string }
  /** Press a key on the focused element, or on `sel`. */
  | { do: "key"; key: string; sel?: string }
  /** Scroll an element to a pixel offset, eased. */
  | { do: "scroll"; sel: string; to: number }
  /** Wheel over an element; with `ctrl` the panel reads it as a zoom gesture. */
  | { do: "wheel"; sel: string; delta: number; ctrl?: boolean }
  /** Let the panel settle for this many ms of story time. */
  | { do: "wait"; ms: number }

export interface Step<D> {
  /** Story time, ms. */
  at: number
  /** Starts a chapter: its first step carries the chapter's name. */
  chapter?: string
  /** Shallow patch of the panel's data; the host answers later reads from the merged result. */
  data?: Partial<D>
  actions?: Action[]
}

export interface ChapterDef {
  name: string
  caption: string
  /**
   * What the UI looks like at the chapter's start when it is entered by seeking (or a static
   * frame) rather than played to: instant, silent actions replayed before the chapter's step.
   */
  setup?: Action[]
}

export interface StorySource<D> {
  id: string
  panel: PanelID
  title: string
  /** Design size of the host shell in CSS px; the page scales the iframe to fit. */
  size: { width: number; height: number }
  /** Full data the panel starts with, before any step. */
  initial: D
  chapters: ChapterDef[]
  steps: Step<D>[]
  /** Story time at which the story ends, ms. */
  end: number
  /** Chapter whose final state is the static frame (reduced motion). Defaults to the last. */
  staticChapter?: string
}

/** A compiled story: the source as JSON, with chapters timed from their steps. */
export interface Story<D = unknown> extends Omit<StorySource<D>, "chapters"> {
  chapters: (ChapterDef & { at: number; ms: number })[]
}

/** Authoring helper: keeps `D` inferred so patches and initial data are checked against it. */
export function defineStory<D>(source: StorySource<D>): StorySource<D> {
  return source
}

export function compile<D>(source: StorySource<D>): Story<D> {
  const starts = new Map<string, number>()
  for (const step of source.steps) if (step.chapter) starts.set(step.chapter, step.at)
  const chapters = source.chapters.map((chapter, index, all) => {
    const at = starts.get(chapter.name)
    if (at === undefined)
      throw new Error(`Story ${source.id}: chapter "${chapter.name}" has no step that starts it`)
    const next = all[index + 1] ? starts.get(all[index + 1]!.name) : source.end
    return { ...chapter, at, ms: Math.max(1, (next ?? source.end) - at) }
  })
  const steps = [...source.steps].sort((a, b) => a.at - b.at)
  return { ...source, chapters, steps }
}

/** The data at story time `t`: initial, then every step patch up to and including `t`. */
export function dataAt<D>(story: Pick<Story<D>, "initial" | "steps">, t: number): D {
  let data = story.initial
  for (const step of story.steps) {
    if (step.at > t) break
    if (step.data) data = { ...data, ...step.data }
  }
  return data
}

/** Story time zero as wall-clock time: the demo's `Date.now()` is this plus the story clock. */
export const T0 = Date.UTC(2026, 10, 19, 14, 0, 0)
