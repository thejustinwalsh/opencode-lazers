import type { CcccLanguage } from "./types.ts"

const LANGUAGES: Readonly<Record<CcccLanguage, readonly string[]>> = {
  typescript: ["ts", "tsx", "mts", "cts"],
  javascript: ["js", "jsx", "mjs", "cjs"],
  rust: ["rs"],
  go: ["go"],
  php: ["php"],
  ruby: ["rb"],
  scheme: ["scm", "ss", "sld"],
  racket: ["rkt", "rktl", "rktd"],
  commonlisp: ["lisp", "lsp", "cl"],
  emacslisp: ["el"],
  clojure: ["clj", "cljs", "cljc"],
  kotlin: ["kt", "kts"],
  python: ["py", "pyi"],
  zig: ["zig"],
  c: ["c", "h"],
  cpp: ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "h++", "tpp", "ipp"],
  perl: ["pl", "pm", "t"],
  swift: ["swift"],
  java: ["java"],
  dart: ["dart"],
  scala: ["scala", "sc"],
}

const BY_EXTENSION = new Map(
  Object.entries(LANGUAGES).flatMap(([language, extensions]) =>
    extensions.map((extension) => [extension, language as CcccLanguage] as const),
  ),
)

export function languageOf(path: string): CcccLanguage | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) : undefined
}
