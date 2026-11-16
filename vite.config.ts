import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const buildWorker = fileURLToPath(new URL("./scripts/build-radar-layout.ts", import.meta.url))

export default defineConfig({
  plugins: [gui()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    __LAZERS_RADAR_WORKER_SOURCE__: JSON.stringify(
      execFileSync("bun", [buildWorker, "--stdout"], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }),
    ),
  },
  resolve: {
    conditions: ["module", "browser", "development|production"],
  },
})
