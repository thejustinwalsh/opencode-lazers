import { Command, MenuItem, Panel, Style } from "@opencode/plugin/gui"
import type { Context, Panel as PanelDefinition, PanelTab } from "@opencode/plugin/gui"

export function registerTrajectoryPanel(
  ctx: Pick<Context, "id" | "sessions" | "layout" | "add">,
  css: string,
  render: PanelDefinition["render"],
  label: PanelTab["label"],
) {
  const tab = {
    id: "trajectory",
    title: "Trajectory",
    closable: "hover" as const,
    label,
  }
  const open = () => {
    const session = ctx.sessions.current()
    if (session?.location) ctx.layout.open(`${ctx.id}:trajectory`, session, { tab: "select" })
  }
  ctx.add(Style, css)
  ctx.add(Panel, {
    id: "trajectory",
    region: "side",
    list: (input) => (input.open.includes(tab.id) ? [tab] : []),
    render,
  })
  ctx.add(Command, {
    id: "trajectory.open",
    title: "Open LAZERS trajectory",
    section: "session",
    slash: { name: "lz-trajectory" },
    run: open,
  })
  ctx.add(MenuItem, {
    id: "trajectory.open",
    menu: "session.panel",
    title: "Trajectory",
    icon: "branch",
    order: 60,
    run: open,
  })
}
