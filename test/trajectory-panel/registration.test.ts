import { expect, test } from "bun:test"
import { Command, MenuItem, Panel, Style } from "@opencode/plugin/gui"
import { registerTrajectoryPanel } from "../../src/trajectory-panel/registration.ts"

test("Trajectory registers as a closable optional panel with command and session menu entry", () => {
  const registrations: Array<{ token: unknown; value: unknown }> = []
  const context = {
    id: "lazers",
    add: (token: unknown, value: unknown) => {
      registrations.push({ token, value })
      return () => {}
    },
  }
  registerTrajectoryPanel(context as never, "trajectory-css", () => null)

  expect(
    registrations.some(({ token, value }) => token === Style && typeof value === "string"),
  ).toBe(true)
  const contribution = registrations.find(({ token }) => token === Panel)?.value as {
    id: string
    region: string
    list: (input: { open: string[] }) => Array<{ id: string; title: string; closable: string }>
    render: unknown
  }
  expect(contribution).toBeDefined()
  expect(contribution.id).toBe("trajectory")
  expect(contribution.region).toBe("side")
  expect(contribution.list({ open: [] })).toEqual([])
  expect(contribution.list({ open: ["trajectory"] })).toEqual([
    { id: "trajectory", title: "Trajectory", closable: "hover" },
  ])
  expect(typeof contribution.render).toBe("function")
  expect(
    registrations.some(
      ({ token, value }) =>
        token === Command && (value as { id?: string }).id === "trajectory.open",
    ),
  ).toBe(true)
  expect(
    registrations.some(
      ({ token, value }) =>
        token === MenuItem &&
        (value as { id?: string; title?: string }).id === "trajectory.open" &&
        (value as { title?: string }).title === "Trajectory",
    ),
  ).toBe(true)
})
