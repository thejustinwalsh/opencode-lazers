import { describe, expect, test } from "bun:test"
import type { CodeReviewComparison, CodeReviewSide } from "../../contract.ts"
import { headSides, joinFiles, readable, sideOf, sourceIdentity, splitPath } from "./files.ts"
import type { FileRow } from "./files.ts"

const oid = (n: number) => n.toString(16).padStart(40, "0")
const TASK = "11111111-1111-4111-8111-111111111111"
const CMP = "a".repeat(64)

const comparison = (
  mode: CodeReviewComparison["identity"]["mode"],
  sides: CodeReviewSide[],
): Pick<CodeReviewComparison, "identity" | "sides"> => ({
  sides,
  identity: {
    version: 1,
    comparisonID: CMP,
    projectID: "project-x",
    taskID: TASK,
    planID: null,
    attemptID: "22222222-2222-4222-8222-222222222222",
    mode,
    baseRevision: oid(1),
    headRevision: oid(2),
    snapshotID: null,
    capturedAt: null,
    attribution: "committed",
  } as CodeReviewComparison["identity"],
})

const row = (
  path: string,
  side: CodeReviewSide,
  id: number | null,
  status: string,
  extra: Record<string, unknown> = {},
): FileRow => ({
  path,
  side,
  object_id: id === null ? null : oid(id),
  kind: id === null ? "absent" : "text",
  status,
  changed: status !== "unchanged",
  hunks: [],
  attribution_task_ids: [],
  size: id === null ? null : 10,
  mode: id === null ? null : "100644",
  ...extra,
})

const map = (...rows: FileRow[]) => new Map(rows.map((r) => [r.path as string, r]))

describe("task mode", () => {
  const cmp = comparison("task", ["base", "head"])
  const hunks = [{ baseStart: 1, baseEnd: 2, headStart: 1, headEnd: 3 }]
  const base = map(
    row("added.ts", "base", null, "added"),
    row("deleted.ts", "base", 3, "deleted"),
    row("mod.ts", "base", 4, "modified", { hunks }),
    row("same.ts", "base", 5, "unchanged"),
  )
  const head = map(
    row("added.ts", "head", 6, "added", { attribution_task_ids: [TASK] }),
    row("deleted.ts", "head", null, "deleted"),
    row("mod.ts", "head", 7, "modified", { hunks }),
    row("same.ts", "head", 5, "unchanged"),
  )
  const files = joinFiles(cmp, base, new Map([["head", head]]))

  test("pairs statuses and sides, excludes unchanged, path order", () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["added.ts", "added"],
      ["deleted.ts", "deleted"],
      ["mod.ts", "modified"],
    ])
    const [added, deleted, mod] = files
    expect(added!.base).toBeNull()
    expect(added!.head?.revision).toBe(oid(6))
    expect(added!.attributionTaskIDs).toEqual([TASK])
    expect(deleted!.head).toBeNull()
    expect(deleted!.base?.revision).toBe(oid(3))
    expect(mod!.base?.revision).toBe(oid(4))
    expect(mod!.head?.revision).toBe(oid(7))
    expect(mod!.hunks).toEqual(hunks)
  })
})

describe("live mode", () => {
  const cmp = comparison("live", ["base", "head", "staged", "unstaged", "untracked"])

  test("layers newest first", () => {
    expect(headSides(cmp)).toEqual(["untracked", "unstaged", "staged", "head"])
    expect(headSides(comparison("task", ["base", "head"]))).toEqual(["head"])
  })

  test("newest layer wins, head-only keeps head object, deletion, equal-to-base excluded", () => {
    const base = map(
      row("layered.ts", "base", 1, "unchanged"),
      row("headonly.ts", "base", 2, "unchanged"),
      row("gone.ts", "base", 3, "unchanged"),
      row("revert.ts", "base", 4, "unchanged"),
    )
    const heads = new Map<CodeReviewSide, Map<string, FileRow>>([
      [
        "head",
        map(
          row("layered.ts", "head", 10, "modified"),
          row("headonly.ts", "head", 20, "modified"),
          row("gone.ts", "head", 30, "modified"),
          row("revert.ts", "head", 40, "modified"),
        ),
      ],
      ["staged", map(row("layered.ts", "staged", 11, "modified"))],
      [
        "unstaged",
        map(
          row("layered.ts", "unstaged", 12, "modified"),
          row("gone.ts", "unstaged", null, "deleted"),
          row("revert.ts", "unstaged", 4, "modified"),
        ),
      ],
      ["untracked", map(row("new.ts", "untracked", 50, "added"))],
    ])
    const files = joinFiles(cmp, base, heads)
    const by = Object.fromEntries(files.map((f) => [f.path, f]))
    expect(Object.keys(by).sort()).toEqual(["gone.ts", "headonly.ts", "layered.ts", "new.ts"])
    expect(by["layered.ts"]!.head).toMatchObject({ side: "unstaged", revision: oid(12) })
    expect(by["layered.ts"]!.status).toBe("modified")
    expect(by["headonly.ts"]!.head).toMatchObject({ side: "head", revision: oid(20) })
    expect(by["gone.ts"]!.status).toBe("deleted")
    expect(by["gone.ts"]!.head).toBeNull()
    expect(by["new.ts"]!.status).toBe("added")
    expect(by["new.ts"]!.base).toBeNull()
    for (const f of files) expect(f.hunks).toEqual([])
  })

  test("live ignores head-row hunks", () => {
    const heads = new Map<CodeReviewSide, Map<string, FileRow>>([
      [
        "head",
        map(
          row("a.ts", "head", 9, "modified", {
            hunks: [{ baseStart: 1, baseEnd: 1, headStart: 1, headEnd: 1 }],
          }),
        ),
      ],
    ])
    const files = joinFiles(cmp, map(row("a.ts", "base", 8, "unchanged")), heads)
    expect(files[0]!.hunks).toEqual([])
  })
})

describe("sideOf", () => {
  test("absent, missing and unknown kinds are null", () => {
    expect(sideOf(undefined)).toBeNull()
    expect(sideOf(row("a", "base", null, "added"))).toBeNull()
    expect(sideOf(row("a", "base", 1, "added", { kind: "weird" }))).toBeNull()
  })
  test("present row maps to a source", () => {
    expect(sideOf(row("a", "head", 1, "added"))).toEqual({
      side: "head",
      revision: oid(1),
      kind: "text",
      size: 10,
    })
  })
})

describe("sourceIdentity", () => {
  test("copies identity fields exactly with side object as revision", () => {
    const cmp = comparison("task", ["base", "head"])
    const source = { side: "head" as const, revision: oid(9), kind: "text" as const, size: 3 }
    const identity = sourceIdentity(cmp, "src/a b.ts", source)
    const i = cmp.identity
    expect(identity).toEqual({
      version: i.version,
      projectID: i.projectID,
      taskID: i.taskID,
      planID: i.planID,
      attemptID: i.attemptID,
      comparisonID: i.comparisonID,
      mode: i.mode,
      side: "head",
      path: "src/a b.ts",
      revision: oid(9),
    })
  })
})

describe("readable and splitPath", () => {
  const side = (kind: string) =>
    ({ side: "head" as const, revision: oid(1), kind, size: 1 }) as never
  const file = (base: string | null, head: string | null) =>
    ({ base: base && side(base), head: head && side(head) }) as never
  test("readable", () => {
    expect(readable(file("text", "text"))).toBe(true)
    expect(readable(file(null, "unknown"))).toBe(true)
    expect(readable(file("binary", "text"))).toBe(false)
    expect(readable(file("text", "symlink"))).toBe(false)
  })
  test("splitPath", () => {
    expect(splitPath("a.ts")).toEqual({ name: "a.ts", folder: "" })
    expect(splitPath("src/x/a.ts")).toEqual({ name: "a.ts", folder: "src/x" })
  })
})
