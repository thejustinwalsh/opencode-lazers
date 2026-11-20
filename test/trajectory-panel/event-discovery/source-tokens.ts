import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast"

export type TokenKind =
  | "identifier"
  | "string"
  | "template"
  | "template-head"
  | "template-middle"
  | "template-tail"
  | "regex"
  | "literal"
  | "punctuation"

export interface Token {
  kind: TokenKind
  text: string
  value?: string
  scope: number
}

export interface TokenizedSource {
  tokens: Token[]
  scopeParents: Map<number, number | undefined>
  braceScopes: Map<number, number>
}

const REGEX_PREFIX_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
])

const EXPRESSION_KEYWORDS = new Set(["false", "null", "super", "this", "true"])
const TOKEN_KIND_BY_SYNTAX_KIND = new Map<SyntaxKind, TokenKind>([
  [SyntaxKind.StringLiteral, "string"],
  [SyntaxKind.NoSubstitutionTemplateLiteral, "template"],
  [SyntaxKind.TemplateHead, "template-head"],
  [SyntaxKind.TemplateMiddle, "template-middle"],
  [SyntaxKind.TemplateTail, "template-tail"],
  [SyntaxKind.RegularExpressionLiteral, "regex"],
  [SyntaxKind.NumericLiteral, "literal"],
  [SyntaxKind.BigIntLiteral, "literal"],
])

function canStartRegex(previous: Token | undefined) {
  if (!previous) return true
  if (REGEX_PREFIX_KEYWORDS.has(previous.text)) return true
  if (
    ["identifier", "literal", "regex", "string", "template", "template-tail"].includes(
      previous.kind,
    )
  )
    return previous.kind === "identifier" && REGEX_PREFIX_KEYWORDS.has(previous.text)
  if ([")", "]", "}", "++", "--"].includes(previous.text)) return false
  return true
}

function tokenKind(kind: SyntaxKind, scanner: ReturnType<typeof createScanner>): TokenKind {
  if (scanner.isIdentifier() && !EXPRESSION_KEYWORDS.has(scanner.getTokenText()))
    return "identifier"
  return (
    TOKEN_KIND_BY_SYNTAX_KIND.get(kind) ??
    (EXPRESSION_KEYWORDS.has(scanner.getTokenText()) ? "literal" : "punctuation")
  )
}

function scopeToken(
  kind: SyntaxKind,
  scanner: ReturnType<typeof createScanner>,
  tokens: Token[],
  scopeParents: Map<number, number | undefined>,
  braceScopes: Map<number, number>,
  scopes: number[],
  nextScope: { value: number },
) {
  const text = scanner.getTokenText()
  const token: Token = {
    kind: tokenKind(kind, scanner),
    text,
    value: scanner.getTokenValue(),
    scope: scopes.at(-1)!,
  }
  const index = tokens.push(token) - 1
  if (kind === SyntaxKind.OpenBraceToken) {
    const scope = nextScope.value++
    scopeParents.set(scope, scopes.at(-1))
    braceScopes.set(index, scope)
    scopes.push(scope)
  } else if (kind === SyntaxKind.CloseBraceToken && scopes.length > 1) scopes.pop()
  return token
}

function nextScannerToken(scanner: ReturnType<typeof createScanner>, previous: Token | undefined) {
  const kind = scanner.scan()
  return kind === SyntaxKind.SlashToken && canStartRegex(previous)
    ? scanner.reScanSlashToken()
    : kind
}

function templateContinuation(
  kind: SyntaxKind,
  scanner: ReturnType<typeof createScanner>,
  tokens: Token[],
  scopeParents: Map<number, number | undefined>,
  braceScopes: Map<number, number>,
  scopes: number[],
  nextScope: { value: number },
  templateExpressions: Array<{ braceDepth: number }>,
) {
  if (kind !== SyntaxKind.CloseBraceToken || !templateExpressions.length) return
  const expression = templateExpressions.at(-1)!
  if (expression.braceDepth > 0) {
    expression.braceDepth--
    return
  }

  const templateKind = scanner.reScanTemplateToken(false)
  const token = scopeToken(
    templateKind,
    scanner,
    tokens,
    scopeParents,
    braceScopes,
    scopes,
    nextScope,
  )
  if (templateKind === SyntaxKind.TemplateTail) templateExpressions.pop()
  return token
}

function updateTemplateExpressions(kind: SyntaxKind, expressions: Array<{ braceDepth: number }>) {
  if (kind === SyntaxKind.TemplateHead) expressions.push({ braceDepth: 0 })
  else if (kind === SyntaxKind.OpenBraceToken && expressions.length)
    expressions.at(-1)!.braceDepth++
}

/** Tokenizes TypeScript using its scanner, including regular-expression and template literals. */
export function tokensOf(source: string): TokenizedSource {
  const scanner = createScanner(true, LanguageVariant.JSX, source)
  const tokens: Token[] = []
  const scopeParents = new Map<number, number | undefined>([[0, undefined]])
  const braceScopes = new Map<number, number>()
  const scopes = [0]
  const nextScope = { value: 1 }
  const templateExpressions: Array<{ braceDepth: number }> = []
  let previous: Token | undefined
  let kind = nextScannerToken(scanner, previous)

  while (kind !== SyntaxKind.EndOfFile) {
    const continuation = templateContinuation(
      kind,
      scanner,
      tokens,
      scopeParents,
      braceScopes,
      scopes,
      nextScope,
      templateExpressions,
    )
    if (continuation) {
      previous = continuation
      kind = nextScannerToken(scanner, previous)
      continue
    }

    const token = scopeToken(kind, scanner, tokens, scopeParents, braceScopes, scopes, nextScope)
    updateTemplateExpressions(kind, templateExpressions)
    previous = token
    kind = nextScannerToken(scanner, previous)
  }

  return { tokens, scopeParents, braceScopes }
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
