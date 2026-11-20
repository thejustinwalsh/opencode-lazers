/**
 * Turns the output of a real run of the live chat (`test/e2e/live-chat.mjs ... all`) into the
 * recorded session the page plays when WebGPU is missing: `public/live/session.json` plus the
 * model's own speech as mono Opus in WebM and AAC in MP4. Every word and sound in the recording is
 * what the model produced in that run.
 *
 *   bun scripts/capture-live-session.ts <e2e-output-dir>
 */
import { mkdir, readFile, writeFile, stat } from "node:fs/promises"
import { join } from "node:path"

const dir = process.argv[2]
if (!dir) throw new Error("usage: bun scripts/capture-live-session.ts <e2e-output-dir>")
const out = join(import.meta.dir, "..", "public", "live")
await mkdir(out, { recursive: true })

const capture = JSON.parse(await readFile(join(dir, "capture.json"), "utf8")) as {
  question1: string
  answer1: string
  transcript: string
  answer2: string
}

async function seconds(wav: string) {
  const bytes = await readFile(wav)
  return (bytes.length - 44) / 2 / bytes.readUInt32LE(24)
}

async function encode(name: string) {
  const wav = join(dir, `${name}.wav`)
  const run = async (args: string[]) => {
    const proc = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-ac", "1", ...args], {
      stderr: "inherit",
    })
    if ((await proc.exited) !== 0) throw new Error(`ffmpeg failed for ${name}`)
  }
  await run(["-c:a", "libopus", "-b:a", "24k", "-application", "voip", join(out, `${name}.webm`)])
  await run(["-c:a", "aac", "-b:a", "40k", "-movflags", "+faststart", join(out, `${name}.m4a`)])
  return { seconds: await seconds(wav) }
}

const one = await encode("speech-1")
const two = await encode("speech-2")
const session = {
  version: 1,
  steps: [
    { type: "user", text: capture.question1 },
    { type: "answer", text: capture.answer1, audio: "speech-1", seconds: one.seconds },
    { type: "dictate", text: capture.transcript, seconds: 5 },
    { type: "answer", text: capture.answer2, audio: "speech-2", seconds: two.seconds },
  ],
  audio: {
    "speech-1": { webm: "live/speech-1.webm", m4a: "live/speech-1.m4a" },
    "speech-2": { webm: "live/speech-2.webm", m4a: "live/speech-2.m4a" },
  },
}
await writeFile(join(out, "session.json"), JSON.stringify(session))
let total = 0
for (const f of ["session.json", "speech-1.webm", "speech-1.m4a", "speech-2.webm", "speech-2.m4a"])
  total += (await stat(join(out, f))).size
console.log(
  `wrote ${out}: ${total} bytes (a visitor fetches the session JSON plus one audio format)`,
)
