import { expect, test } from "bun:test"
import { dispatchControlTransition } from "./dispatch-control-machine.ts"

test("dispatch control uses explicit XState pause and unpause transitions", () => {
  expect(dispatchControlTransition("enabled", "PAUSE")).toBe("paused")
  expect(dispatchControlTransition("paused", "PAUSE")).toBe("paused")
  expect(dispatchControlTransition("paused", "UNPAUSE")).toBe("enabled")
  expect(() => dispatchControlTransition("enabled", "UNPAUSE")).toThrow("Invalid dispatch control")
})
