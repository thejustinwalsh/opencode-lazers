import { Show } from "solid-js"
import type { JSX } from "solid-js"
import type { TaskStateFilter } from "./state-filter.ts"
import type { ExecutionPlanGroup } from "./execution-list.ts"

export function ExecutionPlanGroupView(props: {
  group: ExecutionPlanGroup
  stateFilter: TaskStateFilter
  children: JSX.Element
  onOpenPlan?: (planID: string) => void
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
      <Show
        when={props.group.hasRecordedTitle || props.group.priority !== undefined}
        fallback={props.children}
      >
        <details open>
          <summary class="lazers-tasks-plan-heading">
            <Show when={props.group.hasRecordedTitle}>
              <span>{props.group.title}</span>
            </Show>
            <span class="lazers-tasks-plan-order">
              <Show when={props.group.priority !== undefined}>
                <span>Priority {props.group.priority}</span>
              </Show>
              <Show when={props.group.planOrder !== undefined}>
                <span>Order {props.group.planOrder! + 1}</span>
              </Show>
              <Show when={remaining() && props.group.totalCount > 1}>
                <span>
                  {props.group.nonterminalCount}/{props.group.totalCount} remaining
                </span>
              </Show>
            </span>
          </summary>
          <Show when={props.group.schedulingReason || props.group.afterPlans?.length}>
            <div class="lazers-tasks-plan-reason">
              <Show when={props.group.schedulingReason}>{(reason) => <span>{reason()}</span>}</Show>
              <Show when={props.group.afterPlans?.length}>
                <span>After </span>
                {props.group.afterPlans?.map((planID, index) => (
                  <>
                    {index ? ", " : ""}
                    <button
                      type="button"
                      class="lazers-tasks-dependency-ref"
                      aria-label={`Open prerequisite plan ${planID}`}
                      onClick={() => props.onOpenPlan?.(planID)}
                    >
                      {planID.slice(0, 8)}
                    </button>
                  </>
                ))}
              </Show>
            </div>
          </Show>
          {props.children}
        </details>
      </Show>
    </section>
  )
}
