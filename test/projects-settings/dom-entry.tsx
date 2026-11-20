import { createComponent, createRoot } from "solid-js"
import type { JSX } from "solid-js"
import { render } from "solid-js/web"
import { PluginContext } from "../../node_modules/@opencode/plugin/dist/gui/internal.js"
import { setupProjects } from "../../src/projects/gui.tsx"
import type {
  ProfileOutcomeView,
  ProfileView,
  ProjectScope,
  ProjectsListing,
  ProjectsOutcome,
  ProjectView,
} from "../../src/projects/contract.ts"

type Call = { method: string; input: Record<string, unknown> }
const CODE = /^[A-Z]{2,4}\d*$/

/** An in-memory stand-in for `lz.projects`: same inputs and outputs, no database. */
export function harness(
  root: HTMLElement,
  seed: ProjectView[],
  options: {
    reachable?: boolean
    /** Profile views by project key; anything else reads as no profile. */
    profiles?: Record<string, ProfileView>
    /** What `saveProfile` answers. */
    save?: ProfileOutcomeView
    /** Sessions of open tabs, for starting setup from Settings. */
    sessions?: { id: string; directory: string }[]
  } = {},
) {
  const tabs: { id: string; focus?: boolean }[] = []
  const confirms: { title: string; description?: string }[] = []
  const toasts: { title: string; open: boolean }[] = []
  const projects = structuredClone(seed)
  let globalPause: ProjectsListing["globalPause"] = null
  let reachable = options.reachable ?? true
  const calls: Call[] = []
  const settings = { globalSlots: null, agingMs: 600_000, historyCacheMB: 128 }
  const ok: ProjectsOutcome = { ok: true }
  const find = (scope: ProjectScope) =>
    scope.kind === "project" ? projects.find((p) => p.key === scope.key) : undefined
  const methods = {
    profile: (input: { key: string }): ProfileView =>
      structuredClone(
        options.profiles?.[input.key] ?? { key: input.key, history: [], setupDismissedAt: null },
      ),
    saveProfile: (_input: Record<string, unknown>): ProfileOutcomeView =>
      options.save ?? {
        ok: false,
        refusal: "PROFILE_INVALID",
        message: "verify: A profile needs at least one verify command",
      },
    startSetup: () => ({ ok: true as const, sessionID: "setup-1" }),
    list: (): ProjectsListing => ({
      projects: structuredClone(projects),
      globalPause,
      globalSettings: settings,
    }),
    setCode: (input: { key: string; code: string }): ProjectsOutcome => {
      if (!CODE.test(input.code))
        return {
          ok: false,
          refusal: "PROJECT_CODE_INVALID",
          message: "Use 2 to 4 capital letters.",
        }
      if (projects.some((p) => p.code === input.code && p.key !== input.key))
        return {
          ok: false,
          refusal: "PROJECT_CODE_TAKEN",
          message: "Another project already uses that code.",
        }
      find({ kind: "project", key: input.key })!.code = input.code
      return ok
    },
    setPause: (input: {
      scope: ProjectScope
      paused: boolean
      reason?: string
    }): ProjectsOutcome => {
      const pause = input.paused ? { reason: input.reason ?? "", by: "owner", at: 1 } : null
      if (input.scope.kind === "global") globalPause = pause
      else find(input.scope)!.pause = pause
      return ok
    },
    setSetting: (input: {
      scope: ProjectScope
      name: string
      value: number | null
    }): ProjectsOutcome => {
      const project = find(input.scope)!
      const defaults: Record<string, number | null> = {
        limit: null,
        weight: 1,
        spendCeilingTokens: 5000,
      }
      ;(project.settings as Record<string, number | null>)[input.name] =
        input.value ?? defaults[input.name] ?? null
      return ok
    },
  }
  const ctx = {
    id: "lazers",
    signal: new AbortController().signal,
    client: {
      rpc: () =>
        new Proxy(
          {},
          {
            get: (_, method: string) => async (input: Record<string, unknown>) => {
              if (!reachable) throw new Error("offline")
              calls.push({ method, input })
              return (methods as Record<string, (i: never) => unknown>)[method]!(input as never)
            },
          },
        ),
    },
    ui: {
      SettingsSection: (props: { title?: string; children: JSX.Element; footer?: JSX.Element }) => (
        <section aria-label={props.title}>
          <h2>{props.title}</h2>
          {props.children}
          {props.footer}
        </section>
      ),
      SettingsRow: (props: {
        title: JSX.Element
        description?: JSX.Element
        children?: JSX.Element
      }) => (
        <div class="fixture-row">
          <div class="fixture-title">{props.title}</div>
          <div class="fixture-description">{props.description}</div>
          {props.children}
        </div>
      ),
      TextInput: (props: {
        label: string
        value: string
        onInput(value: string): void
        onSubmit?(value: string): void
      }) => (
        <input
          aria-label={props.label}
          value={props.value}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") props.onSubmit?.(e.currentTarget.value)
          }}
        />
      ),
      Switch: (props: { label: string; checked: boolean; onChange(value: boolean): void }) => (
        <input
          aria-label={props.label}
          type="checkbox"
          role="switch"
          checked={props.checked}
          onChange={(e) => props.onChange(e.currentTarget.checked)}
        />
      ),
      Button: (props: { children: JSX.Element; onClick?(): void }) => (
        <button type="button" onClick={() => props.onClick?.()}>
          {props.children}
        </button>
      ),
    },
    sessions: {
      list: () =>
        (options.sessions ?? []).map((session) => ({
          id: session.id,
          server: { id: "srv", client: { rpc: () => ctx.client.rpc() } },
          location: { directory: session.directory },
        })),
    },
    tabs: {
      open: (session: { id: string }, opts?: { focus?: boolean }) =>
        void tabs.push({ id: session.id, ...(opts?.focus ? { focus: true } : {}) }),
    },
    dialogs: {
      confirm: async (dialog: { title: string; description?: string }) => {
        confirms.push(dialog)
        return true
      },
    },
    toast: {
      show: (toast: { title: string }) => {
        const record = { title: toast.title, open: true }
        toasts.push(record)
        return {
          dismiss: () => {
            record.open = false
          },
        }
      },
    },
    add: () => {},
  }
  let Section!: () => JSX.Element
  const setupDispose = createRoot((dispose) => {
    createComponent(PluginContext.Provider, {
      value: ctx as never,
      get children() {
        Section = setupProjects(ctx as never)
        return null
      },
    })
    return dispose
  })
  const dispose = render(
    () =>
      createComponent(PluginContext.Provider, {
        value: ctx as never,
        get children() {
          return <Section />
        },
      }),
    root,
  )
  return {
    calls,
    confirms,
    toasts,
    tabs,
    setReachable: (value: boolean) => {
      reachable = value
    },
    dispose() {
      dispose()
      setupDispose()
    },
  }
}
