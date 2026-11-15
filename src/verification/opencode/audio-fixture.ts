import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { FROZEN_AUDIO_FIXTURES } from "./audio-fixture-contract.ts"
import type { AudioFixtureDelivery, FrozenAudioFixtureID } from "./audio-fixture-contract.ts"

/** Read only the two reviewed, immutable clip IDs from the verification cache. */
export async function readFrozenAudioFixture(
  verificationBase: string,
  id: FrozenAudioFixtureID,
): Promise<AudioFixtureDelivery> {
  const definition = Object.hasOwn(FROZEN_AUDIO_FIXTURES, id)
    ? FROZEN_AUDIO_FIXTURES[id]
    : undefined
  if (definition === undefined) throw new Error("Unknown frozen audio clip ID")
  const directory = join(dirname(resolve(verificationBase)), "lazers-lfm3-audio-reference")
  const expectedPath = join(directory, definition.file)
  const directoryInfo = await lstat(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
    throw new Error("Approved frozen-audio cache is not a real directory")
  const directoryRealpath = await realpath(directory)
  if (directoryRealpath !== resolve(directory))
    throw new Error("Approved frozen-audio cache path changed")
  const info = await lstat(expectedPath)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== definition.bytes)
    throw new Error("Approved frozen clip is missing or has an unexpected size")
  const path = await realpath(expectedPath)
  if (path !== expectedPath) throw new Error("Approved frozen clip path changed")
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes: Buffer
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size !== definition.bytes)
      throw new Error("Approved frozen clip changed before it could be read")
    bytes = await handle.readFile()
  } finally {
    await handle.close()
  }
  const validated = validateFrozenAudioFixture(id, bytes)
  return {
    requestID: "pending",
    fixtureID: id,
    transcript: definition.transcript,
    sampleRate: definition.sampleRate,
    durationMs: validated.durationMs,
    sha256: validated.sha256,
    audioBase64: bytes.toString("base64"),
  }
}

export function validateFrozenAudioFixture(
  id: FrozenAudioFixtureID,
  bytes: Uint8Array,
): { durationMs: number; sha256: string } {
  const definition = Object.hasOwn(FROZEN_AUDIO_FIXTURES, id)
    ? FROZEN_AUDIO_FIXTURES[id]
    : undefined
  if (definition === undefined) throw new Error("Unknown frozen audio clip ID")
  if (bytes.byteLength !== definition.bytes)
    throw new Error("Approved frozen clip is missing or has an unexpected size")
  const hash = createHash("sha256").update(bytes).digest("hex")
  if (hash !== definition.sha256)
    throw new Error("Approved frozen clip failed its pinned SHA-256 check")
  validateFrozenWav(bytes, definition.sampleRate)
  return {
    durationMs: Math.round(((bytes.byteLength - 44) / (definition.sampleRate * 2)) * 1_000),
    sha256: definition.sha256,
  }
}

export function validateFrozenWav(bytes: Uint8Array, sampleRate: number): void {
  if (
    bytes.byteLength < 44 ||
    bytes.byteLength > 100_000 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WAVE" ||
    ascii(bytes, 12, 4) !== "fmt " ||
    ascii(bytes, 36, 4) !== "data"
  ) {
    throw new Error("Frozen clip is not a bounded PCM WAV")
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== 1 ||
    view.getUint32(24, true) !== sampleRate ||
    view.getUint16(34, true) !== 16 ||
    view.getUint32(40, true) !== bytes.byteLength - 44 ||
    (bytes.byteLength - 44) % 2 !== 0
  ) {
    throw new Error("Frozen clip format or sample rate does not match its approved identity")
  }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}
