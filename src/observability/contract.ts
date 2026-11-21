/** A panel's view: one session's tasks, the project, or (the Radar's) every project the caller may read. */
export type ObservationScope =
  | { kind: "session"; sessionID: string }
  | { kind: "project"; sessionID: string }
  | { kind: "all"; sessionID: string }
