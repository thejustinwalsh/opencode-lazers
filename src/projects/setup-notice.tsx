import type { Plugin } from "@opencode/plugin/gui"
import { createEffect } from "solid-js"
import { Projects } from "./contract.ts"

type Ctx = Parameters<Plugin.Setup>[0]
/** What the notice needs of a session: its server, its id and where it runs. */
export type NoticeSession = Pick<
  NonNullable<ReturnType<Ctx["sessions"]["current"]>>,
  "id" | "server" | "directory"
>

const signal = (ctx: Ctx) => AbortSignal.any([ctx.signal, AbortSignal.timeout(5_000)])

/**
 * Starts the setup Architect session of the session's project and shows it. A failure is shown,
 * never thrown; the notice and Settings both call this.
 */
export async function startSetupInSession(ctx: Ctx, session: NoticeSession): Promise<boolean> {
  try {
    const outcome = await session.server.client
      .rpc(Projects)
      .startSetup(
        { sessionID: session.id },
        { location: { directory: session.directory }, signal: signal(ctx) },
      )
    if (!outcome.ok) {
      ctx.toast.show({
        title: "Could not start setup",
        description: outcome.message,
        variant: "error",
      })
      return false
    }
    ctx.tabs.open({ server: session.server.id, id: outcome.sessionID }, { focus: true })
    return true
  } catch {
    if (!ctx.signal.aborted)
      ctx.toast.show({
        title: "Could not start setup",
        description: "Try again.",
        variant: "error",
      })
    return false
  }
}

/**
 * The setup notice. For each mounted session it asks that session's own location whether its
 * project has a profile: none (and not dismissed) raises "Set up LAZERS for <CODE>" with Set up
 * and Dismiss; a proposal waiting raises "Profile ready for <CODE>" with Review. Each (project,
 * state) is toasted at most once per window; closing a toast is not a dismissal. It is a
 * notice only: nothing here gates work.
 */
export function setupNotice(ctx: Ctx): void {
  const raised = new Set<string>()
  const check = async (session: NoticeSession) => {
    let status
    try {
      status = await session.server.client
        .rpc(Projects)
        .setupStatus(
          { sessionID: session.id },
          { location: { directory: session.directory }, signal: signal(ctx) },
        )
    } catch {
      return
    }
    if (!status.ok) return
    const mark = `${session.server.id}\n${status.key}\n${status.state}`
    if (raised.has(mark)) return
    if (status.state === "none" && !status.dismissed) {
      raised.add(mark)
      ctx.toast.show({
        title: `Set up LAZERS for ${status.code}`,
        description: "Until then LAZERS uses the commands your Architect writes.",
        persistent: true,
        actions: [
          { label: "Set up", run: () => void startSetupInSession(ctx, session) },
          {
            label: "Dismiss",
            run: () =>
              void session.server.client
                .rpc(Projects)
                .dismissSetup(
                  { key: status.key },
                  { location: { directory: session.directory }, signal: signal(ctx) },
                )
                .catch(() => undefined),
          },
        ],
      })
    } else if (status.state === "pending") {
      raised.add(mark)
      ctx.toast.show({
        title: `Profile ready for ${status.code}`,
        description: "Review and confirm it in Settings.",
        persistent: true,
        actions: [{ label: "Review", run: () => ctx.layout.settings("lazers") }],
      })
    }
  }
  createEffect(() => {
    const current = ctx.sessions.current()
    if (current) void check(current)
  })
}
