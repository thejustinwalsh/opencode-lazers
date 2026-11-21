import { sourceRef } from "../streams/source.ts"
import {
  TRAJECTORY_SOURCES,
  trajectoryAttemptColumns,
  trajectoryEffortColumns,
  trajectoryEffortDetail,
  trajectoryEventColumns,
  trajectoryEventDetail,
  trajectoryTranscriptColumns,
  type TrajectoryAttemptsFilter,
  type TrajectoryEffortFilter,
  type TrajectoryEventsFilter,
  type TrajectoryTranscriptFilter,
} from "../streams/sources/trajectory-ref.ts"

/** The four Trajectory sources as the GUI reads them (names and columns; no database). */
export const trajectoryEventsRef = sourceRef<TrajectoryEventsFilter, typeof trajectoryEventColumns>(
  {
    name: TRAJECTORY_SOURCES.events,
    columns: trajectoryEventColumns,
    detail: trajectoryEventDetail,
  },
)
export const trajectoryAttemptsRef = sourceRef<
  TrajectoryAttemptsFilter,
  typeof trajectoryAttemptColumns
>({ name: TRAJECTORY_SOURCES.attempts, columns: trajectoryAttemptColumns })
export const trajectoryEffortRef = sourceRef<
  TrajectoryEffortFilter,
  typeof trajectoryEffortColumns
>({
  name: TRAJECTORY_SOURCES.effort,
  columns: trajectoryEffortColumns,
  detail: trajectoryEffortDetail,
})
export const trajectoryTranscriptRef = sourceRef<
  TrajectoryTranscriptFilter,
  typeof trajectoryTranscriptColumns
>({ name: TRAJECTORY_SOURCES.transcript, columns: trajectoryTranscriptColumns })
