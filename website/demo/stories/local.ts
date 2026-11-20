import { defineStory } from "../src/story.ts"
import type { LocalData } from "../src/panels/local-data.ts"

const session: LocalData["session"] = "LZ-204 · Resolve conflicting edits"
const hover = [{ do: "hover", sel: ".lazers-local-icon" }] as const

export default defineStory<LocalData>({
  id: "local",
  panel: "local",
  title: "Local inference",
  size: { width: 560, height: 176 },
  initial: { session, visible: false, phase: "disabled" },
  chapters: [
    {
      name: "off",
      caption: "Local inference starts off. Nothing loads and the header shows no icon.",
    },
    {
      name: "download",
      caption:
        "Turn it on in Settings, LAZERS. The first request downloads the model; D1 is about 625 MB.",
      setup: [],
    },
    {
      name: "ready",
      caption: "The model is resident on the GPU through WebGPU, and the icon reads Available.",
    },
    {
      name: "decide",
      caption:
        "A typed decision runs on the device, and the icon reads Working. Task review uses these decisions.",
    },
  ],
  steps: [
    { at: 0, chapter: "off", data: { visible: false, phase: "disabled", model: undefined } },
    {
      at: 3000,
      chapter: "download",
      data: { visible: true, phase: "downloading", model: undefined },
      actions: [...hover],
    },
    {
      at: 8000,
      chapter: "ready",
      data: { phase: "ready", model: "d1" },
      actions: [...hover],
    },
    {
      at: 13000,
      chapter: "decide",
      data: { phase: "busy", model: "d1" },
      actions: [...hover],
    },
    { at: 17500, data: { phase: "ready", model: "d1" } },
  ],
  end: 21000,
})
