import { Schema } from "effect"

export const shortText = Schema.String.check(Schema.isBetweenLength(1, 160))
const sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const fixtureID = Schema.Literals(["quick-brown-fox", "turn-left-next-street"])
const audioDuration = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(30_000),
)

export const FROZEN_AUDIO_FIXTURES = {
  "quick-brown-fox": {
    file: "quick-brown-fox.wav",
    transcript: "The quick brown fox jumps over the lazy dog.",
    sampleRate: 16_000,
    bytes: 89_560,
    sha256: "0497e70d431e9d827c10bbaff120c9cbabf0834a747107f83cb161dc1f759880",
  },
  "turn-left-next-street": {
    file: "turn-left-next-street.wav",
    transcript: "Please turn left at the next street.",
    sampleRate: 16_000,
    bytes: 70_164,
    sha256: "f9ce57f4e548e339e944ba87860cd35a545db46e5eafd69f3692ede19f6cb054",
  },
} as const

export type FrozenAudioFixtureID = keyof typeof FROZEN_AUDIO_FIXTURES

export const AudioObservationEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["dictation-start"]),
    fixtureID,
    route: Schema.Literals(["runntime"]),
  }),
  Schema.Struct({
    kind: Schema.Literals(["dictation-complete"]),
    fixtureID,
    matchesExpected: Schema.Boolean,
    insertedExactlyOnce: Schema.Boolean,
    insertionCalls: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: 100 }),
    ),
    insertedChars: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: 4_000 }),
    ),
    submitted: Schema.Literals([false]),
  }),
  Schema.Struct({ kind: Schema.Literals(["dictation-cancelled"]), fixtureID }),
  Schema.Struct({ kind: Schema.Literals(["dictation-failed"]), fixtureID }),
  Schema.Struct({
    kind: Schema.Literals(["playback-start"]),
    route: Schema.Literals(["runntime"]),
    expectedTextHash: sha256,
    segmentHashes: Schema.Array(sha256).check(Schema.isBetweenLength(1, 32)),
  }),
  Schema.Struct({
    kind: Schema.Literals(["playback-segment-start", "playback-segment-end"]),
    segmentIndex: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: 31 }),
    ),
    textHash: sha256,
    sampleRate: Schema.Literals([24_000]),
    frames: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 720_000 })),
    durationMs: audioDuration,
  }),
  Schema.Struct({ kind: Schema.Literals(["playback-complete"]) }),
  Schema.Struct({ kind: Schema.Literals(["playback-cancelled", "playback-failed"]) }),
  Schema.Struct({
    kind: Schema.Literals(["intelligibility"]),
    value: Schema.Literals(["pass", "fail", "unknown"]),
  }),
])
export type AudioObservationEvent = typeof AudioObservationEvent.Type

export const AudioFixtureDelivery = Schema.Struct({
  requestID: shortText,
  fixtureID,
  transcript: Schema.String.check(Schema.isBetweenLength(1, 160)),
  sampleRate: Schema.Literals([16_000]),
  durationMs: audioDuration,
  sha256,
  audioBase64: Schema.String.check(Schema.isBetweenLength(1, 160_000)),
})
export type AudioFixtureDelivery = typeof AudioFixtureDelivery.Type

export const PlaybackPlan = Schema.Struct({
  requestID: shortText,
  sessionID: shortText,
  expectedTextHash: sha256,
  segmentHashes: Schema.Array(sha256).check(Schema.isBetweenLength(1, 32)),
})
export type PlaybackPlan = typeof PlaybackPlan.Type

export function normalizeASR(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[.,!?;:'"“”‘’()[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
