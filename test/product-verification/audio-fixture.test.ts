import { expect, test } from "bun:test"
import { Schema } from "effect"
import {
  AudioObservationEvent,
  FROZEN_AUDIO_FIXTURES,
  normalizeASR,
  sha256Text,
} from "../../src/verification/opencode/audio-fixture-contract.ts"
import {
  readFrozenAudioFixture,
  validateFrozenAudioFixture,
  validateFrozenWav,
} from "../../src/verification/opencode/audio-fixture.ts"

function pcmWav(sampleRate = 16_000): Uint8Array {
  const bytes = new Uint8Array(46)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      bytes[offset + index] = value.charCodeAt(index)
  }
  text(0, "RIFF")
  view.setUint32(4, bytes.length - 8, true)
  text(8, "WAVEfmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, "data")
  view.setUint32(40, 2, true)
  return bytes
}

test("frozen audio IDs expose only the pinned clean clips and normalize ASR punctuation", () => {
  expect(Object.keys(FROZEN_AUDIO_FIXTURES)).toEqual(["quick-brown-fox", "turn-left-next-street"])
  expect(FROZEN_AUDIO_FIXTURES["quick-brown-fox"]).toMatchObject({
    transcript: "The quick brown fox jumps over the lazy dog.",
    sampleRate: 16_000,
    bytes: 89_560,
    sha256: "0497e70d431e9d827c10bbaff120c9cbabf0834a747107f83cb161dc1f759880",
  })
  expect(FROZEN_AUDIO_FIXTURES["turn-left-next-street"]).toMatchObject({
    transcript: "Please turn left at the next street.",
    sampleRate: 16_000,
    bytes: 70_164,
    sha256: "f9ce57f4e548e339e944ba87860cd35a545db46e5eafd69f3692ede19f6cb054",
  })
  expect(normalizeASR("  THE quick, brown fox! ")).toBe("the quick brown fox")
})

test("fixture content identity hashes and bounded PCM16 WAV checks reject tampering", async () => {
  expect(await sha256Text("The quick brown fox jumps over the lazy dog.")).toMatch(/^[a-f0-9]{64}$/)
  expect(() => validateFrozenWav(pcmWav(), 16_000)).not.toThrow()
  expect(() => validateFrozenWav(pcmWav(24_000), 16_000)).toThrow("sample rate")
  const malformed = pcmWav()
  new DataView(malformed.buffer).setUint16(22, 2, true)
  expect(() => validateFrozenWav(malformed, 16_000)).toThrow("format")
})

test("dictation completion receipts cannot claim insertion without inserted words", () => {
  const receipt = {
    kind: "dictation-complete",
    fixtureID: "quick-brown-fox",
    matchesExpected: true,
    insertedExactlyOnce: true,
    insertionCalls: 0,
    insertedChars: 0,
    submitted: false,
  }
  expect(() => Schema.decodeUnknownSync(AudioObservationEvent)(receipt)).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(AudioObservationEvent)({
      ...receipt,
      insertionCalls: 1,
      insertedChars: 45,
    }),
  ).not.toThrow()
})

test("frozen fixture lookup rejects arbitrary file references before filesystem access", async () => {
  for (const unknownID of ["/etc/passwd", "__proto__"]) {
    await expect(readFrozenAudioFixture("/untrusted/root", unknownID as never)).rejects.toThrow(
      "Unknown frozen audio clip ID",
    )
  }
})

test("frozen clips reject tampered and oversized bytes before delivery", () => {
  expect(() =>
    validateFrozenAudioFixture(
      "quick-brown-fox",
      new Uint8Array(FROZEN_AUDIO_FIXTURES["quick-brown-fox"].bytes),
    ),
  ).toThrow("pinned SHA-256")
  expect(() =>
    validateFrozenAudioFixture(
      "quick-brown-fox",
      new Uint8Array(FROZEN_AUDIO_FIXTURES["quick-brown-fox"].bytes + 1),
    ),
  ).toThrow("unexpected size")
})
