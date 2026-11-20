export const unrelatedConfig = {
  application: "LAZERS",
  secretName: "PRIVATE_API_KEY",
  transitionPrefix: "SCOPE_",
  outcomePrefix: "OUTCOME_",
}

const runtimePrefix = `WORKER_${"STARTED"}`
void [unrelatedConfig, runtimePrefix, "CONFIG_ONLY_VALUE"]
