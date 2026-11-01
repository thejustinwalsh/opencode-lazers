const { parentPort } = require("node:worker_threads")

if (!parentPort) throw new Error("ELK layout worker requires a parent port")

const scope = {
  onmessage: undefined,
  postMessage(message) {
    parentPort.postMessage(message)
  },
}

globalThis.self = scope
parentPort.on("message", (data) => scope.onmessage?.({ data }))
require("elkjs/lib/elk-worker.js")
