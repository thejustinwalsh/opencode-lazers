/** The stable identity of a mechanical-preparation effect, excluding its evolving input tree. */
export type PreparationBinding = {
  baseCommit: string
  workspace: string
  command: string
  environmentIdentity: string
  messageID: string
  repairID?: string
  profileRevisionID?: number
  scope: string[]
}

function stringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry): entry is string => typeof entry === "string") &&
    new Set(value).size === value.length
  )
}

/** A recorded permission set remains compatible when the live scope only adds permissions. */
export function preparationScopeContinues(recorded: unknown, current: unknown): boolean {
  if (!stringList(recorded) || !stringList(current)) return false
  const currentScope = new Set(current)
  return recorded.every((path) => currentScope.has(path))
}

/** Scope may only grow; every execution and environment identity remains exactly pinned. */
export function preparationBindingContinues(
  recorded: unknown,
  current: PreparationBinding,
): boolean {
  if (typeof recorded !== "object" || recorded === null || Array.isArray(recorded)) return false
  const previous = recorded as Partial<PreparationBinding>
  if (
    previous.baseCommit !== current.baseCommit ||
    previous.workspace !== current.workspace ||
    previous.command !== current.command ||
    previous.environmentIdentity !== current.environmentIdentity ||
    previous.messageID !== current.messageID ||
    previous.repairID !== current.repairID ||
    previous.profileRevisionID !== current.profileRevisionID ||
    !preparationScopeContinues(previous.scope, current.scope)
  )
    return false
  return true
}
