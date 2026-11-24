interface Database {
  query(statement: string): { run(...values: unknown[]): void }
}

declare const db: Database

db.query(
  "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,NULL,?,'RAW_SQL_EVENT',?,?)",
).run("plan", 2, "{}", 0)

db.query("INSERT INTO configuration(name) VALUES('PRIVATE_API_KEY')").run()

export {}
