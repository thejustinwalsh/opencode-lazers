import { Plugin, SettingsPage, Store, Style, bindPlugin } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { ModelFiles } from "./webgpu/ipc.ts"
import { setupMain } from "./webgpu/main.ts"
import { setupNativeInteractionMain } from "./verification/opencode/native-interaction-main.ts"
import { createInferenceRuntime } from "./webgpu/runtime.ts"
import { runtimeStatusLine } from "./webgpu/runtime-status.ts"
import { SettingLabel } from "./settings-label.tsx"
import { LocalModel } from "./webgpu/contract.ts"
import {
  DECISION_BYTES,
  DECISION_REVISION,
  MODEL_BYTES,
  MODEL_REVISION,
  LFM3_TOKENIZER_REVISION,
  RUNNTIME_REVISION,
} from "./webgpu/manifest.ts"
import type { Decision } from "./webgpu/decisions.ts"
import { DECISION_CONTEXT_MAX_LENGTH } from "./webgpu/decisions.ts"
import { panelErrorMessage } from "./panel-error.ts"
import { panelStatusStyles } from "./panel-status.tsx"
import { detailsPaneStyles } from "./details-pane.css.ts"
import { detailsKitStyles } from "./details/styles.ts"
import { registerDictation } from "./webgpu/dictation.tsx"
import { audioFilePCM16 } from "./webgpu/audio.ts"
import { DEFAULT_VOICE, VOICES, voiceKeys } from "./webgpu/speech.ts"
import { registerReadAloud } from "./webgpu/read-aloud.tsx"
import { setupTaskPanel, taskStores } from "./tasks/panel.tsx"
import type { TaskTrajectoryOpener } from "./tasks/panel.tsx"
import { setupModelsPanel, modelsStores } from "./models/comparison-panel.tsx"
import { setupTrajectoryPanel, trajectoryStores } from "./trajectory-panel/panel.tsx"
import { setupRadarPanel, radarStores } from "./radar/panel.tsx"
import { GENERATION_RESULT_CONTRACT_REVISION, LocalInference } from "./webgpu/rpc.ts"
import { defaultFeatures, featureEnabled, usesGPU } from "./webgpu/features.ts"
import type { Features, LocalFeature } from "./webgpu/features.ts"
import { setupRadarLayoutMain } from "./radar/layout-main.ts"

import { inferenceIndicatorStyles, registerInferenceIndicator } from "./webgpu/indicator.tsx"
import { nativeBusyStyles } from "./native-busy-styles.ts"
import { budgetStores, setupBudget } from "./budget/gui.tsx"
import { setupRetention } from "./retention/gui.tsx"

const NEVER_UNLOAD_MS = -1
/** "Never" only for -1; any other persisted value is shown exactly. */
const keepAliveLabel = (ms: number | undefined) => {
  if (ms === undefined || ms === NEVER_UNLOAD_MS) return "Never"
  if (ms % 60_000 === 0) return ms === 60_000 ? "1 minute" : `${ms / 60_000} minutes`
  return ms % 1_000 === 0 ? `${ms / 1_000} seconds` : `${ms} ms`
}

const formatBytes = (bytes: number) => `${(bytes / 1_000_000_000).toFixed(2)} GB`

export default Plugin.define({
  stores: {
    ...budgetStores,
    ...taskStores,
    ...modelsStores,
    ...trajectoryStores,
    ...radarStores,
    runtime: Store.global(
      Schema.Struct({
        keepAliveMs: Schema.Number.check(
          Schema.isInt(),
          Schema.isBetween({ minimum: -1, maximum: 86_400_000 }),
        ),
      }),
      { keepAliveMs: NEVER_UNLOAD_MS },
    ),
    voice: Store.global(Schema.Struct({ selected: Schema.Literals(voiceKeys) }), {
      selected: DEFAULT_VOICE,
    }),
  },
  async main(ctx) {
    const cleanupInference = await setupMain(ctx)
    let cleanupRadarLayout: Awaited<ReturnType<typeof setupRadarLayoutMain>> | undefined
    try {
      cleanupRadarLayout = setupRadarLayoutMain(ctx)
      const cleanupNativeInteraction = setupNativeInteractionMain(ctx)
      return async () => {
        try {
          cleanupNativeInteraction?.()
        } finally {
          try {
            await cleanupRadarLayout?.()
          } finally {
            if (cleanupInference) await cleanupInference()
          }
        }
      }
    } catch (error) {
      try {
        await cleanupRadarLayout?.()
      } finally {
        if (cleanupInference) await cleanupInference()
      }
      throw error
    }
  },
  setup(ctx) {
    const pageID = "lazers"
    const BudgetSection = setupBudget(ctx, ctx.stores.budget, pageID)
    const RetentionSection = setupRetention(ctx)
    ctx.add(Style, nativeBusyStyles)
    ctx.add(Style, panelStatusStyles)
    ctx.add(Style, detailsPaneStyles)
    ctx.add(Style, detailsKitStyles)
    const openTaskTrajectory: TaskTrajectoryOpener = (session, request) => {
      const target = { ...request, requestID: crypto.randomUUID() }
      ctx.stores.trajectoryView(session).update((draft) => {
        const previous = draft.projects[request.projectDirectory] ?? {
          scope: "session" as const,
          selectedTaskID: null,
          selectedKind: "" as const,
          selectedRecordID: "",
        }
        draft.projects[request.projectDirectory] = {
          ...previous,
          scope: "project",
          selectedTaskID: target.taskID,
          selectedReference: target.reference,
          target,
          selectedKind: "",
          selectedRecordID: "",
        }
      })
      ctx.layout.open(`${ctx.id}:trajectory`, session, { tab: "select" })
    }
    const openTask = (
      session: Parameters<TaskTrajectoryOpener>[0],
      target: { projectDirectory: string; taskID: string },
    ) => {
      ctx.stores.taskView(session).update((draft) => {
        const previous = draft.projects[target.projectDirectory] ?? {
          scope: "project" as const,
          selectedID: null,
          search: "",
          listScroll: 0,
          detailScroll: 0,
        }
        draft.projects[target.projectDirectory] = {
          ...previous,
          scope: "project",
          search: "",
          selectedID: target.taskID,
          detailScroll: 0,
          revealTaskID: target.taskID,
        }
      })
      ctx.layout.open(`${ctx.id}:tasks`, session, { tab: "select" })
    }
    setupTaskPanel(ctx, openTaskTrajectory)
    setupModelsPanel(ctx, openTaskTrajectory)
    setupTrajectoryPanel(ctx, { openTask })
    setupRadarPanel(ctx, { openTrajectory: openTaskTrajectory, openTask })
    const Ui = ctx.ui
    const pageLede =
      "Architect, tasks and panels work without local inference. Everything below is optional."
    if (ctx.app.platform !== "desktop") {
      ctx.add(SettingsPage, {
        id: pageID,
        title: "LAZERS",
        icon: "settings-gear",
        render: () => (
          <Ui.SettingsLayout
            title="LAZERS"
            description="Architect, tasks and panels work here. Local inference runs in OpenCode Desktop."
          >
            <BudgetSection />
            <RetentionSection />
          </Ui.SettingsLayout>
        ),
      })
      return
    }
    const [features, setFeatures] = createSignal<Features>(defaultFeatures(false))
    const [settingsReady, setSettingsReady] = createSignal(false)
    const [saving, setSaving] = createSignal(false)
    const [settingsError, setSettingsError] = createSignal("")
    const enabled = (feature: LocalFeature) => featureEnabled(features(), feature)
    let settingsEpoch = 0
    let refreshing = false
    const settingsSignal = () => AbortSignal.any([ctx.signal, AbortSignal.timeout(5_000)])
    const refreshSettings = async () => {
      if (refreshing) return
      refreshing = true
      const epoch = settingsEpoch
      try {
        const value = await ctx.client
          .rpc(LocalInference)
          .settings({}, { signal: settingsSignal() })
        if (epoch !== settingsEpoch) return
        if (JSON.stringify(value) !== JSON.stringify(features())) setFeatures(value)
        setSettingsReady(true)
        setSettingsError("")
      } catch {
        if (!ctx.signal.aborted)
          setSettingsError("Local inference settings are unavailable. Reconnecting…")
      } finally {
        refreshing = false
      }
    }
    const configure = async (key: keyof Features, value: boolean) => {
      settingsEpoch++
      setSaving(true)
      try {
        const next = await ctx.client
          .rpc(LocalInference)
          .configure({ [key]: value }, { signal: settingsSignal() })
        setFeatures(next)
        setSettingsError("")
      } catch (cause) {
        setSettingsError(`Could not save settings: ${String(cause)}`)
      } finally {
        setSaving(false)
      }
    }
    void refreshSettings()
    const settingsTimer = setInterval(() => {
      void refreshSettings()
    }, 1_000)
    onCleanup(() => clearInterval(settingsTimer))
    const runtime = createInferenceRuntime(
      ctx,
      () => ctx.stores.runtime.value?.keepAliveMs,
      () => ctx.stores.voice.value?.selected ?? DEFAULT_VOICE,
      features,
    )
    registerDictation(ctx, runtime)
    registerReadAloud(ctx, runtime)
    ctx.provide(LocalModel, runtime)
    const files = ctx.main(ModelFiles)
    const Settings = bindPlugin(() => {
      const [cache, setCache] = createSignal<Awaited<ReturnType<typeof files.status>>>()
      const [decisionCache, setDecisionCache] =
        createSignal<Awaited<ReturnType<typeof files.decisionStatus>>>()
      const [action, setAction] = createSignal("")
      const [error, setError] = createSignal("")
      const [prompt, setPrompt] = createSignal("Reply with exactly: local GPU ready.")
      const [reply, setReply] = createSignal("")
      const [decisionKind, setDecisionKind] = createSignal<Decision["kind"]>("boolean")
      const [question, setQuestion] = createSignal("Has the request been approved?")
      const [evidence, setEvidence] = createSignal("The user explicitly approved this request.")
      const [decisionReply, setDecisionReply] = createSignal("")
      const [speech, setSpeech] = createSignal("The local model is ready.")
      const [speechURL, setSpeechURL] = createSignal("")
      const [transcript, setTranscript] = createSignal("")
      const [rendererCapture, setRendererCapture] =
        createSignal<Awaited<ReturnType<typeof files.rendererCaptureStatus>>>()
      const [rendererCaptureBusy, setRendererCaptureBusy] = createSignal(false)
      const [rendererCaptureError, setRendererCaptureError] = createSignal("")
      const cachedBytes = () =>
        (cache()?.phase === "downloading"
          ? (cache()?.downloadedBytes ?? 0)
          : (cache()?.cachedBytes ?? 0)) +
        (decisionCache()?.phase === "downloading"
          ? (decisionCache()?.downloadedBytes ?? 0)
          : (decisionCache()?.cachedBytes ?? 0))
      const downloading = () =>
        cache()?.phase === "downloading" || decisionCache()?.phase === "downloading"
      const cacheLabel = () =>
        downloading()
          ? "Downloading from Hugging Face"
          : cache()?.phase === "verifying" || decisionCache()?.phase === "verifying"
            ? "Verifying cached models"
            : cache()?.phase === "cached" && decisionCache()?.phase === "cached"
              ? "Cached on this device"
              : cachedBytes() > 0
                ? "Some models are cached"
                : "Not downloaded"
      const [previewing, setPreviewing] = createSignal(false)
      let previewAudio: HTMLAudioElement | undefined
      const stopPreview = () => {
        if (!previewAudio) return
        previewAudio.pause()
        URL.revokeObjectURL(previewAudio.src)
        previewAudio = undefined
        setPreviewing(false)
      }
      let test: AbortController | undefined
      const testAborted = () => test?.signal.aborted === true
      createEffect(() => {
        const key = (
          {
            test: "questions",
            decision: "decisions",
            speak: "readAloud",
            preview: "readAloud",
            transcribe: "dictation",
          } as const
        )[action() as "test" | "decision" | "speak" | "preview" | "transcribe"]
        if (!features().enabled || (key && !enabled(key))) test?.abort()
        if (!enabled("readAloud") && speechURL()) {
          URL.revokeObjectURL(speechURL())
          setSpeechURL("")
        }
        if (!enabled("readAloud")) stopPreview()
      })
      let cacheRefreshing = false
      const refresh = async () => {
        if (cacheRefreshing) return
        cacheRefreshing = true
        try {
          setCache(await files.status({ signal: settingsSignal() }))
          setDecisionCache(await files.decisionStatus({ signal: settingsSignal() }))
          setRendererCapture(await files.rendererCaptureStatus({ signal: settingsSignal() }))
        } catch (cause) {
          setError(String(cause))
        } finally {
          cacheRefreshing = false
        }
      }
      onMount(() => {
        void refresh()
        const timer = setInterval(() => {
          void refresh()
        }, 1_000)
        onCleanup(() => {
          clearInterval(timer)
          test?.abort()
          stopPreview()
          if (speechURL()) URL.revokeObjectURL(speechURL())
        })
      })
      const perform = async (label: string, run: () => Promise<unknown>) => {
        test = undefined
        setAction(label)
        setError("")
        try {
          await run()
        } catch (cause) {
          if (label === "clear" || (features().enabled && !testAborted()))
            setError(panelErrorMessage(cause))
        } finally {
          setAction("")
          await refresh()
        }
      }
      const testModel = () =>
        perform("test", async () => {
          test = new AbortController()
          setReply("")
          const result = await runtime.generate(prompt(), test.signal)
          if (!result.ok) throw new Error(result.error)
          const tokens = [
            result.promptTokens === undefined ? "" : `${result.promptTokens} input tokens`,
            result.completionTokens === undefined ? "" : `${result.completionTokens} output tokens`,
          ].filter(Boolean)
          setReply(tokens.length ? `${result.text}\n\n${tokens.join(" · ")}` : result.text)
        })
      const clear = async () => {
        if (
          !(await ctx.dialogs.confirm({
            title: "Remove downloaded models?",
            description:
              "This unloads the local models and removes LAZERS’ cached weights. Enabled local features will download the models they need again, up to 3.19 GB from Hugging Face.",
            confirm: "Remove model files",
            danger: true,
          }))
        )
          return
        await perform("clear", async () => {
          await runtime.unload()
          await files.clear()
        })
      }
      const updateRendererCapture = async (arm: boolean) => {
        setRendererCaptureBusy(true)
        setRendererCaptureError("")
        try {
          setRendererCapture(
            await (arm
              ? files.armRendererCapture({ signal: settingsSignal() })
              : files.stopRendererCapture({ signal: settingsSignal() })),
          )
        } catch (cause) {
          setRendererCaptureError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setRendererCaptureBusy(false)
          await refresh()
        }
      }
      const wav = (base64: string) =>
        new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: "audio/wav" })
      /** Speaks one sentence in the selected voice, so the picker is chosen by ear. */
      const previewVoice = () => {
        if (previewing()) return stopPreview()
        const voice = VOICES[ctx.stores.voice.value?.selected ?? DEFAULT_VOICE].label
        void perform("preview", async () => {
          test = new AbortController()
          const result = await runtime.speak(`This is the ${voice} voice.`, test.signal)
          if (!result.ok || !result.audioBase64)
            throw new Error(result.error || "The model returned no speech")
          const audio = new Audio(URL.createObjectURL(wav(result.audioBase64)))
          previewAudio = audio
          audio.addEventListener("ended", stopPreview)
          setPreviewing(true)
          await audio.play()
        })
      }
      const keepAlive = () => ctx.stores.runtime.value?.keepAliveMs
      const keepAliveOptions = () => {
        const standard = [
          { value: String(NEVER_UNLOAD_MS), label: "Always" },
          { value: "60000", label: "1 minute" },
          { value: "300000", label: "5 minutes" },
          { value: "900000", label: "15 minutes" },
        ]
        const current = keepAlive()
        return current === undefined || standard.some((option) => option.value === String(current))
          ? standard
          : [...standard, { value: String(current), label: keepAliveLabel(current) }]
      }
      // A short plain state; the runtime's own sentence stays in the tooltip and diagnostics.
      const runtimeLine = () =>
        runtimeStatusLine({
          enabled: features().enabled,
          phase: runtime.phase(),
          detail: runtime.detail(),
          ...(runtime.modelName() ? { modelName: runtime.modelName()! } : {}),
        })
      const testDecision = () =>
        perform("decision", async () => {
          test = new AbortController()
          setDecisionReply("")
          const context = evidence()
          if (context.length > DECISION_CONTEXT_MAX_LENGTH)
            throw new Error(
              `Decision context must be at most ${DECISION_CONTEXT_MAX_LENGTH.toLocaleString()} characters.`,
            )
          const kind = decisionKind()
          const decision: Decision =
            kind === "boolean"
              ? { kind }
              : kind === "choice"
                ? { kind, choices: ["approved", "not-approved"] }
                : { kind, minimum: 0, maximum: 1 }
          const result = await runtime.decide(
            { question: question(), context, decision, timeoutMs: 60_000 },
            test.signal,
          )
          if (!result.ok) throw new Error(result.error)
          setDecisionReply(JSON.stringify(result))
        })
      return (
        <Ui.SettingsLayout title="LAZERS" description={pageLede}>
          <div class="lazers-settings-head">
            <h2 id="lazers-local-title">Local inference</h2>
            <span role="status" title={runtimeLine().tooltip}>
              {runtimeLine().text}
            </span>
          </div>
          <Ui.SettingsSection
            footer={
              <>
                <Show when={!features().enabled && runtime.state() === "error"}>
                  <Ui.Button
                    size="small"
                    onClick={() => {
                      void runtime.unload()
                    }}
                  >
                    Retry GPU cleanup
                  </Ui.Button>
                </Show>
                <Show when={settingsError()}>
                  <p class="lazers-settings-hint" role="alert">
                    {settingsError()}
                  </p>
                </Show>
              </>
            }
          >
            <Ui.SettingsRow
              title={
                <SettingLabel
                  name="Run local models on this device"
                  hint="Off releases GPU memory; downloads are kept"
                />
              }
            >
              <Ui.Switch
                label="Run local models on this device"
                hideLabel
                checked={features().enabled}
                disabled={!settingsReady() || saving()}
                onChange={(value) => {
                  void configure("enabled", value)
                }}
              />
            </Ui.SettingsRow>
            {(
              [
                ["questions", "Local questions", "for agents and the test panel"],
                ["decisions", "System One decisions", "typed decisions API"],
                ["review", "Task review", "advisory check before submission · needs decisions"],
                ["dictation", "Dictation", "microphone button and push-to-talk"],
                ["readAloud", "Read aloud", "speaker button and speech"],
              ] as const
            ).map(([key, label, hint]) => (
              <Ui.SettingsRow
                title={<SettingLabel name={label} hint={hint} child off={!features().enabled} />}
              >
                <Ui.Switch
                  label={label}
                  hideLabel
                  checked={features()[key]}
                  disabled={
                    !settingsReady() ||
                    saving() ||
                    !features().enabled ||
                    (key === "review" && !features().decisions)
                  }
                  onChange={(value) => {
                    void configure(key, value)
                  }}
                />
              </Ui.SettingsRow>
            ))}
          </Ui.SettingsSection>
          <Ui.SettingsSection
            footer={
              <Show when={downloading()}>
                <progress
                  class="lazers-settings-progress"
                  aria-label="Model download"
                  value={cachedBytes()}
                  max={MODEL_BYTES + DECISION_BYTES}
                />
              </Show>
            }
          >
            <Show when={features().enabled}>
              <Ui.SettingsRow
                title={
                  <SettingLabel
                    name="Keep model loaded"
                    hint="Never unloading avoids the reload wait"
                  />
                }
              >
                <Ui.Select
                  label="Keep model loaded"
                  value={keepAlive() === undefined ? undefined : String(keepAlive())}
                  options={keepAliveOptions()}
                  onChange={(value) => ctx.stores.runtime.set({ keepAliveMs: Number(value) })}
                />
              </Ui.SettingsRow>
              <Ui.SettingsRow title={<SettingLabel name="Voice" hint="used by Read aloud" />}>
                <div class="lazers-settings-controls">
                  <Ui.Button
                    size="small"
                    icon="outline-audio"
                    disabled={
                      !enabled("readAloud") || (Boolean(action()) && action() !== "preview")
                    }
                    busy={action() === "preview" && !previewing()}
                    onClick={previewVoice}
                  >
                    {previewing() ? "Stop" : "Preview"}
                  </Ui.Button>
                  <Ui.Select
                    label="Voice"
                    value={ctx.stores.voice.value?.selected ?? DEFAULT_VOICE}
                    disabled={!enabled("readAloud")}
                    options={voiceKeys.map((key) => ({ value: key, label: VOICES[key].label }))}
                    onChange={(selected) => {
                      stopPreview()
                      ctx.stores.voice.set({ selected })
                    }}
                  />
                </div>
              </Ui.SettingsRow>
            </Show>
            <Ui.SettingsRow
              title={
                <SettingLabel
                  name="Downloaded models"
                  hint={`${cacheLabel()} · ${formatBytes(cachedBytes())} of ${formatBytes(MODEL_BYTES + DECISION_BYTES)}`}
                />
              }
            >
              <Ui.Button
                size="small"
                icon="trash"
                disabled={
                  Boolean(action()) ||
                  runtime.state() === "loading" ||
                  runtime.state() === "busy" ||
                  (cache()?.cachedBytes ?? 0) + (decisionCache()?.cachedBytes ?? 0) === 0
                }
                onClick={() => {
                  void clear()
                }}
              >
                Remove
              </Ui.Button>
            </Ui.SettingsRow>
          </Ui.SettingsSection>
          <BudgetSection />
          <RetentionSection />
          <details class="lazers-local lazers-local-diagnostics">
            <summary>
              Advanced diagnostics <span>GPU, model identity, renderer capture</span>
            </summary>
            <Show when={runtime.detail()}>
              <p class="lazers-local-meta">Runtime · {runtime.detail()}</p>
            </Show>
            <p class="lazers-local-meta">
              Service completion contract: {runtime.contractStatus()} · required{" "}
              <code>{GENERATION_RESULT_CONTRACT_REVISION}</code>
            </p>
            <Show when={runtime.gpu()}>
              <p class="lazers-local-meta">{runtime.gpu()}</p>
            </Show>
            <Show when={runtime.modelIdentity()}>
              {(identity) => (
                <p class="lazers-local-meta">
                  {identity().backend} · {identity().repository} · {identity().precision} · model{" "}
                  <code>{identity().revision}</code> · runtime{" "}
                  <code>{identity().runtimeRevision}</code>
                  <br />
                  Artifacts: <code>{identity().artifacts}</code>
                </p>
              )}
            </Show>
            <section aria-labelledby="lazers-renderer-capture-title">
              <h2 id="lazers-renderer-capture-title">Renderer CPU capture</h2>
              <p>
                Arm the Electron profiler for the next local inference job in this window. It does
                not start or cancel inference or change local settings. The capture disarms after 60
                seconds without a job and stops after completion, manual stop, 120 seconds, or
                renderer unresponsiveness.
              </p>
              <div class="lazers-local-actions">
                <Ui.Button
                  disabled={rendererCaptureBusy()}
                  busy={rendererCaptureBusy()}
                  onClick={() => {
                    void updateRendererCapture(
                      !["preparing", "waiting", "recording", "stopping"].includes(
                        rendererCapture()?.state ?? "idle",
                      ),
                    )
                  }}
                >
                  {["preparing", "waiting", "recording", "stopping"].includes(
                    rendererCapture()?.state ?? "idle",
                  )
                    ? rendererCapture()?.state === "waiting"
                      ? "Disarm capture"
                      : "Stop capture"
                    : "Arm next-job capture"}
                </Ui.Button>
              </div>
              <p role="status" aria-live="polite">
                {rendererCapture()?.message ?? "Checking this window’s renderer capture status…"}
              </p>
              <Show when={rendererCapture()?.stopTrigger}>
                <p class="lazers-local-meta">
                  Trigger: {rendererCapture()?.stopTrigger} ·{" "}
                  {rendererCapture()?.triggeredAt === undefined
                    ? ""
                    : new Date(rendererCapture()!.triggeredAt!).toISOString()}
                </p>
              </Show>
              <Show when={rendererCapture()?.profilerCommands?.length}>
                <p class="lazers-local-meta">
                  Profiler commands:{" "}
                  {rendererCapture()
                    ?.profilerCommands?.map(
                      (command) =>
                        `${command.method}: ${command.outcome}${command.nativePending ? " (native command pending)" : ""}${command.profilerStateUncertain ? " (profiler may still be running)" : ""} · ${new Date(command.startedAt).toISOString()}–${new Date(command.settledAt).toISOString()}${command.nativeSettledAt === undefined ? "" : ` · native settled ${new Date(command.nativeSettledAt).toISOString()} (${command.nativeOutcome})`}`,
                    )
                    .join("; ")}
                </p>
              </Show>
              <Show when={rendererCapture()?.profilerCleanup}>
                <p class="lazers-local-meta">
                  Debugger cleanup: {rendererCapture()?.profilerCleanup?.outcome} ·{" "}
                  {new Date(rendererCapture()!.profilerCleanup!.startedAt).toISOString()}–
                  {new Date(rendererCapture()!.profilerCleanup!.settledAt).toISOString()}
                </p>
              </Show>
              <Show when={rendererCapture()?.persistenceFailure === "late-metadata-update"}>
                <p role="alert">
                  Late profiler metadata could not be updated. The original capture outcome remains
                  authoritative.
                </p>
              </Show>
              <Show when={rendererCapture()?.lastJobID}>
                <p class="lazers-local-meta">
                  Target: request {rendererCapture()?.lastRequestID} · job{" "}
                  {rendererCapture()?.lastJobID}
                  {rendererCapture()?.lastStage ? ` · ${rendererCapture()?.lastStage}` : ""}
                  {rendererCapture()?.stageCount
                    ? ` · ${rendererCapture()?.stageCount} stages`
                    : ""}
                </p>
              </Show>
              <Show when={rendererCapture()?.path}>
                <p class="lazers-local-path">Metadata: {rendererCapture()?.path}</p>
              </Show>
              <Show when={rendererCapture()?.profilePath}>
                <p class="lazers-local-path">CPU profile: {rendererCapture()?.profilePath}</p>
              </Show>
              <Show when={rendererCaptureError()}>
                <p role="alert">{rendererCaptureError()}</p>
              </Show>
            </section>
            <Show when={features().enabled}>
              <section>
                <h2>Runtime controls</h2>
                <p>
                  Resident model: {runtime.resident() ?? "none"}. Only one model occupies GPU
                  memory; requests switch models automatically.
                </p>
                <div class="lazers-local-actions">
                  <Ui.Button
                    variant="contrast"
                    icon="download"
                    disabled={
                      Boolean(action()) ||
                      !usesGPU(features()) ||
                      runtime.state() === "loading" ||
                      runtime.state() === "ready" ||
                      runtime.state() === "busy" ||
                      Boolean(cache()?.occupied)
                    }
                    onClick={() => {
                      void perform("load", runtime.load)
                    }}
                  >
                    Reload model
                  </Ui.Button>
                  <Ui.Button
                    disabled={Boolean(action()) || runtime.state() !== "ready"}
                    onClick={() => {
                      void perform("unload", runtime.unload)
                    }}
                  >
                    Unload from GPU
                  </Ui.Button>
                  <Ui.Button
                    disabled={!runtime.canSimulateDeviceLoss() || runtime.state() !== "ready"}
                    onClick={runtime.simulateDeviceLoss}
                  >
                    Test GPU recovery
                  </Ui.Button>
                  <Show when={runtime.state() === "loading" || runtime.state() === "busy"}>
                    <Ui.Button
                      onClick={() => {
                        test?.abort()
                        runtime.cancel()
                      }}
                    >
                      Cancel
                    </Ui.Button>
                  </Show>
                </div>
                <p class="lazers-local-meta">
                  One model owner across Desktop windows. FIFO queue of up to eight requests. Files
                  stay cached after unloading.
                </p>
              </section>
              <section aria-labelledby="lazers-cache-detail-title">
                <div class="lazers-local-row">
                  <div>
                    <h2 id="lazers-cache-detail-title">Cache details</h2>
                    <p>
                      {cache()?.phase === "cached"
                        ? "Cached on this device"
                        : cache()?.phase === "downloading"
                          ? "Downloading from Hugging Face"
                          : cache()?.phase === "verifying"
                            ? "Verifying SHA-256 checksums"
                            : "Not downloaded"}
                    </p>
                  </div>
                  <span class="lazers-local-size">
                    {formatBytes(
                      cache()?.phase === "downloading"
                        ? (cache()?.downloadedBytes ?? 0)
                        : (cache()?.cachedBytes ?? 0),
                    )}{" "}
                    / {formatBytes(MODEL_BYTES)}
                  </span>
                </div>
                <Show when={cache()?.phase === "downloading"}>
                  <progress
                    aria-label="Model download"
                    value={cache()?.downloadedBytes ?? 0}
                    max={MODEL_BYTES}
                  />
                </Show>
                <p class="lazers-local-path">{cache()?.directory}</p>
                <p class="lazers-local-path">{decisionCache()?.directory}</p>
                <p class="lazers-local-meta">
                  Q4_K_M model + Q8 projector · verified immutable revision{" "}
                  <code>{MODEL_REVISION.slice(0, 8)}</code>
                </p>
                <p class="lazers-local-meta">
                  ruNNtime public API: exact Q4_K_M language and Q8_0 projector pair · code revision{" "}
                  <code>{RUNNTIME_REVISION.slice(0, 8)}</code> · tokenizer revision{" "}
                  <code>{LFM3_TOKENIZER_REVISION.slice(0, 8)}</code>
                </p>
                <p class="lazers-local-meta">
                  d1-Omni-2B Q4f16 decoder · text decisions · revision{" "}
                  <code>{DECISION_REVISION.slice(0, 8)}</code>
                </p>
              </section>
              <section aria-labelledby="lazers-speech-title">
                <h2 id="lazers-speech-title">Test speech</h2>
                <p>
                  Generate speech locally, or transcribe an audio clip up to 30 seconds. Microphone
                  dictation is available above the chat composer.
                </p>
                <Ui.TextInput
                  label="Text to speak"
                  value={speech()}
                  onInput={setSpeech}
                  disabled={Boolean(action())}
                />
                <div class="lazers-local-actions">
                  <Ui.Button
                    disabled={Boolean(action()) || !speech().trim() || !enabled("readAloud")}
                    busy={action() === "speak"}
                    onClick={() => {
                      void perform("speak", async () => {
                        test = new AbortController()
                        const result = await runtime.speak(speech(), test.signal)
                        if (!result.ok || !result.audioBase64)
                          throw new Error(result.error || "The model returned no speech")
                        if (speechURL()) URL.revokeObjectURL(speechURL())
                        setSpeechURL(URL.createObjectURL(wav(result.audioBase64)))
                      })
                    }}
                  >
                    Generate speech
                  </Ui.Button>
                </div>
                <Show when={enabled("readAloud") && speechURL()}>
                  <audio controls src={speechURL()} aria-label="Generated local speech" />
                </Show>
                <label class="lazers-local-audio-label">
                  Audio clip to transcribe
                  <input
                    type="file"
                    accept="audio/*"
                    disabled={Boolean(action()) || !enabled("dictation")}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0]
                      if (!file) return
                      void perform("transcribe", async () => {
                        test = new AbortController()
                        setTranscript("")
                        const result = await runtime.transcribe(
                          await audioFilePCM16(file),
                          (text) => setTranscript((previous) => previous + text),
                          test.signal,
                        )
                        if (!result.ok) throw new Error(result.error)
                        setTranscript(result.text)
                      })
                    }}
                  />
                </label>
                <Show when={transcript()}>
                  <pre class="lazers-local-reply">{transcript()}</pre>
                </Show>
              </section>
              <section aria-labelledby="lazers-test-title">
                <h2 id="lazers-test-title">Try local inference</h2>
                <p>Send a short request through the plugin’s server RPC and back to this GPU.</p>
                <Ui.TextInput
                  label="Local inference prompt"
                  value={prompt()}
                  onInput={setPrompt}
                  disabled={Boolean(action())}
                />
                <div class="lazers-local-actions">
                  <Ui.Button
                    disabled={Boolean(action()) || !prompt().trim() || !enabled("questions")}
                    busy={action() === "test"}
                    onClick={() => {
                      void testModel()
                    }}
                  >
                    Run locally
                  </Ui.Button>
                </div>
                <Show when={reply()}>
                  <pre class="lazers-local-reply">{reply()}</pre>
                </Show>
              </section>
              <section aria-labelledby="lazers-decision-title">
                <h2 id="lazers-decision-title">Try a typed decision</h2>
                <p>
                  Validate a boolean, an exact choice, or a score from 0 to 1 against supplied
                  evidence.
                </p>
                <div class="lazers-local-actions">
                  <Ui.Menu
                    label={`Decision type: ${decisionKind()}`}
                    trigger="button"
                    disabled={Boolean(action()) || !enabled("decisions")}
                    items={(["boolean", "choice", "score"] as const).map((kind) => ({
                      label: kind,
                      onSelect: () => setDecisionKind(kind),
                    }))}
                  />
                </div>
                <Ui.TextInput
                  label="Decision question"
                  value={question()}
                  onInput={setQuestion}
                  disabled={Boolean(action())}
                />
                <div class="lazers-local-actions">
                  <Ui.TextInput
                    label="Decision context"
                    value={evidence()}
                    onInput={setEvidence}
                    disabled={Boolean(action())}
                  />
                </div>
                <Show when={decisionKind() === "choice"}>
                  <p class="lazers-local-meta">Choices: approved · not-approved</p>
                </Show>
                <div class="lazers-local-actions">
                  <Ui.Button
                    busy={action() === "decision"}
                    disabled={Boolean(action()) || !enabled("decisions")}
                    onClick={() => {
                      void testDecision()
                    }}
                  >
                    Ask for decision
                  </Ui.Button>
                </div>
                <Show when={decisionReply()}>
                  <pre class="lazers-local-reply">{decisionReply()}</pre>
                </Show>
              </section>
            </Show>
          </details>
          <Show when={error() || cache()?.error || decisionCache()?.error}>
            <p class="lazers-settings-hint" role="alert">
              {error() || cache()?.error || decisionCache()?.error}
            </p>
          </Show>
        </Ui.SettingsLayout>
      )
    })
    registerInferenceIndicator(
      ctx,
      runtime,
      () => usesGPU(features()),
      () => ctx.layout.settings(pageID),
    )
    ctx.add(SettingsPage, {
      id: pageID,
      title: "LAZERS",
      icon: "settings-gear",
      render: () => <Settings />,
    })
    ctx.add(
      Style,
      `
      .lazers-local { color: var(--text-base); font: inherit; }
      .lazers-local h2 { font-size: 14px; font-weight: 600; margin: 0 0 4px; }
      .lazers-local p { color: var(--text-weak); font-size: 13px; line-height: 1.5; margin: 4px 0 12px; }
      .lazers-local section { padding: 24px 0; border-top: 1px solid var(--border-weak-base); }
      .lazers-settings-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: -20px; }
      .lazers-settings-head h2 { margin: 0; color: var(--text-strong); font-size: 13px; font-weight: 500; }
      .lazers-settings-head span { min-width: 0; color: var(--text-weak); font-size: 12.5px; text-align: right; overflow-wrap: anywhere; }
      .lazers-settings-controls { display: flex; align-items: center; gap: 8px; }
      .lazers-settings-number { width: 96px; text-align: right; font-variant-numeric: tabular-nums; }
      .lazers-settings-hint { margin: 8px 0 0; color: var(--text-weak); font-size: 12px; line-height: 1.5; }
      .lazers-settings-progress { width: 100%; height: 4px; margin-top: 8px; }
      .lazers-local-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
      .lazers-local-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 16px 0; }
      .lazers-local-size { white-space: nowrap; font-size: 12px; font-variant-numeric: tabular-nums; }
      .lazers-local p.lazers-local-meta { font-size: 12px; color: var(--text-weaker); }
      .lazers-local-path, .lazers-local-reply { overflow-wrap: anywhere; white-space: pre-wrap; font: 12px/1.6 var(--font-family-mono, monospace); }
      .lazers-local-reply { padding: 16px; background: var(--surface-base); border: 1px solid var(--border-weak-base); border-radius: 8px; }
      .lazers-local progress { width: 100%; height: 4px; }
      .lazers-local-diagnostics summary { display: flex; align-items: center; gap: 8px; padding: 16px 0; cursor: pointer; font-size: 13px; font-weight: 400; list-style: none; }
      .lazers-local-diagnostics summary::-webkit-details-marker { display: none; }
      .lazers-local-diagnostics summary::before { content: ""; flex: none; box-sizing: border-box; width: 6px; height: 6px; margin: 0 5px 0 2px; border-right: 1.5px solid var(--icon-base, var(--text-weak)); border-bottom: 1.5px solid var(--icon-base, var(--text-weak)); transform: rotate(-45deg); transition: transform 100ms ease; }
      .lazers-local-diagnostics[open] > summary::before { transform: translateY(-2px) rotate(45deg); }
      .lazers-local-diagnostics summary span { margin-left: auto; color: var(--text-weak); font-size: 12px; font-weight: 400; }
      .lazers-local-audio-label { display: grid; gap: 8px; margin-top: 20px; font-size: 13px; }
      .lazers-local audio { width: 100%; max-width: 420px; }
      ${inferenceIndicatorStyles}
      @media (max-width: 560px) { .lazers-local-row { flex-wrap: wrap; gap: 4px; } }
    `,
    )
    return () => runtime.dispose()
  },
})
