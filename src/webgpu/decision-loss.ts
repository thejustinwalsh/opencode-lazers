/**
 * ORT 1.31.1's checked WebGPU status path reports loss as `WebGPU device lost.`
 * or through its device-lost callback as
 * `WebGPU device lost (<reason>): <message>`. When a failed OrtRun surfaces
 * this status, checkLastError supplies the envelope matched below. GPUBuffer
 * download can also report explicit device loss through buffer_manager.cc.
 *
 * Keep this deliberately narrower than lifecycle.recoverable: inference,
 * validation, mapping, and network failures must not retire a resident model.
 */
export const isOrtWebGpuDeviceLoss = (error: unknown): boolean => {
  if (!(error instanceof Error) || error.name !== "Error") return false
  if (!/^failed to call OrtRun\(\)\. ERROR_CODE: -?\d+, ERROR_MESSAGE: /s.test(error.message))
    return false
  return (
    /WebGPU device lost(?:\.| \(\d+\):)/.test(error.message) ||
    (/onnxruntime[/\\]core[/\\]providers[/\\]webgpu[/\\]buffer_manager\.cc:\d+/.test(
      error.message,
    ) &&
      /Failed to execute 'mapAsync' on 'GPUBuffer': Device was lost before MapAsync completed\./.test(
        error.message,
      ))
  )
}
