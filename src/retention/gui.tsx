import { Plugin, Style, bindPlugin } from "@opencode/plugin/gui"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { RETENTION_PRESET_DAYS, Retention } from "./contract.ts"
import type { RetentionPreviewView, RetentionStatusView } from "./contract.ts"
import { CUSTOM, formatBytes, formatCount, parseDays, plural } from "./format.ts"
import { SettingLabel, settingLabelStyles } from "../settings-label.tsx"

const LONG_MS = 10 * 60_000

/**
 * The Storage section of the LAZERS settings page: how much recorded history there is, a dry-run
 * preview of what retiring it at an age would remove and keep, the retire action behind a
 * confirmation, and an optional automatic retention.
 */
export function setupRetention(ctx: Parameters<Plugin.Setup>[0]) {
  const Ui = ctx.ui
  ctx.add(Style, retentionStyles)
  return bindPlugin(() => {
    const [status, setStatus] = createSignal<RetentionStatusView>()
    const [choice, setChoice] = createSignal("30")
    const [custom, setCustom] = createSignal("")
    const [preview, setPreview] = createSignal<RetentionPreviewView>()
    const [busy, setBusy] = createSignal<"" | "status" | "preview" | "retire">("")
    const [progress, setProgress] = createSignal<{ rows: number; bytes: number; trees: number }>()
    const [result, setResult] = createSignal("")
    const [error, setError] = createSignal("")
    const days = createMemo(() => parseDays(choice(), custom()))
    const rpc = () => ctx.client.rpc(Retention)
    const signal = () => AbortSignal.any([ctx.signal, AbortSignal.timeout(LONG_MS)])

    const refresh = async () => {
      try {
        setStatus(await rpc().status({}, { signal: signal() }))
        setError("")
      } catch {
        if (!ctx.signal.aborted)
          setError("Storage information is unavailable. Reload LAZERS and try again.")
      }
    }
    onMount(() => void refresh())

    const pick = (value: string) => {
      setChoice(value)
      setPreview(undefined)
      setResult("")
    }
    const guarded = async (kind: "preview" | "retire", run: () => Promise<void>) => {
      if (busy()) return
      setBusy(kind)
      setError("")
      try {
        await run()
      } catch (cause) {
        if (!ctx.signal.aborted) setError(`Could not ${kind}: ${String(cause)}`)
      } finally {
        setBusy("")
      }
    }
    const runPreview = () =>
      guarded("preview", async () => {
        const chosen = days()
        if (chosen === undefined) return
        setResult("")
        setPreview(await rpc().preview({ days: chosen }, { signal: signal() }))
      })
    const retire = () =>
      guarded("retire", async () => {
        const shown = preview()
        if (!shown || shown.days !== days()) return
        const trees = shown.worktrees.filter((tree) => tree.action === "remove")
        const confirmed = await ctx.dialogs.confirm({
          title: `Retire ${plural(shown.rows, "record")}${trees.length ? ` and ${plural(trees.length, "worktree")}` : ""}?`,
          description: `This removes recorded detail of finished work older than ${plural(shown.days, "day")}, about ${formatBytes(shown.bytes + shown.worktreeBytes)}. Tasks, results and proofs stay. It cannot be undone.`,
          confirm: "Retire",
          danger: true,
        })
        if (!confirmed) return
        let runID: number | undefined
        const total = { rows: 0, bytes: 0, trees: 0, treeBytes: 0 }
        setProgress({ rows: 0, bytes: 0, trees: 0 })
        for (;;) {
          const slice = await rpc().retire(
            {
              days: shown.days,
              asOf: shown.asOf,
              confirmed: true,
              ...(runID === undefined ? {} : { runID }),
            },
            { signal: signal() },
          )
          runID = slice.runID
          total.rows += slice.rows
          total.bytes += slice.bytes
          total.trees += slice.worktrees.length
          total.treeBytes += slice.worktrees.reduce((sum, tree) => sum + (tree.bytes ?? 0), 0)
          setProgress({ rows: total.rows, bytes: total.bytes, trees: total.trees })
          if (slice.done) break
        }
        setProgress(undefined)
        setPreview(undefined)
        setResult(
          `Retired ${plural(total.rows, "record")} (${formatBytes(total.bytes)})` +
            `${total.trees ? ` and ${plural(total.trees, "worktree")} (${formatBytes(total.treeBytes)})` : ""}.`,
        )
        await refresh()
      })
    const setAuto = async (value: number | null) => {
      try {
        const next = await rpc().setAuto({ days: value }, { signal: signal() })
        setStatus((current) => (current ? { ...current, autoDays: next.autoDays } : current))
        setError("")
      } catch (cause) {
        setError(`Could not save the retention setting: ${String(cause)}`)
      }
    }

    const options = createMemo(() => [
      ...RETENTION_PRESET_DAYS.map((preset) => {
        const known = status()?.presets.find((item) => item.days === preset)
        return {
          value: String(preset),
          label: `${plural(preset, "day")}${known && known.bytes > 0 ? ` · ${formatBytes(known.bytes)}` : ""}`,
        }
      }),
      { value: CUSTOM, label: "Custom…" },
    ])
    const autoOptions = createMemo(() => {
      const current = status()?.autoDays
      const known = RETENTION_PRESET_DAYS.map((preset) => ({
        value: String(preset),
        label: plural(preset, "day"),
      }))
      return current && !RETENTION_PRESET_DAYS.some((preset) => preset === current)
        ? [...known, { value: String(current), label: plural(current, "day") }]
        : known
    })
    const removable = (shown: RetentionPreviewView) =>
      shown.worktrees.filter((tree) => tree.action === "remove")
    const nothing = (shown: RetentionPreviewView) => shown.rows === 0 && !removable(shown).length

    return (
      <Ui.SettingsSection
        title="Storage"
        footer={
          <>
            <Show when={progress()}>
              {(now) => (
                <p class="lazers-settings-hint" role="status" aria-live="polite">
                  Retiring… {plural(now().rows, "record")} so far ({formatBytes(now().bytes)})
                  {now().trees ? `, ${plural(now().trees, "worktree")}` : ""}
                </p>
              )}
            </Show>
            <Show when={result()}>
              <p class="lazers-settings-hint" role="status" aria-live="polite">
                {result()}
                <Show when={(status()?.freeBytes ?? 0) > 0}>
                  {" "}
                  {formatBytes(status()!.freeBytes)} inside the database file is now free for reuse;
                  the file itself shrinks only after a separate full compaction (VACUUM).
                </Show>
              </p>
            </Show>
            <Show when={error()}>
              <p class="lazers-settings-hint" role="alert">
                {error()}
              </p>
            </Show>
            <Show when={preview()}>
              {(shown) => (
                <div class="lazers-retention-preview" aria-label="Retention preview">
                  <Show
                    when={!nothing(shown())}
                    fallback={
                      <p class="lazers-settings-hint">
                        Nothing is older than {plural(shown().days, "day")}. Nothing to retire.
                      </p>
                    }
                  >
                    <h3>
                      Will retire {plural(shown().rows, "record")} · {formatBytes(shown().bytes)}
                    </h3>
                    <dl>
                      <For each={shown().kinds.filter((kind) => kind.rows > 0)}>
                        {(kind) => (
                          <div title={kind.detail}>
                            <dt>{kind.label}</dt>
                            <dd>
                              {formatCount(kind.rows)} · {formatBytes(kind.bytes)}
                            </dd>
                          </div>
                        )}
                      </For>
                      <Show when={removable(shown()).length}>
                        <div title="Clean, merged worktrees of finished plans, removed through OpenCode">
                          <dt>Worktrees</dt>
                          <dd>
                            {formatCount(removable(shown()).length)} ·{" "}
                            {formatBytes(shown().worktreeBytes)}
                          </dd>
                        </div>
                      </Show>
                    </dl>
                  </Show>
                  <h3>Stays</h3>
                  <ul>
                    <For each={shown().protected.filter((item) => item.count > 0)}>
                      {(item) => (
                        <li>
                          {formatCount(item.count)} {item.noun}: {item.reason}
                        </li>
                      )}
                    </For>
                    <For each={shown().worktrees.filter((tree) => tree.action === "keep")}>
                      {(tree) => (
                        <li title={tree.path}>
                          Worktree {tree.path.split("/").pop()}
                          {tree.bytes ? ` (${formatBytes(tree.bytes)})` : ""}: {tree.reason}
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              )}
            </Show>
          </>
        }
      >
        <Ui.SettingsRow
          title={
            <SettingLabel
              name="Recorded history"
              hint={
                status()
                  ? `${formatBytes(status()!.fileBytes)} on disk · ${formatBytes(status()!.freeBytes)} reusable`
                  : "measuring"
              }
            />
          }
        />
        <Ui.SettingsRow
          title={<SettingLabel name="Retire history older than" hint="finished work only" />}
        >
          <div class="lazers-settings-controls">
            <Show when={choice() === CUSTOM}>
              <Ui.TextInput
                label="Days"
                class="lazers-settings-number"
                value={custom()}
                invalid={custom() !== "" && days() === undefined}
                placeholder="days"
                onInput={(text) => {
                  setCustom(text)
                  setPreview(undefined)
                  setResult("")
                }}
              />
            </Show>
            <Ui.Select
              label="Retire history older than"
              value={choice()}
              options={options()}
              disabled={busy() !== ""}
              onChange={pick}
            />
          </div>
        </Ui.SettingsRow>
        <Ui.SettingsRow
          title={
            <SettingLabel
              name="Preview, then retire"
              hint="tasks, results and proofs always stay"
            />
          }
        >
          <div class="lazers-settings-controls">
            <Ui.Button
              size="small"
              icon="magnifying-glass"
              disabled={days() === undefined || busy() !== ""}
              busy={busy() === "preview"}
              onClick={() => void runPreview()}
            >
              Preview
            </Ui.Button>
            <Ui.Button
              size="small"
              variant="danger"
              icon="trash"
              disabled={
                busy() !== "" || !preview() || preview()!.days !== days() || nothing(preview()!)
              }
              busy={busy() === "retire"}
              onClick={() => void retire()}
            >
              Retire
            </Ui.Button>
          </div>
        </Ui.SettingsRow>
        <Ui.SettingsRow
          title={
            <SettingLabel
              name="Retire automatically"
              hint="off by default · only while no worker is running"
            />
          }
        >
          <div class="lazers-settings-controls">
            <Show when={status()?.autoDays}>
              <Ui.Select
                label="Keep history for"
                value={String(status()!.autoDays)}
                options={autoOptions()}
                onChange={(value) => void setAuto(Number(value))}
              />
            </Show>
            <Ui.Switch
              label="Retire automatically"
              hideLabel
              checked={status()?.autoDays != null}
              disabled={!status()}
              onChange={(on) => void setAuto(on ? Math.max(days() ?? 30, 30) : null)}
            />
          </div>
        </Ui.SettingsRow>
      </Ui.SettingsSection>
    )
  })
}

const retentionStyles = `
${settingLabelStyles}
.lazers-retention-preview { margin-top: 8px; font-size: 12.5px; color: var(--text-base); }
.lazers-retention-preview h3 { margin: 12px 0 4px; font-size: 12.5px; font-weight: 500; color: var(--text-strong); }
.lazers-retention-preview h3:first-child { margin-top: 0; }
.lazers-retention-preview dl { margin: 0; border: 1px solid var(--border-weak-base); border-radius: 6px; }
.lazers-retention-preview dl > div { display: flex; justify-content: space-between; gap: 16px; padding: 6px 10px; }
.lazers-retention-preview dl > div + div { border-top: 1px solid var(--border-weak-base); }
.lazers-retention-preview dt { color: var(--text-base); }
.lazers-retention-preview dd { margin: 0; color: var(--text-weak); font-variant-numeric: tabular-nums; white-space: nowrap; }
.lazers-retention-preview ul { margin: 0; padding-left: 18px; color: var(--text-weak); line-height: 1.5; }
.lazers-retention-preview li { overflow-wrap: anywhere; }
`
