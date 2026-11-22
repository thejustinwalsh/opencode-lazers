import captured from "../models-identity/fixtures/captured-20261103.json" with { type: "json" }
import { ModelEvidenceSnapshotSchema } from "../../src/models/source-schema.ts"
import type { ModelEvidenceSnapshot } from "../../src/models/source-schema.ts"
import type { ModelEvidenceComparisonSourceRead } from "../../src/models/source-store.ts"
import type { CurrentPriceIndex } from "../../src/models/valuation-schema.ts"
import {
  ModelPriceSourceSettingsSchema,
  defaultModelPriceSourcePolicy,
} from "../../src/models/price-source-settings.ts"
import type { makeFixture } from "../trajectory/fixture.ts"
import { createTaskValuationReader } from "../../src/models/task-valuation.ts"
import { nativeMillionTokenIndex } from "../models-valuation/fixtures/current-indexes.ts"

const lz137Route = {
  providerID: "openai",
  modelID: "gpt-6-luna",
  variant: "max",
} as const

const nativeSnapshot = ModelEvidenceSnapshotSchema.parse(captured.native.snapshot)
const openrouterSnapshot = ModelEvidenceSnapshotSchema.parse(captured.openrouter.snapshot)

function readySource(snapshot: ModelEvidenceSnapshot): ModelEvidenceComparisonSourceRead {
  return {
    source: snapshot.source,
    storage: "ready",
    snapshotState: "available",
    snapshotID: snapshot.snapshotID,
    refresh: {
      source: snapshot.source,
      state: "succeeded",
      generation: snapshot.generation,
      startedAt: snapshot.retrievedAt,
      completedAt: snapshot.retrievedAt,
      latestSnapshotID: snapshot.snapshotID,
      latestRetrievedAt: snapshot.retrievedAt,
      latestRecordCount: snapshot.records.length,
      errorCode: null,
      httpStatus: 200,
    },
    snapshot,
  }
}

const lz137MarketSources = [
  readySource(nativeSnapshot),
  readySource(openrouterSnapshot),
] satisfies readonly ModelEvidenceComparisonSourceRead[]

const lz137MarketSettings = ModelPriceSourceSettingsSchema.parse({
  policy: defaultModelPriceSourcePolicy(),
  access: { openrouter: "configured", opencode: "configured" },
})

export function lz137ValuationProvider(options: { withStrictOpenCodePrice?: boolean } = {}) {
  const index: CurrentPriceIndex = structuredClone(nativeMillionTokenIndex)
  if (options.withStrictOpenCodePrice) {
    const strictOpenCodePin: CurrentPriceIndex["pins"][number] = {
      ...structuredClone(nativeMillionTokenIndex.pins[0]!),
      route: { ...lz137Route },
      productID: "openai/gpt-6-luna",
      configurationID: "openai-gpt-6-luna-strict-quote",
      rates: {
        unit: "USD per token",
        uncachedInput: "0.0000002",
        completion: "0.000001",
        cacheRead: "0.00000002",
        cacheWrite: "0.0000002",
      },
      provenance: {
        source: "native-catalog",
        snapshotID: "30000000-0000-4000-8000-000000000004",
        generation: 7,
        retrievedAt: "2026-11-06T12:00:00.000Z",
        asOf: null,
        sourceURL: "https://opencode.ai/v2/docs/models/",
        recordIndex: 1,
        recordID: "gpt-6-luna",
      },
    }
    index.pins = [strictOpenCodePin]
  } else index.pins = []
  return createTaskValuationReader(async (_routes, signal) => {
    signal.throwIfAborted()
    return {
      index: structuredClone(index),
      freshness: "current",
      settings: lz137MarketSettings,
      sources: lz137MarketSources,
    }
  })
}

/** Prepare public retained facts, rather than injecting a cost into the consumer. */
export function prepareLz137RetainedData(fixture: ReturnType<typeof makeFixture>) {
  const sessionID = "ses-failed"
  const attemptID = fixture.attempts[0]!.id
  const session = fixture.sessions.get(sessionID)
  if (!session) throw new Error("LZ-137 fixture session is missing")
  session.model = {
    providerID: lz137Route.providerID,
    id: lz137Route.modelID,
    variant: lz137Route.variant,
  }
  session.tokens = {
    input: 56_452,
    output: 2_061,
    reasoning: 2_202,
    cache: { read: 820_992, write: 0 },
  }

  const usage = Array.from({ length: 19 }, (_, index) => ({
    input: index < 3 ? 2_972 : 2_971,
    cacheRead: index < 2 ? 43_211 : 43_210,
    cacheWrite: 0,
    output: index < 9 ? 109 : 108,
    reasoning: index < 17 ? 116 : 115,
  }))
  const progressRoute = { ...lz137Route }
  fixture.store.atomic((db) => {
    const insert = (input: {
      kind: "step" | "gap"
      index: number
      messageID: string | null
      payload: Record<string, unknown>
    }) => {
      const suffix = `${input.kind}-${input.index}`
      db.query(
        `INSERT INTO runner_progress
         (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,
          source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        fixture.directory,
        "project",
        fixture.receipt.planID,
        fixture.task.id,
        attemptID,
        sessionID,
        5_000 + input.index,
        5_100 + input.index,
        "native-event",
        JSON.stringify(["native-event"]),
        input.kind,
        JSON.stringify([`lz137-${suffix}`]),
        input.messageID,
        input.messageID,
        `lz137-${suffix}`,
        JSON.stringify(input.payload),
      )
    }

    for (const [index, callUsage] of usage.entries()) {
      const messageID = `lz137-call-${index}`
      insert({
        kind: "step",
        index,
        messageID,
        payload: {
          measurementBasis: "additive-step-measurement",
          usage: callUsage,
          route: progressRoute,
          routeEvidence: { status: "observed", route: progressRoute },
        },
      })
    }
    for (const index of [19, 20])
      insert({
        kind: "gap",
        index,
        messageID: null,
        payload: { reason: `Retained recovery gap ${index - 18}` },
      })
  })
  const emptyRetry = fixture.sessions.get("ses-accepted")
  if (emptyRetry) {
    emptyRetry.model = {
      providerID: lz137Route.providerID,
      id: lz137Route.modelID,
      variant: lz137Route.variant,
    }
    emptyRetry.tokens = {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }
    emptyRetry.messages = emptyRetry.messages?.map((message) => {
      const record = message as { model?: unknown }
      return record.model
        ? {
            ...message,
            model: {
              providerID: lz137Route.providerID,
              id: lz137Route.modelID,
              variant: lz137Route.variant,
            },
          }
        : message
    }) as never
  }
  return { route: lz137Route, usage }
}
