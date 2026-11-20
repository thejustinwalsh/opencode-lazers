import { expect, test } from "bun:test"
import { adapterBufferLimits, D1_MAX_BUFFER_BYTES } from "./device-limits"

test("requests the adapter's buffer limits, not the WebGPU defaults", async () => {
  const limits = { maxStorageBufferBindingSize: 4_294_967_292, maxBufferSize: 4_294_967_296 }
  const gpu = { requestAdapter: async () => ({ limits }) } as unknown as Pick<GPU, "requestAdapter">
  expect(await adapterBufferLimits(undefined, gpu)).toEqual(limits)
})

test("no adapter requests nothing", async () => {
  const gpu = { requestAdapter: async () => null } as unknown as Pick<GPU, "requestAdapter">
  expect(await adapterBufferLimits(undefined, gpu)).toEqual({})
  expect(await adapterBufferLimits(undefined, undefined)).toEqual({})
})

test("a stated need is requested, clamped between the WebGPU default and the adapter", async () => {
  const limits = { maxStorageBufferBindingSize: 4_294_967_292, maxBufferSize: 4_294_967_296 }
  const gpu = { requestAdapter: async () => ({ limits }) } as unknown as Pick<GPU, "requestAdapter">
  expect(D1_MAX_BUFFER_BYTES).toBe(603_979_776)
  expect(await adapterBufferLimits(D1_MAX_BUFFER_BYTES, gpu)).toEqual({
    maxStorageBufferBindingSize: 603_979_776,
    maxBufferSize: 603_979_776,
  })
  expect(await adapterBufferLimits(1, gpu)).toEqual({
    maxStorageBufferBindingSize: 134_217_728,
    maxBufferSize: 268_435_456,
  })
  expect(await adapterBufferLimits(2 ** 40, gpu)).toEqual(limits)
})
