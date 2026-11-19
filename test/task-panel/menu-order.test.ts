import { expect, test } from "bun:test"
import { MenuItem } from "@opencode/plugin/gui"
import { registerModelsPanel } from "../../src/models/registration.ts"
import { registerRadarPanel } from "../../src/radar/registration.ts"
import { registerTrajectoryPanel } from "../../src/trajectory-panel/registration.ts"

// OpenCode's own `session.panel` items end at Files 30 and sort ascending by `order ?? 0`, so an
// item without an order lists ahead of them. Tasks 40 is asserted in menu-tab.test.ts.
const NATIVE_LAST = 30

function menuItem(register: (ctx: never) => void) {
  const added: Array<{ token: unknown; value: Record<string, unknown> }> = []
  const ctx = {
    id: "lazers",
    add: (token: unknown, value: Record<string, unknown>) => added.push({ token, value }),
    sessions: { current: () => undefined },
    layout: { open: () => {} },
  }
  register(ctx as never)
  return added.find((item) => item.token === MenuItem)!.value
}

test("every LAZERS side-panel menu item lists after OpenCode's own and has an icon", () => {
  const items = [
    menuItem((ctx) => registerModelsPanel(ctx, "", (() => null) as never, (() => null) as never)),
    menuItem((ctx) =>
      registerTrajectoryPanel(
        ctx,
        "",
        () => null,
        () => null,
      ),
    ),
    menuItem((ctx) =>
      registerRadarPanel(
        ctx,
        () => null,
        () => null,
      ),
    ),
  ]
  expect(items.map((item) => item.title)).toEqual(["Models", "Trajectory", "Radar"])
  for (const item of items) {
    expect(item.menu).toBe("session.panel")
    expect(item.order as number).toBeGreaterThan(NATIVE_LAST)
    expect(typeof item.icon).toBe("string")
  }
  // Tasks is 40. Models is settings-like, so it closes the list.
  const byOrder = items.toSorted((a, b) => (a.order as number) - (b.order as number))
  expect(byOrder.map((item) => item.title)).toEqual(["Trajectory", "Radar", "Models"])
  expect(byOrder[0]!.order as number).toBeGreaterThan(40)
})
