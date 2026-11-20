import { expect, test } from "bun:test"
import { rpcStreamsTransport, type ChangedEvent, type StreamsRpc } from "./gui.ts"

test("the RPC transport forwards events, and resyncs only after a lost subscription", async () => {
  let subscriptions = 0
  const calls: unknown[] = []
  const rpc = {
    open: async (input: unknown) => (calls.push(["open", input]), { seq: 1, data: "" }),
    slide: async () => ({ seq: 2, data: "" }),
    seek: async () => ({ seq: 3, data: "" }),
    read: async () => ({ seq: 4, data: "" }),
    touch: async () => ({ alive: true }),
    close: async () => ({ closed: true }),
    events: {
      subscribe: () => {
        const n = ++subscriptions
        return (async function* () {
          yield { data: { stream: "s", seq: n } }
          if (n === 1) throw new Error("event stream lost")
          await new Promise(() => {})
        })()
      },
    },
  } as unknown as StreamsRpc
  const controller = new AbortController()
  const transport = rpcStreamsTransport(() => rpc, controller.signal, { resubscribeMs: 10 })
  const seen: ChangedEvent[] = []
  const off = transport.onChanged((event) => seen.push(event))
  for (let i = 0; i < 100 && seen.length < 3; i++) await Bun.sleep(10)
  expect(seen).toEqual([{ stream: "s", seq: 1 }, "resync", { stream: "s", seq: 2 }])
  expect((await transport.read("s")).seq).toBe(4)
  off()
  controller.abort()
})
