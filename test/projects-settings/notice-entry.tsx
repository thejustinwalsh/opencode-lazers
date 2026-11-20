import { createRoot, createSignal } from "solid-js"
import { setupNotice } from "../../src/projects/setup-notice.tsx"
import type { SetupStartedView, SetupStatusView } from "../../src/projects/contract.ts"

type Toast = {
  title: string
  description?: string
  persistent?: boolean
  actions?: { label: string; run(): void }[]
}

/** A fake window: a routed session, a recording toast API and an RPC that answers from `options`. */
export function noticeHarness(options: {
  status: SetupStatusView | "offline"
  started?: SetupStartedView
}) {
  const toasts: Toast[] = []
  const tabs: { session: { server: string; id: string }; options?: { focus?: boolean } }[] = []
  const settings: (string | undefined)[] = []
  const calls: { method: string; input: Record<string, unknown>; location?: unknown }[] = []
  const methods: Record<string, (input: never) => unknown> = {
    setupStatus: () => {
      if (options.status === "offline") throw new Error("offline")
      return options.status
    },
    startSetup: () => options.started ?? { ok: true, sessionID: "setup-1" },
    dismissSetup: () => ({ ok: true }),
  }
  const server = {
    id: "srv",
    client: {
      rpc: () =>
        new Proxy(
          {},
          {
            get:
              (_, method: string) =>
              async (input: Record<string, unknown>, call?: { location?: unknown }) => {
                calls.push({ method, input, location: call?.location })
                return methods[method]!(input as never)
              },
          },
        ),
    },
  }
  const [current, setCurrent] = createSignal<unknown>()
  const ctx = {
    signal: new AbortController().signal,
    sessions: { current, list: () => [] },
    toast: { show: (toast: Toast) => (toasts.push(toast), { dismiss() {} }) },
    tabs: { open: (session: never, opts?: never) => void tabs.push({ session, options: opts }) },
    layout: { settings: (page?: string) => void settings.push(page) },
  }
  const dispose = createRoot((dispose) => {
    setupNotice(ctx as never)
    return dispose
  })
  return {
    toasts,
    tabs,
    settings,
    calls,
    mount: (id: string, directory = "/work/alpha") => setCurrent({ id, server, directory }),
    dispose,
  }
}
