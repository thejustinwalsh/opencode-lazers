import {
  createDirectAnalysisTestLifetime,
  runWithDirectAnalysisTestLifetime,
} from "./direct-analysis-test-context.ts"

const activeTestLifetimes = new Map<
  ReturnType<typeof createDirectAnalysisTestLifetime>,
  Promise<unknown>
>()

type TestOptions = {
  timeout?: number
  retry?: number
  repeats?: number
}

type TestRegistrar = (
  label: string,
  callback: () => void | Promise<unknown>,
  options?: number | TestOptions,
) => void

export async function closeOutstandingDirectAnalysisTestLifetimes(): Promise<void> {
  const outstanding = [...activeTestLifetimes]
  for (const [lifetime] of outstanding) lifetime.close()
  await Promise.allSettled(outstanding.map(([, completion]) => completion))
}

export function createDirectAnalysisTestRegistrar(register: TestRegistrar): TestRegistrar {
  return (label, callback, options) => {
    register(
      label,
      () => {
        const lifetime = createDirectAnalysisTestLifetime()

        let completion: Promise<unknown>
        try {
          completion = Promise.resolve(runWithDirectAnalysisTestLifetime(lifetime, callback))
        } catch (error) {
          completion = Promise.reject(error)
        }

        // Attach the test callback to the lifetime race before cleanup closes the lifetime. If
        // cleanup closes it first, the expiration signal can win the race and hide a real failure.
        const bodyCompletion = lifetime.waitForBodyCompletion(completion)
        const observedCompletion = completion.finally(async () => {
          lifetime.close()
          await lifetime.drain()
        })
        void observedCompletion.catch(() => {})
        const callbackCompletion = bodyCompletion.then(async (outcome) => {
          if (outcome.kind === "expired") return
          await observedCompletion
          if (outcome.kind === "failed") throw outcome.error
          return outcome.value
        })
        // Bun may stop awaiting this callback at its timeout. The actual completion remains
        // observed and drained by `observedCompletion`, including failures after that timeout.
        void callbackCompletion.catch(() => {})
        activeTestLifetimes.set(lifetime, observedCompletion)
        void observedCompletion.then(
          () => activeTestLifetimes.delete(lifetime),
          () => activeTestLifetimes.delete(lifetime),
        )
        // Bun stops awaiting a timed-out test callback before its async work unwinds. Resolve its
        // registered callback when teardown expires the lifetime; keep the real completion
        // observed and drained separately so late callback errors cannot escape between tests.
        return callbackCompletion
      },
      options,
    )
  }
}
