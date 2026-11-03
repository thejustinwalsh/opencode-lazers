import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { nativeWorkerOptions } from "../runner/catalog.ts"
import { TaskRepository } from "../storage.ts"
import {
  ModelCatalogOutputSchema,
  ModelComparisonRPCInputSchema,
  ModelConfigureRPCInputSchema,
  ModelEvidenceRPCInputSchema,
  ModelMappingWriteOutputSchema,
  ModelSourceRefreshRPCInputSchema,
  ModelSettingsOutputSchema,
  ModelSettingsRPCInputSchema,
  ModelCatalogRPCInputSchema,
  Models,
  ModelConfigurationsRPCInputSchema,
  ModelGroupsRPCInputSchema,
} from "./contract.ts"
import { ModelComparisonOutputSchema } from "./comparison-schema.ts"
import { ModelConfigurationsOutputSchema, ModelGroupsOutputSchema } from "./model-group-schema.ts"
import { ModelEvidenceOutputSchema } from "./source-schema.ts"
import { ModelEvidenceRefresher } from "./source-refresh.ts"
import type { ModelEvidenceFetcher } from "./source-refresh.ts"
import { readModelComparison } from "./comparison-read.ts"
import { readModelConfigurations, readModelGroups } from "./model-group-read.ts"
import { ModelEvidenceReadStore, ModelEvidenceStore } from "./source-store.ts"
import { ModelSettingsService } from "./service.ts"

type ModelsContext = Pick<
  Plugin.Context,
  "agent" | "integration" | "location" | "model" | "permission" | "rpc" | "session"
>
type EvidenceReadStore = Pick<
  ModelEvidenceReadStore,
  "close" | "projectDirectory" | "readComparisonSources"
>
type EvidenceReadStoreFactory = (path: string, projectDirectory: string) => EvidenceReadStore

function isSessionNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "SessionNotFoundError"
  )
}

async function authorize(
  ctx: ModelsContext,
  sessionID: string,
  projectID: string,
  action: string,
  resources: string[],
  signal: AbortSignal,
) {
  const readEligibleSession = async () => {
    const session = await Effect.runPromise(
      ctx.session
        .get({ sessionID: Session.ID.make(sessionID) })
        .pipe(
          Effect.catch((error) =>
            isSessionNotFound(error) ? Effect.succeed(null) : Effect.fail(error),
          ),
        ),
      { signal },
    )
    if (
      !session ||
      String(session.id) !== sessionID ||
      session.projectID !== projectID ||
      session.time.archived !== undefined ||
      !session.agent
    )
      throw new Error("Models scope is unavailable")
    return { session, agent: session.agent }
  }

  const eligible = await readEligibleSession()

  const agent = Agent.ID.make(eligible.agent)
  await Effect.runPromise(
    ctx.permission.assert({
      sessionID: Session.ID.make(eligible.session.id),
      agent,
      action,
      resources,
    }),
    { signal },
  )
  signal.throwIfAborted()
  const currentSession = await readEligibleSession()
  if (currentSession.agent !== eligible.agent) throw new Error("Models scope is unavailable")
  return currentSession.session
}

/** Desktop RPC and Code Mode tools share the same project-scoped SQLite mappings. */
export function registerModelsServer(
  ctx: ModelsContext,
  repository: TaskRepository,
  fetcher?: ModelEvidenceFetcher,
  evidenceReadStoreFactory: EvidenceReadStoreFactory = (databasePath, directory) =>
    new ModelEvidenceReadStore(databasePath, directory),
) {
  const path = repository.path
  const projectDirectory = repository.projectDirectory
  const projectID = ctx.location.project.id
  const withService = <T>(run: (service: ModelSettingsService) => T): T => {
    const connection = new TaskRepository(path, projectDirectory)
    try {
      return run(new ModelSettingsService(connection))
    } finally {
      connection.close()
    }
  }
  const withEvidenceStore = <T>(run: (store: ModelEvidenceStore) => T): T => {
    const store = new ModelEvidenceStore(path, projectDirectory)
    try {
      return run(store)
    } finally {
      store.close()
    }
  }
  const withEvidenceStoreAsync = async <T>(
    run: (store: ModelEvidenceStore) => Promise<T>,
  ): Promise<T> => {
    const store = new ModelEvidenceStore(path, projectDirectory)
    try {
      return await run(store)
    } finally {
      store.close()
    }
  }
  const withEvidenceReadStore = <T>(run: (store: EvidenceReadStore) => T): T => {
    const store = evidenceReadStoreFactory(path, projectDirectory)
    try {
      return run(store)
    } finally {
      store.close()
    }
  }
  const failure = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

  return Effect.gen(function* () {
    yield* ctx.rpc.register(Models, {
      settings: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelSettingsRPCInputSchema.parse(input)
            await authorize(
              ctx,
              request.sessionID,
              projectID,
              "lz-get-model-settings",
              [request.taskID ?? projectDirectory],
              signal,
            )
            signal.throwIfAborted()
            const output = withService((service) => service.settings({ taskID: request.taskID }))
            return ModelSettingsOutputSchema.parse(output)
          },
          catch: failure,
        }).pipe(Effect.orDie),
      configure: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelConfigureRPCInputSchema.parse(input)
            const resource =
              request.target.scope === "task" ? request.target.taskID : projectDirectory
            await authorize(
              ctx,
              request.sessionID,
              projectID,
              "lz-configure-models",
              [resource],
              signal,
            )
            signal.throwIfAborted()
            const update = {
              target: request.target,
              persona: request.persona,
              expectedRevision: request.expectedRevision,
              route: request.route,
            }
            return ModelMappingWriteOutputSchema.parse(
              withService((service) => service.configure(update)),
            )
          },
          catch: failure,
        }).pipe(Effect.orDie),
      catalog: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelCatalogRPCInputSchema.parse(input)
            await authorize(
              ctx,
              request.sessionID,
              projectID,
              "lz-models-catalog",
              [projectDirectory],
              signal,
            )
            signal.throwIfAborted()
            return ModelCatalogOutputSchema.parse(await nativeWorkerOptions(ctx))
          },
          catch: failure,
        }).pipe(Effect.orDie),
      sourceEvidence: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelEvidenceRPCInputSchema.parse(input)
            await authorize(
              ctx,
              request.sessionID,
              projectID,
              "lz-read-model-evidence",
              [projectDirectory],
              signal,
            )
            signal.throwIfAborted()
            return ModelEvidenceOutputSchema.parse(
              withEvidenceStore((store) =>
                store.read({
                  snapshotID: request.snapshotID,
                  cursor: request.cursor,
                  limit: request.limit,
                }),
              ),
            )
          },
          catch: failure,
        }).pipe(Effect.orDie),
      comparison: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelComparisonRPCInputSchema.parse(input)
            await authorize(
              ctx,
              request.sessionID,
              projectID,
              "lz-read-model-comparison",
              [projectDirectory],
              signal,
            )
            signal.throwIfAborted()
            const result = withEvidenceReadStore((store) =>
              readModelComparison(store, {
                cursor: request.cursor,
                filters: request.filters,
                limit: request.limit,
              }),
            )
            signal.throwIfAborted()
            const output = ModelComparisonOutputSchema.parse(result)
            signal.throwIfAborted()
            return output
          },
          catch: failure,
        }).pipe(Effect.orDie),
      modelGroups: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelGroupsRPCInputSchema.parse(input)
            await authorize(
              ctx,
              request.sessionID,
              projectID,
              "lz-read-model-groups",
              [projectDirectory],
              signal,
            )
            signal.throwIfAborted()
            const result = withEvidenceReadStore((store) =>
              readModelGroups(store, {
                cursor: request.cursor,
                filters: request.filters,
                limit: request.limit,
              }),
            )
            signal.throwIfAborted()
            const output = ModelGroupsOutputSchema.parse(result)
            signal.throwIfAborted()
            return output
          },
          catch: failure,
        }).pipe(Effect.orDie),
      modelConfigurations: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelConfigurationsRPCInputSchema.parse(input)
            await authorize(
              ctx,
              request.sessionID,
              projectID,
              "lz-read-model-configurations",
              [projectDirectory],
              signal,
            )
            signal.throwIfAborted()
            const result = withEvidenceReadStore((store) =>
              readModelConfigurations(store, {
                groupID: request.groupID,
                context: request.context,
                cursor: request.cursor,
                filters: request.filters,
                limit: request.limit,
              }),
            )
            signal.throwIfAborted()
            const output = ModelConfigurationsOutputSchema.parse(result)
            signal.throwIfAborted()
            return output
          },
          catch: failure,
        }).pipe(Effect.orDie),
      refreshSources: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelSourceRefreshRPCInputSchema.parse(input)
            await authorize(
              ctx,
              request.sessionID,
              projectID,
              "lz-refresh-model-evidence",
              [projectDirectory],
              signal,
            )
            signal.throwIfAborted()
            return ModelEvidenceOutputSchema.parse(
              await withEvidenceStoreAsync((store) =>
                new ModelEvidenceRefresher(ctx, store, fetcher).refresh(signal),
              ),
            )
          },
          catch: failure,
        }).pipe(Effect.orDie),
    })
  })
}
