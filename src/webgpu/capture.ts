/** Each recording owns its resources even if a permission/resume promise settles after cancellation. */
export class CaptureResources {
  recorder: MediaRecorder | undefined
  stream: MediaStream | undefined
  meter: AudioContext | undefined
  timer: ReturnType<typeof setInterval> | undefined
  fixtureStop: (() => void) | undefined
  stop() {
    this.fixtureStop?.()
    if (this.recorder?.state === "recording") this.recorder.stop()
  }
  release() {
    clearInterval(this.timer)
    this.timer = undefined
    this.stop()
    this.fixtureStop = undefined
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = undefined
    void this.meter?.close().catch(() => {})
    this.meter = undefined
  }
}
