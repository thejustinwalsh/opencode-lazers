import type { Context, MountedSession } from "@opencode/plugin/gui"
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { panelErrorMessage } from "../panel-error.ts"
import { DelegatedAgentCapacityRPC } from "./delegated-agent-capacity-contract.ts"
import type { DelegatedAgentStatus } from "./delegated-agent-capacity.ts"

type SettingsContext = Pick<Context, "sessions" | "signal" | "ui">
type CapacityScope = {
  client: MountedSession["server"]["client"]
  sessionID: string
  sessionKey: string
  visit: object
  directory: string
  locationDirectory: string
  serverID: string
}

function sameScope(left: CapacityScope | undefined, right: CapacityScope | undefined) {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.sessionKey === right.sessionKey &&
      left.sessionID === right.sessionID &&
      left.visit === right.visit &&
      left.directory === right.directory &&
      left.locationDirectory === right.locationDirectory &&
      left.serverID === right.serverID &&
      left.client === right.client)
  )
}

export function DelegatedAgentCapacitySettings(props: { context: SettingsContext }) {
  const context = props.context
  const [status, setStatus] = createSignal<DelegatedAgentStatus>()
  const [limit, setLimit] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [ready, setReady] = createSignal(false)
  const [error, setError] = createSignal("")
  let activeScope: CapacityScope | undefined
  let scopeRevision = 0

  const currentScope = (): CapacityScope | undefined => {
    const session = context.sessions.current()
    if (!session || session.pending || !session.location || !session.server.connected) return
    return {
      client: session.server.client,
      sessionID: session.id,
      sessionKey: session.key,
      visit: session.visit,
      directory: session.directory,
      locationDirectory: session.location.directory,
      serverID: session.server.id,
    }
  }
  const scopeIsCurrent = (scope: CapacityScope, revision: number) =>
    revision === scopeRevision && activeScope === scope && sameScope(scope, currentScope())
  const requestSignal = () => AbortSignal.any([context.signal, AbortSignal.timeout(5_000)])

  const refresh = async (scope: CapacityScope, revision: number): Promise<boolean> => {
    if (!scopeIsCurrent(scope, revision)) return false
    try {
      const value = await scope.client
        .rpc(DelegatedAgentCapacityRPC)
        .read({ sessionID: scope.sessionID }, { signal: requestSignal() })
      if (!scopeIsCurrent(scope, revision)) return false
      if (status()?.revision !== value.revision) setLimit(String(value.limit))
      setStatus(value)
      setReady(true)
      setError("")
      return true
    } catch (cause) {
      if (scopeIsCurrent(scope, revision) && !context.signal.aborted)
        setError(panelErrorMessage(cause))
      return false
    }
  }

  const save = async () => {
    const current = status()
    const scope = activeScope
    const revision = scopeRevision
    const next = Number(limit())
    if (
      !scope ||
      !current ||
      !scopeIsCurrent(scope, revision) ||
      !Number.isSafeInteger(next) ||
      next < 1
    ) {
      setError("Enter a positive whole-number limit.")
      return
    }
    setSaving(true)
    setError("")
    try {
      const result = await scope.client
        .rpc(DelegatedAgentCapacityRPC)
        .configure(
          { sessionID: scope.sessionID, expectedRevision: current.revision, limit: next },
          { signal: requestSignal() },
        )
      if (!scopeIsCurrent(scope, revision)) return
      const refreshed = await refresh(scope, revision)
      if (result.status === "conflict" && scopeIsCurrent(scope, revision))
        setError(
          refreshed
            ? "The limit changed elsewhere. The latest setting has been reloaded."
            : "The limit changed elsewhere. The latest setting could not be reloaded.",
        )
    } catch (cause) {
      if (scopeIsCurrent(scope, revision) && !context.signal.aborted)
        setError(panelErrorMessage(cause))
    } finally {
      if (scopeIsCurrent(scope, revision)) setSaving(false)
    }
  }

  createEffect(() => {
    const nextScope = currentScope()
    if (sameScope(activeScope, nextScope)) return
    activeScope = nextScope
    const revision = ++scopeRevision
    setStatus(undefined)
    setLimit("")
    setSaving(false)
    setReady(false)
    setError("")
    if (nextScope) void refresh(nextScope, revision)
  })
  onMount(() => {
    const timer = setInterval(() => {
      if (activeScope) void refresh(activeScope, scopeRevision)
    }, 5_000)
    onCleanup(() => clearInterval(timer))
  })

  const Ui = context.ui
  return (
    <section class="lazers-agent-capacity" aria-labelledby="lazers-agent-capacity-title">
      <div class="lazers-settings-head">
        <h2 id="lazers-agent-capacity-title">Delegated-agent capacity</h2>
        <span>{status() ? `${status()!.active} active · ${status()!.queued} waiting` : ""}</span>
      </div>
      <p>
        One project-wide limit for Implementors, Auditors, and native subagents. Architect work is
        excluded. Lowering the limit never interrupts agents already running.
      </p>
      <Show when={status()}>
        {(current) => (
          <p class="lazers-settings-hint">
            <strong>Canonical project:</strong>
            <br />
            <code class="lazers-local-path">{current().projectDirectory}</code>
          </p>
        )}
      </Show>
      <div class="lazers-settings-controls">
        <label for="lazers-agent-capacity-limit">Maximum active agents</label>
        <input
          id="lazers-agent-capacity-limit"
          class="lazers-settings-number"
          type="number"
          min="1"
          step="1"
          value={limit()}
          onInput={(event) => setLimit(event.currentTarget.value)}
          disabled={!status() || !currentScope() || saving()}
        />
        <Ui.Button
          size="small"
          disabled={!status() || !currentScope() || saving()}
          onClick={() => void save()}
        >
          {saving() ? "Saving…" : "Save"}
        </Ui.Button>
      </div>
      <Show when={status()?.reason}>
        <p class="lazers-settings-hint" role="status">
          {status()?.reason}
        </p>
      </Show>
      <Show when={ready() && status() && !status()!.reason}>
        <p class="lazers-settings-hint" role="status">
          {status()!.active > status()!.limit
            ? `The limit is ${status()!.limit}, but ${status()!.active} agents are already active; they will finish without preemption.`
            : "No agents are waiting for capacity."}
        </p>
      </Show>
      <Show when={!currentScope() && !error()}>
        <p class="lazers-settings-hint">
          Open a connected session in this project to view and change the limit.
        </p>
      </Show>
      <Show when={error()}>
        <p class="lazers-settings-hint" role="alert">
          {error()}
        </p>
      </Show>
    </section>
  )
}
