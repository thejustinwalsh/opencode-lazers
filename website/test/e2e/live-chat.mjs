/**
 * Real-browser proof of the live chat (headless Chromium, WebGPU, Playwright). Not part of `bun test`.
 * It never downloads the weights: requests to Hugging Face are fulfilled from the files the product
 * already cached on disk (read-only), so the page's own download, hashing, OPFS cache and
 * progress code runs against local bytes.
 *
 *   SITE_URL=https://lazers-website-live.localhost bun test/e2e/live-chat.mjs <out-dir> [cold|warm|all]
 *
 * Env: PLAYWRIGHT_CORE (path to playwright-core), MODEL_DIR (the product's models directory).
 */
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const out = process.argv[2]
const stage = process.argv[3] ?? "all"
const SITE = process.env.SITE_URL ?? "https://lazers-website-live.localhost"
const PW =
  process.env.PLAYWRIGHT_CORE ??
  "/Users/tjw/Documents/ChatGPT/runntime/node_modules/.pnpm/playwright-core@1.64.0/node_modules/playwright-core/index.mjs"
const MODELS =
  process.env.MODEL_DIR ?? join(homedir(), ".local/share/opencode/plugins/lazers/models")
const GGUF_REV = "3d29af2ad166f8299c2d820937e47dc0add20ffc"
const TOK_REV = "21d75123f86c1f7ffb4bef1ea202710c4e7ebe67"
const { chromium } = await import(PW)
mkdirSync(out, { recursive: true })
const profile = join(out, "profile")
const log = (...a) => console.log(`[${((performance.now() - T0) / 1000).toFixed(1)}s]`, ...a)
const T0 = performance.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PHRASE = "How do I install it?"
const QUESTION = "In one short sentence, what does LAZERS do?"

function readSlice(path, start, end) {
  const fd = openSync(path, "r")
  try {
    const buf = Buffer.alloc(end - start + 1)
    readSync(fd, buf, 0, buf.length, start)
    return buf
  } finally {
    closeSync(fd)
  }
}

async function launch(extra = []) {
  const stats = { huggingface: [], other: [], blocked: [] }
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
    permissions: ["microphone"],
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      ...extra,
    ],
  })
  // Everything that is not this site or the (served-from-disk) model host is refused and recorded.
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url())
    if (url.hostname.endsWith("localhost") || url.protocol === "data:" || url.protocol === "blob:")
      return route.continue()
    stats.blocked.push(route.request().url())
    return route.abort()
  })
  await context.route("https://huggingface.co/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "range",
      "access-control-expose-headers": "content-range, content-length, accept-ranges",
    }
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors })
    let path
    const gguf = url.pathname.match(
      new RegExp(`^/LiquidAI/LFM3-Omni-2B-GGUF/resolve/${GGUF_REV}/([^/]+)$`),
    )
    if (gguf) path = join(MODELS, GGUF_REV, gguf[1])
    if (url.pathname === `/LiquidAI/LFM3-Omni-2B/resolve/${TOK_REV}/tokenizer.json`)
      path = join(MODELS, TOK_REV, "tokenizer.json")
    if (!path || !existsSync(path)) {
      stats.blocked.push(request.url())
      return route.fulfill({ status: 404, headers: cors, body: "not found" })
    }
    const size = statSync(path).size
    const range = request.headers()["range"]?.match(/^bytes=(\d+)-(\d+)?$/)
    if (!range) {
      stats.huggingface.push({
        file: url.pathname.split("/").pop(),
        start: 0,
        bytes: size,
        status: 200,
      })
      return route.fulfill({
        status: 200,
        headers: { ...cors, "content-type": "application/octet-stream" },
        body: readFileSync(path),
      })
    }
    const start = Number(range[1])
    const end = Math.min(Number(range[2] ?? size - 1), size - 1)
    stats.huggingface.push({
      file: url.pathname.split("/").pop(),
      start,
      bytes: end - start + 1,
      status: 206,
    })
    return route.fulfill({
      status: 206,
      headers: {
        ...cors,
        "content-type": "application/octet-stream",
        "content-range": `bytes ${start}-${end}/${size}`,
        "accept-ranges": "bytes",
      },
      body: readSlice(path, start, end),
    })
  })
  context.on("request", (r) => {
    const u = new URL(r.url())
    if (
      !u.hostname.endsWith("localhost") &&
      u.hostname !== "huggingface.co" &&
      !r.url().startsWith("data:") &&
      !r.url().startsWith("blob:")
    )
      stats.other.push(r.url())
  })
  await context.addInitScript(() => {
    // Records every buffer the page schedules on the Web Audio graph, and the page's own state timeline.
    window.__audio = []
    const start = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (...args) {
      try {
        const data = this.buffer.getChannelData(0)
        let sum = 0
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
        window.__audio.push({
          at: performance.now(),
          sampleRate: this.buffer.sampleRate,
          length: this.buffer.length,
          rms: Math.sqrt(sum / data.length),
          samples: window.__keepAudio ? Array.from(data) : undefined,
        })
      } catch {
        // A buffer without channel data is not speech; the page's own error shows elsewhere.
      }
      return start.apply(this, args)
    }
    window.__marks = {}
    const mark = (k) => (window.__marks[k] ??= performance.now())
    window.__mark = mark
    setInterval(() => {
      const lc = document.querySelector(".lc")
      if (!lc) return
      const w = document.querySelector("[data-testid=working]")?.innerText ?? ""
      if (/Checking/.test(w)) mark("starting")
      if (/Downloading/.test(w)) mark("downloading")
      if (/onto the GPU/.test(w)) mark("loadingGPU")
      if (lc.dataset.phase === "ready") mark("ready")
      const reply = [
        ...document.querySelectorAll(".lc-msg[data-role=assistant][data-kind=chat]"),
      ].find((m) => m.innerText.trim())
      if (reply) mark("firstToken")
      if (document.querySelector(".lc-msg[data-role=assistant][data-status=done][data-kind=chat]"))
        mark("answerDone")
      if (window.__audio.length) mark("firstAudio")
    }, 20)
  })
  return { context, stats }
}

async function shots(page, name) {
  for (const [w, h] of [
    [1280, 900],
    [390, 844],
  ]) {
    await page.setViewportSize({ width: w, height: h })
    await sleep(250)
    await page.locator("#local .lc, #local").first().scrollIntoViewIfNeeded()
    await page
      .locator("#local")
      .first()
      .screenshot({ path: join(out, `${name}-${w}.png`) })
      .catch(() => undefined)
    const lc = page.locator(".lc").first()
    await lc.screenshot({ path: join(out, `${name}-chat-${w}.png`) }).catch(() => undefined)
  }
  await page.setViewportSize({ width: 1280, height: 900 })
}

async function openPage(context) {
  const page = context.pages()[0] ?? (await context.newPage())
  const errors = []
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(SITE, { waitUntil: "load" })
  await page.locator(".lc").first().scrollIntoViewIfNeeded()
  return { page, errors }
}

const waitUntil = async (page, fn, arg, timeout = 600_000) =>
  page.waitForFunction(fn, arg, { timeout, polling: 100 })

async function send(page, text) {
  const box = page.locator(".lc-input")
  await box.click()
  await box.fill(text)
  await page.evaluate(() => (window.__marks.sent = performance.now()))
  await box.press("Enter")
}

async function collectMarks(page) {
  const marks = await page.evaluate(() => window.__marks)
  const rel = (k) => (marks[k] !== undefined ? Math.round(marks[k] - marks.sent) : null)
  return Object.fromEntries(
    [
      "starting",
      "downloading",
      "loadingGPU",
      "ready",
      "firstToken",
      "answerDone",
      "firstAudio",
    ].map((k) => [k, rel(k)]),
  )
}

const result = {}

if (stage === "cold" || stage === "all") {
  rmSync(profile, { recursive: true, force: true })
  const { context, stats } = await launch()
  const { page, errors } = await openPage(context)
  log("page loaded")
  const gpu = await page.evaluate(async () => ({
    gpu: "gpu" in navigator,
    adapter: !!(await navigator.gpu?.requestAdapter()),
  }))
  log("webgpu", gpu)
  result.gpu = gpu
  const jsBefore = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((e) => /\.js(\?|$)/.test(e.name))
      .map((e) => ({ name: e.name.split("/").pop(), bytes: e.transferSize || e.encodedBodySize })),
  )
  result.jsBeforeAction = jsBefore
  result.requestsBeforeAction = stats.huggingface.length
  await shots(page, "01-idle")

  // Queue two messages while the first is still loading.
  await send(page, QUESTION)
  await waitUntil(page, () => window.__marks.downloading, undefined, 90_000)
  await page.locator(".lc-input").fill("And is it free?")
  await page.locator(".lc-input").press("Enter")
  // Sample the progress display.
  const samples = []
  let shotDownload = false
  while (!(await page.evaluate(() => window.__marks.ready))) {
    const text = await page.evaluate(
      () => document.querySelector("[data-testid=working]")?.innerText ?? "",
    )
    if (text && samples.at(-1) !== text) samples.push(text.replace(/\n+/g, " | "))
    if (!shotDownload && /\b[2-9]\d%/.test(text)) {
      shotDownload = true
      await shots(page, "02-downloading")
    }
    await sleep(500)
  }
  result.progressSamples = samples.filter((_, i) => i % Math.ceil(samples.length / 12) === 0)
  log("ready", await collectMarks(page))
  await shots(page, "03-loaded")
  await waitUntil(page, () =>
    document.querySelector(".lc-msg[data-role=assistant][data-status=done][data-kind=chat]"),
  )
  const answer1 = await page
    .locator(".lc-msg[data-role=assistant][data-kind=chat]")
    .first()
    .innerText()
  log("answer 1:", answer1)
  result.answer1 = answer1
  result.marksCold = await collectMarks(page)
  // speech: audio on the Web Audio graph
  await waitUntil(page, () => window.__audio.length > 0, undefined, 300_000).catch(() => undefined)
  await shots(page, "04-speaking")
  // wait for the second answer and its speech
  await waitUntil(
    page,
    () =>
      document.querySelectorAll(".lc-msg[data-role=assistant][data-status=done][data-kind=chat]")
        .length >= 2,
  )
  const answers = await page.locator(".lc-msg[data-role=assistant][data-kind=chat]").allInnerTexts()
  result.answers = answers
  await sleep(500)
  await waitUntil(
    page,
    () =>
      /speaker: (read|no)/.test(
        document.querySelector("[aria-label^='LAZERS speaker']").getAttribute("aria-label"),
      ),
    undefined,
    300_000,
  )
  result.audioBuffers = await page.evaluate(() =>
    window.__audio.map((a) => ({
      sampleRate: a.sampleRate,
      length: a.length,
      seconds: +(a.length / a.sampleRate).toFixed(2),
      rms: +a.rms.toFixed(4),
    })),
  )
  log("audio", result.audioBuffers.length, "buffers")
  await shots(page, "05-answered")
  // unload
  await page.getByRole("button", { name: "Unload" }).click()
  await waitUntil(page, () => document.querySelector(".lc").dataset.phase === "idle")
  result.unloadWorks = true
  await shots(page, "06-unloaded")
  // Harness: the model's own TTS of the dictation phrase, from a second worker on the same cache.
  const wav = await page.evaluate(async (phrase) => {
    const worker = new Worker("/src/live/worker.ts", { type: "module" })
    const chunks = []
    await new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        const m = e.data
        if (m.t === "loaded") worker.postMessage({ t: "speak", id: 1, text: phrase })
        if (m.t === "speechChunk") chunks.push(Array.from(m.samples))
        if (m.t === "speechEnd") resolve()
        if (m.t === "loadFailed" || m.t === "speechFailed") reject(new Error(m.message))
      }
      worker.postMessage({ t: "load" })
    })
    worker.terminate()
    return chunks.flat()
  }, PHRASE)
  const pcm = Float32Array.from(wav)
  writeWav(join(out, "phrase.wav"), pcm, 24_000)
  result.phraseSeconds = +(pcm.length / 24_000).toFixed(2)
  log("phrase wav", result.phraseSeconds, "s")
  // storage + network facts
  result.storage = await page.evaluate(async () => {
    const e = await navigator.storage.estimate()
    return { usage: e.usage, quota: e.quota }
  })
  const files = {}
  for (const r of stats.huggingface) {
    files[r.file] ??= { requests: 0, bytes: 0, largest: 0 }
    files[r.file].requests++
    files[r.file].bytes += r.bytes
    files[r.file].largest = Math.max(files[r.file].largest, r.bytes)
  }
  result.networkCold = { huggingface: files, otherRequests: stats.other, blocked: stats.blocked }
  result.consoleErrors = errors.slice(0, 10)
  await context.close()
  writeFileSync(join(out, "cold.json"), JSON.stringify(result, null, 2))
  log("cold done")
}

if (stage === "warm" || stage === "all") {
  const warm = {}
  const { context, stats } = await launch([
    `--use-file-for-fake-audio-capture=${join(out, "phrase.wav")}`,
  ])
  const { page, errors } = await openPage(context)
  await page.evaluate(() => (window.__keepAudio = true))
  await send(page, QUESTION)
  await waitUntil(page, () =>
    document.querySelector(".lc-msg[data-role=assistant][data-status=done][data-kind=chat]"),
  )
  warm.marks = await collectMarks(page)
  warm.statusLine = await page.locator(".lc-status").innerText()
  warm.answer = await page
    .locator(".lc-msg[data-role=assistant][data-kind=chat]")
    .first()
    .innerText()
  warm.hfRequests = stats.huggingface.filter((r) => !r.file.endsWith("tokenizer.json")).length
  warm.tokenizerRequests = stats.huggingface.filter((r) => r.file.endsWith("tokenizer.json")).length
  log("warm", warm)
  await shots(page, "07-cached")
  // speech finishes, then dictate
  await waitUntil(page, () => window.__audio.length > 0, undefined, 300_000)
  await waitUntil(
    page,
    () =>
      /speaker: (read|no)/.test(
        document.querySelector("[aria-label^='LAZERS speaker']").getAttribute("aria-label"),
      ),
    undefined,
    300_000,
  )
  warm.speechA1 = await page.evaluate(() =>
    window.__audio.map((a) => ({
      sampleRate: a.sampleRate,
      seconds: +(a.length / a.sampleRate).toFixed(2),
      rms: +a.rms.toFixed(4),
    })),
  )
  await page.evaluate(() => (window.__speechA1 = window.__audio.map((a) => a.samples)))
  const mic = page.locator("[aria-label^='LAZERS microphone']")
  await mic.click()
  await waitUntil(
    page,
    () =>
      /recording/.test(
        document.querySelector("[aria-label^='LAZERS microphone']").getAttribute("aria-label"),
      ),
    undefined,
    30_000,
  )
  await sleep(2500)
  await shots(page, "08-recording")
  await sleep(2500)
  await mic.click()
  await waitUntil(
    page,
    () => document.querySelector(".lc-input").value.length > 0,
    undefined,
    120_000,
  )
  warm.transcript = await page.locator(".lc-input").inputValue()
  warm.micMeterSeen = true
  log("transcript:", warm.transcript)
  await shots(page, "09-transcribed")
  // send the transcript, capture its answer + speech for the recording
  await page.evaluate(() => (window.__audio.length = 0))
  await page.locator(".lc-input").press("Enter")
  await waitUntil(
    page,
    () =>
      document.querySelectorAll(".lc-msg[data-role=assistant][data-status=done][data-kind=chat]")
        .length >= 2,
  )
  warm.answer2 = (
    await page.locator(".lc-msg[data-role=assistant][data-kind=chat]").allInnerTexts()
  )[1]
  await waitUntil(page, () => window.__audio.length > 0, undefined, 300_000)
  await waitUntil(
    page,
    () =>
      /speaker: (read|no)/.test(
        document.querySelector("[aria-label^='LAZERS speaker']").getAttribute("aria-label"),
      ),
    undefined,
    300_000,
  )
  await sleep(500)
  const a2 = await page.evaluate(() => window.__audio.map((a) => a.samples))
  const a1 = await page.evaluate(() => window.__speechA1)
  writeWav(join(out, "speech-1.wav"), Float32Array.from(a1.flat()), 24_000)
  writeWav(join(out, "speech-2.wav"), Float32Array.from(a2.flat()), 24_000)
  // The model's real answer and speech for both turns, for the recorded session.
  writeFileSync(
    join(out, "capture.json"),
    JSON.stringify(
      {
        question1: QUESTION,
        answer1: warm.answer,
        transcript: warm.transcript,
        answer2: warm.answer2,
      },
      null,
      2,
    ),
  )
  warm.network = {
    huggingfaceRequests: stats.huggingface.length,
    other: stats.other,
    blocked: stats.blocked,
  }
  warm.consoleErrors = errors.slice(0, 10)
  await shots(page, "10-second-answer")
  await context.close()
  writeFileSync(join(out, "warm.json"), JSON.stringify(warm, null, 2))
  log("warm done")
}

function writeWav(path, samples, rate) {
  const bytes = Buffer.alloc(44 + samples.length * 2)
  bytes.write("RIFF", 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write("WAVEfmt ", 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(rate, 24)
  bytes.writeUInt32LE(rate * 2, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write("data", 36)
  bytes.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++)
    bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  writeFileSync(path, bytes)
}
