import { Command, MenuItem, Panel, Style } from "@opencode/plugin/gui"
import type { PanelProps } from "@opencode/plugin/gui"
import type { Component } from "solid-js"
import type { RadarContext } from "./panel.tsx"
import css from "./panel.css?inline"

/** Register the native tab, view, and its session-panel entry points. */
export function registerRadarPanel(ctx: RadarContext, render: Component<PanelProps>) {
  const tab = { id: "radar", title: "Radar", closable: "hover" as const }
  const open = () => {
    const session = ctx.sessions.current()
    if (session?.location) ctx.layout.open(`${ctx.id}:radar`, session, { tab: "select" })
  }
  ctx.add(Style, css)
  ctx.add(Panel, {
    id: "radar",
    region: "side",
    list: (input) => (input.open.includes(tab.id) ? [tab] : []),
    render,
  })
  ctx.add(Command, {
    id: "radar.open",
    title: "Open LAZERS Radar",
    section: "session",
    slash: { name: "radar" },
    run: open,
  })
  ctx.add(MenuItem, {
    id: "radar.open",
    menu: "session.panel",
    title: "Radar",
    icon: "task",
    run: open,
  })
}
