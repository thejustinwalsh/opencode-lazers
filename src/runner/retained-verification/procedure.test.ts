import { expect, test } from "bun:test"
import { retainedProcedurePlan } from "./procedure.ts"

test("automatic formatting and lint fixes compose with behavior and type checks", () => {
  expect(
    retainedProcedurePlan(
      "bun fmt && bun lint --fix && bun fmt && bun check && bun test src/tasks",
    ),
  ).toMatchObject({
    status: "supported",
    plan: { kind: "bun-quality", targets: ["src/tasks"], projectScripts: [] },
  })
})

test.each(["bun fmt", "bun fmt --check"])(
  "the lifecycle candidate's scoped formatter retains its exact targets: %s",
  (formatter) => {
    const targets = [
      "src/progress/native.ts",
      "src/progress/native-current-idle.test.ts",
      "test/current-idle-hook",
    ]
    expect(
      retainedProcedurePlan(
        `${formatter} ${targets.join(" ")} && bun lint && bun check && git diff --check && bun run build:gui`,
      ),
    ).toMatchObject({
      status: "supported",
      plan: { kind: "bun-quality", targets, projectScripts: ["build:gui"] },
    })
  },
)

test("the observed trajectory build/test chain retains every declared step", () => {
  const command =
    "bun run build:gui && bun test src/trajectory/read.test.ts src/trajectory/tools.test.ts test/trajectory-panel"
  expect(retainedProcedurePlan(command)).toMatchObject({
    status: "supported",
    plan: {
      kind: "bun-quality",
      targets: [
        "src/trajectory/read.test.ts",
        "src/trajectory/tools.test.ts",
        "test/trajectory-panel",
      ],
      projectScripts: ["build:gui"],
    },
  })
})

test("composed checks collect tests and scripts across quality steps", () => {
  expect(
    retainedProcedurePlan(
      "bun test src/runner && bun lint && bun run build:gui && bun test test/trajectory-panel src/runner",
    ),
  ).toMatchObject({
    status: "supported",
    plan: { targets: ["src/runner", "test/trajectory-panel"], projectScripts: ["build:gui"] },
  })
})

test.each([
  "bun run build:gui && echo unbound",
  "bun run build:gui && bun test src/runner$(echo injected)",
  "bun run build:gui && bun test src/runner`echo injected`",
  "bun test src/runner && bun test ../../shared-tests",
  "bun run build:gui && bun test src/runner; echo unbound",
  "bun test src/runner || bun run build:gui",
  "bun run build:gui && ",
  "bun fmt --check ../../shared-source",
  "bun fmt src/progress/native.ts; echo unbound",
  "bun fmt --check src/progress/$(echo injected)",
  "bun fmt --config foreign.json src/progress/native.ts",
])("authorized verification commands are not restricted by a syntax allowlist: %s", (command) => {
  expect(retainedProcedurePlan(command).status).toBe("supported")
})
