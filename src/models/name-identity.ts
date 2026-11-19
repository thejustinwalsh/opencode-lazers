/**
 * Model name identity: one pure resolver for every cross-source join.
 *
 * Every source spells a model differently (`anthropic/claude-sonnet-4.5`,
 * `claude-sonnet-4-5-20250929`, `Claude 4.5 Sonnet (Sep '25)`, `anthropic.claude-sonnet-4-5-v1:0`).
 * `parseModelName` reduces any of them to a canonical identity, and `createModelIndex` joins by
 * that identity in recorded tiers, so a match says how it was made:
 *
 *   exact-id            the same string
 *   cross-id            the same string after separator folding, against any name a source gave
 *   identity            equal canonical identity (family, version, tier words, size, variants)
 *   identity-relaxed    equal identity once a size one side omits is set aside
 *   alias               a reviewed rename (a tiny table)
 *
 * Identity keeps what changes the model (tier words such as mini, flash, pro, sonnet; sizes;
 * `thinking`; the version) and drops what does not (dates, build stamps, `latest`, `preview`,
 * `:free`, routing and cloud prefixes, effort levels). Effort is not identity: it is returned
 * beside the identity so `gpt-5 (high)` attaches to `gpt-5` with the effort recorded.
 * A row that could be two different identities is never guessed: it stays unmatched, with the
 * reason, unless the vendor or the closeness of the names settles it.
 */

export type ModelIdentity = {
  /** The canonical key two names share when they are the same model. */
  key: string
  /** The same key without its size, for the relaxed tier. */
  looseKey: string
  vendor: string | null
  family: string
  version: string | null
  tiers: string[]
  size: string | null
  variants: string[]
  /** A reasoning or thinking-budget level: carried beside the identity, never part of it. */
  effort: string | null
  /** The snapshot date when the name carried one, as written (not part of identity). */
  date: string | null
  /** Every word that identified the model, in canonical order, for closeness comparisons. */
  tokens: string[]
}

/** Spellings of a vendor mapped to one slug. Spelling only; it names no model. */
const VENDOR_SPELLINGS: Record<string, string> = {
  "x-ai": "xai",
  "z-ai": "zai",
  zhipu: "zai",
  zhipuai: "zai",
  "meta-llama": "meta",
  meta: "meta",
  mistralai: "mistral",
  moonshot: "moonshotai",
  moonshotai: "moonshotai",
  kimi: "moonshotai",
  "deepseek-ai": "deepseek",
  qwen: "alibaba",
  alibaba: "alibaba",
  "alibaba-cn": "alibaba",
  "google-vertex": "google",
  "google-vertex-anthropic": "anthropic",
  "amazon-bedrock": "amazon",
  minimaxai: "minimax",
  nvidia: "nvidia",
  nousresearch: "nous",
  cohere: "cohere",
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  deepseek: "deepseek",
  xai: "xai",
  zai: "zai",
  mistral: "mistral",
  minimax: "minimax",
  amazon: "amazon",
  ai21: "ai21",
}

export function vendorSlug(raw: string | null | undefined): string | null {
  if (!raw) return null
  const text = raw.trim().toLowerCase()
  if (!text) return null
  return VENDOR_SPELLINGS[text] ?? VENDOR_SPELLINGS[text.replace(/\s+/g, "-")] ?? null
}

/** Path words that route a request and say nothing about the model. */
const ROUTING_SEGMENTS = new Set([
  "models",
  "model",
  "accounts",
  "fireworks",
  "openrouter",
  "bedrock",
  "azure",
  "vertex",
  "vertex_ai",
  "huggingface",
  "hf",
  "together",
  "groq",
  "replicate",
  "workers-ai",
  "cf",
  "@cf",
  "opencode",
  "opencode-go",
])
const REGION_PREFIX = /^(?:us|eu|ap|apac|au|ca|jp|global)\./

/** Words that do not change which model it is. */
const NOISE = new Set([
  "latest",
  "preview",
  "exp",
  "experimental",
  "beta",
  "alpha",
  "free",
  "nitro",
  "extended",
  "floor",
  "online",
  "exacto",
  "it",
  "contributor",
  "spot",
  "maas",
  "highspeed",
  "ultrafast",
  "batch",
  "hf",
  "fp8",
  "fp4",
  "int4",
  "int8",
  "awq",
  "gguf",
  "bf16",
  "v1",
  "version",
  "the",
])
/** Effort levels: a property of how a model was run. `medium` and `max` are tiers unless marked. */
const EFFORT = new Set(["low", "high", "xhigh", "minimal", "none"])
const MARKED_EFFORT = new Set([...EFFORT, "medium", "max", "unknown"])
const MONTHS = new Set([
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
])
const VARIANT_WORDS = new Set(["thinking", "reasoning"])

const validMonth = (text: string) => Number(text) >= 1 && Number(text) <= 12
const validDay = (text: string) => Number(text) >= 1 && Number(text) <= 31

/** A string as a name only: lowercase, one separator kind, nothing else changed. */
export function foldName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s_:/.\\-]+/g, " ")
    .trim()
}

function stripParentheses(text: string): { text: string; marked: string[] } {
  const marked: string[] = []
  const stripped = text.replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (_match, a: string, b: string) => {
    for (const word of (a ?? b ?? "").toLowerCase().split(/[\s,/]+/))
      if (word) marked.push(word.replace(/^'/, ""))
    return " "
  })
  return { text: stripped, marked }
}

type Dated = { text: string; date: string | null }

/** Remove snapshot dates in the forms sources use; keeps the first one found. */
function stripDates(text: string): Dated {
  let date: string | null = null
  const take = (found: string) => {
    date ??= found
    return " "
  }
  let out = text
  out = out.replace(/@\d{8}\b/g, (m) => take(m.slice(1)))
  out = out.replace(/(?<![\d.])20\d{2}[-._ ]\d{2}[-._ ]\d{2}(?!\d)/g, take)
  out = out.replace(/(?<![\d.])20\d{6}(?!\d)/g, take)
  // Month and year, either order: `09-2025`, `2025-09`
  out = out.replace(/(?<![\d.])(?:0[1-9]|1[0-2])[-._ ]20\d{2}(?!\d)/g, take)
  out = out.replace(/(?<![\d.])\d{2}[-._ ]\d{2}[-._ ]20\d{2}(?!\d)/g, take)
  // `Sep '25`, `Sept 2025`
  out = out.replace(
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*[\s.,-]*(?:'\d{2}|20\d{2})\b/gi,
    take,
  )
  // `06-05`, `01-21`: month then day, between letters-or-version and the end or a separator
  out = out.replace(/(?<=[\s\-_.])(\d{2})[-._](\d{2})(?![\d.])/g, (m, a: string, b: string) =>
    validMonth(a) && validDay(b) ? take(m) : m,
  )
  // A bare four-digit stamp after the name: MMDD (`0905`, `1106`) or YYMM (`2507`)
  out = out.replace(/(?<=[a-z\d][\s\-_])(\d{4})(?![\d.])/g, (m, d: string) => {
    const mmdd = validMonth(d.slice(0, 2)) && validDay(d.slice(2))
    const yymm =
      Number(d.slice(0, 2)) >= 23 && Number(d.slice(0, 2)) <= 29 && validMonth(d.slice(2))
    return mmdd || yymm ? take(d) : m
  })
  return { text: out, date }
}

export type ParseHints = {
  /** A provider or organisation field from the source, when it gave one. */
  vendor?: string | null
}

export function parseModelName(raw: string, hints: ParseHints = {}): ModelIdentity {
  let working = raw.trim().toLowerCase()
  let vendor = vendorSlug(hints.vendor)
  const efforts: string[] = []

  // Provider-style prefix: `anthropic.claude-...` (Bedrock), `us.anthropic.claude-...`
  working = working.replace(REGION_PREFIX, "").replace(/^c4ai-/, "")
  const dotted = /^([a-z][a-z0-9-]*)\.(?=[a-z])/.exec(working)
  if (dotted && vendorSlug(dotted[1])) {
    vendor ??= vendorSlug(dotted[1])
    working = working.slice(dotted[0].length)
  }
  // Path prefixes: `vendor/model`, `accounts/fireworks/models/model`
  if (working.includes("/")) {
    const segments = working.split("/").filter(Boolean)
    const last = segments.pop() ?? ""
    for (const segment of segments) {
      const slug = vendorSlug(segment)
      if (slug) vendor ??= slug
      else if (!ROUTING_SEGMENTS.has(segment) && !vendor) vendor ??= vendorSlug(segment)
    }
    working = last
  }
  // Routing suffixes: `:free`, `:nitro`, and Bedrock `-v1:0`
  working = working.replace(/-v\d+:\d+$/, "")
  working = working.replace(/:(?:free|nitro|extended|floor|online|exacto|beta)\b/g, "")
  working = working.replace(/:(?:thinking)\b/g, " thinking ")
  working = working.replace(/:\d+$/, "")
  // Fireworks style version: `glm-4p5`
  working = working.replace(/(\d)p(\d)/g, "$1.$2")

  const parenthetical = stripParentheses(working)
  working = parenthetical.text
  for (const word of parenthetical.marked) {
    if (MARKED_EFFORT.has(word)) efforts.push(word)
    else if (VARIANT_WORDS.has(word)) working += ` ${word}`
  }

  // Effort or budget marked with an underscore at the end: `gpt-5_high`, `claude-opus-4_32k`
  const underscore = /^(.*\S)_([a-z0-9]+)$/.exec(working)
  if (underscore && VARIANT_WORDS.has(underscore[2]!))
    working = `${underscore[1]!} ${underscore[2]!}`
  else if (underscore && (MARKED_EFFORT.has(underscore[2]!) || /^\d+k$/.test(underscore[2]!))) {
    efforts.push(underscore[2]!)
    working = underscore[1]!
  }

  const dated = stripDates(working)
  working = dated.text

  // Sizes (`480b`, `a22b`) are identity; mark them before digits and letters are split
  working = working
    .replace(/\ba(\d+(?:\.\d+)?)b\b/g, " size~a$1b ")
    .replace(/(?<![\w.])(\d+(?:\.\d+)?)\s*([bkm])\b/g, " size~$1$2 ")
  const fused = fuseVersion(working)

  const tiers: string[] = []
  const variants: string[] = []
  const sizes: string[] = []
  const family: string[] = []
  let sawNon = false
  for (const word of fused.words) {
    if (word.startsWith("size~")) {
      sizes.push(word.slice(5))
      continue
    }
    if (NOISE.has(word)) continue
    if (MONTHS.has(word)) continue
    if (EFFORT.has(word)) {
      efforts.push(word)
      continue
    }
    if (word === "non") {
      sawNon = true
      continue
    }
    if (VARIANT_WORDS.has(word)) {
      variants.push(sawNon ? `non-${word}` : word)
      sawNon = false
      continue
    }
    if (TIER_WORDS.has(word)) {
      tiers.push(word)
      continue
    }
    family.push(word)
  }

  const familyText = family.join(" ")
  const sortedTiers = [...new Set(tiers)].sort()
  const sortedVariants = [...new Set(variants)].sort()
  const size = sizes[0] ?? null
  const version = fused.version?.replace(/(?:\.0)+$/, "") || null
  const base = [familyText, version ?? "", sortedTiers.join("+"), sortedVariants.join("+")].join(
    "|",
  )
  const effort = efforts.find((word) => word !== "unknown") ?? null
  return {
    key: `${base}|${size ?? ""}`,
    looseKey: base,
    vendor,
    family: familyText,
    version,
    tiers: sortedTiers,
    size,
    variants: sortedVariants,
    effort,
    date: dated.date,
    tokens: [...family, ...sortedTiers, ...sortedVariants, ...(version ? [version] : [])],
  }
}

/**
 * Words that tell models of one family apart. A generic vocabulary, not a model list: a word
 * outside it is treated as part of the family name.
 */
const TIER_WORDS = new Set([
  "mini",
  "nano",
  "micro",
  "small",
  "medium",
  "large",
  "tiny",
  "flash",
  "lite",
  "pro",
  "max",
  "ultra",
  "turbo",
  "haiku",
  "sonnet",
  "opus",
  "fable",
  "coder",
  "code",
  "codex",
  "instruct",
  "chat",
  "air",
  "plus",
  "flashx",
  "spark",
  "mega",
  "vision",
  "omni",
  "image",
  "audio",
  "embed",
  "base",
  "guard",
  "distill",
])

/** Digits that sit together in a name are one version: `4 5` and `4.5` are both `4.5`. */
function fuseVersion(text: string): { words: string[]; version: string | null } {
  const tokens = text
    .split(/[\s\-_:,]+/)
    .flatMap((piece) =>
      piece.startsWith("size~")
        ? [piece]
        : piece.split(/(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/).filter(Boolean),
    )
    .filter(Boolean)
  const words: string[] = []
  let version: string | null = null
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at]!
    if (/^\d+(?:\.\d+)*$/.test(token)) {
      let combined = token
      // Fold `4`, `5` into `4.5`; two short numbers only, and only when adjacent
      while (
        at + 1 < tokens.length &&
        /^\d{1,2}$/.test(combined.split(".").at(-1)!) &&
        /^\d{1,2}$/.test(tokens[at + 1]!) &&
        combined.split(".").length < 2
      ) {
        combined = `${combined}.${tokens[at + 1]!}`
        at++
      }
      // Several separate numbers are a family's own numbering (`o 3`): the first leads
      version = version === null ? combined : `${version}.${combined}`
      continue
    }
    words.push(token)
  }
  return { words, version }
}

// -- Matching ---------------------------------------------------------------------------------

export type MatchTier = "exact-id" | "cross-id" | "identity" | "identity-relaxed" | "alias"

export type IndexItem<T> = {
  /** The source's own id for the item. */
  id: string
  /** Every other name the source gave: slugs, display names, hugging face ids. */
  names?: readonly string[]
  /** The provider or organisation field, when the source has one. */
  vendor?: string | null
  value: T
}

export type Resolution<T> =
  | {
      status: "matched"
      tier: MatchTier
      /** One identity; several items when it has dated snapshots or provider copies. */
      items: ReadonlyArray<IndexItem<T>>
      identity: ModelIdentity
    }
  | {
      status: "unmatched"
      reason: "no-identity-match" | "ambiguous" | "unparseable"
      detail: string
      identity: ModelIdentity
    }

/** Reviewed renames the name rules cannot reconcile; keep it tiny. Folded name to folded name. */
const MODEL_ALIASES: Readonly<Record<string, string>> = {
  "gpt-5.5-pre-release": "gpt-5.5",
}

/** The closeness of two token lists: shared over total, a tie-break between identities. */
function closeness(a: readonly string[], b: readonly string[]) {
  const left = new Set(a)
  const right = new Set(b)
  const shared = [...left].filter((token) => right.has(token)).length
  return shared / Math.max(1, new Set([...left, ...right]).size)
}

const aliasTargets = new Map(
  Object.entries(MODEL_ALIASES).map(([from, to]) => [parseModelName(from).key, parseModelName(to)]),
)

export function createModelIndex<T>(items: ReadonlyArray<IndexItem<T>>) {
  type Entry = { item: IndexItem<T>; identity: ModelIdentity }
  const byId = new Map<string, Entry[]>()
  const byName = new Map<string, Entry[]>()
  const byKey = new Map<string, Entry[]>()
  const byLooseKey = new Map<string, Entry[]>()
  const push = (map: Map<string, Entry[]>, key: string, entry: Entry) => {
    const list = map.get(key)
    if (list) list.push(entry)
    else map.set(key, [entry])
  }

  // Vendor for family: derived from the entries' own vendor fields, majority wins.
  const votes = new Map<string, Map<string, number>>()
  const parsed: Entry[] = items.map((item) => ({
    item,
    identity: parseModelName(item.id, { vendor: item.vendor ?? null }),
  }))
  for (const { item, identity } of parsed) {
    const vendor = identity.vendor ?? vendorSlug(item.vendor)
    if (!vendor || !identity.family) continue
    const tally = votes.get(identity.family) ?? new Map<string, number>()
    tally.set(vendor, (tally.get(vendor) ?? 0) + 1)
    votes.set(identity.family, tally)
  }
  const familyVendors = new Map<string, string>()
  for (const [family, tally] of votes)
    familyVendors.set(family, [...tally.entries()].sort((a, b) => b[1] - a[1])[0]![0])
  const vendorFor = (identity: ModelIdentity) =>
    identity.vendor ?? familyVendors.get(identity.family) ?? null

  for (const entry of parsed) {
    const { item, identity } = entry
    push(byId, item.id.trim().toLowerCase(), entry)
    for (const name of [item.id, ...(item.names ?? [])]) push(byName, foldName(name), entry)
    // A display name is another spelling of the model: index its identity too.
    const identities = new Map<string, ModelIdentity>([[identity.key, identity]])
    for (const name of item.names ?? []) {
      const alt = parseModelName(name, { vendor: item.vendor ?? null })
      identities.set(alt.key, alt)
    }
    for (const alt of identities.values()) {
      if (!alt.family) continue
      push(byKey, alt.key, entry)
      push(byLooseKey, alt.looseKey, entry)
    }
  }

  const unique = (entries: Entry[]) => [...new Map(entries.map((e) => [e.item, e])).values()]
  const matched = (tier: MatchTier, entries: Entry[], identity: ModelIdentity): Resolution<T> => ({
    status: "matched",
    tier,
    items: unique(entries).map((entry) => entry.item),
    identity,
  })

  function resolve(raw: string, hints: ParseHints = {}): Resolution<T> {
    const identity = parseModelName(raw, hints)
    const exact = byId.get(raw.trim().toLowerCase())
    if (exact) return matched("exact-id", exact, identity)
    const fold = byName.get(foldName(raw))
    if (fold) return matched("cross-id", fold, identity)
    if (!identity.family)
      return { status: "unmatched", reason: "unparseable", detail: "no family name", identity }

    const vendor = vendorFor(identity)
    // Identities that differ only in vendor spelling stay one; a vendor settles ties below.
    const sameKey = byKey.get(identity.key)
    if (sameKey) {
      const narrowed = narrowByVendor(sameKey, vendor)
      return matched("identity", narrowed, identity)
    }
    const alias = aliasTargets.get(identity.key)
    if (alias) {
      const hit = byKey.get(alias.key) ?? byLooseKey.get(alias.looseKey)
      if (hit) return matched("alias", hit, identity)
    }
    // Relaxed: the size is set aside when one side omits it; the sizes never disagree.
    const loose = byLooseKey.get(identity.looseKey)
    if (loose) {
      const compatible = loose.filter(
        (entry) =>
          identity.size === null ||
          entry.identity.size === null ||
          entry.identity.size === identity.size,
      )
      if (compatible.length) {
        const keys = new Set(compatible.map((entry) => entry.identity.key))
        if (keys.size === 1) return matched("identity-relaxed", compatible, identity)
        // Several sizes: the row names no size, so the choice is not ours to make.
        const nearest = pickClosest(compatible, identity, vendor, vendorFor)
        if (nearest) return matched("identity-relaxed", nearest, identity)
        return {
          status: "unmatched",
          reason: "ambiguous",
          detail: `could be ${[...keys].slice(0, 3).join(" or ")}`,
          identity,
        }
      }
    }
    return {
      status: "unmatched",
      reason: "no-identity-match",
      detail:
        `no model with identity ${identity.family} ${identity.version ?? ""} ${identity.tiers.join(" ")}`.trim(),
      identity,
    }
  }

  function narrowByVendor(entries: Entry[], vendor: string | null) {
    if (!vendor) return entries
    const same = entries.filter((entry) => vendorFor(entry.identity) === vendor)
    return same.length ? same : entries
  }

  function pickClosest(
    entries: Entry[],
    identity: ModelIdentity,
    vendor: string | null,
    vendorOf: (identity: ModelIdentity) => string | null,
  ): Entry[] | null {
    const scored = entries
      .map((entry) => ({
        entry,
        score:
          closeness(identity.tokens, entry.identity.tokens) +
          (vendor && vendorOf(entry.identity) === vendor ? 1 : 0),
      }))
      .sort((a, b) => b.score - a.score)
    if (!scored.length) return null
    const best = scored[0]!
    const tied = scored.filter((entry) => entry.score === best.score)
    const keys = new Set(tied.map((entry) => entry.entry.identity.key))
    return keys.size === 1 ? tied.map((entry) => entry.entry) : null
  }

  return { resolve, size: items.length }
}

export type ModelIndex<T> = ReturnType<typeof createModelIndex<T>>

/** The vendor each family is credited to by a set of named rows; for callers that need it. */
export function deriveFamilyVendors(
  rows: ReadonlyArray<{ name: string; vendor: string | null | undefined }>,
) {
  const votes = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const identity = parseModelName(row.name, { vendor: row.vendor ?? null })
    if (!identity.vendor || !identity.family) continue
    const tally = votes.get(identity.family) ?? new Map<string, number>()
    tally.set(identity.vendor, (tally.get(identity.vendor) ?? 0) + 1)
    votes.set(identity.family, tally)
  }
  return new Map(
    [...votes].map(([family, tally]) => [
      family,
      [...tally.entries()].sort((a, b) => b[1] - a[1])[0]![0],
    ]),
  )
}
