import { expect, test } from "bun:test"
import { runtimeErrorReason, runtimeStatusLine } from "./runtime-status.ts"

const base = { enabled: true, modelName: "LFM3" }

test("each runtime phase reads as one short plain state", () => {
  expect(runtimeStatusLine({ ...base, phase: "ready" }).text).toBe("LFM3 loaded")
  expect(runtimeStatusLine({ ...base, phase: "busy" }).text).toBe("LFM3 working")
  expect(runtimeStatusLine({ ...base, phase: "unloaded" }).text).toBe(
    "Unloaded · loads on next request",
  )
  expect(runtimeStatusLine({ ...base, phase: "loading" }).text).toBe("Loading")
  expect(
    runtimeStatusLine({ ...base, phase: "downloading", detail: "Downloading local models · 42%" })
      .text,
  ).toBe("Downloading · 42%")
  expect(runtimeStatusLine({ ...base, phase: "downloading" }).text).toBe("Downloading")
  // No resident model: say so without a name.
  expect(runtimeStatusLine({ enabled: true, phase: "ready" }).text).toBe("Loaded")
  expect(runtimeStatusLine({ enabled: false, phase: "disabled" }).text).toBe("Off")
  expect(runtimeStatusLine({ enabled: false, phase: "ready" }).text).toBe("Stopping local work")
})

test("the runtime's own prose never reaches the header line", () => {
  const prose = [
    "d1 ready · chat and speech load on demand",
    "Loading ruNNtime Omni audio · model.gguf · 12%",
    "Preparing local intelligence",
    "Evaluating decision questions locally",
  ]
  for (const detail of prose)
    for (const phase of ["ready", "busy", "unloaded", "loading", "downloading"])
      expect(runtimeStatusLine({ ...base, phase, detail }).text).not.toContain(detail)
})

test("known failures become a short reason and the raw text stays in the tooltip", () => {
  const raw = "The main-process provider changed without exact retirement evidence"
  expect(runtimeStatusLine({ ...base, phase: "error", detail: raw })).toEqual({
    text: "Error · Provider changed",
    tooltip: raw,
  })
  const known: Array<[string, string]> = [
    ["WebGPU is unavailable in this Desktop renderer", "WebGPU unavailable"],
    [
      "GPU cleanup failed; ownership is retained. Retry unloading before using local inference.",
      "GPU cleanup failed",
    ],
    [
      "Local inference completion contract is not verified; reload the OpenCode service and reopen Desktop before probing.",
      "Service needs reload",
    ],
    ["GPU device lost; recovering from verified disk cache", "GPU device lost"],
    ["Out of memory while allocating the model", "Out of memory"],
    ["Model download failed", "Download failed"],
  ]
  for (const [text, reason] of known) {
    expect(runtimeErrorReason(text)).toBe(reason)
    const line = runtimeStatusLine({ ...base, phase: "error", detail: text })
    expect(line.text).toBe(`Error · ${reason}`)
    expect(line.text).not.toContain(text)
    expect(line.tooltip).toBe(text)
  }
})

test("an unknown error is a bare Error with the raw text in the tooltip", () => {
  const detail = "TypeError: cannot read properties of undefined (reading 'engine')"
  expect(runtimeErrorReason(detail)).toBeUndefined()
  expect(runtimeStatusLine({ ...base, phase: "error", detail })).toEqual({
    text: "Error",
    tooltip: detail,
  })
  expect(runtimeStatusLine({ ...base, phase: "error" })).toEqual({ text: "Error" })
  // An error shows even when the feature is switched off, so a failed cleanup is not hidden.
  expect(runtimeStatusLine({ enabled: false, phase: "error", detail }).text).toBe("Error")
})
