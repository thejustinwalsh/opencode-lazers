import type { JSX } from "solid-js"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { DelegatedAgentCapacitySettings } from "../../src/runner/delegated-agent-capacity-settings.tsx"
import type { DelegatedAgentStatus } from "../../src/runner/delegated-agent-capacity.ts"

export type ConfigureInput = { sessionID: string; expectedRevision: number; limit: number }
export type ConfigureResult =
  | {
      status: "updated"
      settings: { projectDirectory: string; revision: number; limit: number }
    }
  | {
      status: "conflict"
      expectedRevision: number
      currentRevision: number
      current: { projectDirectory: string; revision: number; limit: number }
    }
export type CapacityClient = {
  rpc: (_definition: unknown) => {
    read: (
      input: { sessionID: string },
      options: { signal: AbortSignal },
    ) => Promise<DelegatedAgentStatus>
    configure: (input: ConfigureInput, options: { signal: AbortSignal }) => Promise<ConfigureResult>
  }
}
export type TestSession = {
  id: string
  key: string
  tab: string
  visit: object
  pending: boolean
  directory: string
  location?: { directory: string }
  server: { id: string; connected: boolean; client: CapacityClient }
}

const Button = (props: { disabled?: boolean; onClick?: () => void; children: JSX.Element }) => (
  <button type="button" disabled={props.disabled} onClick={props.onClick}>
    {props.children}
  </button>
)

export function harness(root: HTMLElement, initialSession?: TestSession) {
  const [session, setSession] = createSignal<TestSession | undefined>(initialSession)
  const context = {
    signal: new AbortController().signal,
    sessions: { current: session },
    ui: { Button },
  }
  const dispose = render(() => <DelegatedAgentCapacitySettings context={context as never} />, root)
  return { dispose, setSession }
}
