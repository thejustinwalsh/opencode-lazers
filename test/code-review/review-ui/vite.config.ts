import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("../../..", import.meta.url))
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: fileURLToPath(
    new URL("../../../node_modules/.cache/review-ui-harness", import.meta.url),
  ),
  plugins: [solid()],
  resolve: { conditions: ["browser", "development", "module"] },
  server: { fs: { allow: [repo] } },
  build: { target: "esnext" },
})
