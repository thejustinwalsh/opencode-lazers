declare module "*lfm3-engine.js" {
  export interface GenerationResult {
    message: { content: string | readonly { type: string; text?: string; audio?: Float32Array }[] }
    finish_reason: string
    usage: { prompt_tokens: number; completion_tokens: number }
  }
  export interface Generation extends AsyncIterable<{
    type: string
    text?: string
    audio?: Float32Array
  }> {
    result: Promise<GenerationResult>
    cancel(): void
  }
  export interface Session {
    generate(
      messages: readonly {
        role: string
        content: string | readonly { type: "audio"; audio: AudioBuffer }[]
      }[],
      options: {
        generation_mode: "text" | "audio" | "interleaved"
        max_new_tokens: number
        signal: AbortSignal
        enable_thinking: false
        depth_decoder_temperature?: number
        depth_decoder_repetition_penalty?: number
      },
    ): Generation
    dispose(): Promise<void>
  }
  export class Lfm3OmniForConditionalGeneration {
    static from_pretrained(
      model: string,
      options: {
        revision: string
        file: string
        mmproj: string
        maxLength: number
        cache: false
        prefixSnapshotStore: null
        signal: AbortSignal
        fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
        onProgress: (progress: { message?: string; fraction?: number }) => void
      },
    ): Promise<Lfm3OmniForConditionalGeneration>
    create_session(): Session
    deviceInfo(): { description?: string; vendor?: string }
    lost: Promise<unknown>
    dispose(): Promise<void>
  }
}
