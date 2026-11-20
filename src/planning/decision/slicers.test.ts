import { expect, test } from "bun:test"
import {
  fixedSlices,
  groupChildren,
  packToLimit,
  sentenceWindows,
  structuralChildren,
  type Slice,
} from "./slicers.ts"

const fence = "```"
const text = [
  "## Goal",
  "Add a plan view.",
  "## Steps",
  "- store drafts",
  "- render breakdown",
  `${fence}ts`,
  "const a = 1. b = 2",
  fence,
  "Last paragraph one. Two. Three. Four. Five.",
].join("\n")
const at = (s: Slice) => text.slice(s.start, s.end)
const whole = { start: 0, end: text.length }

test("a document splits into headings, then items, code and paragraphs, then sentences", () => {
  const top = structuralChildren(text, whole)
  expect(top.map((s) => s.kind)).toEqual(["heading", "heading"])
  expect(at(top[0]!).startsWith("## Goal")).toBe(true)
  expect(at(top[1]!).startsWith("## Steps")).toBe(true)
  const second = structuralChildren(text, top[1]!)
  expect(second.map((s) => s.kind)).toEqual(["list-item", "list-item", "code", "paragraph"])
  expect(at(second[0]!)).toBe("- store drafts")
  expect(at(second[1]!)).toBe("- render breakdown")
  expect(at(second[2]!)).toContain("1. b")
  expect(at(second[2]!).endsWith(fence)).toBe(true)
  const paragraph = second[3]!
  expect(at(paragraph)).toBe("Last paragraph one. Two. Three. Four. Five.")
  expect(structuralChildren(text, paragraph).map(at)).toEqual([
    "Last paragraph one.",
    "Two.",
    "Three.",
    "Four.",
    "Five.",
  ])
  expect(structuralChildren("Fix the typo in README.", { start: 0, end: 23 })).toEqual([])
})

test("fixed slices window a long paragraph by four sentences with one overlapping", () => {
  const paragraph = "Last paragraph one. Two. Three. Four. Five."
  expect(fixedSlices(paragraph).map((s) => paragraph.slice(s.start, s.end))).toEqual([
    "Last paragraph one. Two. Three. Four.",
    "Four. Five.",
  ])
})

test("sentence windows cover a long ask, four at a time, overlapping by one", () => {
  const ask = "A one. B two. C three. D four. E five. F six. G seven."
  const windows = sentenceWindows(ask).map((s) => ask.slice(s.start, s.end))
  expect(windows).toEqual(["A one. B two. C three. D four.", "D four. E five. F six. G seven."])
  expect(sentenceWindows("Short ask. Two.").map((s) => s.kind)).toEqual(["whole"])
})

test("packing to a limit never ends a slice inside a sentence and flags oversize units", () => {
  const { slices, oversize } = packToLimit(text, whole, { maxChars: 25 })
  const ends = new Set([text.length])
  for (const unit of [
    ...structuralChildren(text, whole).flatMap((s) => structuralChildren(text, s)),
  ])
    ends.add(unit.end)
  for (const s of slices) {
    const last = text.slice(s.start, s.end).trimEnd().at(-1)!
    expect(".!?-)`s".includes(last) || last.length === 1).toBe(true)
    expect(s.end <= text.length).toBe(true)
  }
  expect(oversize.map(at).join("\n")).toContain("const a = 1. b = 2")
  expect(slices.some((s) => oversize.includes(s))).toBe(true)
  expect(packToLimit("Short.", { start: 0, end: 6 }, { maxChars: 40 }).slices[0]!.kind).toBe(
    "whole",
  )
})

test("grouping merges children left to right into at most the bound", () => {
  const sentences = structuralChildren("A one. B two. C three. D four. E five.", {
    start: 0,
    end: 38,
  })
  const groups = groupChildren(sentences, 2)
  expect(groups).toHaveLength(2)
  expect(groups[0]!.start).toBe(sentences[0]!.start)
  expect(groups[1]!.end).toBe(sentences.at(-1)!.end)
  expect(groupChildren(sentences, 9)).toEqual(sentences)
})

test("every slicer is deterministic", () => {
  const run = () => [
    structuralChildren(text, whole),
    fixedSlices(text),
    sentenceWindows(text),
    packToLimit(text, whole, { maxChars: 25 }),
  ]
  expect(run()).toEqual(run())
})
