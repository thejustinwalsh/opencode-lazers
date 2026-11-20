import type { OpenCodeClient } from "@opencode/client/promise"
import { RendererInference } from "../rpc.ts"
import type { LocationInferenceRelay } from "./location.ts"
import { InferenceRelay } from "./protocol.ts"

type ClientHooks = {
  afterClaim?: () => void
  beforeBegin?: () => Promise<void>
  beforeComplete?: () => void | Promise<void>
  afterComplete?: () => void | Promise<void>
  recover?: (requestID: string) => Promise<boolean>
}

export function makeClient(
  relay: LocationInferenceRelay,
  infer: (signal?: AbortSignal) => Promise<unknown>,
  hooks: ClientHooks = {},
): OpenCodeClient {
  return {
    rpc(definition: { id: string }) {
      if (definition.id === InferenceRelay.id)
        return {
          discover: async () => relay.discover(),
          claim: async ({ requestID, claimToken }: { requestID: string; claimToken: string }) => {
            const request = relay.claim(requestID, claimToken)
            hooks.afterClaim?.()
            return request
          },
          begin: async ({ requestID, claimToken }: { requestID: string; claimToken: string }) => {
            await hooks.beforeBegin?.()
            return relay.begin(requestID, claimToken)
          },
          renew: async ({ requestID, claimToken }: { requestID: string; claimToken: string }) =>
            relay.renew(requestID, claimToken),
          complete: async ({
            requestID,
            claimToken,
            completion,
          }: {
            requestID: string
            claimToken: string
            completion: Parameters<typeof relay.complete>[2]
          }) => {
            await hooks.beforeComplete?.()
            const result = relay.complete(requestID, claimToken, completion)
            await hooks.afterComplete?.()
            return result
          },
          recover: ({ requestID, claimToken }: { requestID: string; claimToken: string }) =>
            hooks.recover?.(requestID) ?? Promise.resolve(relay.recover(requestID, claimToken)),
          acknowledge: async ({ requestID }: { requestID: string }) => relay.acknowledge(requestID),
        }
      if (definition.id === RendererInference.id) {
        const call = (_input: unknown, options: { signal?: AbortSignal }) => infer(options.signal)
        return { ask: call, settings: call, configure: call }
      }
      throw new Error(`Unexpected RPC: ${definition.id}`)
    },
    debug: { location: { list: async () => [{ directory: "/workspace/project" }] } },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) =>
        (async function* () {
          if (signal.aborted) return
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          )
          yield undefined
        })(),
    },
  } as unknown as OpenCodeClient
}

export async function waitUntil(predicate: () => boolean, progress?: () => Promise<void>) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await progress?.()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Timed out waiting for retained relay state")
}
