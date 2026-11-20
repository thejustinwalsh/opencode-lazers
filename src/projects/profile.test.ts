import { expect, test } from "bun:test"
import {
  credentialLikeEnv,
  parseProfile,
  profileDiff,
  ProjectProfileSchema,
  type ProjectProfile,
} from "./profile.ts"

const fmt = ["**/*.{json,md,ts,tsx}"]
const lazers = {
  toolchains: ["bun"],
  verify: [
    { id: "format", command: "bun fmt --check" },
    { id: "lint", command: "bun lint" },
    { id: "types", command: "bun check" },
    { id: "tests", command: "bun test --timeout 120000" },
  ],
  fix: [
    { command: "bun fmt", files: fmt },
    { command: "bun lint --fix", files: ["**/*.{ts,tsx}"] },
    { command: "bun fmt", files: fmt },
  ],
  env: [],
  audit: "fallow",
  source: { include: ["src/**/*.ts", "src/**/*.tsx"], exclude: ["**/*.test.ts"] },
}
const rust = {
  toolchains: ["cargo"],
  verify: [{ id: "tests", command: "cargo test" }],
  fix: [
    { command: "cargo fmt", files: ["**/*.rs"] },
    { command: "cargo clippy --fix --allow-dirty", files: ["**/*.rs"] },
  ],
  env: [],
  audit: "off",
  source: { include: ["src/**/*.rs"], exclude: [] },
}
const issuesOf = (value: unknown) => {
  const parsed = parseProfile(value)
  if (parsed.ok) throw new Error("expected issues")
  return parsed.issues
}
const profileOf = (value: unknown): ProjectProfile => {
  const parsed = parseProfile(value)
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  return parsed.profile
}

test("a valid profile parses and the schema accepts the same value", () => {
  expect(profileOf(lazers)).toEqual(lazers as ProjectProfile)
  expect(ProjectProfileSchema.safeParse(lazers).success).toBe(true)
  const bad = ProjectProfileSchema.safeParse({ ...lazers, verify: [] })
  expect(bad.success).toBe(false)
})

test("each rejection names its code and field path", () => {
  const cases: [unknown, string, string][] = [
    [{ ...lazers, verify: [] }, "VERIFY_EMPTY", "verify"],
    [{ ...lazers, source: { include: [], exclude: [] } }, "SOURCE_INCLUDE_EMPTY", "source.include"],
    [{ ...lazers, audit: "eslint" }, "AUDIT_UNKNOWN", "audit"],
    [
      {
        ...lazers,
        verify: [
          { id: "tests", command: "a" },
          { id: "tests", command: "b" },
        ],
      },
      "VERIFY_ID_DUPLICATE",
      "verify[1].id",
    ],
    [{ ...lazers, verify: [{ id: "Bad", command: "a" }] }, "VERIFY_ID_INVALID", "verify[0].id"],
    [
      { ...lazers, verify: [{ id: "t", command: "cargo test\nrm -rf ~" }] },
      "COMMAND_INVALID",
      "verify[0].command",
    ],
    [{ ...lazers, verify: [{ id: "t", command: "  " }] }, "COMMAND_INVALID", "verify[0].command"],
    [{ ...lazers, env: ["HOME"] }, "ENV_RESERVED", "env[0]"],
    [{ ...lazers, env: ["cargo_home"] }, "ENV_INVALID", "env[0]"],
    [{ ...lazers, toolchains: ["Rust"] }, "TOOLCHAIN_INVALID", "toolchains[0]"],
    [
      { ...lazers, source: { ...lazers.source, exports: "rust" } },
      "EXPORTS_DEFERRED",
      "source.exports",
    ],
    [{ ...lazers, timeouts: {} }, "FIELD_UNKNOWN", "timeouts"],
    [{ ...lazers, install: "make\tdeps\u0007" }, "COMMAND_INVALID", "install"],
  ]
  for (const [value, code, path] of cases)
    expect(issuesOf(value).map((i) => `${i.code}@${i.path}`)).toContain(`${code}@${path}`)
  for (const glob of ["src\\**\\*.rs", "/abs/**", "../x/**"])
    expect(
      issuesOf({ ...lazers, fix: [{ command: "x", files: [glob] }] }).map(
        (i) => `${i.code}@${i.path}`,
      ),
    ).toContain("GLOB_INVALID@fix[0].files[0]")
  expect(issuesOf({ ...lazers, fix: [{ command: "x", files: [] }] })[0]?.code).toBe("GLOB_INVALID")
  expect(issuesOf(null)[0]?.code).toBe("FIELD_UNKNOWN")
})

test("no manifest: an empty toolchain list is valid", () => {
  const profile = profileOf({
    verify: [{ id: "check", command: "./check.sh" }],
    source: { include: ["scripts/**"] },
  })
  expect(profile.toolchains).toEqual([])
  expect(profile.audit).toBe("fallow")
})

test("diff against nothing adds every entry", () => {
  const changes = profileDiff(undefined, profileOf(lazers))
  const count = (field: string) =>
    changes.filter((c) => c.field === field && c.kind === "added").length
  expect(count("verify")).toBe(4)
  expect(count("fix")).toBe(3)
  expect(count("toolchains")).toBe(1)
  expect(count("source.include")).toBe(2)
  expect(count("source.exclude")).toBe(1)
  expect(changes.find((c) => c.field === "audit")).toMatchObject({ kind: "added", after: "fallow" })
  expect(changes.every((c) => c.kind === "added")).toBe(true)
})

test("diff reports exactly the verbatim changes", () => {
  const a = profileOf(rust)
  const b = profileOf({
    ...rust,
    verify: [{ id: "tests", command: "cargo test --locked" }],
    fix: [rust.fix[0]],
    env: ["RUSTUP_HOME"],
  })
  expect(profileDiff(a, b)).toEqual([
    {
      field: "verify",
      kind: "changed",
      key: "tests",
      before: "cargo test",
      after: "cargo test --locked",
    },
    { field: "fix", kind: "removed", key: "1", before: "cargo clippy --fix --allow-dirty" },
    { field: "env", kind: "added", key: "RUSTUP_HOME", after: "RUSTUP_HOME" },
  ])
  expect(profileDiff(a, a)).toEqual([])
})

test("a changed files list is one entry; a reorder is visible", () => {
  const a = profileOf(rust)
  const files = profileDiff(
    a,
    profileOf({
      ...rust,
      fix: [{ command: "cargo fmt", files: ["src/**/*.rs", "tests/**/*.rs"] }, rust.fix[1]],
    }),
  )
  expect(files).toEqual([
    {
      field: "fix",
      kind: "changed",
      key: "0",
      before: "**/*.rs",
      after: "src/**/*.rs,tests/**/*.rs",
    },
  ])
  const two = profileOf({
    ...rust,
    verify: [
      { id: "a", command: "x" },
      { id: "b", command: "y" },
    ],
  })
  const swapped = profileOf({
    ...rust,
    verify: [
      { id: "b", command: "y" },
      { id: "a", command: "x" },
    ],
  })
  expect(profileDiff(two, swapped)).toEqual([
    { field: "verify", kind: "changed", key: "order", before: "a,b", after: "b,a" },
  ])
})

test("credential-looking variable names are flagged", () => {
  expect(credentialLikeEnv("NPM_TOKEN")).toBe(true)
  expect(credentialLikeEnv("AWS_SECRET_ACCESS_KEY")).toBe(true)
  expect(credentialLikeEnv("CARGO_HOME")).toBe(false)
})
