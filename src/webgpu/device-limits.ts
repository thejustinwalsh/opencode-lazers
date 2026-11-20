/**
 * WebGPU gives a device the default limits unless larger ones are requested: a 128 MiB storage
 * buffer binding and a 256 MiB buffer, whatever the adapter supports. A long prompt needs larger
 * activations (measured: 138 to 249 MB at 3,700 to 12,400 tokens on D1).
 *
 * With `bytes`, the largest single buffer the model can need, the request is that size: never
 * below the WebGPU default and never above the adapter. With no `bytes` it is the adapter's own
 * limits.
 */
export async function adapterBufferLimits(
  bytes?: number,
  gpu: Pick<GPU, "requestAdapter"> | undefined = globalThis.navigator?.gpu,
): Promise<Record<string, number>> {
  const adapter = await gpu?.requestAdapter()
  if (!adapter) return {}
  const { maxStorageBufferBindingSize: binding, maxBufferSize: buffer } = adapter.limits
  if (bytes === undefined) return { maxStorageBufferBindingSize: binding, maxBufferSize: buffer }
  return {
    maxStorageBufferBindingSize: Math.min(binding, Math.max(bytes, DEFAULT_BINDING)),
    maxBufferSize: Math.min(buffer, Math.max(bytes, DEFAULT_BUFFER)),
  }
}

const DEFAULT_BINDING = 134_217_728
const DEFAULT_BUFFER = 268_435_456

/**
 * D1's largest buffer: one f32 activation of [tokens, 2 x ffn], the gated feed-forward's first
 * projection. Weights are Q8 and smaller (the embedding is 65,536 x 1,024 bytes = 67 MB), and
 * quantization does not shrink activations. 16,384 tokens x 9,216 x 4 bytes = 604 MB. The
 * measured refusals match the formula: [3738, 9216] = 137.8 MB, [6752, 9216] = 248.9 MB.
 */
export const D1_MAX_BUFFER_BYTES = 16_384 * (2 * 4_608) * 4
