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
        <span class="lazers-tasks-plan-order">
          <Show when={props.group.priority !== undefined}>
            <span>Priority {props.group.priority}</span>
          </Show>
          <Show when={props.group.planOrder !== undefined}>
            <span>Order {props.group.planOrder! + 1}</span>
          </Show>
          <Show when={nonterminal()}>
            <span>
              {props.group.nonterminalCount}/{props.group.totalCount} nonterminal
            </span>
          </Show>
        </span>
      </div>
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
    </section>
  )
}
