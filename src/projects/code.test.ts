import { expect, test } from "bun:test"
import { REFERENCE_PATTERN, projectCodeFrom, uniqueProjectCode } from "./code.ts"

test.each([
  ["opencode-native-settlement", "ONS"],
  ["opencode-lazers", "OL"],
  ["runntime", "RUN"],
  ["three-flatland", "TF"],
  ["thejustinwalsh.github.io", "TGI"],
  ["a", "AX"],
  ["42", "PX"],
  ["héllo wörld", "HW"],
  ["one two three four five", "OTTF"],
  ["日本語", "PX"],
  ["ab", "AB"],
])("projectCodeFrom(%s) is %s", (name, code) => expect(projectCodeFrom(name)).toBe(code))

test("a clash appends the lowest free number", () => {
  expect(uniqueProjectCode("APP", new Set())).toBe("APP")
  expect(uniqueProjectCode("APP", new Set(["APP"]))).toBe("APP2")
  expect(uniqueProjectCode("APP", new Set(["APP", "APP2"]))).toBe("APP3")
})

test("the reference pattern matches coded references only", () => {
  expect("see ONS2-14 and LZ-9".match(new RegExp(REFERENCE_PATTERN, "g"))).toEqual([
    "ONS2-14",
    "LZ-9",
  ])
  expect(REFERENCE_PATTERN.test("lz-9")).toBe(false)
})
