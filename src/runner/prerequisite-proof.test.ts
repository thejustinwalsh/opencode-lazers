import { expect, test } from "bun:test"
import {
  evaluatePrerequisiteIntegration,
  type PrerequisiteIntegrationRow,
} from "./prerequisite-proof.ts"

const directory = "/project"
const artifact = "a".repeat(40)
const head = "b".repeat(40)
const baseline = "c".repeat(40)
const row = (): PrerequisiteIntegrationRow => ({
  plan_id: "parent",
  project_directory: directory,
  state: "integrated",
  artifact,
  accepted_id: 2,
  accepted_version: 3,
  accepted_payload: JSON.stringify({ artifact }),
  integration_id: 4,
  integration_version: 3,
  integration_payload: JSON.stringify({ artifact, head, branch: "main", reason: "reviewed" }),
  invalidation_id: 1,
})
const recorder = () => {
  const calls: string[][] = []
  return {
    calls,
    git: (_directory: string, args: string[]) => {
      calls.push(args)
      return args[0] === "rev-parse" ? baseline : ""
    },
  }
}

test("valid integration retains every Git check for dispatch and selected-baseline proof", () => {
  for (const state of ["cleaning", "cleanup-blocked", "integrated"]) {
    for (const selected of [undefined, baseline]) {
      const probe = recorder()
      expect(
        evaluatePrerequisiteIntegration(
          directory,
          ["parent"],
          [{ ...row(), state }],
          probe.git,
          selected,
        ),
      ).toBe(baseline)
      expect(probe.calls).toEqual([
        ...(selected === undefined ? [["rev-parse", "HEAD"]] : []),
        ["rev-parse", `${baseline}^{commit}`],
        ["merge-base", "--is-ancestor", artifact, head],
        ["merge-base", "--is-ancestor", head, baseline],
        ["merge-base", "--is-ancestor", artifact, baseline],
      ])
    }
  }
})

test("all durable evidence is validated before starting any Git process", () => {
  const invalid: Partial<PrerequisiteIntegrationRow>[] = [
    { project_directory: "/foreign" },
    { plan_id: "foreign" },
    { state: "cancelled" },
    { artifact: null },
    { accepted_id: null },
    { accepted_version: null },
    { integration_id: null },
    { integration_version: null },
    { accepted_id: 4 },
    { integration_version: 2 },
    { invalidation_id: 2 },
    { invalidation_id: NaN },
    { accepted_payload: "{broken" },
    { accepted_payload: "null" },
    { accepted_payload: JSON.stringify({ artifact: head }) },
    { integration_payload: "[]" },
    { integration_payload: "{broken" },
    {
      integration_payload: JSON.stringify({
        artifact: head,
        head,
        branch: "main",
        reason: "reviewed",
      }),
    },
    { integration_payload: JSON.stringify({ artifact, head, branch: " ", reason: "reviewed" }) },
    { integration_payload: JSON.stringify({ artifact, head, branch: "main", reason: " " }) },
    {
      integration_payload: JSON.stringify({
        artifact,
        head: "bad",
        branch: "main",
        reason: "reviewed",
      }),
    },
  ]
  for (const change of invalid) {
    const probe = recorder()
    expect(
      evaluatePrerequisiteIntegration(directory, ["parent"], [{ ...row(), ...change }], probe.git),
    ).toBeUndefined()
    expect(probe.calls).toEqual([])
  }
  const probe = recorder()
  expect(
    evaluatePrerequisiteIntegration(
      directory,
      ["parent", "second"],
      [row(), { ...row(), plan_id: "second", accepted_id: null }],
      probe.git,
    ),
  ).toBeUndefined()
  expect(evaluatePrerequisiteIntegration(directory, ["parent"], [], probe.git)).toBeUndefined()
  expect(
    evaluatePrerequisiteIntegration(directory, ["parent", "parent"], [row(), row()], probe.git),
  ).toBeUndefined()
  expect(probe.calls).toEqual([])
})

test("changed evidence and ancestry are rechecked on every decision without a cached pass", () => {
  const current = row()
  const probe = recorder()
  expect(evaluatePrerequisiteIntegration(directory, ["parent"], [current], probe.git)).toBe(
    baseline,
  )
  current.invalidation_id = current.accepted_id
  probe.calls.length = 0
  expect(
    evaluatePrerequisiteIntegration(directory, ["parent"], [current], probe.git),
  ).toBeUndefined()
  expect(probe.calls).toEqual([])
  current.accepted_id = 5
  current.integration_id = 6
  current.artifact = "d".repeat(40)
  current.accepted_payload = JSON.stringify({ artifact: current.artifact })
  current.integration_payload = JSON.stringify({
    artifact: current.artifact,
    head,
    branch: "changed",
    reason: "fresh integration",
  })
  expect(evaluatePrerequisiteIntegration(directory, ["parent"], [current], probe.git)).toBe(
    baseline,
  )
  expect(probe.calls[2]).toEqual(["merge-base", "--is-ancestor", current.artifact, head])
  for (let failAt = 0; failAt < 5; failAt++) {
    let calls = 0
    expect(
      evaluatePrerequisiteIntegration(directory, ["parent"], [current], (_directory, args) => {
        if (calls++ === failAt) throw new Error("Git evidence unavailable")
        return args[0] === "rev-parse" ? baseline : ""
      }),
    ).toBeUndefined()
    expect(calls).toBe(failAt + 1)
  }
})
