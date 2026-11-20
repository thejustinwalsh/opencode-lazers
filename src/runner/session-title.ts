/** The native session title: the project code, then the text, cut to 120 characters. */
export function sessionTitle(code: string, text: string): string {
  return `${code} · ${text}`.slice(0, 120)
}
