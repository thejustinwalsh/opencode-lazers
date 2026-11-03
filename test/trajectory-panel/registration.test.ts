import { expect, test } from "bun:test"
import { Command, MenuItem, Panel, Style } from "@opencode/plugin/gui"
import { registerTrajectoryPanel } from "../../src/trajectory-panel/registration.ts"

test("Trajectory registers as a closable optional panel with command and session menu entry", () => {
  const registrations: Array<{ token: unknown; value: unknown }> = []
  const session = { id: "ses-trajectory", location: {} }
  const opened: unknown[][] = []
  const context = {
    id: "lazers",
    add: (token: unknown, value: unknown) => {
      registrations.push({ token, value })
      return () => {}
    },
    sessions: { current: () => session },
    layout: { open: (...args: unknown[]) => opened.push(args) },
  }
  registerTrajectoryPanel(
    context as never,
    "trajectory-css",
    () => null,
    () => null,
  )

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
  expect(contribution.list({ open: ["trajectory"] })).toMatchObject([
    { id: "trajectory", title: "Trajectory", closable: "hover" },
  ])
  expect(typeof contribution.render).toBe("function")
  const command = registrations.find(({ token }) => token === Command)?.value as {
    id: string
    title: string
    slash: { name: string }
    run: () => void
  }
  expect(command).toMatchObject({
    id: "trajectory.open",
    title: "Open LAZERS trajectory",
    slash: { name: "lz-trajectory" },
  })
  command.run()
  expect(opened).toEqual([["lazers:trajectory", session, { tab: "select" }]])
  expect(
    registrations.some(
      ({ token, value }) =>
        token === MenuItem &&
        (value as { id?: string; title?: string }).id === "trajectory.open" &&
        (value as { title?: string }).title === "Trajectory",
    ),
  ).toBe(true)
})
