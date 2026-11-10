import { Show } from "solid-js"
import type { JSX } from "solid-js"
import type { TaskStateFilter } from "./state-filter.ts"
import type { ExecutionPlanGroup } from "./execution-list.ts"

export function ExecutionPlanGroupView(props: {
  group: ExecutionPlanGroup
  stateFilter: TaskStateFilter
  children: JSX.Element
}) {
  const remaining = () => ["open", "queued", "running", "blocked"].includes(props.stateFilter)
  return (
    <section
      class="lazers-tasks-plan"
      aria-label={
        props.group.hasRecordedTitle
          ? remaining()
            ? `${props.group.title}, ${props.group.nonterminalCount} remaining of ${props.group.totalCount} tasks in this plan`
            : props.group.title
          : undefined
      }
    >
      <Show when={props.group.hasRecordedTitle} fallback={props.children}>
        <details open>
          <summary class="lazers-tasks-plan-heading">
            <span>{props.group.title}</span>
            <Show when={remaining() && props.group.totalCount > 1}>
              <span>
                {props.group.nonterminalCount}/{props.group.totalCount} remaining
              </span>
            </Show>
          </summary>
          {props.children}
        </details>
      </Show>
    </section>
  )
}
