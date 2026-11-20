import { Plugin } from "@opencode/plugin/gui"
import { createEffect, createSignal, For, onMount, Show } from "solid-js"
import type { JSX } from "solid-js"
import { Label } from "../details/components.tsx"
import { Projects } from "./contract.ts"
import type { ProfileRevisionView, ProfileView, ProjectView } from "./contract.ts"
import type { ProjectProfile } from "./profile.ts"

type Ctx = Parameters<Plugin.Setup>[0]
type Proof = ProfileRevisionView["proofs"][number]
type Change = NonNullable<ProfileView["pending"]>["changes"][number]

/** What the editor opens with when a project has no profile: a shape to fill in, not a default. */
const TEMPLATE = {
  toolchains: [],
  verify: [{ id: "check", command: "" }],
  fix: [],
  env: [],
  audit: "fallow",
  source: { include: [], exclude: [] },
}

const asProfile = (value: unknown) => value as ProjectProfile
const kindLabel = { added: "Added", removed: "Removed", changed: "Changed" } as const
const lastLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop()

function proofLabel(proof: Proof | undefined): {
  tone: "success" | "critical" | "neutral"
  text: string
} {
  if (proof?.outcome === "proven") return { tone: "success", text: "Proven" }
  if (proof?.outcome === "failed") return { tone: "critical", text: "Failed" }
  return { tone: "neutral", text: "Not run" }
}

/** A failed proof's exit code and the last line it printed, so the owner sees why. */
function failureNote(proof: Proof | undefined): string | undefined {
  if (proof?.outcome !== "failed") return undefined
  return [
    proof.exitCode === null ? undefined : `exit ${proof.exitCode}`,
    lastLine(proof.stderrTail) ?? lastLine(proof.stdoutTail) ?? proof.reason,
  ]
    .filter(Boolean)
    .join(": ")
}

/** The commands the runtime would run unattended, and those it will not because they are unproven. */
function unattended(revision: ProfileRevisionView) {
  const profile = asProfile(revision.profile)
  const proofOf = (key: string) => revision.proofs.find((proof) => proof.key === key)
  const entries = [
    ...(profile.install === undefined
      ? []
      : [{ text: `install: ${profile.install}`, proof: proofOf("install:0") }]),
    ...profile.fix.map((entry, index) => ({
      text: `fix: ${entry.command}`,
      proof: proofOf(`fix:${index}`),
    })),
  ]
  return {
    runs: entries.filter((entry) => entry.proof?.outcome === "proven").map((entry) => entry.text),
    held: entries.filter((entry) => entry.proof?.outcome !== "proven").map((entry) => entry.text),
  }
}

/**
 * The Verification group of one project in Settings: the active profile with each command's
 * proof, a pending revision with what changed, and an editor for the same JSON the Architect
 * proposes and the store keeps (one document, one schema). Confirmation is the owner's alone.
 */
export function VerificationGroup(props: {
  ctx: Ctx
  project: ProjectView
  refresh: () => void
}): JSX.Element {
  const { ctx } = props
  const Ui = ctx.ui
  const rpc = () => ctx.client.rpc(Projects)
  const [view, setView] = createSignal<ProfileView | undefined>()
  const [editing, setEditing] = createSignal(false)
  const [text, setText] = createSignal("")
  const [reason, setReason] = createSignal("")
  const [problem, setProblem] = createSignal<string | undefined>()
  const [busy, setBusy] = createSignal(false)

  const load = async () => {
    try {
      setView(
        await rpc().profile(
          { key: props.project.key },
          { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(5_000)]) },
        ),
      )
    } catch {
      // The next list refresh retries.
    }
  }
  onMount(() => void load())
  createEffect(() => {
    JSON.stringify(props.project.profile)
    void load()
  })

  const seed = () => {
    const current = view()
    const source = current?.pending?.profile ?? current?.active?.profile ?? TEMPLATE
    return JSON.stringify(source, null, 2)
  }
  const openEditor = () => {
    setText(seed())
    setReason("")
    setProblem(undefined)
    setEditing(true)
  }
  const save = async () => {
    let profile: unknown
    try {
      profile = JSON.parse(text())
    } catch (error) {
      setProblem(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const why = reason().trim()
    if (!why) {
      setProblem("Say why the profile changes.")
      return
    }
    setBusy(true)
    setProblem(undefined)
    // A proof runs every command once and can take minutes: no 5 s timeout, only the plugin's signal.
    const toast = ctx.toast.show({
      title: "Proving the profile",
      description: "Running each command once in a separate worktree.",
      variant: "loading",
      persistent: true,
    })
    try {
      const outcome = await rpc().proposeProfile(
        { key: props.project.key, profile, reason: why },
        { signal: ctx.signal },
      )
      if (!outcome.ok) setProblem(outcome.message)
      else setEditing(false)
    } catch {
      setProblem("Could not prove the profile. Try again.")
    } finally {
      toast.dismiss()
      setBusy(false)
      await load()
      props.refresh()
    }
  }
  const decide = async (method: "confirmProfile" | "discardProfile", revision: number) => {
    try {
      const outcome = await rpc()[method](
        { key: props.project.key, revision },
        { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(5_000)]) },
      )
      setProblem(outcome.ok ? undefined : outcome.message)
    } catch {
      setProblem("Could not save. Try again.")
    }
    await load()
    props.refresh()
  }
  const confirm = async (revision: ProfileRevisionView) => {
    const { runs, held } = unattended(revision)
    const description = [
      runs.length ? `Runs unattended:\n${runs.join("\n")}` : "Nothing runs unattended.",
      held.length ? `Will not run unattended (unproven):\n${held.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n")
    const ok = await ctx.dialogs.confirm({
      title: `Confirm profile revision ${revision.revision}?`,
      description,
      confirm: "Confirm",
    })
    if (ok) await decide("confirmProfile", revision.revision)
  }

  const Cmd = (cmd: { command: string; proof?: Proof | undefined }) => {
    const label = proofLabel(cmd.proof)
    return (
      <div class="lazers-verification-command">
        <code>{cmd.command}</code>
        <Label tone={label.tone}>{label.text}</Label>
        <Show when={failureNote(cmd.proof)}>
          {(note) => <span class="lazers-projects-refusal">{note()}</span>}
        </Show>
      </div>
    )
  }
  const Revision = (rev: { revision: ProfileRevisionView }) => {
    const profile = () => asProfile(rev.revision.profile)
    const proofOf = (key: string) => rev.revision.proofs.find((proof) => proof.key === key)
    return (
      <div class="lazers-verification-body">
        <div>Toolchains: {profile().toolchains.join(", ") || "none"}</div>
        <For each={profile().verify}>
          {(entry) => (
            <div>
              <span class="lazers-projects-note">verify {entry.id}</span>
              <Cmd command={entry.command} proof={proofOf(`verify:${entry.id}`)} />
            </div>
          )}
        </For>
        <Show when={profile().install}>
          {(install) => (
            <div>
              <span class="lazers-projects-note">install</span>
              <Cmd command={install()} proof={proofOf("install:0")} />
            </div>
          )}
        </Show>
        <For each={profile().fix}>
          {(entry, index) => (
            <div>
              <span class="lazers-projects-note">fix {entry.files?.join(", ")}</span>
              <Cmd command={entry.command} proof={proofOf(`fix:${index()}`)} />
            </div>
          )}
        </For>
        <div>Audit: {profile().audit === "fallow" ? "Fallow" : "Off"}</div>
        <div>Source include: {profile().source.include.join(", ")}</div>
        <div>Source exclude: {profile().source.exclude.join(", ") || "none"}</div>
        <For each={profile().env}>
          {(name) => (
            <div>
              <code>{name}</code>
              <Show when={rev.revision.credentialLikeEnv.includes(name)}>
                <Label tone="warning">Credential</Label>
              </Show>
            </div>
          )}
        </For>
      </div>
    )
  }

  return (
    <>
      <Ui.SettingsRow
        title={<span class="lazers-projects-name">Verification</span>}
        description={
          <span class="lazers-projects-detail">
            <Show when={!view()?.active && !view()?.pending}>
              <span class="lazers-projects-note">No profile</span>
            </Show>
            <Show when={view()?.active}>
              {(active) => (
                <>
                  <span class="lazers-projects-note">
                    Revision {active().revision}, confirmed{" "}
                    {active().decidedAt ? new Date(active().decidedAt!).toLocaleDateString() : ""}
                  </span>
                  <Revision revision={active()} />
                </>
              )}
            </Show>
            <Show when={problem()}>
              {(message) => (
                <span class="lazers-projects-refusal" role="alert">
                  {message()}
                </span>
              )}
            </Show>
          </span>
        }
      >
        <div class="lazers-projects-controls">
          <Show when={!editing()}>
            <Ui.Button size="small" onClick={openEditor}>
              {view()?.active || view()?.pending ? "Edit" : "Set up"}
            </Ui.Button>
          </Show>
        </div>
      </Ui.SettingsRow>
      <Show when={view()?.pending}>
        {(pending) => (
          <Ui.SettingsRow
            title={<span class="lazers-projects-name">Pending revision {pending().revision}</span>}
            description={
              <span class="lazers-projects-detail">
                <For each={pending().changes}>
                  {(change: Change) => (
                    <span class="lazers-verification-change">
                      <Label tone="interactive">{kindLabel[change.kind]}</Label> {change.field}{" "}
                      {change.key}
                      <Show when={change.before !== undefined}>
                        {" "}
                        <code>{change.before}</code>
                      </Show>
                      <Show when={change.before !== undefined && change.after !== undefined}>
                        {" → "}
                      </Show>
                      <Show when={change.after !== undefined}>
                        {" "}
                        <code>{change.after}</code>
                      </Show>
                    </span>
                  )}
                </For>
                <Show when={pending().mapPreview}>
                  {(map) => (
                    <span class="lazers-projects-note">
                      Map: {map().files} files, {map().names} names, {map().tokens} tokens (now{" "}
                      {map().currentFiles} files, {map().currentTokens} tokens)
                    </span>
                  )}
                </Show>
                <Revision revision={pending()} />
              </span>
            }
          >
            <div class="lazers-projects-controls">
              <Ui.Button size="small" onClick={() => void confirm(pending())}>
                Confirm
              </Ui.Button>
              <Ui.Button
                size="small"
                variant="ghost"
                onClick={() => void decide("discardProfile", pending().revision)}
              >
                Discard
              </Ui.Button>
            </div>
          </Ui.SettingsRow>
        )}
      </Show>
      <Show when={editing()}>
        <Ui.SettingsRow
          title={<span class="lazers-projects-name">Profile JSON</span>}
          description={
            <span class="lazers-projects-detail">
              <textarea
                aria-label="Profile JSON"
                class="lazers-verification-editor"
                rows={18}
                spellcheck={false}
                value={text()}
                onInput={(event) => setText(event.currentTarget.value)}
              />
              <Ui.TextInput label="Reason" value={reason()} onInput={setReason} />
            </span>
          }
        >
          <div class="lazers-projects-controls">
            <Ui.Button size="small" onClick={() => void save()}>
              Save
            </Ui.Button>
            <Ui.Button size="small" variant="ghost" onClick={() => !busy() && setEditing(false)}>
              Cancel
            </Ui.Button>
          </div>
        </Ui.SettingsRow>
      </Show>
    </>
  )
}

export const verificationStyles = `
.lazers-verification-body { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--text-weak); }
.lazers-verification-command { display:flex; align-items:center; flex-wrap:wrap; gap:6px 8px; }
.lazers-verification-command code, .lazers-verification-change code { font-family:var(--font-family-mono, ui-monospace, monospace); color:var(--text-strong); overflow-wrap:anywhere; }
.lazers-verification-change { font-size:12px; color:var(--text-weak); }
.lazers-verification-editor { width:100%; font-family:var(--font-family-mono, ui-monospace, monospace); font-size:12px; }
`
