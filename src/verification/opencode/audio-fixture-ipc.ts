import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"
import {
  AudioFixtureDelivery,
  AudioObservationEvent,
  PlaybackPlan,
  shortText,
} from "./audio-fixture-contract.ts"

const AudioFixtureStatus = Schema.Struct({
  requestID: Schema.optional(shortText),
  sessionID: Schema.optional(shortText),
})

export const NativeAudioFixture = Ipc.define({
  id: "lazers.verification.audio-fixture",
  methods: {
    enabled: { input: AudioFixtureStatus, output: Schema.Boolean },
    takeDictation: {
      input: Schema.Struct({ sessionID: shortText }),
      output: Schema.NullOr(AudioFixtureDelivery),
    },
    takePlaybackPlan: {
      input: Schema.Struct({ sessionID: shortText }),
      output: Schema.NullOr(PlaybackPlan),
    },
    observe: {
      input: Schema.Struct({
        requestID: shortText,
        sessionID: shortText,
        event: AudioObservationEvent,
      }),
    },
  },
})
