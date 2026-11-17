import { For, Show } from "solid-js"
import type { TaskStateFilter } from "./state-filter.ts"
import type { ExecutionPlanGroup } from "./execution-list.ts"
import { planStateLabel } from "./row-presentation.ts"

/**
 * A titled plan's heading: a quiet collapse control plus scheduler facts (priority, plan order,
 * prerequisites). It is one item of the flat virtual list; its tasks are sibling items, hidden when
 * collapsed. The scheduling reason stays one line here; the inspector carries the full text.
 */
export function ExecutionPlanHeading(props: {
  group: ExecutionPlanGroup
  stateFilter: TaskStateFilter
  collapsed: boolean
  onToggle: () => void
  onOpenPlan?: (planID: string) => void
  planTitle?: (planID: string) => string | undefined
}) {
  const remaining = () => ["open", "queued", "running", "blocked"].includes(props.stateFilter)
  const afterPlans = () => props.group.afterPlans ?? []
  const planState = () => planStateLabel(props.group.state)
  const planName = (planID: string) => props.planTitle?.(planID) ?? `Plan ${planID.slice(0, 8)}`
  return (
    <div class="lazers-tasks-plan" role="none" data-collapsed={props.collapsed}>
      <button
        type="button"
        class="lazers-tasks-plan-heading"
        aria-expanded={!props.collapsed}
        aria-label={[
          remaining()
            ? `${props.group.title}, ${props.group.nonterminalCount} remaining of ${props.group.totalCount} tasks in this plan`
            : props.group.title,
          ...(props.group.priority !== undefined ? [`priority ${props.group.priority}`] : []),
          ...(props.group.planOrder !== undefined
            ? [`plan order ${props.group.planOrder + 1}`]
            : []),
          ...(planState() ? [`plan ${planState()!.toLowerCase()}`] : []),
        ].join(", ")}
        onClick={() => props.onToggle()}
      >
        <span>{props.group.title}</span>
        <span class="lazers-tasks-plan-order">
          <Show when={planState()}>
            {(label) => <span class="lazers-tasks-plan-state">{label()}</span>}
          </Show>
          <Show when={props.group.priority !== undefined}>
            <span title="Scheduler priority for this plan">Priority {props.group.priority}</span>
          </Show>
          <Show when={props.group.planOrder !== undefined}>
            <span title="Scheduler plan order">Order {props.group.planOrder! + 1}</span>
          </Show>
          <Show when={remaining() && props.group.totalCount > 1}>
            <span>
              {props.group.nonterminalCount}/{props.group.totalCount} remaining
            </span>
          </Show>
        </span>
      </button>
      <Show when={props.group.schedulingReason || afterPlans().length}>
        <div class="lazers-tasks-plan-reason">
          <Show when={afterPlans().length}>
            <span class="lazers-tasks-plan-after">
              <span>After </span>
              <For each={afterPlans()}>
                {(planID, index) => (
                  <>
                    {index() ? ", " : ""}
                    <button
                      type="button"
                      class="lazers-tasks-dependency-ref"
                      aria-label={`Open prerequisite plan ${planName(planID)} (${planID})`}
                      title={planID}
                      onClick={() => props.onOpenPlan?.(planID)}
                    >
                      {planName(planID)}
                    </button>
                  </>
                )}
              </For>
            </span>
          </Show>
          <Show when={props.group.schedulingReason}>
            {(reason) => (
              <span class="lazers-tasks-plan-reason-text" title={reason()}>
                {reason()}
              </span>
            )}
          </Show>
        </div>
      </Show>
    </div>
  )
}
