import { Command, LinkHandler, MenuItem, Panel, Style, bindPlugin } from "@opencode/plugin/gui"
import { linkSignal, linkedSession } from "../link-host.ts"
import type { PanelProps, SetupContext } from "@opencode/plugin/gui"
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js"
import { createPlanLinkHandler } from "./links.ts"
import css from "./panel.css?inline"
import { PlanningRpc } from "./rpc-contract.ts"
import { Streams } from "../streams/contract.ts"
import { createStream, rpcStreamsTransport, type StreamsRpc } from "../streams/gui.ts"
import { planningRefs } from "../streams/sources/planning-ref.ts"
import { planningViewOfRow } from "./view-assembly.ts"
import { planningViewModel } from "./view-model.ts"
import type { PlanningView } from "./view-model.ts"

type PlanningContext = SetupContext<{}>

/** Which plan a session's tab shows; a link click sets it, otherwise the latest plan shows. */
const [selected, setSelected] = createSignal<Record<string, string>>({})
const sessionKey = (session: { id: string; server: { id: string } }) =>
  `${session.server.id}\u0000${session.id}`

/**
 * The Plan tab: the session's newest plan (or the one a link selected), read through two streams
 * (`planning.list` at window 1, `planning.detail` at window 1), so a stored change shows when it
 * is written and an idle tab reads nothing.
 */
function PlanPanel(props: PanelProps & { ctx: PlanningContext }) {
  const ctx = props.ctx
  const connection = createMemo(
    () => {
      const session = props.session
      const server = ctx.servers.get(session.server.id)
      if (!server?.connected || !session.location || !session.directory) return undefined
      return { client: server.client, directory: session.directory }
    },
    undefined,
    {
      equals: (previous, next) =>
        previous?.client === next?.client && previous?.directory === next?.directory,
    },
  )
  return (
    <Show
      when={connection()}
      keyed
      fallback={<PlanBody view={undefined} error="The session is offline." />}
    >
      {(value) => {
        const abort = new AbortController()
        onCleanup(() => abort.abort())
        const transport = rpcStreamsTransport(
          () => value.client.rpc(Streams) as unknown as StreamsRpc,
          abort.signal,
          { location: { directory: value.directory } },
        )
        const plans = createStream(transport, planningRefs.list, () => ({
          filter: { sessionID: props.session.id },
          order: "newest",
          window: 1,
        }))
        const planningID = createMemo(
          () => selected()[sessionKey(props.session)] ?? plans.items()[0]?.id,
        )
        const [view, setView] = createSignal<PlanningView | null | undefined>(undefined)
        const [detailError, setDetailError] = createSignal("")
        createEffect(() => {
          if (!plans.loaded()) return
          if (!planningID()) setView(null)
        })
        return (
          <>
            <Show when={planningID()} keyed>
              {(id) => {
                const detail = createStream(transport, planningRefs.detail, () => ({
                  filter: { planningID: id },
                  order: "key",
                  window: 1,
                }))
                createEffect(() => {
                  setDetailError(detail.error()?.message ?? "")
                  if (!detail.loaded()) return
                  const row = detail.items()[0]
                  setView(row ? planningViewOfRow(row) : null)
                })
                return null
              }}
            </Show>
            <PlanBody view={view()} error={plans.error()?.message ?? detailError()} />
          </>
        )
      }}
    </Show>
  )
}

function PlanBody(props: { view: PlanningView | null | undefined; error: string }) {
  const view = () => props.view
  const error = () => props.error
  return (
    <div class="lz-plan" data-component="lz-plan">
      <Switch>
        <Match when={view()}>
          {(current) => (
            <>
              <div class="lz-plan-head">
                <span class="lz-plan-title">{current().title}</span>
                <span class="lz-plan-chip">{current().state}</span>
                <span class="lz-plan-chip">r{current().revision}</span>
              </div>
              <For each={planningViewModel(current())}>
                {(section) => (
                  <div class="lz-plan-section">
                    <h3>{section.title}</h3>
                    <For each={section.rows}>
                      {(row) => (
                        <div class="lz-plan-row" data-tone={row.tone}>
                          {row.text}
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </>
          )}
        </Match>
        <Match when={view() === null}>
          <div class="lz-plan-empty">
            No plan in this session yet. The Architect stores one when an ask needs it.
          </div>
        </Match>
      </Switch>
      <Show when={error()}>
        <div class="lz-plan-row" data-tone="warn">
          {error()}
        </div>
      </Show>
    </div>
  )
}

export function setupPlanningPanel(ctx: PlanningContext) {
  const Ui = ctx.ui
  ctx.add(
    LinkHandler,
    createPlanLinkHandler({
      session: (source) =>
        ctx.sessions
          .list()
          .find((session) => session.id === source.id && session.server.id === source.server.id),
      async project(session, signal) {
        const server = ctx.servers.get(session.server.id)
        if (!server?.connected || !session.location) throw new Error("Plan link session is offline")
        const location = await server.client.location.get(
          { location: session.location },
          { signal },
        )
        return location.project
      },
      async get(session, planningID, signal) {
        const server = ctx.servers.get(session.server.id)
        if (!server?.connected || !session.location) throw new Error("Plan link session is offline")
        return server.client
          .rpc(PlanningRpc)
          .resolve({ planningID }, { location: session.location, signal })
      },
      signal: () => linkSignal(ctx),
      open(target) {
        const session = linkedSession(ctx, target)
        if (!session) return
        setSelected((all) => ({ ...all, [sessionKey(session)]: target.planningID }))
        ctx.layout.open(`${ctx.id}:plan`, session, { tab: "select" })
      },
    }),
  )
  const tab = {
    id: "plan",
    title: "Plan",
    closable: "hover" as const,
    label: () => (
      <div class="flex items-center gap-1.5">
        <Ui.Icon name="task" size="small" />
        <span>Plan</span>
      </div>
    ),
  }
  const open = () => {
    const session = ctx.sessions.current()
    if (session?.location) ctx.layout.open(`${ctx.id}:plan`, session, { tab: "select" })
  }
  ctx.add(Style, css)
  ctx.add(Panel, {
    id: "plan",
    region: "side",
    list: (input) => (input.open.includes(tab.id) ? [tab] : []),
    render: bindPlugin((props: PanelProps) => <PlanPanel {...props} ctx={ctx} />),
  })
  ctx.add(Command, {
    id: "plan.open",
    title: "Open LAZERS plan",
    section: "session",
    slash: { name: "lz-plan" },
    run: open,
  })
  ctx.add(MenuItem, {
    id: "plan.open",
    menu: "session.panel",
    title: "Plan",
    icon: "task",
    order: 80,
    run: open,
  })
}
