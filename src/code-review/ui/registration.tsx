import { Command, LinkHandler, MenuItem, Panel, Style, bindPlugin } from "@opencode/plugin/gui"
import type { PanelProps, SessionRef } from "@opencode/plugin/gui"
import { linkSignal } from "../../link-host.ts"
import { resolvePanelProject } from "../../panel-project.ts"
import { Streams } from "../../streams/contract.ts"
import { readWindow, rpcStreamsTransport } from "../../streams/gui.ts"
import type { StreamsRpc } from "../../streams/gui.ts"
import { taskDetailRef } from "../../streams/sources/tasks-ref.ts"
import { resolveLinkProject } from "../../tasks/links.ts"
import { ownsReviewLink, parseReviewLink } from "./model/anchor.ts"
import { lazy } from "solid-js"
import type { ReviewContext, ReviewOpeners } from "./panel.tsx"
import { navigate, initialReviewView } from "./state.ts"
import type { ReviewOpenRequest } from "./state.ts"
import css from "./panel.css?inline"

/** Opens Review on a task in a session, at a comparison, file and lines when given. */
export type ReviewOpener = (session: SessionRef, open: ReviewOpenRequest) => void

export const REVIEW_PANEL_ID = "review"

/**
 * The renderer (Pierre, Shiki) loads with the panel's first render, in the window: its modules
 * read browser globals as they load, and the plugin's other processes never render a panel.
 */
const ReviewPanel = lazy(() =>
  import("./panel.tsx").then((module) => ({ default: module.ReviewPanel })),
)

/**
 * The task-specific semantic review. The host's own panel is "Review" (session diff), so this one
 * is "Semantic review" in the strip and the panel menu.
 */
export function setupReviewPanel(ctx: ReviewContext, openers: ReviewOpeners): ReviewOpener {
  const Ui = ctx.ui
  const key = `${ctx.id}:${REVIEW_PANEL_ID}`
  const openReview: ReviewOpener = (session, open) => {
    ctx.stores.reviewView(session).update((draft) => {
      draft.projects[open.projectDirectory] = navigate(
        draft.projects[open.projectDirectory] ?? initialReviewView,
        open,
      )
    })
    ctx.layout.open(key, session, { tab: "select" })
  }
  const tab = {
    id: REVIEW_PANEL_ID,
    title: "Semantic review",
    closable: "hover" as const,
    label: () => (
      <div class="flex min-w-0 items-center gap-1.5">
        <Ui.Icon name="review" size="small" class="shrink-0" />
        <span class="truncate">Semantic review</span>
      </div>
    ),
  }
  const open = () => {
    const session = ctx.sessions.current()
    if (session?.location) ctx.layout.open(key, session, { tab: "select" })
  }
  ctx.add(Style, css)
  ctx.add(Panel, {
    id: REVIEW_PANEL_ID,
    region: "side",
    list: (input) => (input.open.includes(tab.id) ? [tab] : []),
    render: bindPlugin((props: PanelProps) => (
      <ReviewPanel {...props} ctx={ctx} openers={openers} />
    )),
  })
  ctx.add(Command, {
    id: "review.open",
    title: "Open LAZERS semantic review",
    section: "session",
    slash: { name: "lz-review" },
    run: open,
  })
  // After Tasks (40) and Trajectory (50); see the ordering note in tasks/panel.tsx.
  ctx.add(MenuItem, {
    id: "review.open",
    menu: "session.panel",
    title: "Semantic review",
    icon: "review",
    order: 45,
    run: open,
  })
  // Review links from Architect replies and composer chips reopen the exact task, comparison,
  // file and lines.
  ctx.add(LinkHandler, {
    priority: 100,
    match: (link) => ownsReviewLink(link.href),
    open: (link) => {
      const target = parseReviewLink(link.href)
      const source = link.session
      if (!target || !source) return
      const signal = linkSignal(ctx)
      const services = {
        session: (ref: SessionRef) =>
          ctx.sessions
            .list()
            .find((session) => session.id === ref.id && session.server.id === ref.server.id),
        signal: () => signal,
        async project(session: SessionRef, abort: AbortSignal) {
          const server = ctx.servers.get(session.server.id)
          if (!server?.connected || !session.location)
            throw new Error("Review link session is offline")
          const project = await resolvePanelProject(
            server.client,
            session.location.directory,
            abort,
            session.id,
          )
          return { canonical: project.project, id: project.projectID }
        },
      }
      void (async () => {
        const found = await resolveLinkProject(services, source, target.projectID).catch(
          () => undefined,
        )
        if (!found) return
        const server = ctx.servers.get(found.session.server.id)
        if (!server) return
        const [row] = await readWindow(
          rpcStreamsTransport(() => server.client.rpc(Streams) as unknown as StreamsRpc, signal, {
            location: { directory: found.project.canonical },
          }),
          taskDetailRef,
          {
            filter: {
              scope: { kind: "project", sessionID: found.session.id },
              reference: target.reference,
            },
            order: "task",
            window: 1,
          },
        ).catch(() => [])
        if (!row || typeof row.task_id !== "string") return
        openReview(found.session, {
          projectDirectory: found.project.canonical,
          taskID: row.task_id,
          reference: target.reference,
          request: target.request,
          ...(target.path ? { path: target.path } : {}),
          ...(target.side ? { side: target.side } : {}),
          ...(target.startLine ? { startLine: target.startLine } : {}),
          ...(target.endLine ? { endLine: target.endLine } : {}),
          ...(target.comparisonID ? { comparisonID: target.comparisonID } : {}),
        })
      })()
    },
  })
  return openReview
}
