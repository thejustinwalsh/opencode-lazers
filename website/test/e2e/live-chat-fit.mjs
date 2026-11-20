/**
 * Layout guard for the live chat in a real browser (headless Chromium, no GPU needed). The dev
 * server exposes `window.__lazersChat.set(state)`, so every state is drawn without loading the
 * model. For each width and state it asserts the chat fits its parent column and the viewport, that
 * the header, pill lane and composer sit fully inside the frame, and that the message list is the
 * region that scrolls. Screenshots go to <out-dir>.
 *
 *   SITE_URL=https://lazers-website-chatfit.localhost bun test/e2e/live-chat-fit.mjs <out-dir>
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const out = process.argv[2]
const SITE = process.env.SITE_URL ?? "https://lazers-website-chatfit.localhost"
const PW =
  process.env.PLAYWRIGHT_CORE ??
  "/Users/tjw/Documents/ChatGPT/runntime/node_modules/.pnpm/playwright-core@1.64.0/node_modules/playwright-core/index.mjs"
const { chromium } = await import(PW)
mkdirSync(out, { recursive: true })

const SIZES = [
  [320, 700],
  [390, 800],
  [430, 900],
  [600, 900],
  [768, 1000],
  [820, 1100],
  [900, 900],
  [1024, 800],
  [1180, 820],
  [1280, 800],
  [1440, 900],
  [1600, 900],
  [844, 390],
]

/** Runs in the page: puts the chat into a named state. */
function applyState(name) {
  const hook = window.__lazersChat
  const base = (window.__lcBase ??= hook.get())
  const long = "word ".repeat(60)
  const unbroken = `https://example.com/${"a".repeat(180)}`
  const answers = Array.from({ length: 5 }, (_, i) => ({
    id: 10 + i * 2,
    role: "assistant",
    kind: "chat",
    status: "done",
    replyTo: 9 + i * 2,
    text: `Answer ${i + 1}. ${long}\n\n${unbroken}\n\nconst veryLongIdentifierName_${"x".repeat(90)} = 1`,
  }))
  const users = answers.map((a, i) => ({
    id: 9 + i * 2,
    role: "user",
    kind: "chat",
    status: "sent",
    text: `Question ${i + 1}: ${long}`,
  }))
  const chat = answers.flatMap((a, i) => [users[i], a])
  const ready = { name: "ready", fromCache: true }
  const files = [
    { id: "model", name: "LFM3-Omni-2B-Q4_K_M.gguf", done: 410_000_000, total: 1_099_630_080 },
    { id: "projector", name: "mmproj-LFM3-Omni-2B-Q8_0.gguf", done: 0, total: 506_842_528 },
  ]
  const states = {
    idle: [base],
    downloading: [
      {
        ...base,
        phase: { name: "downloading", files },
        jobs: [{ kind: "message", id: 1 }],
        messages: [
          ...base.messages,
          { id: 1, role: "user", kind: "chat", status: "queued", text: "What does LAZERS do?" },
        ],
        draft: "a follow-up typed while it downloads",
      },
    ],
    ready: [{ ...base, phase: ready, messages: [...base.messages, ...chat] }],
    recording: [
      {
        ...base,
        phase: ready,
        mic: "recording",
        messages: [...base.messages, ...chat.slice(0, 2)],
      },
      { bars: "▁▂▃▄▅▆▇█▇", seconds: 12 },
    ],
    failed: [
      {
        ...base,
        phase: { name: "failed", reason: "offline", message: `The connection dropped. ${long}` },
        messages: base.messages,
      },
    ],
  }
  const [state, meter] = states[name]
  hook.set(state, meter ?? null)
}

const browser = await chromium.launch({ channel: "chromium", headless: true })
const failures = []
let checks = 0

async function measure(page, label) {
  const r = await page.evaluate(() => {
    const rect = (e) => {
      const b = e.getBoundingClientRect()
      return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }
    }
    const frame = document.querySelector(".lc")
    const parent = frame.closest("figure") ?? frame.parentElement
    const list = frame.querySelector(".lc-list")
    const f = rect(frame)
    const inside = [
      ".lc-bar",
      ".lc-foot",
      ".lc-box",
      ".lc-input",
      ".lc-send",
      ".lc-pills",
      ".lc-pill",
    ]
      .flatMap((s) => [...frame.querySelectorAll(s)].map((e) => [s, rect(e)]))
      .filter(([, b]) => b.l < f.l - 0.5 || b.r > f.r + 0.5 || b.t < f.t - 0.5 || b.b > f.b + 0.5)
      .map(([s]) => s)
    return {
      frame: f,
      parent: rect(parent),
      inside,
      vw: document.documentElement.clientWidth,
      vh: innerHeight,
      docW: document.documentElement.scrollWidth,
      listOverX: list.scrollWidth - list.clientWidth,
      listOverflowY: getComputedStyle(list).overflowY,
      frameOverflow: getComputedStyle(frame).overflow,
      listH: list.getBoundingClientRect().height,
      barB: rect(frame.querySelector(".lc-bar")).b,
      footT: rect(frame.querySelector(".lc-foot")).t,
    }
  })
  const bad = []
  if (r.frame.r > r.parent.r + 0.5 || r.frame.l < r.parent.l - 0.5)
    bad.push("frame outside parent column")
  if (r.frame.r > r.vw + 0.5 || r.frame.l < -0.5) bad.push("frame outside viewport")
  if (r.docW > r.vw) bad.push(`page scrolls horizontally (${r.docW} > ${r.vw})`)
  if (r.inside.length) bad.push(`outside frame: ${[...new Set(r.inside)].join(",")}`)
  if (r.listOverX > 1) bad.push(`list overflows horizontally by ${r.listOverX}px`)
  if (!["auto", "scroll"].includes(r.listOverflowY)) bad.push("list is not the scrolling region")
  if (r.frame.h > r.vh - 8)
    bad.push(`frame ${Math.round(r.frame.h)}px is taller than the viewport ${r.vh}px`)
  if (r.listH < 80) bad.push(`list is only ${Math.round(r.listH)}px tall`)
  checks++
  if (bad.length) {
    failures.push(`${label}: ${bad.join("; ")}`)
    console.log("FAIL", failures.at(-1))
  }
  return r
}

for (const [mode, init] of [
  ...(process.env.ONLY === "nogpu" ? [] : [["live", null]]),
  ...(process.env.ONLY === "live"
    ? []
    : [
        [
          "nogpu",
          () => {
            delete Navigator.prototype.gpu
          },
        ],
      ]),
]) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
  })
  if (init) await context.addInitScript(init)
  const page = await context.newPage()
  await page.goto(SITE, { waitUntil: "load" })
  await page.locator("#local").scrollIntoViewIfNeeded()
  await page.locator(".lc").first().waitFor()
  await page.waitForTimeout(600)
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h })
    if (mode === "nogpu") {
      // Each width starts from the poster again.
      await page.reload({ waitUntil: "load" })
      await page.locator("#local").scrollIntoViewIfNeeded()
      await page.locator(".lc").first().waitFor()
    }
    await page.waitForTimeout(250)
    const states =
      mode === "live"
        ? ["idle", "downloading", "ready", "recording", "failed"]
        : ["poster", "playing"]
    for (const name of states) {
      if (mode === "live")
        await page.evaluate(`(${applyState.toString()})(${JSON.stringify(name)})`)
      else if (name === "playing") {
        await page
          .getByRole("button", { name: "Play the demo" })
          .click()
          .catch(() => undefined)
        await page.waitForTimeout(4500)
      }
      await page.waitForTimeout(150)
      await page.locator(".lc").first().scrollIntoViewIfNeeded()
      await measure(page, `${mode}/${name}@${w}x${h}`)
      const file = join(out, `${mode}-${name}-${w}x${h}.png`)
      await page
        .locator(".lc-figure, .lc")
        .first()
        .screenshot({ path: file })
        .catch(() => undefined)
    }
  }
  await context.close()
}
if (process.env.ONLY !== "nogpu") {
  // Remove downloaded model: a 5 MB stand-in file in the cache directory is deleted and counted.
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()
  await page.goto(SITE, { waitUntil: "load" })
  await page.locator("#local").scrollIntoViewIfNeeded()
  await page.locator(".lc").first().waitFor()
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const dir = await (
      await root.getDirectoryHandle("lazers-live-demo", { create: true })
    ).getDirectoryHandle("x", { create: true })
    const w = await (await dir.getFileHandle("stand-in.bin", { create: true })).createWritable()
    await w.write(new Uint8Array(5_000_000))
    await w.close()
  })
  page.once("dialog", (d) => d.accept())
  await page.getByRole("button", { name: "Remove model" }).click()
  await page.waitForFunction(
    () =>
      /Removed the downloaded model/.test(document.querySelector(".lc-status")?.textContent ?? ""),
    undefined,
    10_000,
  )
  const note = await page.locator(".lc-status").innerText()
  const left = await page.evaluate(
    async () =>
      await navigator.storage
        .getDirectory()
        .then((r) => r.getDirectoryHandle("lazers-live-demo"))
        .then(() => true)
        .catch(() => false),
  )
  console.log("remove model:", note, "| directory left:", left)
  if (!/5\.0 MB|0\.0 GB/.test(note)) failures.push(`remove model: unexpected notice ${note}`)
  await context.close()
}
await browser.close()
console.log(`${checks} checks, ${failures.length} failing`)
for (const f of failures) console.log("FAIL", f)
process.exit(failures.length ? 1 : 0)
