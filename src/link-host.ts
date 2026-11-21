/** How long a chat-link lookup may take before it is given up. */
const LINK_TIMEOUT_MS = 5_000

/** The signal of one chat-link lookup: the host's own, plus the lookup time limit. */
export function linkSignal(ctx: { signal: AbortSignal }): AbortSignal {
  return AbortSignal.any([ctx.signal, AbortSignal.timeout(LINK_TIMEOUT_MS)])
}

/** The open session a resolved link points at, found again by id, server and directory. */
export function linkedSession<
  S extends { id: string; server: { id: string }; location?: { directory: string } },
>(
  ctx: { sessions: { list(): readonly S[] } },
  target: { session: { id: string; server: { id: string } }; sessionDirectory: string },
): S | undefined {
  return ctx.sessions
    .list()
    .find(
      (candidate) =>
        candidate.id === target.session.id &&
        candidate.server.id === target.session.server.id &&
        candidate.location?.directory === target.sessionDirectory,
    )
}
