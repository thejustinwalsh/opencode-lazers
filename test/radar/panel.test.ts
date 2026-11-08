import { expect, test } from "bun:test"
import { Command, MenuItem, Panel, Style } from "@opencode/plugin/gui"
import type { PanelProps } from "@opencode/plugin/gui"
import type { Component } from "solid-js"
import { registerRadarPanel } from "../../src/radar/registration.ts"
import { radarProjectIdentity } from "../../src/radar/project.ts"

test("native registration exposes its closable tab and radar command without acquiring observations", () => {
  const nativeProjectID = "b5da4cadd97e51f2f6c88ff71daa1006f6a5b7df"
  const canonicalDirectory = "/workspace/opencode-lazers"
  const identity = radarProjectIdentity({ id: nativeProjectID, canonical: canonicalDirectory })
  expect(identity).toEqual({ project: canonicalDirectory, projectID: nativeProjectID })
  const session = { id: "ses-radar", location: {} }
  const opened: unknown[] = []
  const registrations: Array<{ kind: unknown; value: unknown }> = []
  const context = {
    id: "lazers",
    add: (kind: unknown, value: unknown) => registrations.push({ kind, value }),
    sessions: { current: () => session },
    layout: { open: (...args: unknown[]) => opened.push(args) },
  }
  const render: Component<PanelProps> = () => null
  registerRadarPanel(context as never, render, () => null)

  expect(registrations.some((item) => item.kind === Style)).toBe(true)
  const panel = registrations.find((item) => item.kind === Panel)?.value as {
    id: string
    region: string
    list: (input: { open: string[] }) => Array<{ id: string; title: string; closable: string }>
    render: (props: PanelProps) => unknown
  }
  expect(panel).toMatchObject({ id: "radar", region: "side" })
  expect(panel.list({ open: [] })).toEqual([])
  expect(panel.list({ open: ["radar"] })).toMatchObject([
    { id: "radar", title: "Radar", closable: "hover" },
  ])

  const command = registrations.find((item) => item.kind === Command)?.value as {
    id: string
    title: string
    slash: { name: string }
    run: () => void
  }
  const menu = registrations.find((item) => item.kind === MenuItem)?.value as {
    id: string
    run: () => void
  }
  expect(command).toMatchObject({
    id: "radar.open",
    title: "Open LAZERS Radar",
    slash: { name: "lz-radar" },
  })
  command.run()
  menu.run()
  expect(opened).toEqual([
    ["lazers:radar", session, { tab: "select" }],
    ["lazers:radar", session, { tab: "select" }],
  ])
  panel.render({} as PanelProps)
})
