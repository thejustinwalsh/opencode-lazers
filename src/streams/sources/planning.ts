import { defineSource, type StreamContext } from "../source.ts"
import {
  PLANNING_SOURCES,
  planningDetailCold,
  planningDetailColumns,
  planningListColumns,
  type PlanningDetailFilter,
  type PlanningListFilter,
} from "./planning-ref.ts"

/**
 * The Plan panel's sources (replacing the `lz.planning` `list` and `get` reads it polled every
 * 3 s). Neither read checked the session; `get` returned only this project's plans, so both
 * sources read only the service's own project, whatever the caller sent.
 */
const ownProject = <F extends { projectKey?: string }>(input: F, context: StreamContext): F => ({
  ...input,
  projectKey: context.projectID,
})

/** A session's plans newest first, through `planning_plannings_session`. */
export const planningListSource = defineSource({
  name: PLANNING_SOURCES.list,
  table: "planning_plannings",
  key: ["id"],
  orders: {
    newest: [
      { column: "created_at", direction: "desc" },
      { column: "id", direction: "asc" },
    ],
  },
  authorize: ownProject<PlanningListFilter>,
  filter: (input: PlanningListFilter) => ({
    where: "planning_plannings.session_id = ? AND planning_plannings.project_key = ?",
    params: [input.sessionID, input.projectKey ?? ""],
  }),
  columns: planningListColumns,
})

/**
 * One plan at its latest revision with the child rows the view assembles from
 * (`assemblePlanningView`), each in the store's own order. The plan is read by its key, so the
 * child reads run for one plan only.
 */
const DETAIL = `(SELECT p.id AS id, p.project_key AS project_key, p.title AS title, p.state AS state,
    p.revision AS revision, r.body AS body, r.validation AS validation,
    (SELECT json_group_object(h.revision, json(h.field_hashes)) FROM planning_revisions h
      WHERE h.planning_id = p.id AND (h.revision = p.revision
        OR h.revision IN (SELECT f.revision FROM planning_findings f WHERE f.planning_id = p.id)))
      AS hashes,
    (SELECT json_group_array(json(x)) FROM (SELECT json_object('id', f.id, 'source', f.source,
        'revision', f.revision, 'draft_id', f.draft_id, 'field', f.field, 'severity', f.severity,
        'confidence', f.confidence, 'body', f.body, 'resolution', f.resolution) AS x
      FROM planning_findings f WHERE f.planning_id = p.id ORDER BY f.rowid)) AS findings,
    (SELECT json_group_array(json(x)) FROM (SELECT json_object('id', q.id, 'source', q.source,
        'revision', q.revision, 'body', q.body, 'route', q.route, 'answer', q.answer) AS x
      FROM planning_questions q WHERE q.planning_id = p.id ORDER BY q.rowid)) AS questions,
    (SELECT json_group_array(json(x)) FROM (SELECT json_object('id', v.id, 'stage', v.stage,
        'revision', v.revision, 'runs', (SELECT json_group_array(json(y)) FROM (
          SELECT json_object('agent', u.agent, 'state', u.state, 'reason', u.reason,
            'input_tokens', u.input_tokens, 'output_tokens', u.output_tokens,
            'duration_ms', u.duration_ms) AS y
          FROM planning_runs u WHERE u.review_id = v.id ORDER BY u.started_at, u.attempt, u.id))) AS x
      FROM planning_reviews v WHERE v.planning_id = p.id ORDER BY v.created_at, v.id)) AS reviews,
    (SELECT json_group_array(json(x)) FROM (SELECT json_object('draft_id', t.draft_id,
        'reference', t.reference, 'changed_fields_json', t.changed_fields_json) AS x
      FROM planning_tasked t WHERE t.planning_id = p.id ORDER BY t.rowid)) AS tasked
  FROM planning_plannings p
  JOIN planning_revisions r ON r.planning_id = p.id AND r.revision = p.revision) AS planning_detail`

export const planningDetailSource = defineSource({
  name: PLANNING_SOURCES.detail,
  table: DETAIL,
  tables: [
    "planning_plannings",
    "planning_revisions",
    "planning_findings",
    "planning_questions",
    "planning_reviews",
    "planning_runs",
    "planning_tasked",
  ],
  key: ["id"],
  orders: { key: [{ column: "id", direction: "asc" }] },
  authorize: ownProject<PlanningDetailFilter>,
  filter: (input: PlanningDetailFilter) => ({
    where: "planning_detail.id = ? AND planning_detail.project_key = ?",
    params: [input.planningID, input.projectKey ?? ""],
  }),
  columns: planningDetailColumns,
  detail: planningDetailCold,
})
