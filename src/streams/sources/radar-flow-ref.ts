import type { Columns } from "../frame.ts"
import { sourceRef } from "../source.ts"
import type { RadarScope } from "./radar-ref.ts"

/**
 * The Monitor's model phases, the part a consumer without a database needs. Rows come from the
 * stored transcript metadata (`transcript_steps`, `transcript_sessions`, `src/transcript-meta/`):
 * one row per assistant message of a worker attempt session, no text.
 *
 * ```
 * radar.steps        one session's steps, newest first   ─► model request / stream / response
 * radar.transcripts  read state of the listed sessions   ─► "still reading" until available
 * ```
 *
 * Tool phases are not here: they are `observability.liveHistory` (`toolsOnly`) for a worker and
 * `radar.nativeCalls` for every session.
 */
export const RADAR_FLOW_SOURCES = {
  steps: "radar.steps",
  transcripts: "radar.transcripts",
} as const

/** One session's steps. A session view reads its own session and that session's children. */
export type RadarStepsFilter = { projectDirectory: string; scope: RadarScope; sessionID: string }
/** The read state of these sessions; a session view reads its own and its children's. */
export type RadarTranscriptsFilter = {
  projectDirectory: string
  scope: RadarScope
  sessionIDs: string[]
}

export const radarStepColumns = {
  id: "int",
  session_id: "text",
  message_id: "text",
  /** The message's position in the whole transcript: the order key. */
  ordinal: "int",
  provider_id: "text",
  model_id: "text",
  variant: "text",
  /** Request started. */
  created_at: "int",
  /** First streamed output. */
  streamed_at: "int",
  /** Response completed. */
  completed_at: "int",
  input_tokens: "int",
  output_tokens: "int",
  /**
   * The error's name when the step failed; no message text is stored. A retried step reads as
   * its own outcome: Flow draws no retry (the old progress phases carried none either).
   */
  error_type: "text",
} as const satisfies Columns

export const radarTranscriptColumns = {
  id: "int",
  session_id: "text",
  /** `not-read` until a pass reaches the end of the transcript, then `available`. */
  read_state: "text",
  message_count: "int",
} as const satisfies Columns

export const radarFlowRefs = {
  steps: sourceRef<RadarStepsFilter, typeof radarStepColumns>({
    name: RADAR_FLOW_SOURCES.steps,
    columns: radarStepColumns,
  }),
  transcripts: sourceRef<RadarTranscriptsFilter, typeof radarTranscriptColumns>({
    name: RADAR_FLOW_SOURCES.transcripts,
    columns: radarTranscriptColumns,
  }),
}
