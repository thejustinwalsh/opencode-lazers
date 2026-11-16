import { For, Show } from "solid-js"
import type { JSX } from "solid-js"
import type { TaskStateFilter } from "./state-filter.ts"
import type { ExecutionPlanGroup } from "./execution-list.ts"
import { planStateLabel } from "./row-presentation.ts"

/**
 * A titled plan gets a quiet collapsible heading when it groups several tasks or carries
 * scheduler facts (priority, plan prerequisites). A plain one-task plan is its task's row.
 * The scheduling reason stays one line here; the inspector carries the full text.
 */
export function ExecutionPlanGroupView(props: {
  group: ExecutionPlanGroup
  stateFilter: TaskStateFilter
  children: JSX.Element
  onOpenPlan?: (planID: string) => void
  planTitle?: (planID: string) => string | undefined
}) {
  const remaining = () => ["open", "queued", "running", "blocked"].includes(props.stateFilter)
  const afterPlans = () => props.group.afterPlans ?? []
  const headed = () =>
    props.group.hasRecordedTitle &&
    (props.group.totalCount > 1 || Boolean(props.group.priority) || afterPlans().length > 0)
  const planState = () => planStateLabel(props.group.state)
  const planName = (planID: string) => props.planTitle?.(planID) ?? `Plan ${planID.slice(0, 8)}`
  return (
    <Show when={headed()} fallback={props.children}>
      <section
        class="lazers-tasks-plan"
        role="group"
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
      >
        <details open>
          <summary class="lazers-tasks-plan-heading">
            <span>{props.group.title}</span>
            <span class="lazers-tasks-plan-order">
              <Show when={planState()}>
                {(label) => <span class="lazers-tasks-plan-state">{label()}</span>}
              </Show>
              <Show when={props.group.priority !== undefined}>
                <span title="Scheduler priority for this plan">
                  Priority {props.group.priority}
                </span>
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
          </summary>
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
          {props.children}
        </details>
      </section>
    </Show>
  )
}
