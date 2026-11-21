/**
 * Aborts `controller` once the owned audio verification that started a recording or playback is
 * gone: asks the audio fixture every second whether the request still holds the audio, and treats
 * an error or a lost ownership as the reason to stop. Returns the function that stops the check.
 */
export function monitorAudioOwnership(
  audioFixture: {
    enabled(
      input: { requestID: string; sessionID: string },
      options: { signal: AbortSignal },
    ): Promise<boolean>
  },
  controller: AbortController,
  requestID: string,
  sessionID: string,
): () => void {
  let checking = false
  const timer = setInterval(() => {
    if (checking || controller.signal.aborted) return
    checking = true
    void audioFixture
      .enabled(
        { requestID, sessionID },
        { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3_000)]) },
      )
      .then((enabled) => {
        if (!enabled) controller.abort(new Error("Owned audio verification was lost"))
      })
      .catch((error: unknown) => controller.abort(error))
      .finally(() => {
        checking = false
      })
  }, 1_000)
  return () => clearInterval(timer)
}
