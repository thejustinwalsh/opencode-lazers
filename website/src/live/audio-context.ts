/** The page's one playback context. It is created, and resumed, inside the visitor's click so
 *  Safari lets later automatic speech play; it costs nothing until first used. */
export const SPEECH_RATE = 24_000
let shared: AudioContext | undefined
export function playbackContext(): AudioContext {
  shared ??= new AudioContext({ sampleRate: SPEECH_RATE })
  return shared
}
export function primeAudio() {
  try {
    void playbackContext().resume()
  } catch {
    // No Web Audio: speech reports its own error when it is needed.
  }
}
export function closeAudio() {
  const ctx = shared
  shared = undefined
  void ctx?.close().catch(() => undefined)
}
