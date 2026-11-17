import { For, Show } from "solid-js"
import type { TaskStateFilter } from "./state-filter.ts"
import type { ExecutionPlanGroup } from "./execution-list.ts"
import { planStateLabel } from "./row-presentation.ts"

/**
 * A titled plan's heading: a top-level tree item that collapses its rows (aria-level 2 siblings that
 * follow it), plus scheduler facts (priority, plan order, prerequisites). It is one item of the flat
 * virtual list; its rows are hidden when collapsed. The heading stays one line; full scheduling
 * details are available from its inline disclosure.
 */
export function ExecutionPlanHeading(props: {
  group: ExecutionPlanGroup
  stateFilter: TaskStateFilter
  collapsed: boolean
  setSize: number
  posInSet: number
  tabIndex: number
  onToggle: () => void
  onKeyDown: (event: KeyboardEvent & { currentTarget: HTMLDivElement; target: Element }) => void
  onOpenPlan?: (planID: string) => void
  planTitle?: (planID: string) => string | undefined
}) {
  const remaining = () => ["open", "queued", "running", "blocked"].includes(props.stateFilter)
  const afterPlans = () => props.group.afterPlans ?? []
  const hasPrerequisiteDetails = () =>
    afterPlans().length > 0 ||
    props.group.afterPlansCount !== undefined ||
    props.group.afterPlansComplete !== undefined
  const hasSchedulingDetails = () =>
    Boolean(props.group.schedulingReason) || hasPrerequisiteDetails()
  const planState = () => planStateLabel(props.group.state)
  const planName = (planID: string) => props.planTitle?.(planID) ?? `Plan ${planID.slice(0, 8)}`
  const prerequisiteSummary = () => {
    const count = afterPlans().length
    if (props.group.afterPlansComplete === true)
      return count ? "Prerequisite plans" : "No prerequisite plans."
    if (props.group.afterPlansComplete === false) {
      return props.group.afterPlansCount === undefined
        ? `${count} known prerequisite plans; additional plans may be unavailable.`
        : `Showing ${count} of ${props.group.afterPlansCount} prerequisite plans.`
    }
    return count ? "Known prerequisite plans" : "No prerequisite plans are listed."
  }
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
        <span class="lazers-tasks-plan-title" title={props.group.title}>
          {props.group.title}
        </span>
        <span class="lazers-tasks-plan-order">
          <Show when={planState()}>
            {(label) => (
              <span class="lazers-tasks-plan-state" title={`Plan ${label().toLowerCase()}`}>
                {label()}
              </span>
            )}
          </Show>
          <Show when={props.group.priority !== undefined}>
            <span title="Scheduler priority for this plan">Priority {props.group.priority}</span>
          </Show>
          <Show when={props.group.planOrder !== undefined}>
            <span title="Scheduler plan order">Order {props.group.planOrder! + 1}</span>
          </Show>
          <Show when={remaining() && props.group.totalCount > 1}>
            <span title="Tasks remaining in this plan">
              {props.group.nonterminalCount}/{props.group.totalCount} remaining
            </span>
          </Show>
        </span>
      </div>
      <Show when={hasSchedulingDetails()}>
        <details class="lazers-tasks-plan-details">
          <summary
            aria-label={`Scheduling details for ${props.group.title}`}
            title="Scheduling details"
          >
            <span aria-hidden="true">i</span>
          </summary>
          <div class="lazers-tasks-plan-details-panel">
            <Show when={props.group.schedulingReason}>
              {(reason) => <p class="lazers-tasks-plan-details-reason">{reason()}</p>}
            </Show>
            <Show when={hasPrerequisiteDetails()}>
              <div
                class="lazers-tasks-plan-prerequisites"
                role="group"
                aria-label="Prerequisite plans"
              >
                <p class="lazers-tasks-plan-prerequisite-summary">{prerequisiteSummary()}</p>
                <Show when={afterPlans().length}>
                  <div class="lazers-tasks-plan-prerequisite-links">
                    <For each={afterPlans()}>
                      {(planID) => (
                        <button
                          type="button"
                          class="lazers-tasks-dependency-ref"
                          aria-label={`Open prerequisite plan ${planName(planID)} (${planID})`}
                          title={planID}
                          onClick={() => props.onOpenPlan?.(planID)}
                        >
                          {planName(planID)}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </details>
      </Show>
    </div>
  )
}
