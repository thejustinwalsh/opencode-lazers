import type { FailureReason, FileProgress, HistoryMessage } from "./machine"

/** Main thread -> worker. */
export type ToWorker =
  | { t: "load" }
  | { t: "cancelLoad" }
  | { t: "generate"; id: number; history: HistoryMessage[] }
  | { t: "speak"; id: number; text: string }
  | { t: "transcribe"; pcm: Float32Array }
  | { t: "cancelJob" }
  | { t: "stopSpeech" }
  | { t: "unload" }

/** Worker -> main thread. */
export type FromWorker =
  | { t: "download"; files: FileProgress[] }
  | { t: "loading"; fromCache: boolean }
  | { t: "loaded"; fromCache: boolean; ms: number }
  | { t: "loadFailed"; reason: FailureReason | "unsupported"; message: string }
  | { t: "token"; id: number; text: string }
  | { t: "genDone"; id: number; text: string; ms: number; tokens: number }
  | { t: "genFailed"; id: number; message: string }
  | { t: "speechChunk"; id: number; samples: Float32Array }
  | { t: "speechEnd"; id: number }
  | { t: "speechFailed"; id: number; message: string }
  | { t: "transcribed"; text: string }
  | { t: "transcribeFailed"; message: string }
  | { t: "deviceLost"; message: string }
  | { t: "unloaded" }
