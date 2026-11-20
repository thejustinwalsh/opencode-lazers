import { expect, test } from "bun:test"
import { profileFixChain } from "./profile-fix.ts"

test("each entry gets the changed paths its globs select, in profile order", () => {
  const chain = profileFixChain(
    [
      { index: 0, command: "fmt", files: ["**/*.rs"] },
      { index: 1, command: "lint" },
    ],
    ["src/a.rs", "README.md"],
  )
  expect(chain?.command).toBe("fmt 'src/a.rs' && lint 'src/a.rs' 'README.md'")
  expect(chain?.steps.map((step) => step.index)).toEqual([0, 1])
})

test("a path with a quote is quoted for the shell", () => {
  expect(profileFixChain([{ index: 0, command: "fmt" }], ["it's.rs"])?.command).toBe(
    "fmt 'it'\\''s.rs'",
  )
})

test("an entry with no matching path is omitted; none left is undefined", () => {
  expect(
    profileFixChain(
      [
        { index: 0, command: "fmt", files: ["**/*.py"] },
        { index: 3, command: "lint", files: ["**/*.rs"] },
      ],
      ["a.rs"],
    )?.steps,
  ).toEqual([{ index: 3, command: "lint", paths: ["a.rs"] }])
  expect(
    profileFixChain([{ index: 0, command: "fmt", files: ["**/*.py"] }], ["a.rs"]),
  ).toBeUndefined()
  expect(profileFixChain([], ["a.rs"])).toBeUndefined()
  expect(profileFixChain([{ index: 0, command: "fmt" }], [])).toBeUndefined()
})
