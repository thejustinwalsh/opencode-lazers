/**
 * WebGPU gives a device the default limits unless larger ones are requested: a 128 MiB storage
 * buffer binding and a 256 MiB buffer, whatever the adapter supports. A long prompt needs larger
 * activations (measured: 138 to 249 MB at 3,700 to 12,400 tokens on D1), so request the
 * adapter's own limits for the two buffer sizes.
 */
export async function adapterBufferLimits(
  gpu: Pick<GPU, "requestAdapter"> | undefined = globalThis.navigator?.gpu,
): Promise<Record<string, number>> {
  const adapter = await gpu?.requestAdapter()
  if (!adapter) return {}
  return {
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxBufferSize: adapter.limits.maxBufferSize,
  }
}
