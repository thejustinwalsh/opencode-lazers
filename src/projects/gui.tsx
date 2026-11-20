import { Plugin, Style, bindPlugin } from "@opencode/plugin/gui"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { JSX } from "solid-js"
import { Label } from "../details/components.tsx"
import { SettingLabel, settingLabelStyles } from "../settings-label.tsx"
import { Projects } from "./contract.ts"
import type { ProjectScope, ProjectsListing, ProjectsOutcome, ProjectView } from "./contract.ts"
import { VerificationGroup, verificationStyles } from "./profile-gui.tsx"

type Ctx = Parameters<Plugin.Setup>[0]
const REFRESH_MS = 3_000

const scopeKey = (scope: ProjectScope) => (scope.kind === "global" ? "global" : scope.key)

/** A number field that saves as the owner types: a valid number stores it, an empty field clears it. */
function parseField(text: string, whole: boolean): { value: number | null } | { error: string } {
  const trimmed = text.trim()
  if (!trimmed) return { value: null }
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value <= 0 || (whole && !Number.isInteger(value)))
    return { error: whole ? "Enter a whole number of 1 or more." : "Enter a number above 0." }
  return { value }
}

/**
 * The Projects section of the LAZERS settings page: dispatch pause for all projects and for each
 * one, a project's code, and its limit, weight and spend ceiling. Every write is followed by a
 * re-read, so the page shows what is stored.
 */
export function setupProjects(ctx: Ctx) {
  const Ui = ctx.ui
  ctx.add(Style, `${settingLabelStyles}\n${projectsStyles}\n${verificationStyles}`)

  const Section = bindPlugin(() => {
    const [listing, setListing] = createStore<{ value?: ProjectsListing }>({})
    const [unreachable, setUnreachable] = createSignal(false)
    /** A refused write by row key (`global` for the header), shown beside the control. */
    const [refusals, setRefusals] = createSignal<Record<string, string>>({})
    const [drafts, setDrafts] = createSignal<Record<string, string>>({})

    const signal = () => AbortSignal.any([ctx.signal, AbortSignal.timeout(5_000)])
    const refresh = async () => {
      try {
        // Reconciled by key: a project's row keeps its identity, focus and unsent drafts.
        const next = await ctx.client.rpc(Projects).list({}, { signal: signal() })
        setListing("value", reconcile(next, { key: "key", merge: true }))
        setUnreachable(false)
      } catch {
        if (!ctx.signal.aborted) setUnreachable(true)
      }
    }
    onMount(() => {
      void refresh()
      const timer = setInterval(() => void refresh(), REFRESH_MS)
      onCleanup(() => clearInterval(timer))
    })

    const setDraft = (id: string, text: string | undefined) =>
      setDrafts((all) => {
        const { [id]: _removed, ...rest } = all
        return text === undefined ? rest : { ...rest, [id]: text }
      })
    const refuse = (id: string, message: string | undefined) =>
      setRefusals((all) => {
        const { [id]: _removed, ...rest } = all
        return message === undefined ? rest : { ...rest, [id]: message }
      })
    /** Runs a write, shows a refusal beside `id`, and re-reads either way. */
    const write = async (id: string, call: () => Promise<ProjectsOutcome>) => {
      try {
        const outcome = await call()
        refuse(id, outcome.ok ? undefined : outcome.message)
        await refresh()
        return outcome.ok
      } catch {
        refuse(id, "Could not save. Try again.")
        return false
      }
    }
    const setPause = (scope: ProjectScope, paused: boolean, reason = "") =>
      write(scopeKey(scope), () =>
        ctx.client.rpc(Projects).setPause({ scope, paused, reason }, { signal: signal() }),
      )
    const setSetting = (scope: ProjectScope, name: string, value: number | null) =>
      write(scopeKey(scope), () =>
        ctx.client.rpc(Projects).setSetting({ scope, name, value }, { signal: signal() }),
      )

    /** A switch that asks for an optional reason before it pauses. */
    const PauseSwitch = (props: {
      label: string
      paused: boolean
      onPause: (reason: string) => void
      onResume: () => void
    }) => {
      const [asking, setAsking] = createSignal(false)
      const [reason, setReason] = createSignal("")
      const confirm = () => {
        props.onPause(reason().trim())
        setAsking(false)
        setReason("")
      }
      return (
        <div class="lazers-projects-controls">
          <Show when={asking()}>
            <Ui.TextInput
              label={`Reason to ${props.label.toLowerCase()}`}
              class="lazers-projects-reason"
              value={reason()}
              onInput={setReason}
              onSubmit={confirm}
            />
            <Ui.Button size="small" onClick={confirm}>
              Pause
            </Ui.Button>
            <Ui.Button size="small" variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Ui.Button>
          </Show>
          <Ui.Switch
            label={props.label}
            hideLabel
            checked={props.paused || asking()}
            onChange={(on) => {
              if (on) setAsking(true)
              else if (asking()) setAsking(false)
              else props.onResume()
            }}
          />
        </div>
      )
    }

    const Field = (props: {
      scope: ProjectScope
      name: string
      caption: string
      label: string
      value: number | null
      whole: boolean
    }) => {
      const id = () => `${scopeKey(props.scope)}:${props.name}`
      return (
        <label class="lazers-projects-field">
          <span>{props.caption}</span>
          <span class="lazers-projects-number">
            <Ui.TextInput
              label={props.label}
              class="lazers-settings-number"
              value={drafts()[id()] ?? (props.value === null ? "" : String(props.value))}
              onInput={(text) => {
                setDraft(id(), text)
                const parsed = parseField(text, props.whole)
                if ("error" in parsed) return refuse(scopeKey(props.scope), parsed.error)
                void setSetting(props.scope, props.name, parsed.value).then((ok) => {
                  if (ok && parsed.value === null) setDraft(id(), undefined)
                })
              }}
            />
          </span>
        </label>
      )
    }

    const PauseNote = (props: { pause: { reason: string; by: string } }) => (
      <span class="lazers-projects-note">
        {[props.pause.by, props.pause.reason].filter(Boolean).join(" · ")}
      </span>
    )

    const Row = (props: { project: ProjectView }) => {
      const scope = (): ProjectScope => ({ kind: "project", key: props.project.key })
      const codeID = () => `${props.project.key}:code`
      const code = () => drafts()[codeID()] ?? props.project.code
      const saveCode = async () => {
        const next = code().trim()
        if (next === props.project.code) return setDraft(codeID(), undefined)
        await write(props.project.key, () =>
          ctx.client
            .rpc(Projects)
            .setCode({ key: props.project.key, code: next }, { signal: signal() }),
        )
        // A refused code is dropped with the draft: the stored code stays and the refusal shows.
        setDraft(codeID(), undefined)
      }
      return (
        <Ui.SettingsRow
          title={
            <span class="lazers-projects-title">
              <Ui.TextInput
                label={`Code of ${props.project.name}`}
                class="lazers-projects-code"
                value={code()}
                onInput={(text) => setDraft(codeID(), text)}
                onSubmit={() => void saveCode()}
              />
              <span class="lazers-projects-name">{props.project.name}</span>
              <Show when={props.project.pause}>
                <Label tone="warning">Paused</Label>
              </Show>
              <Show when={props.project.architectContact}>
                {(contact) => (
                  <Label tone="neutral" title={contact().reason || undefined}>
                    Architect contact
                  </Label>
                )}
              </Show>
              <Show when={!props.project.loaded}>
                <Label tone="neutral">Not loaded</Label>
              </Show>
            </span>
          }
          description={
            <span class="lazers-projects-detail">
              <For each={props.project.checkouts}>
                {(path) => <span class="lazers-projects-path">{path}</span>}
              </For>
              <Show when={props.project.pause}>{(pause) => <PauseNote pause={pause()} />}</Show>
              <Show when={refusals()[props.project.key]}>
                {(message) => (
                  <span class="lazers-projects-refusal" role="alert">
                    {message()}
                  </span>
                )}
              </Show>
              <span class="lazers-projects-fields">
                <Field
                  scope={scope()}
                  name="limit"
                  caption="Limit"
                  label={`Limit of ${props.project.name}`}
                  value={props.project.settings.limit}
                  whole
                />
                <Field
                  scope={scope()}
                  name="weight"
                  caption="Weight"
                  label={`Weight of ${props.project.name}`}
                  value={props.project.settings.weight}
                  whole={false}
                />
                <Field
                  scope={scope()}
                  name="spendCeilingTokens"
                  caption="Spend ceiling"
                  label={`Spend ceiling of ${props.project.name}`}
                  value={props.project.settings.spendCeilingTokens}
                  whole
                />
              </span>
            </span>
          }
        >
          <PauseSwitch
            label={`Pause ${props.project.name}`}
            paused={props.project.pause !== null}
            onPause={(reason) => void setPause(scope(), true, reason)}
            onResume={() => void setPause(scope(), false)}
          />
        </Ui.SettingsRow>
      )
    }

    return (
      <Ui.SettingsSection
        title="Projects"
        footer={
          <Show when={unreachable()}>
            <p class="lazers-settings-hint" role="alert">
              Projects are unavailable. Reconnecting…
            </p>
          </Show>
        }
      >
        <Ui.SettingsRow
          title={
            <SettingLabel
              name="Pause all"
              hint={
                listing.value?.globalPause
                  ? [listing.value!.globalPause!.by, listing.value!.globalPause!.reason]
                      .filter(Boolean)
                      .join(" · ")
                  : "no new dispatch in any project; running work finishes"
              }
            />
          }
          description={
            <Show when={refusals().global}>
              {(message) => (
                <span class="lazers-projects-refusal" role="alert">
                  {message()}
                </span>
              )}
            </Show>
          }
        >
          <PauseSwitch
            label="Pause all"
            paused={listing.value?.globalPause != null}
            onPause={(reason) => void setPause({ kind: "global" }, true, reason)}
            onResume={() => void setPause({ kind: "global" }, false)}
          />
        </Ui.SettingsRow>
        <For each={listing.value?.projects ?? []}>
          {(project) => (
            <>
              <Row project={project} />
              <VerificationGroup ctx={ctx} project={project} refresh={() => void refresh()} />
            </>
          )}
        </For>
      </Ui.SettingsSection>
    )
  })
  return Section as () => JSX.Element
}

const projectsStyles = `
.lazers-projects-title { display:inline-flex; align-items:center; flex-wrap:wrap; gap:6px 8px; min-width:0; }
.lazers-projects-code { width:64px; font-family:var(--font-family-mono, ui-monospace, monospace); }
.lazers-projects-name { color:var(--text-strong); }
.lazers-projects-detail { display:flex; flex-direction:column; gap:4px; min-width:0; }
.lazers-projects-fields { display:flex; align-items:center; flex-wrap:wrap; gap:6px 14px; margin-top:4px; }
.lazers-projects-number { display:inline-flex; width:96px; min-width:0; }
.lazers-projects-number > * { width:100%; min-width:0; }
.lazers-projects-path { color:var(--text-weak); font-family:var(--font-family-mono, ui-monospace, monospace); font-size:12px; overflow-wrap:anywhere; }
.lazers-projects-note { color:var(--text-weak); font-size:12px; }
.lazers-projects-refusal { color:var(--text-critical-base, var(--icon-critical-base)); font-size:12px; }
.lazers-projects-controls { display:flex; align-items:center; flex-wrap:wrap; justify-content:flex-end; gap:8px 12px; max-width:100%; }
.lazers-projects-field { display:inline-flex; align-items:center; gap:6px; color:var(--text-weak); font-size:12px; }
.lazers-projects-reason { width:200px; max-width:100%; }
`
