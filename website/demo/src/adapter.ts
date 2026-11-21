/** One recorded read and the contract schema that must accept it. */
export interface Read {
  label: string
  schema: { "~standard": { validate(value: unknown): unknown } }
  value: unknown
}

export type Emit = (type: string, data: unknown) => void

/**
 * What a panel needs from the stand-in host. The host builds the plugin context OpenCode Desktop
 * would, calls the real `setup*Panel`, and mounts the registered Panel; the adapter supplies the
 * panel's setup call and answers its reads from the story's current data.
 */
export interface PanelAdapter<D> {
  panelID: string
  tabTitle: string
  project: { canonical: string; id: string }
  /** Calls the real panel setup with the host context (it registers the Panel and Styles). */
  setup(ctx: never, host: { openPanel(id: string): void }): void
  /** Answers by contract id then method; read from `data()` at call time. */
  rpc(data: () => D): Record<string, Record<string, (input: never) => unknown>>
  /** Emits the events a real service would after `data` changed (the panel re-reads on them). */
  changed(data: D, emit: Emit): void
  /** Every contract-shaped value the data answers, for build-time validation. */
  reads(data: D): Read[]
  /** Optional initial values of the plugin's stores (view state), by store name. */
  stores?: Record<string, unknown>
}
