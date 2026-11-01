import { Show } from "solid-js"
import type { JSX } from "solid-js"
import type { TaskStateFilter } from "./state-filter.ts"
import type { ExecutionPlanGroup } from "./execution-list.ts"

export function ExecutionPlanGroupView(props: {
  group: ExecutionPlanGroup
  stateFilter: TaskStateFilter
  children: JSX.Element
}) {
  const open = () => props.stateFilter === "open"
  return (
    <section
      class="lazers-tasks-plan"
      aria-label={
        open()
          ? `${props.group.title}, ${props.group.activeCount} active of ${props.group.totalCount} tasks`
          : props.group.title
      }
    >
      <div class="lazers-tasks-plan-heading">
        <span>{props.group.title}</span>
        <Show when={open()}>
          <span>
            {props.group.activeCount}/{props.group.totalCount}
          </span>
        </Show>
      </div>
      {props.children}
    </section>
  )
}
