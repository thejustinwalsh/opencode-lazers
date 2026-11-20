// The chips of the Tasks panel, apart from the schema so the GUI bundle can import them.
/** Chips of the Tasks panel. One value per row; `open`, `completed` and `all` are unions. */
export const BUCKETS = [
  "running",
  "queued",
  "paused",
  "blocked",
  "open",
  "accepted",
  "integrated",
  "failed",
  "cancelled",
] as const
export type Bucket = (typeof BUCKETS)[number]
