import { Store } from "@opencode/plugin/gui"
import type { SetupContext } from "@opencode/plugin/gui"
import { Schema } from "effect"
import type { ModelDecisionTaskKind } from "./decision-contract.ts"

const Preference = Schema.Struct({
  tab: Schema.Literals(["compare", "assignments"]),
  persona: Schema.NullOr(Schema.Literals(["ui", "systems", "small-refactoring"])),
  taskKind: Schema.optional(
    Schema.NullOr(
      Schema.Literals([
        "bug-repair",
        "feature-implementation",
        "refactoring",
        "testing",
        "documentation",
        "maintenance",
      ]),
    ),
  ),
  selectedTaskID: Schema.NullOr(Schema.String),
  /** A task was chosen as a comparison filter; the chip shows only then. */
  taskFilter: Schema.optional(Schema.Boolean),
  selectedCandidateID: Schema.NullOr(Schema.String),
  selectedConfigurationID: Schema.optional(Schema.NullOr(Schema.String)),
  /** Retired list/inspector split; read once to size the details pane. */
  split: Schema.optionalKey(Schema.Number),
  /** Details pane: closed by default; size is the body's fraction of the panel. */
  open: Schema.optional(Schema.Boolean),
  size: Schema.optional(Schema.Number),
  evidenceOpen: Schema.optional(Schema.Boolean),
  /** Explicit comparison choice; absent means pick from the available data. */
  compareMode: Schema.optional(
    Schema.NullOr(Schema.Literals(["observed", "projected", "benchmark"])),
  ),
  topScroll: Schema.Number,
  inspectorScroll: Schema.Number,
})
const initial: typeof Preference.Type = {
  tab: "compare",
  persona: null,
  taskKind: null,
  selectedTaskID: null,
  selectedCandidateID: null,
  selectedConfigurationID: null,
  evidenceOpen: false,
  topScroll: 0,
  inspectorScroll: 0,
}

export const modelsStores = {
  modelsView: Store.session(Schema.Struct({ projects: Schema.Record(Schema.String, Preference) }), {
    projects: {},
  }),
}

export type ModelsContext = SetupContext<{ stores: typeof modelsStores }>
export type Tab = "compare" | "assignments"
export type ModelsPreference = typeof Preference.Type
export const modelsInitialPreference = initial
export const modelPersonaLabels = {
  ui: "UI",
  systems: "Systems",
  "small-refactoring": "Small task / refactoring",
} as const
export const modelTaskKindLabels: Record<ModelDecisionTaskKind, string> = {
  "bug-repair": "Bug repair",
  "feature-implementation": "Feature implementation",
  refactoring: "Refactoring",
  testing: "Testing",
  documentation: "Documentation",
  maintenance: "Maintenance",
}
export const modelTaskKinds = Object.keys(modelTaskKindLabels) as ModelDecisionTaskKind[]

export function formatNumber(value: number) {
  return value.toLocaleString()
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumSignificantDigits: 12,
})

export function formatMoney(value: number) {
  return money.format(value)
}

export function statusText(status: string) {
  switch (status) {
    case "observed":
      return "Observed"
    case "partial":
      return "Partial"
    case "missing":
      return "Missing"
    case "unavailable":
      return "Not reported"
    default:
      return status
  }
}
/** Short source name for the summary line; freshness only when it is not current. */
export function marketSummarySource(context: string) {
  const [source = "", ...details] = context.split(" · ")
  const name =
    {
      "OpenRouter model catalog": "OpenRouter",
      "OpenCode model catalog": "OpenCode",
      "Configured price sources": "Configured sources",
      "Configured price source": "Configured source",
    }[source] ?? source
  return details.includes("stale") ? `${name} · out of date` : name
}

/**
 * The task chip is a filter, so it shows only when a task was chosen as one. The first task is
 * opened by default for the detail below; that is not a filter and has no chip.
 */
export function showTaskChip(view: { taskFilter?: boolean }, taskReference: string | undefined) {
  return Boolean(view.taskFilter && taskReference)
}

/**
 * Compare has a lower pane (the selected model) only when there is content to inspect: not while
 * the one loading surface shows, and not on the Benchmark empty state.
 */
export function hasCompareLowerPane(input: {
  contentShown: boolean
  benchmark: boolean
  benchmarkNeedsOpenRouter: boolean
}) {
  return input.contentShown && !(input.benchmark && input.benchmarkNeedsOpenRouter)
}
