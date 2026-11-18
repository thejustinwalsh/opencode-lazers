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
  selectedCandidateID: Schema.NullOr(Schema.String),
  selectedConfigurationID: Schema.optional(Schema.NullOr(Schema.String)),
  split: Schema.Number,
  evidenceOpen: Schema.optional(Schema.Boolean),
  /** Explicit comparison choice; absent means pick from the available data. */
  compareMode: Schema.optional(Schema.NullOr(Schema.Literals(["observed", "benchmark"]))),
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
  split: 64,
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

export const clampSplit = (value: number) => Math.min(76, Math.max(24, value))
/** Plot height bounds; the pane supplies the height in between. */
export const chartHeightBounds = { minimum: 168, maximum: 320 } as const
/** Legend, Chart data summary and pane padding kept visible below the plot. */
export const chartFooterReserve = 56

export function formatNumber(value: number | null | undefined) {
  return value === null || value === undefined ? "Unknown" : value.toLocaleString()
}

export function formatMoney(value: number | null) {
  return value === null
    ? "Unknown market cost"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumSignificantDigits: 12,
      }).format(value)
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
      return "Unavailable"
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
