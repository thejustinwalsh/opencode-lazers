import {
  createDirectAnalysisTestLifetime,
  runWithDirectAnalysisTestLifetime,
} from "./direct-analysis-test-context.ts"

const activeTestLifetimes = new Set<ReturnType<typeof createDirectAnalysisTestLifetime>>()

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

export function closeOutstandingDirectAnalysisTestLifetimes(): void {
  for (const lifetime of activeTestLifetimes) lifetime.close()
  activeTestLifetimes.clear()
}

export function createDirectAnalysisTestRegistrar(register: TestRegistrar): TestRegistrar {
  return (label, callback, options) => {
    register(
      label,
      () => {
        const lifetime = createDirectAnalysisTestLifetime()
        activeTestLifetimes.add(lifetime)

        let completion: Promise<unknown>
        try {
          completion = Promise.resolve(runWithDirectAnalysisTestLifetime(lifetime, callback))
        } catch (error) {
          completion = Promise.reject(error)
        }

        const observedCompletion = completion.finally(() => {
          lifetime.close()
          activeTestLifetimes.delete(lifetime)
        })
        // Bun may stop awaiting a timed-out callback while its async body is still unwinding.
        void observedCompletion.catch(() => {})
        return lifetime.waitForBodyCompletion(observedCompletion)
      },
      options,
    )
  }
}
