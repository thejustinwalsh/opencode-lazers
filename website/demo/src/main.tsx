import "./theme.css"
import type { DemoCommand, DemoMessageBody } from "../../src/lib/demo-protocol.ts"
import { handleCommand } from "./commands.ts"
import { Engine } from "./engine.ts"
import type { MountedHost } from "./host.tsx"
import type { PanelID, Story } from "./story.ts"
import { dataAt } from "./story.ts"

export type PanelModule = {
  mount(container: HTMLElement, data: () => unknown): MountedHost<unknown>
}
const modules: Record<PanelID, () => Promise<PanelModule>> = {
  tasks: () => import("./panels/tasks.ts") as never,
  radar: () => import("./panels/radar.ts") as never,
  trajectory: () => import("./panels/trajectory.ts") as never,
  models: () => import("./panels/models.ts") as never,
  local: () => import("./panels/local.tsx") as never,
}

async function boot() {
  const params = new URLSearchParams(location.hash.slice(1))
  const storyID = params.get("story") ?? "hero"
  const panelID = (params.get("panel") ?? "tasks") as PanelID
  const at = params.get("at") ?? undefined
  const settled = params.get("settled") === "1" || at === "final"
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches || settled
  if (params.get("theme") === "light") document.documentElement.dataset.theme = "light"

  const story = (await (await fetch(`./stories/${storyID}.json`)).json()) as Story<unknown>
  const post = (message: DemoMessageBody) =>
    parent !== window &&
    parent.postMessage({ demo: true, story: storyID, ...message }, location.origin)

  const root = document.getElementById("root")!
  root.innerHTML = `<div class="oc-shell"><div class="oc-tabbar"><span>${story.title}</span></div><div class="oc-body"></div></div>`
  const body = root.querySelector<HTMLElement>(".oc-body")!
  let current = dataAt(story, 0)
  const startChapter =
    at === "final"
      ? story.chapters[story.chapters.length - 1]!.name
      : (at ?? story.chapters[0]!.name)
  const chapter = story.chapters.find((c) => c.name === startChapter) ?? story.chapters[0]!
  current = dataAt(story, settled ? chapter.at + chapter.ms - 1 : chapter.at)

  const host: { mounted?: MountedHost<unknown> } = {}
  // The engine goes first: it pins `Date.now()` to the story clock before the panel reads it.
  const engine = new Engine({
    story,
    root: body,
    post,
    reduced,
    applyData(data) {
      current = data
      host.mounted?.changed(data)
    },
  })
  host.mounted = (await modules[panelID]()).mount(body, () => current)
  const entered = await engine.enter(startChapter, settled)
  post({
    type: "ready",
    chapters: story.chapters.map(({ name, caption, at, ms }) => ({ name, caption, at, ms })),
    width: story.size.width,
    height: story.size.height,
  })
  let playing: Promise<void> | undefined
  const start = () => {
    if (!playing) playing = engine.play(entered.from)
    else engine.resume()
  }
  // Installed for settled frames too: the chapter buttons seek whatever the motion setting.
  addEventListener("message", (event: MessageEvent) => {
    if (event.origin !== location.origin || event.source !== parent) return
    handleCommand(event.data as DemoCommand, {
      ...(settled ? {} : { play: start, pause: () => engine.pause() }),
      seek(chapter) {
        params.set("at", chapter)
        params.delete("settled")
        if (reduced) params.set("settled", "1")
        location.hash = params.toString()
        location.reload()
      },
    })
  })
  if (settled) {
    post({
      type: "chapter",
      name: entered.chapter.name,
      index: story.chapters.indexOf(entered.chapter),
      ms: entered.chapter.ms,
    })
    return
  }
  if (parent === window) start()
}

void boot()
