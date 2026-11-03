import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { nativeWorkerOptions } from "../runner/catalog.ts"
import { TaskRepository } from "../storage.ts"
import {
  ModelCatalogOutputSchema,
  ModelConfigureRPCInputSchema,
  ModelEvidenceRPCInputSchema,
  ModelMappingWriteOutputSchema,
  ModelSourceRefreshRPCInputSchema,
  ModelSettingsOutputSchema,
  ModelSettingsRPCInputSchema,
  ModelCatalogRPCInputSchema,
  Models,
} from "./contract.ts"
import { ModelEvidenceOutputSchema } from "./source-schema.ts"
import { ModelEvidenceRefresher } from "./source-refresh.ts"
import type { ModelEvidenceFetcher } from "./source-refresh.ts"
import { ModelEvidenceStore } from "./source-store.ts"
import { ModelSettingsService } from "./service.ts"

type ModelsContext = Pick<
  Plugin.Context,
  "agent" | "integration" | "location" | "model" | "permission" | "rpc" | "session"
>

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

  const agent = Agent.ID.make(session.agent)
  await Effect.runPromise(
    ctx.permission.assert({
      sessionID: Session.ID.make(session.id),
      agent,
      action,
      resources,
    }),
    { signal },
  )
  return session
}

/** Desktop RPC and Code Mode tools share the same project-scoped SQLite mappings. */
export function registerModelsServer(
  ctx: ModelsContext,
  repository: TaskRepository,
  fetcher?: ModelEvidenceFetcher,
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
              "lazers_get_model_settings",
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
              "lazers_configure_models",
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
              "lazers_models_catalog",
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
              "lazers_read_model_evidence",
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
      refreshSources: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const request = ModelSourceRefreshRPCInputSchema.parse(input)
            await authorize(
              ctx,
              request.sessionID,
              projectID,
              "lazers_refresh_model_evidence",
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
