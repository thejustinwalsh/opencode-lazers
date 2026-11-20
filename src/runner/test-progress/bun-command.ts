export const TEST_HANG_GUARD_MS = 120_000
export const GUARDED_TEST_COMMAND = `bun test --timeout ${TEST_HANG_GUARD_MS}`

const bunTest = /^(\s*)bun test(?=\s|$)/
const valueOptions = new Set([
  "--changed",
  "--coverage-dir",
  "--coverage-reporter",
  "--filter",
  "--max-concurrency",
  "--parallel",
  "--parallel-delay",
  "--path-ignore-patterns",
  "--preload",
  "--reporter",
  "--reporter-outfile",
  "--rerun-each",
  "--retry",
  "--seed",
  "--shard",
  "--test-name-pattern",
  "--timeout",
  "--timings",
  "-t",
])

type WordScanState = {
  word: string
  started: boolean
  quote?: "'" | '"'
  escaped: boolean
}

function appendQuotedWordCharacter(character: string, state: WordScanState): void {
  if (character === state.quote) state.quote = undefined
  else if (character === "\\" && state.quote === '"') state.escaped = true
  else state.word += character
  state.started = true
}

function appendEscapedWordCharacter(character: string, state: WordScanState): void {
  state.word += character
  state.started = true
  state.escaped = false
}

function finishWordOnWhitespace(character: string, state: WordScanState, words: string[]): boolean {
  if (!/\s/.test(character)) return false
  if (state.started) words.push(state.word)
  state.word = ""
  state.started = false
  return true
}

function appendUnquotedWordCharacter(
  character: string,
  state: WordScanState,
  words: string[],
): boolean {
  if (character === "\\") {
    state.escaped = true
    state.started = true
  } else if (character === "'" || character === '"') {
    state.quote = character
    state.started = true
  } else if (character === "#" && !state.started) return false
  else if (finishWordOnWhitespace(character, state, words)) return true
  else state.word += character
  state.started ||= !/\s/.test(character)
  return true
}

function appendWordCharacter(character: string, state: WordScanState, words: string[]): boolean {
  if (state.escaped) {
    appendEscapedWordCharacter(character, state)
    return true
  }
  if (state.quote) {
    appendQuotedWordCharacter(character, state)
    return true
  }
  return appendUnquotedWordCharacter(character, state, words)
}

function shellWords(command: string): string[] {
  const words: string[] = []
  const state: WordScanState = { word: "", started: false, escaped: false }
  for (const character of command) if (!appendWordCharacter(character, state, words)) break
  if (state.started) words.push(state.word)
  return words
}

function hasOption(command: string, options: readonly string[]): boolean {
  const wanted = new Set(options)
  const words = shellWords(command)
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!
    if (word === "--") return false
    if (wanted.has(word) || options.some((option) => word.startsWith(`${option}=`))) return true
    if (valueOptions.has(word)) index++
  }
  return false
}

type ShellScanState = {
  quote?: "'" | '"'
  escaped: boolean
  parentheses: number
  comment: boolean
}

function advanceShellComment(character: string, state: ShellScanState): number | undefined {
  if (!state.comment) return undefined
  if (character !== "\n") return 0
  state.comment = false
  return 1
}

function advanceShellQuote(character: string, state: ShellScanState): boolean {
  if (!state.quote) return false
  if (character === state.quote) state.quote = undefined
  else if (character === "\\" && state.quote === '"') state.escaped = true
  return true
}

function startShellConstruct(
  command: string,
  index: number,
  character: string,
  state: ShellScanState,
): boolean {
  if (character === "\\") state.escaped = true
  else if (character === "'" || character === '"') state.quote = character
  else if (character === "#" && (index === 0 || /\s/.test(command[index - 1]!)))
    state.comment = true
  else return false
  return true
}

function advanceShellParentheses(character: string, state: ShellScanState): boolean {
  if (character === "(") state.parentheses++
  else if (character === ")" && state.parentheses > 0) state.parentheses--
  else return false
  return true
}

function pairedShellOperator(character: string, next: string | undefined): number {
  if (character === "&" && next === "&") return 2
  if (character === "|" && (next === "|" || next === "&")) return 2
  return 0
}

function isShellBackgroundOperator(command: string, index: number): boolean {
  return (
    command[index] === "&" &&
    command[index - 1] !== ">" &&
    command[index - 1] !== "<" &&
    command[index + 1] !== ">"
  )
}

function singleShellOperator(command: string, index: number): number {
  const character = command[index]!
  if (character === "\n" || character === ";" || character === "|") return 1
  return isShellBackgroundOperator(command, index) ? 1 : 0
}

function shellOperatorLength(command: string, index: number): number {
  return (
    pairedShellOperator(command[index]!, command[index + 1]) || singleShellOperator(command, index)
  )
}

function shellScanStep(command: string, index: number, state: ShellScanState): number {
  const character = command[index]!
  const commentLength = advanceShellComment(character, state)
  if (commentLength !== undefined) return commentLength
  if (state.escaped) {
    state.escaped = false
    return 0
  }
  if (advanceShellQuote(character, state)) return 0
  if (startShellConstruct(command, index, character, state)) return 0
  if (advanceShellParentheses(character, state)) return 0
  if (state.parentheses > 0) return 0
  return shellOperatorLength(command, index)
}

/** Split only top-level shell operators, leaving quoted and nested arguments byte-for-byte intact. */
function shellParts(command: string): string[] {
  const parts: string[] = []
  const state: ShellScanState = { escaped: false, parentheses: 0, comment: false }
  let start = 0
  for (let index = 0; index < command.length; index++) {
    const length = shellScanStep(command, index, state)
    if (!length) continue
    parts.push(command.slice(start, index), command.slice(index, index + length))
    start = index + length
    index += length - 1
  }
  parts.push(command.slice(start))
  return parts
}

function withDefaults(segment: string): string {
  const match = bunTest.exec(segment)
  if (!match) return segment

  const rest = segment.slice(match[0].length)
  const defaults = [
    ...(hasOption(rest, ["--timeout"]) ? [] : [`--timeout ${TEST_HANG_GUARD_MS}`]),
    ...(hasOption(rest, ["--reporter", "--dots"]) ? [] : ["--dots"]),
  ]
  return defaults.length === 0 ? segment : `${match[0]} ${defaults.join(" ")}${rest}`
}

/**
 * Add the per-test hang guard and real-progress dots reporter to direct `bun test` shell segments.
 * Authored timeout/reporter options win; non-Bun commands are unchanged. Re-running is idempotent.
 */
export function withBunTestDefaults(command: string): string {
  return shellParts(command)
    .map((part, index) => (index % 2 === 0 ? withDefaults(part) : part))
    .join("")
}

/** Compatibility name retained for existing hang-guard imports. */
export const withTestHangGuard = withBunTestDefaults
