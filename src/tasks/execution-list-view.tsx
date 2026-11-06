import { Show } from "solid-js"
import type { JSX } from "solid-js"
import type { TaskStateFilter } from "./state-filter.ts"
import type { ExecutionPlanGroup } from "./execution-list.ts"

export function ExecutionPlanGroupView(props: {
  group: ExecutionPlanGroup
  stateFilter: TaskStateFilter
  children: JSX.Element
}) {
  const nonterminal = () => ["open", "queued", "running", "blocked"].includes(props.stateFilter)
  return (
    <section
      class="lazers-tasks-plan"
      aria-label={
        nonterminal()
          ? `${props.group.title}, ${props.group.nonterminalCount} nonterminal of ${props.group.totalCount} tasks in this plan`
          : props.group.title
      }
    >
      <div class="lazers-tasks-plan-heading">
        <span>{props.group.title}</span>
        <Show when={nonterminal()}>
          <span>
            {props.group.nonterminalCount}/{props.group.totalCount} nonterminal
          </span>
        </Show>
      </div>
      {props.children}
    </section>
  )
}
