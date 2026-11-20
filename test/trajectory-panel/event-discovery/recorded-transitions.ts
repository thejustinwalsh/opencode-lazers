import { callArguments, matchingDelimiter, tokensOf } from "./source-tokens.ts"
import type { Token } from "./source-tokens.ts"

export interface TransitionSource {
  path: string
  source: string
}

const EVENT_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/

// RunnerStore writers and runtime wrappers that forward the event to those writers.
const PRODUCER_ARGUMENTS = new Map<string, readonly number[]>([
  ["record", [2]],
  ["recordOnce", [2]],
  ["revisePlan", [2]],
  ["move", [2, 3]],
  ["renewalEvent", [1]],
  ["renewalIssue", [1]],
  ["outcomeState", [3]],
  ["workerEvent", [2]],
])

type PreparedSource = { path: string; tokens: Token[] }

function assignmentIndex(tokens: Token[], declaration: number) {
  let index = declaration + 2
  if (tokens[index]?.text === "=") return index
  if (tokens[index]?.text !== ":") return -1
  for (index++; index < tokens.length; index++) {
    if (tokens[index]!.text === "=") return index
    if (tokens[index]!.text === ";") return -1
  }
  return -1
}

function constantDeclaration(tokens: Token[], index: number) {
  if (tokens[index]!.text !== "const" || tokens[index + 1]?.kind !== "identifier") return
  const equals = assignmentIndex(tokens, index)
  const value = tokens[equals + 1]
  if (tokens[equals]?.text !== "=" || !value || !["string", "template"].includes(value.kind)) return
  if (value.value === undefined) return
  return { name: tokens[index + 1]!.text, value: value.value }
}

function constantsOf(sources: PreparedSource[]) {
  const constants = new Map<string, Set<string>>()
  for (const { tokens } of sources)
    for (let index = 0; index < tokens.length - 2; index++) {
      const declaration = constantDeclaration(tokens, index)
      if (!declaration) continue
      const values = constants.get(declaration.name) ?? new Set<string>()
      values.add(declaration.value)
      constants.set(declaration.name, values)
    }
  return constants
}

function eventName(value: string) {
  return EVENT_NAME.test(value) ? value : undefined
}

function topLevelIndex(tokens: Token[], target: string, start = 0) {
  const closing: string[] = []
  for (let index = start; index < tokens.length; index++) {
    const text = tokens[index]!.text
    const close = text === "(" ? ")" : text === "[" ? "]" : text === "{" ? "}" : undefined
    if (close) closing.push(close)
    else if (closing.at(-1) === text) closing.pop()
    else if (!closing.length && text === target) return index
  }
  return -1
}

function conditionalColon(tokens: Token[], start: number) {
  let nested = 1
  for (let index = start; index < tokens.length; index++) {
    const text = tokens[index]!.text
    if (text === "(" || text === "[" || text === "{") {
      index = matchingDelimiter(tokens, index)
      if (index < 0) return -1
    } else if (text === "?") nested++
    else if (text === ":" && --nested === 0) return index
  }
  return -1
}

function conditionalParts(tokens: Token[]): [Token[], Token[]] | undefined {
  const question = topLevelIndex(tokens, "?")
  if (question < 0) return
  const colon = conditionalColon(tokens, question + 1)
  if (colon < 0) return
  return [tokens.slice(question + 1, colon), tokens.slice(colon + 1)]
}

function unwrapExpression(expression: Token[]) {
  let tokens = expression
  while (
    tokens[0]?.text === "(" &&
    tokens.at(-1)?.text === ")" &&
    callArguments(tokens, 0)?.length === 1
  )
    tokens = tokens.slice(1, -1)
  const cast = tokens.findIndex((token) => token.text === "as" || token.text === "satisfies")
  return cast < 0 ? tokens : tokens.slice(0, cast)
}

function namesFromBranches(
  branches: [Token[], Token[]],
  constants: Map<string, Set<string>>,
): Set<string> {
  const names = new Set<string>()
  for (const branch of branches)
    for (const name of expressionNames(branch, constants)) names.add(name)
  return names
}

function expressionNames(expression: Token[], constants: Map<string, Set<string>>): Set<string> {
  const tokens = unwrapExpression(expression)
  const literal = literalEventName(tokens)
  if (literal) return new Set([literal])
  const branches = conditionalParts(tokens)
  if (branches) return namesFromBranches(branches, constants)
  return constantEventNames(tokens, constants)
}

function literalEventName(tokens: Token[]) {
  if (tokens.length !== 1 || !["string", "template"].includes(tokens[0]!.kind)) return
  const value = tokens[0]!.value
  return value ? eventName(value) : undefined
}

function constantEventNames(tokens: Token[], constants: Map<string, Set<string>>) {
  if (tokens.length !== 1 || tokens[0]!.kind !== "identifier") return new Set<string>()
  const names = new Set<string>()
  for (const value of constants.get(tokens[0]!.text) ?? []) {
    const name = eventName(value)
    if (name) names.add(name)
  }
  return names
}

function addProducerNames(
  tokens: Token[],
  constants: Map<string, Set<string>>,
  names: Set<string>,
) {
  for (let index = 0; index < tokens.length - 2; index++) {
    const eventArguments = PRODUCER_ARGUMENTS.get(tokens[index]!.text)
    if (!eventArguments || tokens[index + 1]!.text !== "(") continue
    const args = callArguments(tokens, index + 1)
    if (!args) continue
    for (const argumentIndex of eventArguments)
      for (const name of expressionNames(args[argumentIndex] ?? [], constants)) names.add(name)
  }
}

/**
 * Finds only exact transition values supplied to persistence producers. Config values, comments,
 * SQL keywords, and incomplete event prefixes elsewhere in source are intentionally invisible.
 */
export function discoverRecordedTransitions(sources: TransitionSource[]): string[] {
  const prepared = sources.map(({ path, source }) => ({ path, tokens: tokensOf(source) }))
  const constants = constantsOf(prepared)
  const names = new Set<string>()
  for (const { tokens } of prepared) addProducerNames(tokens, constants, names)
  return [...names].sort()
}
