import { expect, test } from "bun:test"
import { GUARDED_TEST_COMMAND, TEST_HANG_GUARD_MS, withBunTestDefaults } from "./bun-command.ts"

const timeout = `--timeout ${TEST_HANG_GUARD_MS}`
const defaults = `${timeout} --dots`

test("direct Bun test invocations gain timeout and dots defaults before their arguments", () => {
  expect(withBunTestDefaults("bun test")).toBe(`bun test ${defaults}`)
  expect(withBunTestDefaults("bun test src/a.test.ts src/b.test.ts")).toBe(
    `bun test ${defaults} src/a.test.ts src/b.test.ts`,
  )
  expect(GUARDED_TEST_COMMAND).toBe(`bun test ${timeout}`)
})

test("explicit timeouts and reporters retain precedence independently", () => {
  expect(withBunTestDefaults("bun test --timeout 30000 src/a.test.ts")).toBe(
    "bun test --dots --timeout 30000 src/a.test.ts",
  )
  expect(withBunTestDefaults("bun test src/a.test.ts --timeout=30000")).toBe(
    `bun test --dots src/a.test.ts --timeout=30000`,
  )
  expect(withBunTestDefaults("bun test --reporter spec src/a.test.ts")).toBe(
    `bun test ${timeout} --reporter spec src/a.test.ts`,
  )
  expect(withBunTestDefaults("bun test src/a.test.ts --reporter=junit")).toBe(
    `bun test ${timeout} src/a.test.ts --reporter=junit`,
  )
  expect(withBunTestDefaults("bun test --dots --timeout=9000 src/a.test.ts")).toBe(
    "bun test --dots --timeout=9000 src/a.test.ts",
  )
})

test("shell compositions are transformed once without changing quoted arguments or redirections", () => {
  const command =
    "bun test --filter 'keeps && bun test; exactly' 2>&1 >tests.log && bun test --reporter spec src/b.test.ts 2>&1"
  const expected =
    `bun test ${defaults} --filter 'keeps && bun test; exactly' 2>&1 >tests.log && ` +
    `bun test ${timeout} --reporter spec src/b.test.ts 2>&1`
  const effective = withBunTestDefaults(command)

  expect(effective).toBe(expected)
  expect(withBunTestDefaults(effective)).toBe(effective)
})

test("top-level pipes and alternative command separators preserve surrounding shell text", () => {
  expect(withBunTestDefaults("printf 'x | y' | bun test a.test.ts | tee result.log")).toBe(
    `printf 'x | y' | bun test ${defaults} a.test.ts | tee result.log`,
  )
  expect(withBunTestDefaults("bun fmt || bun test a.test.ts ; bun test b.test.ts")).toBe(
    `bun fmt || bun test ${defaults} a.test.ts ; bun test ${defaults} b.test.ts`,
  )
  expect(withBunTestDefaults("bun test a.test.ts 2>&1 && echo done")).toBe(
    `bun test ${defaults} a.test.ts 2>&1 && echo done`,
  )
  expect(withBunTestDefaults("bun test a.test.ts & echo done")).toBe(
    `bun test ${defaults} a.test.ts & echo done`,
  )
})

test("option-looking filter values do not suppress runtime defaults", () => {
  expect(
    withBunTestDefaults("bun test --filter '--timeout 5000 --reporter spec' src/a.test.ts"),
  ).toBe(`bun test ${defaults} --filter '--timeout 5000 --reporter spec' src/a.test.ts`)
})

test("non-Bun tests, scripts, and arbitrary text are unchanged", () => {
  for (const command of [
    "bun run verify",
    "bun run test src/a.test.ts",
    "bun fmt && bun lint --fix",
    "pytest -x",
    "npm test",
    "bun testing",
    "echo bun test",
    "git diff --check",
  ])
    expect(withBunTestDefaults(command)).toBe(command)
})

test("command normalization is idempotent across composed checks", () => {
  const command =
    "bun run build && bun test --timeout=30 a.test.ts || bun test --reporter dots b.test.ts"
  const once = withBunTestDefaults(command)
  expect(withBunTestDefaults(once)).toBe(once)
})
