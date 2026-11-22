import { expect, test } from "bun:test"
import { preparationBindingContinues, type PreparationBinding } from "./binding.ts"

const binding: PreparationBinding = {
  baseCommit: "artifact",
  workspace: "/candidate",
  command: "bun fmt src/change.ts",
  environmentIdentity: "profile-environment",
  messageID: "worker-turn",
  repairID: "repair-1",
  profileRevisionID: 7,
  scope: ["src/**"],
}

test("mechanical preparation continues only for additive scope metadata", () => {
  expect(
    preparationBindingContinues(binding, { ...binding, scope: ["src/**", "test/fixture.ts"] }),
  ).toBe(true)
  expect(preparationBindingContinues(binding, binding)).toBe(true)
  expect(preparationBindingContinues(binding, { ...binding, scope: ["test/fixture.ts"] })).toBe(
    false,
  )
})

test.each([
  ["artifact", { baseCommit: "another-artifact" }],
  ["workspace", { workspace: "/another-candidate" }],
  ["command", { command: "bun fmt src/other.ts" }],
  ["environment", { environmentIdentity: "another-profile-environment" }],
  ["worker turn", { messageID: "another-turn" }],
  ["repair lineage", { repairID: "another-repair" }],
  ["profile revision", { profileRevisionID: 8 }],
])("mechanical preparation does not continue after a changed %s", (_name, changed) => {
  expect(preparationBindingContinues(binding, { ...binding, ...changed })).toBe(false)
})

test("malformed or duplicate recorded scope cannot authorize continuation", () => {
  expect(preparationBindingContinues({ ...binding, scope: ["src/**", "src/**"] }, binding)).toBe(
    false,
  )
  expect(preparationBindingContinues({ ...binding, scope: "src/**" }, binding)).toBe(false)
})
