import { For } from "solid-js"
import type { Ui } from "@opencode/plugin/gui"
import type { ConnectionChip } from "./monitor-model.ts"

export type RadarViewChoice = "monitor" | "map" | "flow"
export type RadarScopeChoice = "session" | "project" | "project-all"

export const SCOPE_LABEL: Record<RadarScopeChoice, string> = {
  session: "This session",
  project: "Project",
  "project-all": "Project · all sessions",
}

const VIEWS: Array<{ id: RadarViewChoice; label: string }> = [
  { id: "monitor", label: "Monitor" },
  { id: "map", label: "Map" },
  { id: "flow", label: "Flow" },
]

/**
 * The one Radar header. Monitor, Map and Flow all render it with the same parts in the same
 * places, so switching views moves nothing.
 */
export function RadarHeader(props: {
  ui: Ui
  view: RadarViewChoice
  onView: (view: RadarViewChoice) => void
  scope: RadarScopeChoice
  onScope: (choice: RadarScopeChoice) => void
  connection: ConnectionChip
  onRefresh: () => void
  ref?: (element: HTMLElement) => void
}) {
  const Ui = props.ui
  return (
    <header class="lazers-radar-header" ref={props.ref}>
      <h2>Radar</h2>
      <div class="lazers-radar-views" role="tablist" aria-label="Radar view">
        <For each={VIEWS}>
          {(item) => (
            <button
              type="button"
              role="tab"
              aria-selected={props.view === item.id}
              onClick={() => props.onView(item.id)}
            >
              {item.label}
            </button>
          )}
        </For>
      </div>
      <span
        class="lazers-radar-connection"
        data-state={props.connection.state}
        title={props.connection.detail}
      >
        <span class="lazers-radar-connection-dot" aria-hidden="true" />
        <span role="status">{props.connection.word}</span>
      </span>
      <span class="lazers-radar-scope">
        <Ui.Menu
          label={SCOPE_LABEL[props.scope]}
          trigger="button"
          icon="chevron-down"
          placement="bottom-start"
          items={(["session", "project", "project-all"] as const).map((choice) => ({
            label: SCOPE_LABEL[choice],
            icon: choice === props.scope ? ("check-small" as const) : undefined,
            onSelect: () => props.onScope(choice),
          }))}
        />
      </span>
      <Ui.Menu
        label="Radar actions"
        icon="outline-dots"
        items={[{ label: "Refresh", icon: "refresh", onSelect: props.onRefresh }]}
      />
    </header>
  )
}
