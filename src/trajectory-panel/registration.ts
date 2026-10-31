import { Command, MenuItem, Panel, Style } from "@opencode/plugin/gui"
import type { Context, Panel as PanelDefinition } from "@opencode/plugin/gui"

const tab = { id: "trajectory", title: "Trajectory", closable: "hover" as const }

export function registerTrajectoryPanel(
  ctx: Pick<Context, "id" | "sessions" | "layout" | "add">,
  css: string,
  render: PanelDefinition["render"],
) {
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
    slash: { name: "trajectory" },
    run: open,
  })
  ctx.add(MenuItem, {
    id: "trajectory.open",
    menu: "session.panel",
    title: "Trajectory",
    icon: "task",
    run: open,
  })
}
