interface TransitionStore {
  record(...args: unknown[]): void
}

declare const store: TransitionStore

function findFence(text: string) {
  return text.matchAll(/`+/g)
}

void findFence
store.record("plan", null, "AFTER_REGEX_EVENT", {})

export {}
