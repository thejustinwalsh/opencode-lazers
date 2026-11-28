import { createHmac, randomBytes } from "node:crypto"
import type {
  GitleaksComparisonReader,
  GitleaksResultIdentity,
  GitleaksSkippedInput,
} from "./contract.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const CORRELATION_KEY = randomBytes(32)

function identityParts(value: unknown): GitleaksResultIdentity {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
  return {
    comparisonID: typeof record.comparisonID === "string" ? record.comparisonID : "",
    baseRevision: typeof record.baseRevision === "string" ? record.baseRevision : "",
    headRevision: typeof record.headRevision === "string" ? record.headRevision : "",
  }
}

function aliasIdentity(kind: string, value: string): string {
  return createHmac("sha256", CORRELATION_KEY).update(`${kind}\0${value}`).digest("hex")
}

/** Keyed per-process aliases correlate failures without echoing unscanned metadata. */
export function opaqueGitleaksIdentity(reader: unknown): GitleaksResultIdentity {
  const identity = identityParts(reader)
  return {
    comparisonID: aliasIdentity("comparison", identity.comparisonID),
    baseRevision: aliasIdentity("base", identity.baseRevision),
    headRevision: aliasIdentity("head", identity.headRevision),
  }
}

/** Preserve only opaque host identity formats; replace descriptive or malformed values. */
export function safeGitleaksIdentity(reader: GitleaksComparisonReader): GitleaksResultIdentity {
  const identity = identityParts(reader)
  return {
    comparisonID: UUID.test(identity.comparisonID)
      ? identity.comparisonID
      : aliasIdentity("comparison", identity.comparisonID),
    baseRevision: REVISION.test(identity.baseRevision)
      ? identity.baseRevision
      : aliasIdentity("base", identity.baseRevision),
    headRevision: REVISION.test(identity.headRevision)
      ? identity.headRevision
      : aliasIdentity("head", identity.headRevision),
  }
}

/** Paths are omitted when no detector result can prove that metadata is safe to return. */
export function privacySafeSkipped(
  skipped: readonly GitleaksSkippedInput[],
): GitleaksSkippedInput[] {
  return skipped.map(({ side, reason }) => ({ side, reason }))
}
