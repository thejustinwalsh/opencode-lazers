import type { ComposerNote, ComposerQuote, SessionScreen } from "@opencode/plugin/gui"

/** The host operations discussion needs; the panel provides them from `ctx`. */
export type DiscussHost = {
  /** The routed session's id now. */
  currentSessionID(): string | undefined
  screen(): SessionScreen | undefined
  /** Opens and shows a session's tab. */
  openSession(session: { server: string; id: string }): void
  /** Resolves once `sessionID` is the routed session, or when `signal` aborts. */
  routed(sessionID: string, signal: AbortSignal): Promise<void>
  signal: AbortSignal
}

export type DiscussResult = "attached" | "no-architect" | "cancelled"

/**
 * Puts a selection into the Architect's next prompt: the quoted code and a pinned review note,
 * attached beside whatever the draft already holds. Nothing is sent and the draft text is never
 * replaced. From a worker's screen, which has no composer, it opens the Architect conversation
 * first and attaches there once it is routed.
 */
export async function discussWithArchitect(
  host: DiscussHost,
  input: {
    server: string
    architectSessionID: string | null
    quote: ComposerQuote
    note: ComposerNote
  },
): Promise<DiscussResult> {
  const architect = input.architectSessionID
  if (!architect) return "no-architect"
  if (host.currentSessionID() !== architect) {
    host.openSession({ server: input.server, id: architect })
    await host.routed(architect, host.signal)
    if (host.signal.aborted || host.currentSessionID() !== architect) return "cancelled"
  }
  const composer = host.screen()?.composer
  if (!composer) return "cancelled"
  if (composer.quotable()) {
    composer.attach(input.note)
    composer.attach(input.quote)
    composer.focus(input.quote.commentID)
  } else {
    // A shell-mode composer takes no quote; the note carries the quoted text so nothing is lost.
    composer.attach({
      ...input.note,
      subject: `${input.note.subject}\n\nSelected code:\n${input.quote.text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}`,
    })
    composer.focus()
  }
  return "attached"
}
