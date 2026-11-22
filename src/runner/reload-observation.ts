import type { Database } from "bun:sqlite"
import type { ReloadObservation, ReloadProcessObservation } from "./reload-safety.ts"
import { observeOpenCodeSessions } from "./reload-host-observation.ts"
import { observeVerificationProcesses } from "./reload-process-observation.ts"

export type ReloadObservationDependencies = {
  observeSessions(): Promise<ReloadObservation>
  observeVerifications(db: Database): Promise<ReloadProcessObservation>
}

export const reloadObservationDependencies: ReloadObservationDependencies = {
  observeSessions: observeOpenCodeSessions,
  observeVerifications: observeVerificationProcesses,
}

export { observeOpenCodeSessions, observeVerificationProcesses }
