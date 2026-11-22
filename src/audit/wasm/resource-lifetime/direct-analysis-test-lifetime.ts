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

        const observedCompletion = completion.finally(async () => {
          lifetime.close()
          await lifetime.drain()
        })
        void observedCompletion.catch(() => {})
        activeTestLifetimes.set(lifetime, observedCompletion)
        void observedCompletion.then(
          () => activeTestLifetimes.delete(lifetime),
          () => activeTestLifetimes.delete(lifetime),
        )
        // Bun stops awaiting a timed-out test callback before its async work unwinds. Resolve its
        // registered callback when teardown expires the lifetime; keep the real completion
        // observed and drained separately so late callback errors cannot escape between tests.
        return lifetime.waitForBodyCompletion(observedCompletion)
      },
      options,
    )
  }
}
