import { expect, test } from "bun:test"
import { decodePCM16, encodePCM16, wavBase64 } from "./audio.ts"

test("bounded PCM transport round-trips without retaining recording files", () => {
  const samples = new Float32Array([-1, -0.5, 0, 0.5, 1])
  const decoded = decodePCM16(encodePCM16(samples))
  samples.forEach((sample, i) => expect(decoded[i]).toBeCloseTo(sample, 4))
  expect(() => encodePCM16(new Float32Array([NaN]))).toThrow()
  expect(() => encodePCM16(new Float32Array(480001))).toThrow()
  expect(() => decodePCM16("AA==")).toThrow()
  expect(() => decodePCM16("!bad")).toThrow()
  const wav = Uint8Array.from(atob(wavBase64(samples)), (c) => c.charCodeAt(0))
  expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF")
  expect(new DataView(wav.buffer).getUint32(24, true)).toBe(24000)
  expect(wav.length).toBe(54)
})

test("maximum-duration audio stays bounded and malformed long encodings fail", () => {
  const encoded = encodePCM16(new Float32Array(480_000))
  expect(encoded.length).toBe(1_280_000)
  expect(decodePCM16(encoded).length).toBe(480_000)
  expect(() => decodePCM16(encoded + "AAAA")).toThrow()
  expect(() => decodePCM16(encoded.slice(0, -1) + "!")).toThrow()
  expect(() => wavBase64(new Float32Array(720_001))).toThrow()
  expect(() => wavBase64(new Float32Array([0]), Infinity)).toThrow("sample rate")
})
