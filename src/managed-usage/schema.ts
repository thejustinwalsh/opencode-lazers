export const managedUsageSchemaModule = {
  generation: 3,
  source: "src/managed-usage/store.ts",
  tables: [
    "managed_usage_meta",
    "managed_usage_boundaries",
    "managed_usage_facts",
    "managed_usage_fact_conflicts",
    "managed_usage_capture_gaps",
  ],
} as const
