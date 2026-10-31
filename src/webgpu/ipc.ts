import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"

export const CacheStatus = Schema.Struct({
  phase: Schema.String,
  cachedBytes: Schema.Number,
  totalBytes: Schema.Number,
  downloadedBytes: Schema.Number,
  directory: Schema.String,
  error: Schema.String,
  occupied: Schema.Boolean,
})
export const ModelFiles = Ipc.define({
  id: "lazers.webgpu-files",
  methods: {
    status: { output: CacheStatus },
    decisionStatus: { output: CacheStatus },
    acquire: { output: Schema.String },
    ensure: { input: Schema.Struct({ owner: Schema.String }) },
    decisionEnsure: { input: Schema.Struct({ owner: Schema.String }) },
    decisionRead: {
      input: Schema.Struct({
        owner: Schema.String,
        id: Schema.String,
        offset: Schema.Number,
        length: Schema.Number,
      }),
      output: Schema.String,
    },
    read: {
      input: Schema.Struct({
        owner: Schema.String,
        id: Schema.String,
        offset: Schema.Number,
        length: Schema.Number,
      }),
      output: Schema.String,
    },
    release: { input: Schema.Struct({ owner: Schema.String }) },
    cancel: { input: Schema.Struct({ owner: Schema.String }) },
    clear: {},
  },
})
