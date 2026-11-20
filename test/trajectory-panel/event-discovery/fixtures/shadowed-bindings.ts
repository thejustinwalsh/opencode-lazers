interface TransitionStore {
  record(...args: unknown[]): void
}

declare const store: TransitionStore

const event = "PRIVATE_API_KEY"
const localConstant = "SCOPED_CONSTANT_EVENT"
store.record("plan", null, localConstant, {})

function recordWithShadowedEvent(event: string) {
  store.record("plan", null, event, {})
}

void [event, recordWithShadowedEvent]

export {}
