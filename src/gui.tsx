import { Plugin, SettingsPage, Store, Style, bindPlugin } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { ModelFiles } from "./webgpu/ipc.ts"
import { setupMain } from "./webgpu/main.ts"
import { setupNativeInteractionMain } from "./verification/opencode/native-interaction-main.ts"
import { createInferenceRuntime, DEFAULT_MODEL_KEEP_ALIVE_MS } from "./webgpu/runtime.ts"
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
import { registerDictation } from "./webgpu/dictation.tsx"
import { audioFilePCM16 } from "./webgpu/audio.ts"
import { DEFAULT_VOICE } from "./webgpu/speech.ts"
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
      { keepAliveMs: DEFAULT_MODEL_KEEP_ALIVE_MS },
    ),
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
    setupBudget(ctx, ctx.stores.budget)
    ctx.add(Style, nativeBusyStyles)
    const openTaskTrajectory: TaskTrajectoryOpener = (session, request) => {
      const target = { ...request, requestID: crypto.randomUUID() }
      ctx.stores.trajectoryView(session).update((draft) => {
        const previous = draft.projects[request.projectDirectory] ?? {
          scope: "session" as const,
          selectedTaskID: null,
          selectedKind: "" as const,
          selectedRecordID: "",
          split: 56,
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
    setupTaskPanel(ctx, openTaskTrajectory)
    setupModelsPanel(ctx, openTaskTrajectory)
    setupTrajectoryPanel(ctx)
    setupRadarPanel(ctx)
    const Ui = ctx.ui
    const pageID = "lazers"
    const Overview = bindPlugin(() => (
      <>
        <header>
          <div class="lazers-local-eyebrow">Plugin settings</div>
          <h1>LAZERS</h1>
          <p>Task workflows, agents, and optional local intelligence.</p>
        </header>
        <section aria-labelledby="lazers-workflow-title">
          <h2 id="lazers-workflow-title">Task workflow</h2>
          <p>
            Architect, saved tasks, and the Tasks panel work independently of local inference.
            Architect uses your selected OpenCode model; local task review is an optional extra
            check.
          </p>
        </section>
      </>
    ))
    if (ctx.app.platform !== "desktop") {
      ctx.add(SettingsPage, {
        id: pageID,
        title: "LAZERS",
        icon: "settings-gear",
        render: () => (
          <div class="lazers-local">
            <Overview />
            <section>
              <h2>Local inference</h2>
              <p>Local WebGPU features can be configured in OpenCode Desktop.</p>
            </section>
          </div>
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
      () => ctx.stores.runtime.value?.keepAliveMs ?? DEFAULT_MODEL_KEEP_ALIVE_MS,
      () => DEFAULT_VOICE,
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
      let test: AbortController | undefined
      const testAborted = () => test?.signal.aborted === true
      createEffect(() => {
        const key = (
          {
            test: "questions",
            decision: "decisions",
            speak: "readAloud",
            transcribe: "dictation",
          } as const
        )[action() as "test" | "decision" | "speak" | "transcribe"]
        if (!features().enabled || (key && !enabled(key))) test?.abort()
        if (!enabled("readAloud") && speechURL()) {
          URL.revokeObjectURL(speechURL())
          setSpeechURL("")
        }
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
          setReply(
            `${result.text}\n\n${result.promptTokens ?? "unknown"} input tokens · ${result.completionTokens ?? "unknown"} output tokens`,
          )
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
        <div class="lazers-local">
          <Overview />
          <section aria-labelledby="lazers-local-title">
            <h2 id="lazers-local-title">Local inference</h2>
            <p>
              Run optional LiquidAI models on this device. Turning this off stops local work and
              releases GPU memory. Downloaded models are kept.
            </p>
            <div class="lazers-local-toggle">
              <h3>Enable local WebGPU inference</h3>
              <Ui.Switch
                label="Enable local WebGPU inference"
                hideLabel
                checked={features().enabled}
                disabled={!settingsReady() || saving()}
                onChange={(value) => {
                  void configure("enabled", value)
                }}
              />
            </div>
            <Show when={!features().enabled}>
              <p role="status">
                {runtime.state() === "disabled"
                  ? "Local inference is off."
                  : runtime.state() === "error"
                    ? runtime.detail()
                    : "Stopping local work…"}
              </p>
              <Show when={runtime.state() === "error"}>
                <Ui.Button
                  onClick={() => {
                    void runtime.unload()
                  }}
                >
                  Retry GPU cleanup
                </Ui.Button>
              </Show>
            </Show>
            <div class="lazers-local-features">
              {(
                [
                  [
                    "questions",
                    "Local questions",
                    "General local questions for agents and the test panel.",
                  ],
                  ["decisions", "System One decisions", "Typed decisions and the System One API."],
                  [
                    "review",
                    "Task review",
                    "Advisory checks before submission. Requires System One decisions.",
                  ],
                  [
                    "dictation",
                    "Dictation and transcription",
                    "Microphone button, push-to-talk shortcut, and audio transcription.",
                  ],
                  [
                    "readAloud",
                    "Read aloud and speech",
                    "Speaker button, local speech generation, and voice tests.",
                  ],
                ] as const
              ).map(([key, label, description]) => (
                <div class="lazers-local-toggle">
                  <div>
                    <h3>{label}</h3>
                    <p>{description}</p>
                  </div>
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
                </div>
              ))}
            </div>
            <Show when={settingsError()}>
              <p role="alert">{settingsError()}</p>
            </Show>
          </section>
          <Show when={features().enabled}>
            <section aria-labelledby="lazers-runtime-title">
              <div class="lazers-local-row">
                <div>
                  <h2 id="lazers-runtime-title">GPU runtime</h2>
                  <p role="status">{runtime.detail()}</p>
                </div>
                <span class="lazers-local-state">{runtime.state()}</span>
              </div>
              <p>Local features load models on demand and share GPU memory.</p>
              <Ui.Menu
                label={`Unload when idle: ${(ctx.stores.runtime.value?.keepAliveMs ?? DEFAULT_MODEL_KEEP_ALIVE_MS) === 60_000 ? "1 minute" : (ctx.stores.runtime.value?.keepAliveMs ?? DEFAULT_MODEL_KEEP_ALIVE_MS) === 300_000 ? "5 minutes" : (ctx.stores.runtime.value?.keepAliveMs ?? DEFAULT_MODEL_KEEP_ALIVE_MS) === 900_000 ? "15 minutes" : "Never"}`}
                trigger="button"
                items={[
                  { label: "Never", value: -1 },
                  { label: "After 1 minute", value: DEFAULT_MODEL_KEEP_ALIVE_MS },
                  { label: "After 5 minutes", value: 300_000 },
                  { label: "After 15 minutes", value: 900_000 },
                ].map((item) => ({
                  label: item.label,
                  onSelect: () => ctx.stores.runtime.set({ keepAliveMs: item.value }),
                }))}
              />
            </section>
          </Show>
          <section aria-labelledby="lazers-cache-title">
            <div class="lazers-local-row">
              <div>
                <h2 id="lazers-cache-title">Downloaded models</h2>
                <p>{cacheLabel()}</p>
              </div>
              <span class="lazers-local-size">
                {formatBytes(cachedBytes())} / {formatBytes(MODEL_BYTES + DECISION_BYTES)}
              </span>
            </div>
            <Show when={downloading()}>
              <progress
                aria-label="Model download"
                value={cachedBytes()}
                max={MODEL_BYTES + DECISION_BYTES}
              />
            </Show>
            <Ui.Button
              icon="trash"
              variant="danger"
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
              Remove downloaded models
            </Ui.Button>
          </section>
          <details class="lazers-local-diagnostics">
            <summary>Advanced diagnostics</summary>
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
                    ? "time unavailable"
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
                        setSpeechURL(
                          URL.createObjectURL(
                            new Blob(
                              [Uint8Array.from(atob(result.audioBase64), (c) => c.charCodeAt(0))],
                              { type: "audio/wav" },
                            ),
                          ),
                        )
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
            <p role="alert">{error() || cache()?.error || decisionCache()?.error}</p>
          </Show>
        </div>
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
      .lazers-local { max-width: 720px; margin: 0 auto; padding: 32px 24px; color: var(--text-base); font: inherit; }
      .lazers-local header { margin-bottom: 32px; }
      .lazers-local h1 { font-size: 24px; font-weight: 600; margin: 8px 0; }
      .lazers-local h2 { font-size: 14px; font-weight: 600; margin: 0 0 4px; }
      .lazers-local p { color: var(--text-weak); font-size: 13px; line-height: 1.5; margin: 4px 0 12px; }
      .lazers-local section { padding: 24px 0; border-top: 1px solid var(--border-weak-base); }
      .lazers-local-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
      .lazers-local-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 16px 0; }
      .lazers-local-features { display: grid; gap: 20px; margin-top: 24px; }
      .lazers-local-toggle { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
      .lazers-local-toggle h3 { margin: 0; font-size: 13px; font-weight: 500; }
      .lazers-local-toggle p { margin: 4px 0 0; font-size: 12px; }
      .lazers-local-eyebrow, .lazers-local-state { color: var(--text-weak); font-size: 12px; }
      .lazers-local-state { padding-top: 2px; text-transform: capitalize; }
      .lazers-local-size { white-space: nowrap; font-size: 12px; font-variant-numeric: tabular-nums; }
      .lazers-local p.lazers-local-meta { font-size: 12px; color: var(--text-weaker); }
      .lazers-local-path, .lazers-local-reply { overflow-wrap: anywhere; white-space: pre-wrap; font: 12px/1.6 var(--font-family-mono, monospace); }
      .lazers-local-reply { padding: 16px; background: var(--surface-base); border: 1px solid var(--border-weak-base); border-radius: 8px; }
      .lazers-local progress { width: 100%; height: 4px; }
      .lazers-local-diagnostics summary { padding: 16px 0; cursor: pointer; font-size: 13px; font-weight: 500; }
      .lazers-local-audio-label { display: grid; gap: 8px; margin-top: 20px; font-size: 13px; }
      .lazers-local audio { width: 100%; max-width: 420px; }
      ${inferenceIndicatorStyles}
      @media (max-width: 560px) { .lazers-local { padding: 24px 16px; } .lazers-local-row { flex-wrap: wrap; gap: 4px; } }
    `,
    )
    return () => runtime.dispose()
  },
})
