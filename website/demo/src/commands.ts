import type { DemoCommand } from "../../src/lib/demo-protocol.ts"

type Handlers = {
  /** Start or resume playback; absent for a settled (still) frame. */
  play?: () => void
  pause?: () => void
  /** Show another chapter: the page reloads at it. */
  seek: (chapter: string) => void
}

/** Parent commands to the frame. A settled frame has no playback but still seeks to a chapter. */
export function handleCommand(command: DemoCommand | undefined, handlers: Handlers) {
  if (!command?.demo) return
  if (command.type === "play") handlers.play?.()
  else if (command.type === "pause") handlers.pause?.()
  else if (command.type === "seek") handlers.seek(command.chapter)
}
