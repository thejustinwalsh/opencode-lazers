import { expect, test } from "bun:test"
import { OpenCode } from "@opencode/client"
import type { InferenceResult } from "./rpc.ts"
import { createNativeLanguageModel } from "./native-conversation.ts"
import { createRendererInferenceClient, forwardNativeConversation } from "./server.ts"

const history = [
  { role: "system" as const, content: "Follow the project rule." },
  { role: "user" as const, content: "First question." },
  { role: "assistant" as const, content: "Earlier answer." },
  { role: "user" as const, content: "Continue from the earlier answer." },
]

const successful = (text: string): InferenceResult => ({
  ok: true,
  text,
  error: "",
  promptTokens: null,
  completionTokens: null,
  finishReason: "stop",
})

function pauseWithSignal(ms: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal?.removeEventListener("abort", abort)
    const abort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      reject(signal?.reason ?? new Error("Event connection was cancelled"))
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }, ms)
    if (signal?.aborted) abort()
    else signal?.addEventListener("abort", abort, { once: true })
  })
}

async function until(condition: () => boolean, label: string) {
  const deadline = Date.now() + 3_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await Bun.sleep(0)
  }
}

test("native conversation waits for delayed pinned-client events and recovers from handshake aborts", async () => {
  const encoder = new TextEncoder()
  let eventConnections = 0
  let abortedConnections = 0
  let cancelledStreams = 0
  let activeStreams = 0
  let readyCalls = 0
  let lostReady = 0
  let generationCalls = 0
  let generationBeforeReady = 0
  let matchingReadySent = false
  let eventController: ReadableStreamDefaultController<Uint8Array> | undefined
  const publish = (event: unknown) => {
    try {
      eventController?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      return eventController !== undefined
    } catch {
      return false
    }
  }
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/api/event") {
      const attempt = ++eventConnections
      try {
        await pauseWithSignal(attempt < 3 ? 200 : 25, init?.signal)
      } catch (error) {
        abortedConnections++
        throw error
      }
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
      let streamClosed = false
      const closeStream = () => {
        if (streamClosed) return
        streamClosed = true
        cancelledStreams++
        activeStreams--
        if (eventController === streamController) eventController = undefined
        try {
          streamController?.close()
        } catch {
          // The reader may already have cancelled the stream.
        }
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller
            eventController = controller
            activeStreams++
            const send = (event: unknown) =>
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
            send({ type: "server.connected" })
            if (attempt === 3)
              send({
                type: "rpc.lazers.webgpu-worker.nativeConversation",
                location: { directory: "/default" },
                data: { requestID: "stale-request", type: "ready" },
              })
            init?.signal?.addEventListener("abort", closeStream, { once: true })
          },
          cancel: closeStream,
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }

    if (url.pathname === "/api/rpc/lazers.webgpu-worker/nativeConversationReady") {
      readyCalls++
      const body = JSON.parse(String(init?.body)) as { input: { requestID: string } }
      const requestID = body.input.requestID
      if (!eventController) lostReady++
      else
        setTimeout(() => {
          matchingReadySent = true
          publish({
            type: "rpc.lazers.webgpu-worker.nativeConversation",
            location: { directory: "/default" },
            data: { requestID, type: "ready" },
          })
        }, 20)
      return Response.json({ output: {} })
    }

    if (url.pathname === "/api/rpc/lazers.webgpu-worker/nativeConversation") {
      generationCalls++
      if (!matchingReadySent) generationBeforeReady++
      const body = JSON.parse(String(init?.body)) as { input: { requestID: string } }
      const requestID = body.input.requestID
      publish({
        type: "rpc.lazers.webgpu-worker.nativeConversation",
        location: { directory: "/default" },
        data: { requestID, type: "delta", text: "ordered " },
      })
      publish({
        type: "rpc.lazers.webgpu-worker.nativeConversation",
        location: { directory: "/default" },
        data: { requestID, type: "delta", text: "reply" },
      })
      publish({
        type: "rpc.lazers.webgpu-worker.nativeConversation",
        location: { directory: "/default" },
        data: { requestID, type: "end" },
      })
      return Response.json({ output: successful("ordered reply") })
    }

    throw new Error(`Unexpected OpenCode client request: ${url.pathname}`)
  }
  const model = createNativeLanguageModel("native-test-model", "runntime", (call) =>
    forwardNativeConversation(
      createRendererInferenceClient(
        OpenCode.make({ baseUrl: "http://opencode.test", fetch: fetcher as typeof fetch }),
      ),
      call,
    ),
  )

  const interrupted = new AbortController()
  const interruptedStream = await model.doStream({
    prompt: history.map((message) =>
      message.role === "system"
        ? { role: message.role, content: message.content }
        : { role: message.role, content: [{ type: "text" as const, text: message.content }] },
    ),
    abortSignal: interrupted.signal,
  })
  const interruptedResult = Array.fromAsync(interruptedStream.stream)
  await until(() => eventConnections === 1, "first delayed event connection")
  interrupted.abort(new Error("cancelled during event handshake"))
  await expect(interruptedResult).rejects.toThrow("cancelled during event handshake")
  await until(() => abortedConnections === 1, "cancelled event connection cleanup")
  expect(readyCalls).toBe(0)
  expect(generationCalls).toBe(0)
  expect(activeStreams).toBe(0)

  const timeoutStream = await model.doStream({
    prompt: history.map((message) =>
      message.role === "system"
        ? { role: message.role, content: message.content }
        : { role: message.role, content: [{ type: "text" as const, text: message.content }] },
    ),
    abortSignal: AbortSignal.timeout(40),
  })
  const timeoutResult = Array.fromAsync(timeoutStream.stream)
  await until(() => eventConnections === 2, "second delayed event connection")
  await expect(timeoutResult).rejects.toThrow()
  await until(() => abortedConnections === 2, "timed-out event connection cleanup")
  expect(readyCalls).toBe(0)
  expect(generationCalls).toBe(0)
  expect(activeStreams).toBe(0)

  const freshStream = await model.doStream({
    prompt: history.map((message) =>
      message.role === "system"
        ? { role: message.role, content: message.content }
        : { role: message.role, content: [{ type: "text" as const, text: message.content }] },
    ),
  })
  const parts = await Array.fromAsync(freshStream.stream)
  expect(
    parts
      .filter((part) => part.type === "text-delta")
      .map((part) => (part.type === "text-delta" ? part.delta : "")),
  ).toEqual(["ordered ", "reply"])
  expect(parts.filter((part) => part.type === "finish")).toHaveLength(1)
  expect(readyCalls).toBe(1)
  expect(lostReady).toBe(0)
  expect(generationCalls).toBe(1)
  expect(generationBeforeReady).toBe(0)
  await until(() => cancelledStreams === 1, "successful event stream cleanup")
  expect(activeStreams).toBe(0)
}, 10_000)
