import { expect, test } from "bun:test"
import { adapterBufferLimits } from "./device-limits"

test("requests the adapter's buffer limits, not the WebGPU defaults", async () => {
  const limits = { maxStorageBufferBindingSize: 4_294_967_292, maxBufferSize: 4_294_967_296 }
  const gpu = { requestAdapter: async () => ({ limits }) } as unknown as Pick<GPU, "requestAdapter">
  expect(await adapterBufferLimits(gpu)).toEqual(limits)
})

test("no adapter requests nothing", async () => {
  const gpu = { requestAdapter: async () => null } as unknown as Pick<GPU, "requestAdapter">
  expect(await adapterBufferLimits(gpu)).toEqual({})
  expect(await adapterBufferLimits(undefined)).toEqual({})
})
