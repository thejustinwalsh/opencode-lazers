export const unrelatedConfig = {
  application: "LAZERS",
  secretName: "PRIVATE_API_KEY",
  transitionPrefix: "SCOPE_",
  outcomePrefix: "OUTCOME_",
}

const runtimePrefix = `WORKER_${"STARTED"}`
const event = "PRIVATE_API_KEY"
void [unrelatedConfig, runtimePrefix, event, "CONFIG_ONLY_VALUE"]
