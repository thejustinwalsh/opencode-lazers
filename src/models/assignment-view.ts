import type { Database } from "bun:sqlite"
import { schemaModules } from "../database-schema.ts"
import type { TaskRepository } from "../storage.ts"
import type { HostAgentFact } from "./assignment-settings.ts"
import { ensureModelMappingTables } from "./mapping-store.ts"

/**
 * `model_assignment_view`: the current record of every mapping layer, one row per
 * (layer, project, task, subject), plus one `host` row per project and agent with what OpenCode
 * resolved for it. `models.assignments` reads a project's rows and the selected task's; the panel
 * composes them (`assignmentSettingsOf`).
 *
 * ```
 * model_mappings INSERT/DELETE ─trigger─► the key's row = its newest revision (same transaction)
 * agent.get at service start and after agent.reload ─► host rows (compare, then write)
 * ```
 *
 * Layer rows, not per-task settings: the panel shows 7 subjects, and only the 3 personas have a
 * task layer. Measured on the live database (2026-11-21): 11 mapping records over 9 keys (4 task
 * keys across 260 tasks). A per-task materialisation would write 7 rows for every task opened and
 * need an idle sweep; layer rows need neither, and a selected task adds at most 3 rows to the read.
 */
const MODULE = schemaModules["model-mappings"]

const TABLES_SQL = `
  CREATE TABLE model_assignment_view (
    id INTEGER PRIMARY KEY,
    layer TEXT NOT NULL CHECK(layer IN ('shared','project','task','host')),
    project_directory TEXT NOT NULL,
    task_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    revision INTEGER NOT NULL,
    record TEXT NOT NULL,
    UNIQUE(layer, project_directory, task_id, subject)
  );
  CREATE INDEX model_assignment_view_project
    ON model_assignment_view(project_directory, layer, task_id, subject);
`

const sameKey = (prefix: string) =>
  `layer=${prefix}.scope AND project_directory=${prefix}.project_directory
   AND task_id=${prefix}.task_id AND subject=${prefix}.persona`

/** The newest remaining revision of a key, as a view row. */
const newestOf = (prefix: string) => `
  INSERT INTO model_assignment_view(layer,project_directory,task_id,subject,revision,record)
  SELECT m.scope,m.project_directory,m.task_id,m.persona,m.revision,m.payload FROM model_mappings m
  WHERE m.scope=${prefix}.scope AND m.project_directory=${prefix}.project_directory
    AND m.task_id=${prefix}.task_id AND m.persona=${prefix}.persona
  ORDER BY m.revision DESC LIMIT 1;`

// Plain UPDATE then INSERT … WHERE NOT EXISTS: a trigger body never conflicts under an outer upsert.
const TRIGGERS_SQL = `
  CREATE TRIGGER model_assignment_view_insert AFTER INSERT ON model_mappings BEGIN
    UPDATE model_assignment_view SET revision=NEW.revision, record=NEW.payload
      WHERE ${sameKey("NEW")} AND revision<NEW.revision;
    INSERT INTO model_assignment_view(layer,project_directory,task_id,subject,revision,record)
      SELECT NEW.scope,NEW.project_directory,NEW.task_id,NEW.persona,NEW.revision,NEW.payload
      WHERE NOT EXISTS (SELECT 1 FROM model_assignment_view WHERE ${sameKey("NEW")});
  END;
  CREATE TRIGGER model_assignment_view_delete AFTER DELETE ON model_mappings BEGIN
    DELETE FROM model_assignment_view WHERE ${sameKey("OLD")};
    ${newestOf("OLD")}
  END;
`

function installAssignmentView(db: Database) {
  ensureModelMappingTables(db)
  db.exec(`DROP TRIGGER IF EXISTS model_assignment_view_insert;
    DROP TRIGGER IF EXISTS model_assignment_view_delete;
    DROP TABLE IF EXISTS model_assignment_view;`)
  db.exec(TABLES_SQL)
  db.exec(TRIGGERS_SQL)
  // Backfill: the newest revision of every key, in this one transaction (tens of rows).
  db.exec(`
    INSERT INTO model_assignment_view(layer,project_directory,task_id,subject,revision,record)
    SELECT m.scope,m.project_directory,m.task_id,m.persona,m.revision,m.payload FROM model_mappings m
    WHERE m.revision=(SELECT MAX(x.revision) FROM model_mappings x WHERE x.scope=m.scope
      AND x.project_directory=m.project_directory AND x.task_id=m.task_id AND x.persona=m.persona)`)
}

/** Install through the module registry (one transaction, generation checked). */
export function ensureModelAssignmentViewSchema(repository: TaskRepository) {
  repository.installSchema(
    "model-mappings",
    MODULE.generation,
    MODULE.tables,
    installAssignmentView,
  )
}

/**
 * Store what the host resolved for each agent; rows whose fact is unchanged are not written. A
 * database without the view (not installed by a project core) is left alone.
 */
export function writeHostAgentFacts(
  repository: TaskRepository,
  facts: ReadonlyArray<{ agentID: string; fact: HostAgentFact }>,
) {
  return repository.atomic((db) => {
    const installed = db
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_assignment_view'")
      .get()
    if (!installed) return 0
    const current = db.query<{ record: string }, [string, string]>(
      `SELECT record FROM model_assignment_view
       WHERE layer='host' AND project_directory=? AND task_id='' AND subject=?`,
    )
    const update = db.query(
      `UPDATE model_assignment_view SET record=?, revision=revision+1
       WHERE layer='host' AND project_directory=? AND task_id='' AND subject=?`,
    )
    const insert = db.query(
      `INSERT INTO model_assignment_view(layer,project_directory,task_id,subject,revision,record)
       VALUES('host',?,'',?,1,?)`,
    )
    let written = 0
    for (const { agentID, fact } of facts) {
      const record = JSON.stringify(fact)
      const stored = current.get(repository.projectDirectory, agentID)
      if (stored?.record === record) continue
      if (stored) update.run(record, repository.projectDirectory, agentID)
      else insert.run(repository.projectDirectory, agentID, record)
      written++
    }
    return written
  })
}
