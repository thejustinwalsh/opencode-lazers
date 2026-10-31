export const AUDIO_RATE = 16_000
export const MAX_AUDIO_SECONDS = 30
const MAX_AUDIO_BYTES = AUDIO_RATE * MAX_AUDIO_SECONDS * 2

/** Bounded mono PCM16 transport; audio is kept in memory, never in plugin storage. */
export function encodePCM16(samples: Float32Array): string {
  if (!samples.length || samples.length * 2 > MAX_AUDIO_BYTES)
    throw new Error("Record between 1 sample and 30 seconds of audio")
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!
    if (!Number.isFinite(sample)) throw new Error("Invalid audio sample")
    view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true)
  }
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 16_384)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384))
  return btoa(binary)
}

export function decodePCM16(base64: string): Float32Array {
  if (
    base64.length > 1_280_000 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
  )
    throw new Error("Invalid audio encoding")
  const binary = atob(base64)
  if (!binary.length || binary.length % 2 || binary.length > MAX_AUDIO_BYTES)
    throw new Error("Audio must be mono PCM16, 16 kHz, at most 30 seconds")
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  return Float32Array.from(
    { length: bytes.length / 2 },
    (_, i) => view.getInt16(i * 2, true) / 32768,
  )
}

export function wavBase64(samples: Float32Array, rate = 24_000): string {
  if (!Number.isInteger(rate) || rate < 8_000 || rate > 48_000)
    throw new Error("Unsupported speech sample rate")
  if (!samples.length || samples.length > rate * MAX_AUDIO_SECONDS)
    throw new Error("Speech exceeds 30 seconds")
  const pcm = atob(encodePCM16AtRate(samples))
  const bytes = new Uint8Array(44 + pcm.length)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i)
  }
  text(0, "RIFF")
  view.setUint32(4, bytes.length - 8, true)
  text(8, "WAVEfmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, "data")
  view.setUint32(40, pcm.length, true)
  for (let i = 0; i < pcm.length; i++) bytes[44 + i] = pcm.charCodeAt(i)
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 16_384)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384))
  return btoa(binary)
}

function encodePCM16AtRate(samples: Float32Array) {
  // Output can be 24 kHz; encode chunks within the stricter 16 kHz transport bound.
  const encoded: string[] = []
  for (let offset = 0; offset < samples.length; offset += AUDIO_RATE)
    encoded.push(atob(encodePCM16(samples.subarray(offset, offset + AUDIO_RATE))))
  return btoa(encoded.join(""))
}

export async function audioFilePCM16(blob: Blob, truncate = false): Promise<string> {
  if (blob.size > 8_000_000) throw new Error("Audio file exceeds 8 MB")
  const audio = new AudioContext()
  try {
    const decoded = await audio.decodeAudioData(await blob.arrayBuffer())
    if (!decoded.duration || (!truncate && decoded.duration > MAX_AUDIO_SECONDS))
      throw new Error("Audio must be 30 seconds or shorter")
    const offline = new OfflineAudioContext(
      1,
      Math.ceil(Math.min(decoded.duration, MAX_AUDIO_SECONDS) * AUDIO_RATE),
      AUDIO_RATE,
    )
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    return encodePCM16((await offline.startRendering()).getChannelData(0))
  } finally {
    await audio.close()
  }
}
