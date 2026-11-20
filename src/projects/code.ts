/** Project codes: 2 to 4 uppercase letters, generated once from the project's folder name. */

/** A task reference such as `LZ-137` or `APP2-5`; every reader of references uses this one pattern. */
export const REFERENCE_PATTERN = /\b[A-Z]{2,4}\d*-\d+\b/

const FALLBACK = "PX"

/**
 * Words are runs of ASCII letters after folding diacritics. Two or more words give each word's
 * initial (at most four); one word gives its first three letters; one letter is padded with `X`;
 * no letters give `PX`.
 */
export function projectCodeFrom(name: string): string {
  const words = name
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
  if (words.length === 0) return FALLBACK
  const code =
    words.length >= 2
      ? words
          .slice(0, 4)
          .map((word) => word[0])
          .join("")
      : words[0]!.slice(0, 3)
  return (code.length < 2 ? `${code}X` : code).toUpperCase()
}

/** `base`, or `base` with the lowest free number from 2 when `taken` holds it. */
export function uniqueProjectCode(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`
}
