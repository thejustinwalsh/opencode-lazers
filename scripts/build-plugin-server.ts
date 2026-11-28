import { watch } from "node:fs"
import { buildServer } from "./build-server.ts"

async function buildAll() {
  await buildServer()
}

await buildAll()
if (process.argv.includes("--watch")) {
  let timer: ReturnType<typeof setTimeout> | undefined
  watch(new URL("../src", import.meta.url), { recursive: true }, () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      buildAll().then(
        () => console.log("server and Review producers rebuilt"),
        (error) => console.error(error),
      )
    }, 150)
  })
  console.log("Watching src; each rebuild reloads live plugins")
  await new Promise(() => {})
}
