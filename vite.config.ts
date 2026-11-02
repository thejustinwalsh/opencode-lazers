import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"
import { readFileSync } from "node:fs"

export default defineConfig({
  plugins: [gui()],
  define: {
    __LAZERS_RADAR_WORKER_SOURCE__: JSON.stringify(
      readFileSync(new URL("./dist/radar-layout-worker.cjs", import.meta.url), "utf8"),
    ),
  },
  resolve: {
    conditions: ["onnxruntime-web-use-extern-wasm", "module", "browser", "development|production"],
  },
})
