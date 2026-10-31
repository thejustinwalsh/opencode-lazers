import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

export default defineConfig({
  plugins: [gui()],
  resolve: {
    conditions: ["onnxruntime-web-use-extern-wasm", "module", "browser", "development|production"],
  },
})
