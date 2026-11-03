import { Command, MenuItem, Panel, Style } from "@opencode/plugin/gui"
import type { Context, Panel as PanelDefinition, PanelTab } from "@opencode/plugin/gui"

/** Register the optional Models tab, slash command, and native panel-menu entry. */
export function registerModelsPanel(
  ctx: Pick<Context, "id" | "sessions" | "layout" | "add">,
  css: string,
  render: PanelDefinition["render"],
  label: PanelTab["label"],
) {
  const tab = {
    id: "models",
    title: "Models",
    closable: "hover" as const,
    label,
  }
  const open = () => {
    const session = ctx.sessions.current()
    if (session?.location) ctx.layout.open(`${ctx.id}:models`, session, { tab: "select" })
  }
  ctx.add(Style, css)
  ctx.add(Panel, {
    id: "models",
    region: "side",
    list: (input) => (input.open.includes(tab.id) ? [tab] : []),
    render,
  })
  ctx.add(Command, {
    id: "lz-models",
    title: "Open LAZERS models comparison",
    section: "session",
    slash: { name: "lz-models" },
    run: open,
  })
  ctx.add(MenuItem, {
    id: "models.open",
    menu: "session.panel",
    title: "Models",
    icon: "settings-gear",
    order: 50,
    run: open,
  })
}
