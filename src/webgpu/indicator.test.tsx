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
        render: (input: { compact: boolean }) => unknown
      }
      expect(registration.at).toBe("session.header")
      const render = (compact = false) =>
        renderToString(() => registration.render({ compact }) as never)
      const html = render()
      expect(html).toContain('<button type="button"')
      expect(html).toContain('aria-label="LFM3: Loading. Open LAZERS settings."')
      expect(tooltipValues.at(-1)).toBe("LFM3: Loading. Open LAZERS settings.")
      expect(html).toContain('<span class="lazers-local-model">LFM3</span>')
      expect(visibleButtonText(html)).toBe("LFM3")

      setModelName("d1")
      setPhase("ready")
      const available = render()
      expect(available).toContain('<span class="lazers-local-model">d1</span>')
      expect(available).toContain('aria-label="d1: Available. Open LAZERS settings."')
      expect(available).toContain('data-phase="ready"')
      expect(available).toContain("lazers-gpu-available")
      expect(visibleButtonText(available)).toBe("d1")

      setPhase("error")
      // A compact header keeps the glyph and its accessible name, and drops the visible name.
      const compact = render(true)
      expect(compact).toContain('aria-label="d1: Error. Open LAZERS settings."')
      expect(compact).toContain("lazers-gpu-error")
      expect(visibleButtonText(compact)).toBe("")

      const failed = render()
      expect(failed).toContain('aria-label="d1: Error. Open LAZERS settings."')
      expect(failed).toContain('data-phase="error"')
      expect(failed).toContain("lazers-gpu-error")
      expect(visibleButtonText(failed)).toBe("d1")

      setModelName(undefined)
      const unknown = render()
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
    // Working has its own glyph: two states never share one.
    expect(html).toContain("lazers-gpu-working")
    expect(html).not.toContain("lazers-gpu-available")
    const idle = renderToString(() =>
      createComponent(InferenceIndicator, {
        runtime: { modelName: () => "LFM3", phase: () => "ready" } as never,
        Tooltip: tooltip as never,
        onSettings: () => {},
      }),
    )
    expect(idle).toContain("lazers-gpu-available")
    expect(idle).not.toContain("lazers-gpu-working")
    // An error names its short reason in the tooltip; the raw text is only in Settings.
    const failed = renderToString(() =>
      createComponent(InferenceIndicator, {
        runtime: {
          modelName: () => "LFM3",
          phase: () => "error",
          detail: () => "The main-process provider changed without exact retirement evidence",
        } as never,
        Tooltip: tooltip as never,
        onSettings: () => {},
      }),
    )
    expect(failed).toContain('aria-label="LFM3: Error · Provider changed. Open LAZERS settings."')
    expect(failed).not.toContain("retirement evidence")
    expect(html).toContain('<span class="lazers-local-model">LFM3</span>')
    expect(inferenceIndicatorStyles).toContain(":focus-visible")
    expect(inferenceIndicatorStyles).toContain("--icon-base")
    expect(inferenceIndicatorStyles).toContain("--text-critical-base")
    expect(inferenceIndicatorStyles).toContain("font: inherit")
    expect(inferenceIndicatorStyles).toContain("prefers-reduced-motion: reduce")
    expect(inferenceIndicatorStyles).not.toMatch(/#[\da-f]{3,8}\b/i)
    // Sized to the host's 26px header controls, with a 16px glyph.
    expect(inferenceIndicatorStyles).toContain("height: 26px")
    expect(inferenceIndicatorStyles).toContain("min-width: 26px")
    expect(html).toContain('width="16"')
  } finally {
    await vite.close()
  }
})
