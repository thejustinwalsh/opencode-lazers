import { sharedInFlight, sharedSessionSet } from "../core/process-shared.ts"
import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import type { TaskRepository } from "../storage.ts"
import { runnableFix } from "./profile-runtime.ts"
import { activeProfile, activeProfileForKey } from "./profile-store.ts"
import { projectKeyOfDirectory, projectSettings } from "./settings.ts"
import type { ActiveProfile, ProofRecord } from "./profile-store.ts"

/** Key of the keyed session instruction that carries the project's verification profile. */
export const architectProfileKey = "lazers-project-profile"

type SessionApi = Pick<Plugin.Context["session"], "get" | "instructions">
const inFlight = sharedInFlight<boolean>("profile-guidance.inFlight")
const installed = sharedSessionSet("profile-guidance.installed")

/** Why a command is unproven, in a few words: its exit code, its reason, or that it never ran. */
function unprovenReason(proof: ProofRecord | undefined): string {
  if (!proof) return "not proven"
  if (proof.exitCode !== null && proof.exitCode !== 0) return `exit ${proof.exitCode}`
  return proof.reason ?? (proof.outcome === "not-run" ? "not run" : "failed")
}

function verifyLines(active: ActiveProfile): string[] {
  return active.profile.verify.map((entry) => {
    const proof = active.proofs.get(`verify:${entry.id}`)
    const note = proof?.outcome === "proven" ? "" : ` (unproven: ${unprovenReason(proof)})`
    return `- ${entry.id}: ${entry.command}${note}`
  })
}

const fixList = (active: ActiveProfile) => {
  const commands = runnableFix(active).map((entry) => entry.command)
  return commands.length ? commands.join("; ") : "none"
}

/** What the Architect is told once per session: the profile's verification, audit and how to use it. */
export function profileGuidanceText(active: ActiveProfile): string {
  const { profile } = active
  return [
    `## Project verification (profile revision ${active.revision})`,
    "",
    "Verify commands of this project:",
    ...verifyLines(active),
    "",
    `Automatic fixes the runtime runs on a worker's changed files before its checks: ${fixList(active)}.`,
    `Audit: ${profile.audit === "fallow" ? "Fallow" : "off"}.`,
    "",
    "Put each verify entry in a task as its own check id; the runtime runs every check and reports each failure. Append test file paths to a test command.",
  ].join("\n")
}

/** Replaces the closing sentence of the task instructions when a profile exists. */
export function workerVerificationSection(active: ActiveProfile): string {
  return [
    "",
    "",
    `## Project verification (profile revision ${active.revision})`,
    ...verifyLines(active),
    "",
    `The runtime runs these automatic fixes on your changed files before your checks: ${fixList(active)}.`,
    "Run each verify command as its own check; append test file paths to a test command.",
  ].join("\n")
}

/**
 * Install the profile guidance as a keyed session instruction on an Architect session, once, as
 * `ensureArchitectMap` does for the map. Nothing is installed without an active profile.
 */
export function ensureArchitectProfileGuidance(
  session: SessionApi,
  repository: TaskRepository,
  sessionID: string,
): Promise<boolean> {
  if (installed.has(sessionID)) return Promise.resolve(false)
  const running = inFlight.get(sessionID)
  if (running) return running
  const run = (async () => {
    const id = Session.ID.make(sessionID)
    const info = await Effect.runPromise(session.get({ sessionID: id }))
    if (info.agent !== "architect") return false
    const active = activeProfile(repository, info.location.directory)
    if (!active) return false
    const entries = await Effect.runPromise(session.instructions.entry.list({ sessionID: id }))
    if (entries.some((entry) => entry.key === architectProfileKey)) {
      installed.add(sessionID)
      return false
    }
    await Effect.runPromise(
      session.instructions.entry.put({
        sessionID: id,
        key: architectProfileKey,
        value: profileGuidanceText(active),
      }),
    )
    installed.add(sessionID)
    return true
  })().finally(() => inFlight.delete(sessionID))
  inFlight.set(sessionID, run)
  return run
}

/** Key of the keyed session instruction that points an Architect at project setup. */
export const setupPointerKey = "lazers-project-setup"
const pointerInFlight = sharedInFlight<boolean>("profile-guidance.pointerInFlight")
const pointerInstalled = sharedSessionSet("profile-guidance.pointerInstalled")

const SETUP_POINTER =
  "This project has no LAZERS profile, so the runtime uses the commands you write in tasks.\n`lz-project-profile` (mode `guide`) explains how to set one up."

/**
 * Installs a two-line pointer to project setup on an Architect session of a project with no
 * active profile, whose owner has not dismissed the notice. Setup sessions already carry the
 * runbook and get nothing. The pointer is not the runbook: a long-lived project would otherwise
 * pay for it in every session.
 */
export function ensureSetupPointer(
  session: SessionApi,
  repository: TaskRepository,
  sessionID: string,
): Promise<boolean> {
  if (pointerInstalled.has(sessionID)) return Promise.resolve(false)
  const running = pointerInFlight.get(sessionID)
  if (running) return running
  const run = (async () => {
    const id = Session.ID.make(sessionID)
    const info = await Effect.runPromise(session.get({ sessionID: id }))
    if (info.agent !== "architect") return false
    if ((info.metadata as Record<string, unknown> | undefined)?.lazersProjectSetup !== undefined)
      return false
    const key = projectKeyOfDirectory(repository, info.location.directory)
    if (!key) return false
    if (activeProfileForKey(repository, key)) return false
    if (projectSettings(repository, key).setupDismissedAt !== null) return false
    const entries = await Effect.runPromise(session.instructions.entry.list({ sessionID: id }))
    if (!entries.some((entry) => entry.key === setupPointerKey))
      await Effect.runPromise(
        session.instructions.entry.put({
          sessionID: id,
          key: setupPointerKey,
          value: SETUP_POINTER,
        }),
      )
    pointerInstalled.add(sessionID)
    return !entries.some((entry) => entry.key === setupPointerKey)
  })().finally(() => pointerInFlight.delete(sessionID))
  pointerInFlight.set(sessionID, run)
  return run
}
