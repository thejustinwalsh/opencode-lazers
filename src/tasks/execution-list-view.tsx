import { Show } from "solid-js"
import type { JSX } from "solid-js"
import type { TaskStateFilter } from "./state-filter.ts"
import type { ExecutionPlanGroup } from "./execution-list.ts"
import { planStateLabel } from "./row-presentation.ts"

/**
 * A plan with a recorded title and more than one task gets a quiet collapsible heading.
 * One-task and untitled plans render their rows plainly; a lone task is its own identity.
 */
export function ExecutionPlanGroupView(props: {
  group: ExecutionPlanGroup
  stateFilter: TaskStateFilter
  children: JSX.Element
}) {
  const remaining = () => ["open", "queued", "running", "blocked"].includes(props.stateFilter)
  const headed = () => props.group.hasRecordedTitle && props.group.totalCount > 1
  const priority = () => props.group.priority
  const planState = () => planStateLabel(props.group.state)
  return (
    <Show when={headed()} fallback={props.children}>
      <section
        class="lazers-tasks-plan"
        role="group"
        aria-label={[
          remaining()
            ? `${props.group.title}, ${props.group.nonterminalCount} remaining of ${props.group.totalCount} tasks in this plan`
            : props.group.title,
          ...(priority() ? [`priority ${priority()}`] : []),
          ...(planState() ? [`plan ${planState()!.toLowerCase()}`] : []),
        ].join(", ")}
      >
        <details open>
          <summary class="lazers-tasks-plan-heading">
            <span>{props.group.title}</span>
            <Show when={planState()}>
              {(label) => <span class="lazers-tasks-plan-state">{label()}</span>}
            </Show>
            <Show when={priority()}>
              <span class="lazers-tasks-plan-priority" title="Scheduler priority for this plan">
                P{priority()}
              </span>
            </Show>
            <Show when={remaining()}>
              <span>
                {props.group.nonterminalCount}/{props.group.totalCount} remaining
              </span>
            </Show>
          </summary>
          {props.children}
        </details>
      </section>
    </Show>
  )
}
