import { defineConfig } from "vite"
import preact from "@preact/preset-vite"
import stylex from "@stylexjs/unplugin"

export default defineConfig({
  base: "./",
  plugins: [
    stylex.vite({
      useCSSLayers: true,
      dev: process.env.NODE_ENV === "development",
      runtimeInjection: false,
    }),
    preact(),
  ],
})
