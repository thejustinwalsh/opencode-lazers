import type { Database } from "bun:sqlite"
import { fingerprint } from "../../identity.ts"
import type { TaskRepository } from "../../storage.ts"
import {
  OwnedResourceSchema,
  ResourceDescriptorSchema,
  ResourceExecutionSchema,
  ResourceOwnerSchema,
} from "./schema.ts"
import type {
  OwnedResource,
  ResourceDescriptor,
  ResourceExecution,
  ResourceExecutionPhase,
  ResourceState,
} from "./schema.ts"

type ResourceRow = { payload: string; fingerprint: string }
type ClaimRow = { resource_id: string }
type HeadRow = { generation: number }

function ensureTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owned_resource_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS owned_resources (
      resource_id TEXT PRIMARY KEY,
      project_directory TEXT NOT NULL,
      request_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation > 0),
      fingerprint TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(project_directory,request_id),
      UNIQUE(resource_key,generation)
    );
    CREATE INDEX IF NOT EXISTS owned_resources_run
      ON owned_resources(project_directory,run_id,created_at,resource_id);
    CREATE TABLE IF NOT EXISTS owned_resource_heads (
      resource_key TEXT PRIMARY KEY,
      generation INTEGER NOT NULL CHECK(generation > 0),
      resource_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS owned_resource_claims (
      resource_key TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL UNIQUE,
      coordinator_id TEXT NOT NULL,
      project_directory TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS owned_resource_executions (
      project_directory TEXT NOT NULL,
      run_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_directory,run_id)
    );
    CREATE TABLE IF NOT EXISTS owned_resource_cleanup_receipts (
      resource_id TEXT PRIMARY KEY,
      project_directory TEXT NOT NULL,
      run_id TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      generation INTEGER NOT NULL,
      evidence TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)
}

function decodeResource(payload: string): OwnedResource {
  return OwnedResourceSchema.parse(JSON.parse(payload))
}

function decodeExecution(row: { run_id: string; phase: string; updated_at: number }) {
  return ResourceExecutionSchema.parse({
    runID: row.run_id,
    phase: row.phase,
    updatedAt: row.updated_at,
  })
}

function allowedTransition(current: ResourceState, next: ResourceState): boolean {
  const allowed: Record<ResourceState, ResourceState[]> = {
    reserved: ["reserved", "creating", "active", "uncertain", "removed"],
    creating: ["creating", "reserved", "active", "deleting", "uncertain", "removed"],
    active: ["active", "deleting", "uncertain", "removed"],
    deleting: ["deleting", "active", "uncertain", "removed"],
    uncertain: ["uncertain", "reserved", "active", "deleting", "removed"],
    removed: ["removed"],
  }
  return allowed[current].includes(next)
}

export type ResourceRegistration =
  | { status: "reserved" | "replayed"; resources: OwnedResource[]; coordinatorID: string }
  | { status: "conflict"; message: string; resourceID: string | null }

/**
 * Durable resource intent and receipts. Claims are global to the shared task
 * database (not project-partitioned); filesystem adapters add a cross-database
 * claim marker and must fail closed when another coordinator owns it.
 */
export class ResourceRepository {
  constructor(readonly repository: TaskRepository) {}

  coordinatorID(): string {
    return this.repository.atomic((db) => {
      ensureTables(db)
      db.query(
        "INSERT OR IGNORE INTO owned_resource_meta(key,value) VALUES('coordinator-id',?)",
      ).run(crypto.randomUUID())
      return db
        .query<{ value: string }, []>(
          "SELECT value FROM owned_resource_meta WHERE key='coordinator-id'",
        )
        .get()!.value
    })
  }

  /** All registrations commit together before callers can create any fixture. */
  registerBatch(ownerInput: unknown, descriptorInputs: unknown[]): ResourceRegistration {
    const owner = ResourceOwnerSchema.parse(ownerInput)
    const descriptors = descriptorInputs.map((descriptor) =>
      ResourceDescriptorSchema.parse(descriptor),
    )
    if (owner.projectDirectory !== this.repository.projectDirectory)
      throw new Error("Resource owner belongs to another project")
    if (descriptors.length < 1 || descriptors.length > 20)
      throw new Error("Register between one and twenty owned resources")
    if (new Set(descriptors.map((item) => item.requestID)).size !== descriptors.length)
      return {
        status: "conflict",
        message: "A registration batch repeats a requestID",
        resourceID: null,
      }
    if (new Set(descriptors.map((item) => item.resourceKey)).size !== descriptors.length)
      return {
        status: "conflict",
        message: "A registration batch repeats a resource identity",
        resourceID: null,
      }

    return this.repository.atomic((db) => {
      ensureTables(db)
      db.query(
        "INSERT OR IGNORE INTO owned_resource_meta(key,value) VALUES('coordinator-id',?)",
      ).run(crypto.randomUUID())
      const coordinatorID = db
        .query<{ value: string }, []>(
          "SELECT value FROM owned_resource_meta WHERE key='coordinator-id'",
        )
        .get()!.value
      const execution = db
        .query<{ phase: string }, [string, string]>(
          "SELECT phase FROM owned_resource_executions WHERE project_directory=? AND run_id=?",
        )
        .get(this.repository.projectDirectory, owner.runID)
      const prepared: Array<{
        descriptor: ResourceDescriptor
        payloadFingerprint: string
        existing?: OwnedResource
      }> = []

      for (const descriptor of descriptors) {
        const payloadFingerprint = fingerprint({ owner, descriptor })
        const existing = db
          .query<ResourceRow, [string, string]>(
            "SELECT payload,fingerprint FROM owned_resources WHERE project_directory=? AND request_id=?",
          )
          .get(this.repository.projectDirectory, descriptor.requestID)
        if (existing) {
          const record = decodeResource(existing.payload)
          if (existing.fingerprint !== payloadFingerprint)
            return {
              status: "conflict" as const,
              message: "requestID already identifies different resource content or ownership",
              resourceID: record.resourceID,
            }
          prepared.push({ descriptor, payloadFingerprint, existing: record })
          continue
        }

        if (execution && execution.phase !== "registered")
          return {
            status: "conflict" as const,
            message: "A probe execution cannot register new resources after it starts",
            resourceID: null,
          }

        const claim = db
          .query<ClaimRow, [string]>(
            "SELECT resource_id FROM owned_resource_claims WHERE resource_key=?",
          )
          .get(descriptor.resourceKey)
        if (claim)
          return {
            status: "conflict" as const,
            message: "Resource identity is already reserved by an owned probe",
            resourceID: claim.resource_id,
          }

        const head = db
          .query<HeadRow, [string]>(
            "SELECT generation FROM owned_resource_heads WHERE resource_key=?",
          )
          .get(descriptor.resourceKey)
        const expectedGeneration = (head?.generation ?? 0) + 1
        if (descriptor.generation !== expectedGeneration)
          return {
            status: "conflict" as const,
            message: `Resource generation is stale or skips the next generation (${expectedGeneration})`,
            resourceID: null,
          }
        prepared.push({ descriptor, payloadFingerprint })
      }

      const now = Date.now()
      const resources: OwnedResource[] = []
      for (const entry of prepared) {
        if (entry.existing) {
          resources.push(entry.existing)
          continue
        }
        const descriptor = entry.descriptor
        const resource = OwnedResourceSchema.parse({
          schemaVersion: 1,
          resourceID: crypto.randomUUID(),
          requestID: descriptor.requestID,
          runID: owner.runID,
          owner,
          resourceKey: descriptor.resourceKey,
          name: descriptor.name,
          generation: descriptor.generation,
          contents: descriptor.contents,
          state: "reserved",
          createdAt: now,
          updatedAt: now,
        })
        const payload = JSON.stringify(resource)
        db.query(
          `INSERT INTO owned_resources
           (resource_id,project_directory,request_id,run_id,resource_key,generation,fingerprint,payload,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          resource.resourceID,
          this.repository.projectDirectory,
          resource.requestID,
          resource.runID,
          resource.resourceKey,
          resource.generation,
          entry.payloadFingerprint,
          payload,
          now,
          now,
        )
        db.query(
          `INSERT INTO owned_resource_heads(resource_key,generation,resource_id) VALUES(?,?,?)
           ON CONFLICT(resource_key) DO UPDATE SET generation=excluded.generation,resource_id=excluded.resource_id`,
        ).run(resource.resourceKey, resource.generation, resource.resourceID)
        db.query(
          "INSERT INTO owned_resource_claims(resource_key,resource_id,coordinator_id,project_directory) VALUES(?,?,?,?)",
        ).run(
          resource.resourceKey,
          resource.resourceID,
          coordinatorID,
          this.repository.projectDirectory,
        )
        resources.push(resource)
      }

      db.query(
        `INSERT OR IGNORE INTO owned_resource_executions(project_directory,run_id,phase,updated_at)
         VALUES(?,?,'registered',?)`,
      ).run(this.repository.projectDirectory, owner.runID, now)
      return {
        status: prepared.every((entry) => entry.existing)
          ? ("replayed" as const)
          : ("reserved" as const),
        resources,
        coordinatorID,
      }
    })
  }

  resourcesForRun(runID: string): OwnedResource[] {
    return this.repository.atomic((db) => {
      ensureTables(db)
      return db
        .query<{ payload: string }, [string, string]>(
          `SELECT payload FROM owned_resources WHERE project_directory=? AND run_id=?
           ORDER BY created_at,resource_id`,
        )
        .all(this.repository.projectDirectory, runID)
        .map((row) => decodeResource(row.payload))
    })
  }

  resource(resourceID: string): OwnedResource | undefined {
    return this.repository.atomic((db) => {
      ensureTables(db)
      const row = db
        .query<{ payload: string }, [string, string]>(
          "SELECT payload FROM owned_resources WHERE project_directory=? AND resource_id=?",
        )
        .get(this.repository.projectDirectory, resourceID)
      return row ? decodeResource(row.payload) : undefined
    })
  }

  claimed(resourceKey: string): OwnedResource | undefined {
    return this.repository.atomic((db) => {
      ensureTables(db)
      const row = db
        .query<{ payload: string }, [string]>(
          `SELECT r.payload FROM owned_resource_claims c
           JOIN owned_resources r ON r.resource_id=c.resource_id WHERE c.resource_key=?`,
        )
        .get(resourceKey)
      return row ? decodeResource(row.payload) : undefined
    })
  }

  execution(runID: string): ResourceExecution | undefined {
    return this.repository.atomic((db) => {
      ensureTables(db)
      const row = db
        .query<{ run_id: string; phase: string; updated_at: number }, [string, string]>(
          "SELECT run_id,phase,updated_at FROM owned_resource_executions WHERE project_directory=? AND run_id=?",
        )
        .get(this.repository.projectDirectory, runID)
      return row ? decodeExecution(row) : undefined
    })
  }

  setExecutionPhase(runID: string, phase: ResourceExecutionPhase): ResourceExecution {
    return this.repository.atomic((db) => {
      ensureTables(db)
      const current = db
        .query<{ run_id: string; phase: string; updated_at: number }, [string, string]>(
          "SELECT run_id,phase,updated_at FROM owned_resource_executions WHERE project_directory=? AND run_id=?",
        )
        .get(this.repository.projectDirectory, runID)
      if (!current) throw new Error("Owned resource execution has not been registered")
      const previous = decodeExecution(current)
      const allowed: Record<ResourceExecutionPhase, ResourceExecutionPhase[]> = {
        registered: ["registered", "preparing", "finished", "interrupted"],
        preparing: ["preparing", "probing", "finished", "interrupted"],
        probing: ["probing", "finished", "interrupted"],
        finished: ["finished"],
        interrupted: ["interrupted"],
      }
      if (!allowed[previous.phase].includes(phase))
        throw new Error(`Invalid resource execution transition ${previous.phase} -> ${phase}`)
      const updatedAt = Math.max(Date.now(), previous.updatedAt)
      db.query(
        "UPDATE owned_resource_executions SET phase=?,updated_at=? WHERE project_directory=? AND run_id=?",
      ).run(phase, updatedAt, this.repository.projectDirectory, runID)
      return ResourceExecutionSchema.parse({ runID, phase, updatedAt })
    })
  }

  /** Exactly one caller may start setup for a registered probe run. */
  claimPreparation(runID: string): boolean {
    return this.repository.atomic((db) => {
      ensureTables(db)
      const result = db
        .query(
          `UPDATE owned_resource_executions SET phase='preparing',updated_at=?
           WHERE project_directory=? AND run_id=? AND phase='registered'`,
        )
        .run(Date.now(), this.repository.projectDirectory, runID)
      return result.changes === 1
    })
  }

  /** Exactly one caller may invoke behavior after all resource setup is durable. */
  beginProbe(runID: string): boolean {
    return this.repository.atomic((db) => {
      ensureTables(db)
      const result = db
        .query(
          `UPDATE owned_resource_executions SET phase='probing',updated_at=?
           WHERE project_directory=? AND run_id=? AND phase='preparing'`,
        )
        .run(Date.now(), this.repository.projectDirectory, runID)
      return result.changes === 1
    })
  }

  setState(resourceID: string, state: ResourceState, evidence?: string): OwnedResource {
    return this.repository.atomic((db) => {
      ensureTables(db)
      const row = db
        .query<{ payload: string }, [string, string]>(
          "SELECT payload FROM owned_resources WHERE project_directory=? AND resource_id=?",
        )
        .get(this.repository.projectDirectory, resourceID)
      if (!row) throw new Error("Owned resource receipt not found")
      const current = decodeResource(row.payload)
      if (!allowedTransition(current.state, state))
        throw new Error(`Invalid owned resource transition ${current.state} -> ${state}`)
      const updated = OwnedResourceSchema.parse({
        ...current,
        state,
        updatedAt: Math.max(Date.now(), current.updatedAt),
      })
      db.query(
        "UPDATE owned_resources SET payload=?,updated_at=? WHERE project_directory=? AND resource_id=?",
      ).run(
        JSON.stringify(updated),
        updated.updatedAt,
        this.repository.projectDirectory,
        resourceID,
      )
      if (state === "removed") {
        db.query(
          "DELETE FROM owned_resource_claims WHERE resource_id=? AND project_directory=?",
        ).run(resourceID, this.repository.projectDirectory)
        const detail = (evidence ?? "Authoritative adapter observation confirmed absence").slice(
          0,
          500,
        )
        db.query(
          `INSERT OR IGNORE INTO owned_resource_cleanup_receipts
           (resource_id,project_directory,run_id,resource_key,generation,evidence,created_at)
           VALUES(?,?,?,?,?,?,?)`,
        ).run(
          current.resourceID,
          this.repository.projectDirectory,
          current.runID,
          current.resourceKey,
          current.generation,
          detail,
          updated.updatedAt,
        )
      }
      return updated
    })
  }

  cleanupReceiptCount(runID: string): number {
    return this.repository.atomic((db) => {
      ensureTables(db)
      return db
        .query<{ count: number }, [string, string]>(
          "SELECT COUNT(*) AS count FROM owned_resource_cleanup_receipts WHERE project_directory=? AND run_id=?",
        )
        .get(this.repository.projectDirectory, runID)!.count
    })
  }
}
