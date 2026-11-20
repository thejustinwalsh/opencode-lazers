export type TokenKind = "identifier" | "string" | "template" | "punctuation"

export interface Token {
  kind: TokenKind
  text: string
  value?: string
}

function quotedEnd(source: string, start: number) {
  const quote = source[start]!
  let index = start + 1
  while (index < source.length) {
    if (source[index] === "\\") index += 2
    else if (source[index++] === quote) break
  }
  return index
}

function commentEnd(source: string, start: number) {
  if (source[start + 1] === "/") {
    let index = start + 2
    while (index < source.length && source[index] !== "\n") index++
    return index
  }
  const end = source.indexOf("*/", start + 2)
  return end < 0 ? source.length : end + 2
}

function embeddedTokenEnd(source: string, index: number) {
  const character = source[index]!
  if (character === "'" || character === '"') return quotedEnd(source, index)
  if (character === "`") return templateEnd(source, index).end
  if (character === "/" && ["/", "*"].includes(source[index + 1] ?? ""))
    return commentEnd(source, index)
  return index + 1
}

function templateExpressionEnd(source: string, start: number) {
  let depth = 1
  let index = start
  while (index < source.length && depth > 0) {
    const character = source[index]!
    if (character === "{") depth++
    else if (character === "}") depth--
    index = embeddedTokenEnd(source, index)
  }
  return index
}

function templateEnd(source: string, start: number): { end: number; value?: string } {
  let index = start + 1
  let value = ""
  let interpolated = false
  while (index < source.length) {
    const character = source[index]!
    if (character === "\\") {
      value += source[index + 1] ?? ""
      index += 2
    } else if (character === "`") {
      return { end: index + 1, ...(interpolated ? {} : { value }) }
    } else if (character === "$" && source[index + 1] === "{") {
      interpolated = true
      index = templateExpressionEnd(source, index + 2)
    } else {
      value += character
      index++
    }
  }
  return { end: index }
}

function triviaEnd(source: string, start: number) {
  let index = start
  while (index < source.length) {
    if (/\s/.test(source[index]!)) index++
    else if (source[index] === "/" && ["/", "*"].includes(source[index + 1] ?? ""))
      index = commentEnd(source, index)
    else break
  }
  return index
}

function punctuation(source: string, index: number): Token {
  const operator = source.slice(index, index + 3)
  if (operator === "...") return { kind: "punctuation", text: operator }
  const pair = source.slice(index, index + 2)
  if (["?.", "=>", "??"].includes(pair)) return { kind: "punctuation", text: pair }
  return { kind: "punctuation", text: source[index]! }
}

function punctuationLength(token: Token) {
  return token.text.length
}

export function tokensOf(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while ((index = triviaEnd(source, index)) < source.length) {
    const character = source[index]!
    if (character === "'" || character === '"') {
      const end = quotedEnd(source, index)
      tokens.push({
        kind: "string",
        text: source.slice(index, end),
        value: source.slice(index + 1, Math.max(index + 1, end - 1)),
      })
      index = end
    } else if (character === "`") {
      const template = templateEnd(source, index)
      tokens.push({
        kind: "template",
        text: source.slice(index, template.end),
        ...(template.value === undefined ? {} : { value: template.value }),
      })
      index = template.end
    } else if (/[A-Za-z_$]/.test(character)) {
      const start = index++
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index]!)) index++
      const text = source.slice(start, index)
      tokens.push({ kind: "identifier", text })
    } else {
      const token = punctuation(source, index)
      tokens.push(token)
      index += punctuationLength(token)
    }
  }
  return tokens
}

function closingToken(open: string) {
  if (open === "(") return ")"
  if (open === "[") return "]"
  if (open === "{") return "}"
  return undefined
}

function isClosingToken(token: string) {
  return token === ")" || token === "]" || token === "}"
}

export function matchingDelimiter(tokens: Token[], open: number) {
  const first = closingToken(tokens[open]!.text)
  if (!first) return -1
  const closing = [first]
  for (let index = open + 1; index < tokens.length; index++) {
    const token = tokens[index]!.text
    const expected = closingToken(token)
    if (expected) closing.push(expected)
    else if (isClosingToken(token)) {
      if (closing.at(-1) !== token) return -1
      closing.pop()
      if (!closing.length) return index
    }
  }
  return -1
}

function splitArguments(tokens: Token[], open: number, close: number) {
  const args: Token[][] = []
  const closing: string[] = []
  let start = open + 1
  for (let index = start; index < close; index++) {
    const token = tokens[index]!.text
    const expected = closingToken(token)
    if (expected) closing.push(expected)
    else if (isClosingToken(token)) closing.pop()
    else if (token === "," && !closing.length) {
      args.push(tokens.slice(start, index))
      start = index + 1
    }
  }
  if (start < close || args.length) args.push(tokens.slice(start, close))
  return args
}

export function callArguments(tokens: Token[], open: number): Token[][] | undefined {
  const close = matchingDelimiter(tokens, open)
  return close < 0 ? undefined : splitArguments(tokens, open, close)
}
