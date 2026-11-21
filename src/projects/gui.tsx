import { Plugin, Style, bindPlugin } from "@opencode/plugin/gui"
import { createEffect, createSignal, For, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { JSX } from "solid-js"
import { Label } from "../details/components.tsx"
import { SettingLabel, settingLabelStyles } from "../settings-label.tsx"
import { Projects } from "./contract.ts"
import type { ProjectScope, ProjectsListing, ProjectsOutcome, ProjectView } from "./contract.ts"
import { VerificationGroup, verificationStyles } from "./profile-gui.tsx"
import { globalViewOf, projectViewOf } from "./overview-view.ts"
import { Streams } from "../streams/contract.ts"
import { createStream, rpcStreamsTransport, type StreamsRpc } from "../streams/gui.ts"
import { projectsRefs } from "../streams/sources/projects-ref.ts"
import {
  MODEL_CHOICES,
  SLICER_CHOICES,
  chooseDecisionModel,
  planningSettingsView,
} from "../planning/settings-view.ts"

type Ctx = Parameters<Plugin.Setup>[0]
/** Rows the projects window starts with; it doubles while rows remain after it (3 live). */
const FIRST_WINDOW = 16

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
 * one, a project's code, and its limit, weight and spend ceiling. The rows are two streams over
 * the stored overview (`projects.list`, `projects.global`), so a write shows when it is stored
 * and an idle page reads nothing.
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
    const transport = rpcStreamsTransport(
      () => ctx.client.rpc(Streams) as unknown as StreamsRpc,
      ctx.signal,
    )
    const [window, setWindow] = createSignal(FIRST_WINDOW)
    const list = createStream(transport, projectsRefs.list, () => ({
      filter: {},
      order: "registry",
      window: window(),
    }))
    const global = createStream(transport, projectsRefs.global, () => ({
      filter: {},
      order: "key",
      window: 1,
    }))
    createEffect(() => {
      if (list.loaded() && list.after() !== 0) setWindow((current) => current * 2)
    })
    createEffect(() => {
      setUnreachable(Boolean(list.error() ?? global.error()))
      const head = global.items()[0]
      if (!list.loaded() || !global.loaded() || !head) return
      // Reconciled by key: a project's row keeps its identity, focus and unsent drafts.
      const next: ProjectsListing = {
        projects: list.items().map((row) => projectViewOf(row)),
        ...globalViewOf(head),
      }
      setListing("value", reconcile(next, { key: "key", merge: true }))
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
    /** Runs a write and shows a refusal beside `id`; the stored result arrives on the stream. */
    const write = async (id: string, call: () => Promise<ProjectsOutcome>) => {
      try {
        const outcome = await call()
        refuse(id, outcome.ok ? undefined : outcome.message)
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
    const setSetting = (scope: ProjectScope, name: string, value: boolean | number | null) =>
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

    /** Decision model and slicing. Wide controls sit under the title; the trailing slot holds one select. */
    const PlanningRows = (props: { settings: ProjectsListing["globalSettings"] }) => {
      const view = () =>
        planningSettingsView({
          decisionModel: props.settings.decisionModel,
          decisionSlicer: props.settings.decisionSlicer,
        })
      const [choosingExternal, setChoosingExternal] = createSignal(false)
      const providerID = () => drafts()["planning:provider"] ?? view().external?.providerID ?? ""
      const modelID = () => drafts()["planning:model"] ?? view().external?.modelID ?? ""
      const showExternal = () => choosingExternal() || view().model.value === "external"
      const saveModel = (kind: "local" | "external" | "architect") => {
        const chosen = chooseDecisionModel(kind, { providerID: providerID(), modelID: modelID() })
        if (!chosen.ok) return refuse("planning", chosen.message)
        setChoosingExternal(false)
        void write("planning", () =>
          ctx.client
            .rpc(Projects)
            .setSetting(
              { scope: { kind: "global" }, name: "decisionModel", value: chosen.value },
              { signal: signal() },
            ),
        )
      }
      return (
        <>
          <Ui.SettingsRow
            title={
              <SettingLabel
                name="Decision model"
                hint="sizes each ask, as context for the Architect"
              />
            }
            description={
              <span class="lazers-projects-detail">
                <Show when={showExternal()}>
                  <span class="lazers-projects-fields">
                    <label class="lazers-projects-field">
                      <span>Provider</span>
                      <Ui.TextInput
                        label="Decision model provider"
                        class="lazers-planning-input"
                        value={providerID()}
                        onInput={(text) => setDraft("planning:provider", text)}
                        onSubmit={() => saveModel("external")}
                      />
                    </label>
                    <label class="lazers-projects-field">
                      <span>Model</span>
                      <Ui.TextInput
                        label="Decision model"
                        class="lazers-planning-input"
                        value={modelID()}
                        onInput={(text) => setDraft("planning:model", text)}
                        onSubmit={() => saveModel("external")}
                      />
                    </label>
                    <Ui.Button size="small" onClick={() => saveModel("external")}>
                      Use
                    </Ui.Button>
                  </span>
                  <span class="lazers-projects-note">
                    {view().external?.notice ?? "Sends the ask text to the provider you name."}
                  </span>
                </Show>
                <Show when={refusals().planning}>
                  {(message) => (
                    <span class="lazers-projects-refusal" role="alert">
                      {message()}
                    </span>
                  )}
                </Show>
              </span>
            }
          >
            <Ui.Select
              label="Decision model"
              value={showExternal() ? "external" : view().model.value}
              options={MODEL_CHOICES.map((choice) => ({
                value: choice.value,
                label: choice.label,
              }))}
              onChange={(value) => {
                if (value === "external") {
                  setChoosingExternal(true)
                  if (view().model.value === "external") return
                  return refuse("planning", undefined)
                }
                saveModel(value as "local" | "architect")
              }}
            />
          </Ui.SettingsRow>
          <Ui.SettingsRow
            title={
              <SettingLabel name="Slicing" hint="how a long ask is cut for the decision model" />
            }
          >
            <Ui.Select
              label="Slicing"
              value={view().slicer.value}
              options={SLICER_CHOICES.map((choice) => ({
                value: choice.value,
                label: choice.label,
              }))}
              onChange={(value) =>
                void write("planning", () =>
                  ctx.client
                    .rpc(Projects)
                    .setSetting(
                      { scope: { kind: "global" }, name: "decisionSlicer", value },
                      { signal: signal() },
                    ),
                )
              }
            />
          </Ui.SettingsRow>
        </>
      )
    }

    const PlanningSwitch = (props: { project: ProjectView }) => (
      <Ui.SettingsRow
        title={
          <SettingLabel
            child
            name="Planning agents run automatically"
            hint={`in ${props.project.name}`}
          />
        }
      >
        <Ui.Switch
          label={`Planning agents run automatically in ${props.project.name}`}
          hideLabel
          checked={props.project.settings.planningAutoDispatch}
          onChange={(on) =>
            void setSetting({ kind: "project", key: props.project.key }, "planningAutoDispatch", on)
          }
        />
      </Ui.SettingsRow>
    )

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
        <Show when={listing.value}>
          {(current) => <PlanningRows settings={current().globalSettings} />}
        </Show>
        <For each={listing.value?.projects ?? []}>
          {(project) => (
            <>
              <Row project={project} />
              <VerificationGroup ctx={ctx} project={project} transport={transport} />
              <PlanningSwitch project={project} />
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
.lazers-planning-input { width:140px; min-width:0; }
.lazers-projects-number { display:inline-flex; width:96px; min-width:0; }
.lazers-projects-number > * { width:100%; min-width:0; }
.lazers-projects-path { color:var(--text-weak); font-family:var(--font-family-mono, ui-monospace, monospace); font-size:12px; overflow-wrap:anywhere; }
.lazers-projects-note { color:var(--text-weak); font-size:12px; }
.lazers-projects-refusal { color:var(--text-critical-base, var(--icon-critical-base)); font-size:12px; }
.lazers-projects-controls { display:flex; align-items:center; flex-wrap:wrap; justify-content:flex-end; gap:8px 12px; max-width:100%; }
.lazers-projects-field { display:inline-flex; align-items:center; gap:6px; color:var(--text-weak); font-size:12px; }
.lazers-projects-reason { width:200px; max-width:100%; }
`
