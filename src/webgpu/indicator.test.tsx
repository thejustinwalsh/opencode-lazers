import { expect, test } from "bun:test"
import { createComponent, createRoot, createSignal } from "solid-js"
import { renderToString } from "solid-js/web"
import { Slot } from "@opencode/plugin/gui"
import { PluginContext } from "../../node_modules/@opencode/plugin/dist/gui/internal.js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const tooltipValues: string[] = []
const tooltip = (props: { value: unknown; children: unknown }) => {
  tooltipValues.push(String(props.value))
  return props.children as never
}
const visibleButtonText = (html: string) =>
  html
    .match(/<button\b[^>]*>([\s\S]*?)<\/button>/)?.[1]
    ?.replace(/<svg\b[\s\S]*?<\/svg>/g, "")
    .replace(/<[^>]+>/g, "")

test("registered header renders truthful names and icon-only status", async () => {
  const vite = await createServer({
    configFile: false,
    plugins: [solid()],
    server: { middlewareMode: true, ws: false },
    appType: "custom",
  })
  try {
    const { registerInferenceIndicator } = await vite.ssrLoadModule("/src/webgpu/indicator.tsx")
    const [phase, setPhase] = createSignal("loading")
    const [modelName, setModelName] = createSignal<string | undefined>("LFM3")
    const runtime = { phase, modelName }
    const registrations: Array<{ token: unknown; value: unknown }> = []
    const context = {
      ui: { Tooltip: tooltip },
      add: (token: unknown, value: unknown) => registrations.push({ token, value }),
    }
    let release!: () => void
    createRoot((dispose) => {
      release = dispose
      createComponent(PluginContext.Provider, {
        value: context as never,
        get children() {
          registerInferenceIndicator(
            context as never,
            runtime as never,
            () => true,
            () => {},
          )
          return null
        },
      })
    })
    try {
      const registration = registrations.find((entry) => entry.token === Slot)?.value as {
        at: string
        render: () => unknown
      }
      expect(registration.at).toBe("session.header")
      const html = renderToString(() => registration.render() as never)
      expect(html).toContain('<button type="button"')
      expect(html).toContain('aria-label="LFM3: Loading. Open LAZERS settings."')
      expect(tooltipValues.at(-1)).toBe("LFM3: Loading. Open LAZERS settings.")
      expect(html).toContain('<span class="lazers-local-model">LFM3</span>')
      expect(visibleButtonText(html)).toBe("LFM3")

      setModelName("d1")
      setPhase("ready")
      const available = renderToString(() => registration.render() as never)
      expect(available).toContain('<span class="lazers-local-model">d1</span>')
      expect(available).toContain('aria-label="d1: Available. Open LAZERS settings."')
      expect(available).toContain('data-phase="ready"')
      expect(available).toContain("lazers-gpu-available")
      expect(visibleButtonText(available)).toBe("d1")

      setPhase("error")
      const failed = renderToString(() => registration.render() as never)
      expect(failed).toContain('aria-label="d1: Error. Open LAZERS settings."')
      expect(failed).toContain('data-phase="error"')
      expect(failed).toContain("lazers-gpu-error")
      expect(visibleButtonText(failed)).toBe("d1")

      setModelName(undefined)
      const unknown = renderToString(() => registration.render() as never)
      expect(unknown).not.toContain("LFM3")
      expect(unknown).not.toContain(">d1</span>")
      expect(unknown).toContain('aria-label="Local inference: Error. Open LAZERS settings."')
      expect(visibleButtonText(unknown)).toBe("")
    } finally {
      release()
    }
  } finally {
    await vite.close()
  }
})

test("the indicator uses a native keyboard control, semantic theme colors and reduced motion", async () => {
  const vite = await createServer({
    configFile: false,
    plugins: [solid()],
    server: { middlewareMode: true, ws: false },
    appType: "custom",
  })
  try {
    const { InferenceIndicator, inferenceIndicatorStyles } = await vite.ssrLoadModule(
      "/src/webgpu/indicator.tsx",
    )
    const runtime = {
      modelName: () => "LFM3",
      phase: () => "busy",
    }
    const html = renderToString(() =>
      createComponent(InferenceIndicator, {
        runtime: runtime as never,
        Tooltip: tooltip as never,
        onSettings: () => {},
      }),
    )

    expect(html).toContain('<button type="button"')
    expect(html).toContain('aria-label="LFM3: Working. Open LAZERS settings."')
    expect(html).toContain('<span class="lazers-local-model">LFM3</span>')
    expect(inferenceIndicatorStyles).toContain(":focus-visible")
    expect(inferenceIndicatorStyles).toContain("--icon-base")
    expect(inferenceIndicatorStyles).toContain("--text-critical-base")
    expect(inferenceIndicatorStyles).toContain("font: inherit")
    expect(inferenceIndicatorStyles).toContain("prefers-reduced-motion: reduce")
    expect(inferenceIndicatorStyles).not.toMatch(/#[\da-f]{3,8}\b/i)
  } finally {
    await vite.close()
  }
})
