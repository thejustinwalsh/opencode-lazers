interface TransitionStore {
  record(...args: unknown[]): void
  recordOnce(...args: unknown[]): void
  revisePlan(...args: unknown[]): void
  move(...args: unknown[]): void
}

declare const store: TransitionStore
declare const enabled: boolean

const CONSTANT_EVENT = "CONSTANT_EVENT"
const TYPED_CONSTANT_EVENT: string = "TYPED_CONSTANT_EVENT"
store.record("plan", null, CONSTANT_EVENT, {})
store.record("plan", null, TYPED_CONSTANT_EVENT, {})
store.recordOnce("plan", null, "ONCE_EVENT", {})
store.revisePlan({ id: "plan" }, {}, "PLAN_EVENT", {})
store.move("plan", "task", "MACHINE_EVENT")
store.record("plan", null, enabled ? "CONDITIONAL_START" : "CONDITIONAL_STOP", {})
store.record("plan", null, "UNLABELLED_EVENT", {})

class RuntimeFixture {
  constructor(private readonly writer: TransitionStore) {}

  renewalEvent(_renewal: unknown, event: string) {
    this.writer.record("plan", null, event, {})
  }

  renewalIssue(_renewal: unknown, event: string) {
    this.writer.record("plan", null, event, {})
  }

  outcomeState(_message: unknown, _state: string, _receipt: unknown, event: string) {
    this.writer.record("plan", null, event, {})
  }

  workerEvent(_plan: unknown, _attempt: unknown, event: "WORKER_STARTED" | "WORKER_STOPPED") {
    this.writer.record("plan", null, event, {})
  }

  move(_row: unknown, _to: unknown, _patch: unknown, event?: string) {
    if (event) this.writer.record("plan", null, event, {})
  }
}

const runtime = new RuntimeFixture(store)
runtime.renewalEvent(null, "RENEWAL_WRAPPED_EVENT")
runtime.renewalIssue(null, "RENEWAL_ISSUE_EVENT")
runtime.outcomeState(null, "delivered", null, "OUTCOME_WRAPPED_EVENT")
runtime.workerEvent(null, null, "WORKER_STARTED")
runtime.move(null, null, null, "TAKEOVER_WRAPPED_EVENT")
