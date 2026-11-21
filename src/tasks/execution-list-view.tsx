import { For, Show } from "solid-js"
import type { TaskStateFilter } from "./state-filter.ts"
import type { ExecutionPlanGroup } from "./execution-list.ts"
import { planStateLabel } from "./row-presentation.ts"

/**
 * A titled plan's heading: a top-level tree item that collapses its rows (aria-level 2 siblings that
 * follow it), plus scheduler facts (priority, plan order, prerequisites). It is one item of the flat
 * virtual list; its rows are hidden when collapsed. The scheduling reason stays one line here; the
 * inspector carries the full text.
 */
export function ExecutionPlanHeading(props: {
  group: ExecutionPlanGroup
  stateFilter: TaskStateFilter
  showRemaining?: boolean
  collapsed: boolean
  setSize: number
  posInSet: number
  tabIndex: number
  onToggle: () => void
  onKeyDown: (event: KeyboardEvent & { currentTarget: HTMLDivElement; target: Element }) => void
  onOpenPlan?: (planID: string) => void
  planTitle?: (planID: string) => string | undefined
}) {
  const remaining = () =>
    props.showRemaining ?? ["open", "queued", "running", "blocked"].includes(props.stateFilter)
  const afterPlans = () => props.group.afterPlans ?? []
  const planState = () => planStateLabel(props.group.state)
  const planName = (planID: string) => props.planTitle?.(planID) ?? `Plan ${planID.slice(0, 8)}`
  return (
    <div
      class="lazers-tasks-plan"
      role="treeitem"
      data-plan-id={props.group.planID}
      data-item-key={`plan:${props.group.planID}`}
      data-collapsed={props.collapsed}
      aria-level={1}
      aria-setsize={props.setSize}
      aria-posinset={props.posInSet}
      aria-expanded={!props.collapsed}
      aria-label={[
        remaining()
          ? `${props.group.title}, ${props.group.nonterminalCount} remaining of ${props.group.totalCount} tasks in this plan`
          : props.group.title,
        ...(props.group.priority !== undefined ? [`priority ${props.group.priority}`] : []),
        ...(props.group.planOrder !== undefined ? [`plan order ${props.group.planOrder + 1}`] : []),
        ...(planState() ? [`plan ${planState()!.toLowerCase()}`] : []),
      ].join(", ")}
      tabIndex={props.tabIndex}
      onKeyDown={(event) => props.onKeyDown(event)}
    >
      <div
        class="lazers-tasks-plan-heading"
        title={props.collapsed ? "Expand plan" : "Collapse plan"}
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
      </div>
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
