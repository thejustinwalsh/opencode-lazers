import { callArguments, matchingDelimiter, tokensOf } from "./source-tokens.ts"
import type { Token, TokenizedSource } from "./source-tokens.ts"

export interface TransitionSource {
  path: string
  source: string
}

const EVENT_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/

// RunnerStore writers and runtime wrappers that forward their event argument.
const PRODUCER_ARGUMENTS = new Map<string, readonly number[]>([
  ["record", [2]],
  ["recordOnce", [2]],
  ["revisePlan", [2]],
  ["move", [2, 3]],
  ["renewalEvent", [1]],
  ["renewalIssue", [1]],
  ["outcomeState", [3]],
  ["workerEvent", [2]],
  ["hold", [1]],
])

type Binding = { values: string[] }
type SourceBindings = {
  source: TokenizedSource
  scopes: Map<number, Map<string, Binding>>
  methodOpenParens: Set<number>
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

function parameterBinding(parameter: Token[]) {
  const name = parameter[0]
  if (name?.kind !== "identifier") return
  const colon = topLevelIndex(parameter, ":")
  const defaultValue = topLevelIndex(parameter, "=")
  const typeEnd = defaultValue < 0 ? parameter.length : defaultValue
  const values =
    colon < 0
      ? []
      : parameter
          .slice(colon + 1, typeEnd)
          .filter((token) => token.kind === "string" || token.kind === "template")
          .flatMap((token) => (token.value === undefined ? [] : [token.value]))
  return { name: name.text, values }
}

function declarationName(tokens: Token[], index: number) {
  if (tokens[index]!.text !== "const" || tokens[index + 1]?.kind !== "identifier") return
  return tokens[index + 1]!.text
}

function assignmentIndex(tokens: Token[], declaration: number) {
  let index = declaration + 2
  if (tokens[index]?.text === ":") {
    index++
    while (index < tokens.length && !["=", ";", ","].includes(tokens[index]!.text)) index++
  }
  return tokens[index]?.text === "=" ? index : -1
}

function staticString(token: Token | undefined) {
  if (!token || (token.kind !== "string" && token.kind !== "template")) return
  return token.value
}

function functionBodyOpen(tokens: Token[], close: number) {
  if (tokens[close + 1]?.text === "{") return close + 1
  if (tokens[close + 1]?.text === "=>" && tokens[close + 2]?.text === "{") return close + 2
  return -1
}

function isParameterList(tokens: Token[], open: number, close: number, body: number) {
  if (body < 0) return false
  const previous = tokens[open - 1]
  return (
    previous?.kind === "identifier" ||
    previous?.text === "function" ||
    tokens[close + 1]?.text === "=>"
  )
}

function bind(
  scopes: Map<number, Map<string, Binding>>,
  scope: number,
  name: string,
  values: string[],
) {
  const current = scopes.get(scope) ?? new Map<string, Binding>()
  current.set(name, { values })
  scopes.set(scope, current)
}

function constantInitializer(tokens: Token[], index: number) {
  const name = declarationName(tokens, index)
  const assignment = assignmentIndex(tokens, index)
  const value = assignment < 0 ? undefined : staticString(tokens[assignment + 1])
  if (!name || value === undefined) return
  return { name, scope: tokens[index]!.scope, value }
}

function parameterScopes(source: TokenizedSource) {
  const { tokens } = source
  const scopes = new Map<number, Map<string, Binding>>()
  const methodOpenParens = new Set<number>()

  for (let open = 0; open < tokens.length; open++) {
    if (tokens[open]!.text !== "(") continue
    const close = matchingDelimiter(tokens, open)
    if (close < 0) continue
    const body = functionBodyOpen(tokens, close)
    if (!isParameterList(tokens, open, close, body)) continue
    const bodyScope = source.braceScopes.get(body)
    if (bodyScope === undefined) continue
    methodOpenParens.add(open)
    for (const parameter of callArguments(tokens, open) ?? []) {
      const binding = parameterBinding(parameter)
      if (binding) bind(scopes, bodyScope, binding.name, binding.values)
    }
  }
  return { scopes, methodOpenParens }
}

function constantScopes(source: TokenizedSource, scopes: Map<number, Map<string, Binding>>) {
  const { tokens } = source
  for (let index = 0; index < tokens.length - 2; index++) {
    const constant = constantInitializer(tokens, index)
    if (constant) bind(scopes, constant.scope, constant.name, [constant.value])
  }
}

function sourceBindings(source: TokenizedSource): SourceBindings {
  const { scopes, methodOpenParens } = parameterScopes(source)
  constantScopes(source, scopes)
  return { source, scopes, methodOpenParens }
}

function resolveBinding(token: Token, context: SourceBindings) {
  let scope: number | undefined = token.scope
  while (scope !== undefined) {
    const binding = context.scopes.get(scope)?.get(token.text)
    if (binding) return binding.values
    scope = context.source.scopeParents.get(scope)
  }
  return []
}

function eventName(value: string) {
  return EVENT_NAME.test(value) ? value : undefined
}

function conditionalColon(tokens: Token[], start: number) {
  let depth = 1
  for (let index = start; index < tokens.length; index++) {
    const text = tokens[index]!.text
    if (text === "(" || text === "[" || text === "{") {
      index = matchingDelimiter(tokens, index)
      if (index < 0) return -1
    } else if (text === "?") depth++
    else if (text === ":" && --depth === 0) return index
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

function combineTemplate(prefixes: string[], expressions: string[], suffix: string) {
  return prefixes.flatMap((prefix) =>
    expressions.map((expression) => `${prefix}${expression}${suffix}`),
  )
}

function templateTailIndex(tokens: Token[]) {
  const tail = tokens.findIndex((token) => token.kind === "template-tail")
  if (tail < 0) return -1
  return tokens.slice(1, tail).some((token) => token.kind === "template-head") ? -1 : tail
}

function templateValues(tokens: Token[], context: SourceBindings): string[] {
  if (tokens[0]?.kind !== "template-head") return []
  const tail = templateTailIndex(tokens)
  if (tail < 0) return []
  return combineTemplate(
    [tokens[0].value ?? ""],
    expressionValues(tokens.slice(1, tail), context),
    tokens[tail]!.value ?? "",
  )
}

function literalValues(tokens: Token[]) {
  if (tokens.length === 1 && (tokens[0]!.kind === "string" || tokens[0]!.kind === "template"))
    return tokens[0]!.value === undefined ? undefined : [tokens[0]!.value]
}

function boundValues(tokens: Token[], context: SourceBindings) {
  const reference = tokens.find((token) => token.kind === "identifier")
  if (!reference) return []
  const values = resolveBinding(reference, context)
  if (tokens.some((token) => token.text === "toUpperCase"))
    return values.map((value) => value.toUpperCase())
  if (tokens.some((token) => token.text === "toLowerCase"))
    return values.map((value) => value.toLowerCase())
  return tokens.length === 1 ? values : []
}

function expressionValues(expression: Token[], context: SourceBindings): string[] {
  const tokens = unwrapExpression(expression)
  const literals = literalValues(tokens)
  if (literals) return literals
  if (tokens[0]?.kind === "template-head") return templateValues(tokens, context)
  const branches = conditionalParts(tokens)
  if (branches) return branches.flatMap((branch) => expressionValues(branch, context))
  return boundValues(tokens, context)
}

function eventNames(expression: Token[], context: SourceBindings) {
  return expressionValues(expression, context).flatMap((value) => {
    const name = eventName(value)
    return name ? [name] : []
  })
}

function sqlTransitionNames(tokens: Token[]) {
  const names: string[] = []
  for (const token of tokens) {
    if (token.kind !== "string" || !token.value) continue
    const match =
      /^\s*INSERT\s+INTO\s+runner_transitions\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(
        token.value,
      )
    if (!match) continue
    const columns = match[1]!.split(",").map((column) => column.trim().toLowerCase())
    const eventIndex = columns.indexOf("event")
    if (eventIndex < 0) continue
    const value = match[2]!.split(",")[eventIndex]?.trim()
    const literal = /^'((?:''|[^'])*)'$/.exec(value ?? "")
    const name = literal && eventName(literal[1]!.replaceAll("''", "'"))
    if (name) names.push(name)
  }
  return names
}

function producerNames(context: SourceBindings) {
  const { tokens } = context.source
  const names = new Set(sqlTransitionNames(tokens))
  for (let index = 0; index < tokens.length - 2; index++) {
    const eventArguments = PRODUCER_ARGUMENTS.get(tokens[index]!.text)
    const open = index + 1
    if (!eventArguments || tokens[open]!.text !== "(" || context.methodOpenParens.has(open))
      continue
    const args = callArguments(tokens, open)
    if (!args) continue
    for (const argumentIndex of eventArguments)
      for (const name of eventNames(args[argumentIndex] ?? [], context)) names.add(name)
  }
  return names
}

/**
 * Finds exact names supplied to transition persistence producers. Bindings remain within their
 * source and lexical scopes; SQL literals count only in runner transition inserts.
 */
export function discoverRecordedTransitions(sources: TransitionSource[]): string[] {
  const names = new Set<string>()
  for (const { source } of sources)
    for (const name of producerNames(sourceBindings(tokensOf(source)))) names.add(name)
  return [...names].sort()
}
