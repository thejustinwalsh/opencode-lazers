import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { createContext, Script } from "node:vm"

const appRequire = createRequire(new URL("../package.json", import.meta.url))
const identity = (value: unknown) => value
const noop = () => {}

// These host facades permit module registration, but never run main/setup or a GPU job.
const gui = {
  Contract: { define: identity },
  Ipc: { define: identity },
  Plugin: { define: identity },
  Store: { global: () => ({}), session: () => ({}) },
  bindPlugin: identity,
  Style: { css: noop },
}
const web = new Proxy({}, { get: (_, key) => (key === "template" ? () => noop : noop) })
const moduleExports: Record<string, unknown> = {}
const sandbox = createContext({
  exports: moduleExports,
  require(name: string) {
    if (name === "@opencode/plugin/gui") return gui
    if (name === "@opencode/plugin/rpc") return { Rpc: { define: identity } }
    if (name === "@opencode/client") return {}
    if (name === "solid-js/web") return web
    return appRequire(name)
  },
  console,
  TextEncoder,
  TextDecoder,
  URL,
  AbortController,
  AbortSignal,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  performance,
  crypto,
})

new Script(readFileSync(new URL("../dist/gui-experimental.cjs", import.meta.url), "utf8"), {
  filename: "gui-experimental.cjs",
}).runInContext(sandbox, { timeout: 15_000 })

if (!moduleExports.default) throw new Error("GUI bundle did not export its plugin definition")
console.log("GUI bundle evaluates without a renderer process global")
