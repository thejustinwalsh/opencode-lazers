import { expect, test } from "bun:test"
import type { ProfileCommands } from "../projects/profile-runtime.ts"
import {
  needsMechanicalQualityPreparation,
  recognizedVerificationPhases,
} from "./quality-failure.ts"

const cargo: ProfileCommands = {
  toolchains: ["cargo"],
  verify: ["cargo fmt --check", "cargo clippy -- -D warnings", "cargo test --locked"],
  fix: ["cargo fmt --"],
}
const mixed: ProfileCommands = {
  toolchains: ["npm", "cargo"],
  verify: ["npm run lint", "cargo test --locked"],
  fix: [],
}
const bunProfile: ProfileCommands = { toolchains: ["bun"], verify: ["bun check"], fix: [] }

test("without a profile the recogniser is today's Bun grammar", () => {
  const accepted = [
    "bun fmt",
    "bun fmt --check",
    "bun lint --fix",
    "bun check",
    "git diff --check",
    "bun run verify",
    "bun run --silent build:gui",
    "bun fmt src/a.ts",
    "bun test src/x.test.ts",
    "bun test",
    "bun fmt && bun lint --fix && bun fmt && bun check && bun test src/tasks",
  ]
  for (const command of accepted)
    expect(recognizedVerificationPhases(command), command).toEqual(command.split(" && "))
  for (const command of [
    "cargo test",
    "bun fmt ../x",
    "bun test src/x.test.ts; rm -rf /",
    "bun run a b",
    "npm run lint",
    "bun fmt && cargo test",
  ])
    expect(recognizedVerificationPhases(command), command).toBeUndefined()
})

test("without a profile, preparation is needed exactly as before", () => {
  expect(needsMechanicalQualityPreparation(["bun run verify"])).toBe(true)
  expect(needsMechanicalQualityPreparation(["bun fmt --check src/a.ts"])).toBe(true)
  expect(needsMechanicalQualityPreparation(["bun test src/a.test.ts"])).toBe(false)
  expect(needsMechanicalQualityPreparation(["cargo test --locked"])).toBe(false)
})

test("a cargo profile recognises its own commands and appended targets", () => {
  expect(recognizedVerificationPhases("cargo fmt --check && cargo test --locked", cargo)).toEqual([
    "cargo fmt --check",
    "cargo test --locked",
  ])
  expect(recognizedVerificationPhases("cargo test --locked -p core", cargo)).toEqual([
    "cargo test --locked -p core",
  ])
  expect(recognizedVerificationPhases("cargo fmt -- src/lib.rs", cargo)).toBeDefined()
  expect(recognizedVerificationPhases("cargo clippy -- -D warnings", cargo)).toBeDefined()
})

test("a profile never recognises an injected or foreign command", () => {
  for (const command of [
    "cargo test --locked; rm -rf /",
    "cargo test --locked -x;rm",
    "cargo test --locked $(id)",
    "cargo test --locked ../x",
    "cargo build",
    "bun fmt",
    "cargo test --locked && rm -rf /",
  ])
    expect(recognizedVerificationPhases(command, cargo), command).toBeUndefined()
})

test("a mixed profile recognises a chain across toolchains", () => {
  expect(recognizedVerificationPhases("npm run lint && cargo test --locked", mixed)).toEqual([
    "npm run lint",
    "cargo test --locked",
  ])
})

test("Bun's grammar applies with a profile only when bun is declared", () => {
  expect(recognizedVerificationPhases("bun fmt", bunProfile)).toEqual(["bun fmt"])
  expect(recognizedVerificationPhases("bun fmt", cargo)).toBeUndefined()
})

test("a profile triggers mechanical preparation only with a runnable fix", () => {
  expect(
    needsMechanicalQualityPreparation(["cargo test --locked"], { ...cargo, runnableFix: 1 }),
  ).toBe(true)
  expect(
    needsMechanicalQualityPreparation(["cargo test --locked"], { ...cargo, runnableFix: 0 }),
  ).toBe(false)
  expect(needsMechanicalQualityPreparation(["cargo build"], { ...cargo, runnableFix: 1 })).toBe(
    false,
  )
})
