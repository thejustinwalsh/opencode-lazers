import type { TaskRepository } from "../storage.ts"
import { BACKFILL_TABLES } from "./identity-backfill.ts"
import { ATTEMPT_KEYS, KEY_BACKFILL, PLAN_KEYS } from "./identity-keys.ts"
import { forgetKeysReady } from "./identity-read.ts"
import { KEY_INDEXES, TEXT_KEY_INDEXES } from "./transition-indexes.ts"

/**
 * Put the history tables back where an older build left them: no integer keys on any row, no key
 * rows, the text-id indexes present, the integer ones absent, and each table at the start of its
 * `identityKeys` lifecycle. A new database settles its empty tables at install, so a test that
 * needs the upgrade path seeds its rows and then calls this.
 */
export function asLegacyHistory(repository: TaskRepository) {
  repository.atomic((db) => {
    db.exec(`
      UPDATE runner_transitions SET plan_n=NULL;
      UPDATE runner_progress SET plan_n=NULL,attempt_n=NULL;
      DELETE FROM ${PLAN_KEYS}; DELETE FROM ${ATTEMPT_KEYS};
      DELETE FROM ${KEY_BACKFILL};
    `)
    for (const table of BACKFILL_TABLES)
      db.query(`INSERT INTO ${KEY_BACKFILL}(table_name) VALUES(?)`).run(table)
    for (const [name] of KEY_INDEXES) db.exec(`DROP INDEX IF EXISTS ${name}`)
    for (const [name, target] of TEXT_KEY_INDEXES)
      db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${target}`)
  })
  forgetKeysReady(repository.read((db) => db))
}
