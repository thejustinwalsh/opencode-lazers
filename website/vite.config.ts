import { defineConfig } from "vite"
import preact from "@preact/preset-vite"
import stylex from "@stylexjs/unplugin"

export default defineConfig(({ command }) => ({
  base: "./",
  plugins: [
    stylex.vite({
      useCSSLayers: true,
      dev: command === "serve",
      runtimeInjection: false,
    }),
    preact(),
  ],
}))
