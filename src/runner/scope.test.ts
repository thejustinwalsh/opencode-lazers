import { expect, test } from "bun:test"
import {
  buildScopeReport,
  classifyChange,
  classifyChanges,
  divergenceReason,
  patternDirectory,
  protectedPaths,
  reservationPatterns,
  scopeNotice,
  scopeRepairText,
  scopedBy,
  sizeWarning,
  type ScopeChange,
  type ScopeModel,
} from "./scope.ts"
import { scopePatternsConflict } from "./artifacts.ts"

const model = (partial: Partial<ScopeModel> = {}): ScopeModel => ({
  edit: ["src/runner/runtime.ts"],
  create: [],
  protected: [],
  ...partial,
})
const added = (path: string): ScopeChange => ({ path, status: "added", added: 10, removed: 0 })
const modified = (path: string): ScopeChange => ({ path, status: "modified", added: 4, removed: 1 })
const deleted = (path: string): ScopeChange => ({ path, status: "deleted", added: 0, removed: 9 })
const kind = (change: ScopeChange, scope: ScopeModel) => classifyChange(change, scope).class

test("an edit-scoped file is in scope, whether modified or deleted", () => {
  expect(kind(modified("src/runner/runtime.ts"), model())).toBe("in-scope")
  expect(kind(deleted("src/runner/runtime.ts"), model())).toBe("in-scope")
})

test("an existing file outside the edit scope is a divergence", () => {
  expect(kind(modified("src/runner/store.ts"), model())).toBe("divergence")
  expect(kind(deleted("src/runner/store.ts"), model())).toBe("divergence")
  expect(kind(modified("README.md"), model())).toBe("divergence")
})

test("a new file beside or below a scoped file is allowed without being listed", () => {
  expect(kind(added("src/runner/queue-limit.ts"), model())).toBe("allowed-new")
  expect(kind(added("src/runner/queue/limit.ts"), model())).toBe("allowed-new")
  expect(kind(added("src/runner/queue/deep/er/limit.ts"), model())).toBe("allowed-new")
})

test("a new file in an unrelated folder is a divergence", () => {
  expect(kind(added("src/audit/new.ts"), model())).toBe("divergence")
  expect(kind(added("docs/new.md"), model())).toBe("divergence")
  expect(kind(added("new.ts"), model())).toBe("divergence")
})

test("a glob allows the folder it locates; a root file allows only the root", () => {
  const scope = model({ edit: ["src/tasks/**"] })
  expect(kind(added("src/tasks/a/b.ts"), scope)).toBe("in-scope")
  expect(kind(added("src/other/b.ts"), scope)).toBe("divergence")
  const root = model({ edit: ["package.json"] })
  expect(kind(added("notes.md"), root)).toBe("allowed-new")
  expect(kind(added("src/deep.ts"), root)).toBe("divergence")
  expect(kind(added("src/deep.ts"), model({ edit: ["**/x.ts"] }))).toBe("divergence")
  expect(patternDirectory("src/runner/*.ts")).toBe("src/runner")
  expect(patternDirectory("src/run*/x.ts")).toBe("src")
  expect(patternDirectory("src/runner/queue/")).toBe("src/runner/queue")
})

test("create entries are expected-new, as a file or a folder", () => {
  const scope = model({
    edit: ["src/a/x.ts"],
    create: [
      { path: "lib/queue-limit.ts", purpose: "queue limit" },
      { path: "lib/queue/", purpose: "queue helpers" },
    ],
  })
  expect(kind(added("lib/queue-limit.ts"), scope)).toBe("expected-new")
  expect(kind(added("lib/queue/a/b.ts"), scope)).toBe("expected-new")
  // The create entry's folder also admits siblings of a created file.
  expect(kind(added("lib/other.ts"), scope)).toBe("allowed-new")
  // Creating is not required to be listed; elsewhere is still a divergence.
  expect(kind(added("elsewhere/x.ts"), scope)).toBe("divergence")
  // A create entry never makes an existing file editable.
  expect(kind(modified("lib/queue-limit.ts"), scope)).toBe("divergence")
})

test("tests beside or mirroring a scoped source are in scope", () => {
  const scope = model({ edit: ["src/runner/queue.ts"] })
  expect(kind(modified("src/runner/queue.test.ts"), scope)).toBe("in-scope")
  expect(kind(added("src/runner/queue.test.ts"), scope)).toBe("allowed-new")
  expect(kind(modified("test/runner/queue.test.ts"), scope)).toBe("in-scope")
  expect(kind(modified("src/runner/__tests__/queue.test.ts"), scope)).toBe("in-scope")
  expect(kind(modified("src/runner/other.test.ts"), scope)).toBe("divergence")
  expect(kind(modified("test/runner/other.test.ts"), scope)).toBe("divergence")
  expect(kind(modified("src/runner/fixtures/a.json"), scope)).toBe("in-scope")
  expect(kind(modified("src/other/fixtures/a.json"), scope)).toBe("divergence")
  expect(kind(modified("test/runner/fixtures/a.json"), model({ edit: ["src/runner/**"] }))).toBe(
    "in-scope",
  )
})

test("renames are a delete of the old path and an add of the new one", () => {
  const scope = model({ edit: ["src/runner/runtime.ts"] })
  const moved = classifyChanges(
    [deleted("src/runner/runtime.ts"), added("src/runner/runtime-core.ts")],
    scope,
  )
  expect(moved.map((change) => change.class)).toEqual(["in-scope", "allowed-new"])
  const elsewhere = classifyChanges(
    [deleted("src/runner/runtime.ts"), added("src/engine/runtime.ts")],
    scope,
  )
  expect(elsewhere.map((change) => change.class)).toEqual(["in-scope", "divergence"])
})

test("protected wins over edit, create and derived allowance", () => {
  const scope = model({
    edit: ["src/audit/**", "src/runner/runtime.ts"],
    create: [{ path: "src/audit/new.ts", purpose: "x" }],
    protected: ["src/audit/**"],
  })
  expect(kind(modified("src/audit/a.ts"), scope)).toBe("protected")
  expect(kind(added("src/audit/new.ts"), scope)).toBe("protected")
  expect(kind(added("src/audit/deep/b.ts"), scope)).toBe("protected")
  expect(kind(deleted("src/audit/a.ts"), scope)).toBe("protected")
  expect(kind(modified("src/runner/runtime.ts"), scope)).toBe("in-scope")
})

test("a path escaping the repository is protected", () => {
  expect(kind(modified("../outside.txt"), model())).toBe("protected")
  expect(kind(modified("/etc/passwd"), model())).toBe("protected")
  expect(protectedPaths(["../x", "ok.ts"], { protected: [] })).toEqual(["../x"])
})

test("an amendment admits a divergence and may release an exact protected path", () => {
  const amended = model({
    edit: ["src/runner/runtime.ts", "src/runner/store.ts"],
    amended: ["src/runner/store.ts"],
  })
  const result = classifyChange(modified("src/runner/store.ts"), amended)
  expect(result.class).toBe("in-scope")
  expect(result.viaAmendment).toBe(true)
  expect(classifyChange(modified("src/runner/runtime.ts"), amended).viaAmendment).toBeUndefined()
  const released = model({
    edit: ["src/runner/runtime.ts", "src/audit/a.ts"],
    amended: ["src/audit/a.ts"],
    protected: ["src/audit/**"],
    released: ["src/audit/a.ts"],
  })
  expect(kind(modified("src/audit/a.ts"), released)).toBe("in-scope")
  expect(kind(modified("src/audit/b.ts"), released)).toBe("protected")
  expect(protectedPaths(["src/audit/a.ts"], released)).toEqual([])
})

test("old-style scopes classify as before, except that new siblings pass", () => {
  const scope = model({ edit: ["a.txt", "src/b.ts"] })
  expect(kind(modified("a.txt"), scope)).toBe("in-scope")
  expect(kind(modified("escape.txt"), scope)).toBe("divergence")
  expect(kind(added("escape.txt"), scope)).toBe("allowed-new")
})

test("reservations include created paths, so overlap detection sees where work will land", () => {
  const patterns = reservationPatterns(
    ["src/a/x.ts"],
    [{ path: "src/queue/" }, { path: "src/q.ts" }],
  )
  expect(patterns).toEqual(["src/a/x.ts", "src/queue/**", "src/q.ts"])
  expect(scopePatternsConflict(["src/queue/**"], patterns)).toBe(true)
  expect(scopePatternsConflict(["lib/**"], patterns)).toBe(false)
  const owners = [
    { taskID: "t1", patterns },
    { taskID: "t2", patterns: ["docs/**"] },
  ]
  expect(scopedBy("src/queue/limit.ts", owners)).toEqual(["t1"])
  expect(scopedBy("src/a/x.ts", owners)).toEqual(["t1"])
  expect(scopedBy("README.md", owners)).toEqual([])
})

test("the report separates what needs a decision from what is only shown", () => {
  const scope = model({
    edit: ["src/runner/runtime.ts"],
    create: [
      { path: "src/runner/queue-limit.ts", purpose: "queue limit" },
      { path: "src/runner/never.ts", purpose: "not created" },
    ],
  })
  const classified = classifyChanges(
    [
      modified("src/runner/runtime.ts"),
      added("src/runner/queue-limit.ts"),
      added("src/runner/helper.ts"),
      modified("src/runner/store.ts"),
      added("docs/new.md"),
    ],
    scope,
  )
  const report = buildScopeReport({
    attemptID: "attempt",
    model: scope,
    classified,
    owners: [{ taskID: "other", patterns: ["src/runner/store.ts"] }],
    amendmentReasons: [],
    warnings: [
      { path: "src/runner/runtime.ts", lines: 12000, baseLines: 11900, added: 100, kind: "grew" },
    ],
  })
  expect(report.created.map((item) => [item.path, item.class])).toEqual([
    ["src/runner/queue-limit.ts", "expected-new"],
    ["src/runner/helper.ts", "allowed-new"],
  ])
  expect(report.missingExpected).toEqual([{ path: "src/runner/never.ts", purpose: "not created" }])
  expect(report.divergences.map((item) => [item.path, item.scopedBy])).toEqual([
    ["src/runner/store.ts", ["other"]],
    ["docs/new.md", []],
  ])
  expect(divergenceReason(report)).toContain("Scope divergence needs a decision: 2 change(s)")
  expect(divergenceReason(report)).toContain("also in the scope of task other")
  const repair = scopeRepairText(report)
  expect(repair).toContain("outside the task's scope: move/remove them or say why they are needed")
  expect(repair).toContain("Consider splitting")
  const notice = scopeNotice(report)
  expect(notice).toContain("src/runner/queue-limit.ts (expected: queue limit)")
  expect(notice).toContain("Expected but not created")
  expect(notice).toContain("Size warnings")
})

test("the size signal warns on crossing the limit and on substantial growth of a large file", () => {
  const base = { path: "src/a.ts", added: 30, removed: 0 }
  expect(sizeWarning({ ...base, lines: 1200, baseLines: 900 })?.kind).toBe("crossed")
  expect(sizeWarning({ ...base, lines: 1000, baseLines: 900 })).toBeUndefined()
  expect(sizeWarning({ ...base, added: 60, lines: 3060, baseLines: 3000 })?.kind).toBe("grew")
  expect(sizeWarning({ ...base, added: 10, lines: 3010, baseLines: 3000 })).toBeUndefined()
  expect(sizeWarning({ ...base, path: "src/a.test.ts", lines: 3000, baseLines: 1 })).toBeUndefined()
  expect(sizeWarning({ ...base, path: "README.md", lines: 3000, baseLines: 1 })).toBeUndefined()
})

test("a new file inside another task's scope is reported as overlap in the notice", () => {
  const scope = model({ edit: ["src/runner/runtime.ts"] })
  const report = buildScopeReport({
    attemptID: "attempt",
    model: scope,
    classified: classifyChanges([added("src/runner/queue.ts")], scope),
    owners: [{ taskID: "other", patterns: ["src/runner/queue.ts"] }],
    amendmentReasons: [],
    warnings: [],
  })
  expect(report.created[0]!.scopedBy).toEqual(["other"])
  expect(scopeNotice(report)).toContain("also in the scope of task other (overlap risk)")
})

test("the hold reason quotes the worker's final message, or says no reason was given", () => {
  const scope = model()
  const report = buildScopeReport({
    attemptID: "a",
    model: scope,
    classified: classifyChanges([modified("README.md")], scope),
    owners: [],
    amendmentReasons: [],
    warnings: [],
  })
  expect(divergenceReason(report)).toContain("Worker's reason: no reason given")
  expect(divergenceReason(report, "  needed\nfor docs ")).toContain(
    '"needed for docs" (final message)',
  )
})
