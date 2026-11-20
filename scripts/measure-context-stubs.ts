/**
 * Before/after size of a synthetic Architect request modelled on the measured session
 * (551 notices over 75 plans). Run: `bun scripts/measure-context-stubs.ts`.
 * Characters, not tokens; tokens are roughly a quarter of that for this text.
 */
import { stubSuperseded } from "../src/runner/context-stubs.ts"
import { measuredSession, sizeOf, textOf, type Msg } from "../src/runner/context-stubs.fixtures.ts"

const messages = measuredSession()
const horizon = messages.findLast((m) => m.role === "user")!.id!
const out = stubSuperseded(messages, { horizon })

const isNotice = (m: Msg) => textOf(m).startsWith("LAZERS outcome")
const isNoticeStub = (m: Msg) => textOf(m).startsWith("[lz-stub notice")
const chars = (list: readonly Msg[]) =>
  list.reduce((n, m) => n + JSON.stringify(m.content).length, 0)
const noticesBefore = messages.filter(isNotice)
const noticesAfter = out.messages.filter((m) => isNotice(m) || isNoticeStub(m))
const plans = new Set(noticesBefore.map((m) => textOf(m).match(/plan=([0-9a-f-]+)/)![1]))

console.log(`notices: ${noticesBefore.length} over ${plans.size} plans`)
console.log(
  `  whole after: ${noticesAfter.filter(isNotice).length}, stubbed: ${noticesAfter.filter(isNoticeStub).length}`,
)
console.log(`  notice chars: ${chars(noticesBefore)} -> ${chars(noticesAfter)}`)
console.log(
  `request: ${messages.length} messages, ${sizeOf(messages)} -> ${sizeOf(out.messages)} chars`,
)
console.log(
  `  units stubbed: ${out.stubbed}, chars removed: ${out.saved} (${((out.saved / sizeOf(messages)) * 100).toFixed(1)}%)`,
)
console.log(
  `  ~tokens ${Math.round(sizeOf(messages) / 4)} -> ${Math.round(sizeOf(out.messages) / 4)}`,
)
