import { expect, test } from "bun:test"
import {
  changedLineMap,
  groupPairs,
  introducedClones,
  mergeClones,
  type CloneGroup,
} from "./compare.ts"
import type { ClonePair, JscpdDetector } from "./contract.ts"

function pair(
  fingerprint: string,
  tokens: number,
  lines: number,
  first: ClonePair["first"],
  second: ClonePair["second"],
  kind = "exact",
): ClonePair {
  return { fingerprint, format: "typescript", kind, tokens, lines, first, second }
}

function group(fingerprint: string, instances: CloneGroup["instances"], lines = 8): CloneGroup {
  return {
    fingerprint,
    instances,
    lines,
    tokens: 80,
    kind: "exact",
    similarity: undefined,
  }
}

test("overlapping detector pairs form one safe clone group", () => {
  const groups = groupPairs([
    pair(
      "jscpd:111111111111",
      60,
      6,
      { path: "a.ts", startLine: 1, endLine: 6 },
      { path: "b.ts", startLine: 1, endLine: 6 },
    ),
    pair(
      "jscpd:222222222222",
      72,
      7,
      { path: "a.ts", startLine: 2, endLine: 8 },
      { path: "c.ts", startLine: 10, endLine: 16 },
    ),
    pair(
      "jscpd:333333333333",
      55,
      6,
      { path: "b.ts", startLine: 1, endLine: 6 },
      { path: "c.ts", startLine: 10, endLine: 16 },
    ),
  ])

  expect(groups).toHaveLength(1)
  expect(groups[0]?.fingerprint).toBe("jscpd:222222222222")
  expect(groups[0]?.instances).toEqual([
    { path: "a.ts", startLine: 1, endLine: 8 },
    { path: "b.ts", startLine: 1, endLine: 6 },
    { path: "c.ts", startLine: 10, endLine: 16 },
  ])
  expect(JSON.stringify(groups)).not.toContain("source text")
})

test("a clone is introduced only when a changed head copy increases its base count", () => {
  const changed = changedLineMap([{ path: "new.ts", startLine: 1, endLine: 12 }])
  const baseGroup = group("jscpd:aaaaaaaaaaaa", [
    { path: "a.ts", startLine: 1, endLine: 8 },
    { path: "b.ts", startLine: 1, endLine: 8 },
  ])
  const headGroup = group("jscpd:aaaaaaaaaaaa", [
    { path: "a.ts", startLine: 1, endLine: 8 },
    { path: "b.ts", startLine: 1, endLine: 8 },
    { path: "new.ts", startLine: 1, endLine: 8 },
  ])

  expect(introducedClones([baseGroup], [headGroup], changed)).toEqual([
    {
      group: headGroup,
      introduced: [{ path: "new.ts", startLine: 1, endLine: 8 }],
      others: [
        { path: "a.ts", startLine: 1, endLine: 8 },
        { path: "b.ts", startLine: 1, endLine: 8 },
      ],
      baseInstances: 2,
    },
  ])
  expect(introducedClones([headGroup], [headGroup], changed)).toEqual([])
  expect(introducedClones([], [headGroup], changedLineMap([]))).toEqual([])
})

test("detectors merge on two shared instances and select the substantially larger report", () => {
  const changed = changedLineMap([{ path: "new.ts", startLine: 1, endLine: 20 }])
  const instances = [
    { path: "new.ts", startLine: 1, endLine: 15 },
    { path: "old.ts", startLine: 1, endLine: 15 },
  ]
  const found = (detector: JscpdDetector, lines: number) => ({
    detector,
    clones: [
      {
        group: group(`jscpd:${detector.padEnd(12, "0")}`, instances, lines),
        introduced: [instances[0]!],
        others: [instances[1]!],
        baseInstances: 0,
      },
    ],
  })
  const merged = mergeClones([found("strict", 8), found("renamed", 12)], changed)

  expect(merged).toHaveLength(1)
  expect(merged[0]?.detector).toBe("renamed")
  expect(merged[0]?.detectors).toEqual(["strict", "renamed"])
  expect(merged[0]?.introduced).toEqual([instances[0]!])
})

test("cross-language labels remain only for groups that span JavaScript and TypeScript", () => {
  const changed = changedLineMap([{ path: "new.ts", startLine: 1, endLine: 12 }])
  const typed = { path: "new.ts", startLine: 1, endLine: 10 }
  const plain = { path: "old.js", startLine: 1, endLine: 10 }
  const clones = mergeClones(
    [
      {
        detector: "cross-language",
        clones: [
          {
            group: group("jscpd:crosslang000", [typed, plain]),
            introduced: [typed],
            others: [plain],
            baseInstances: 0,
          },
        ],
      },
    ],
    changed,
  )

  expect(clones[0]?.detectors).toEqual(["cross-language"])
})
