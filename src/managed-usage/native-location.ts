import { nativeObject } from "./native-facts.ts"

export type ManagedUsageLocation = {
  directory: string
  workspaceID: string | null
}

export function managedUsageLocation(value: unknown): ManagedUsageLocation | null {
  const location = nativeObject(value)
  const directory = location?.directory
  const workspaceID = location?.workspaceID
  if (
    typeof directory !== "string" ||
    !directory.length ||
    (workspaceID !== undefined &&
      workspaceID !== null &&
      (typeof workspaceID !== "string" || !workspaceID.length))
  )
    return null
  return { directory, workspaceID: typeof workspaceID === "string" ? workspaceID : null }
}

export function managedUsageEventLocation(event: unknown): ManagedUsageLocation | null | undefined {
  const envelope = nativeObject(event)
  if (!envelope || envelope.location === undefined) return undefined
  return managedUsageLocation(envelope.location)
}

export function sameManagedUsageLocation(left: ManagedUsageLocation, right: ManagedUsageLocation) {
  return left.directory === right.directory && left.workspaceID === right.workspaceID
}

export function managedUsageLocationKey(location: ManagedUsageLocation) {
  return JSON.stringify([location.directory, location.workspaceID])
}
