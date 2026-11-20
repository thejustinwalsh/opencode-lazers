import { expect, test } from "bun:test"
import { stories } from "../stories/index.ts"
import type { Action } from "../src/story.ts"

/**
 * A story reads as deliberate only when data and the pointer take turns: a patch (new calls,
 * checks, rows) must never land between a pointer move and its click, or while a selection the
 * story made is on screen. Durations are conservative estimates of the engine's travel and holds.
 */
const estimate = (action: Action): number => {
  switch (action.do) {
    case "wait":
      return action.ms
    case "key":
      return 160
    case "type":
      return 1300 + action.text.length * 60
    case "hover":
      return 1400
    case "click":
      return 1500
    default:
      return 1200
  }
}

test("no step mixes a data patch with pointer actions, and no patch lands inside an interaction window", () => {
  const problems: string[] = []
  for (const story of stories) {
    const windows = story.steps
      .filter((step) => step.actions?.length)
      .map((step) => ({
        at: step.at,
        until: step.at + step.actions!.reduce((total, action) => total + estimate(action), 0),
      }))
    for (const step of story.steps) {
      if (!step.data) continue
      // A chapter's first step sets the chapter's starting data before its pointer moves.
      if (step.actions?.length && !step.chapter)
        problems.push(`${story.id}@${step.at}: a data patch and pointer actions share a step`)
      for (const window of windows)
        if (step.at > window.at && step.at < window.until)
          problems.push(
            `${story.id}@${step.at}: a data patch falls inside the interaction at ${window.at}-${window.until}`,
          )
    }
  }
  expect(problems).toEqual([])
})
