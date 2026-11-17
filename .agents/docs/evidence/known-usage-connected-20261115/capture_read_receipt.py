"""Read-only connected acceptance receipt; uses supported authenticated CLI only.

No credentials, task prose, contributors, messages, or raw contexts are retained.
"""

import datetime
import json
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).parent
DIRECTORY = "/Users/tjw/Documents/ChatGPT/opencode-lazers"
LOCATION = "?location[directory]=%2FUsers%2Ftjw%2FDocuments%2FChatGPT%2Fopencode-lazers"
SESSION = "ses_e568438ebffeaoFbF9nBb942XM"
BASE = {
    "sessionID": SESSION,
    "schemaVersion": 2,
    "scope": {"projectDirectory": DIRECTORY},
    "filters": {"persona": None, "taskKind": None, "period": {"from": None, "to": None}},
}


def read(method, additions=None):
    start = time.monotonic()
    result = subprocess.run(
        [
            "opencode", "api", "post",
            f"/api/rpc/lazers.models.decision.v2/{method}{LOCATION}",
            "--data", json.dumps({"input": {**BASE, **(additions or {})}}),
        ],
        text=True, capture_output=True, check=True, timeout=90,
    )
    data = json.loads(result.stdout)
    return data["output"], round((time.monotonic() - start) * 1000)


label = sys.argv[1]
if label not in {"before-refresh", "after-refresh"}:
    raise SystemExit("Expected before-refresh or after-refresh")
overview, elapsed = read("overview")
snapshot = overview["context"]["snapshotID"]
configurations, configuration_elapsed = read("configurations", {"snapshotID": snapshot, "limit": 100})
targets = {
    ("opencode-go", "kimi-k3.1-pro", "high"),
    ("opencode-go", "qwen3.8-flash", "medium"),
    ("openai", "gpt-6-luna", "max"),
}
receipt = {
    "recordedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "transport": "opencode api; existing managed service; authenticated discovery",
    "sessionID": SESSION,
    "scope": BASE["scope"],
    "filters": BASE["filters"],
    "overviewElapsedMs": elapsed,
    "configurationsElapsedMs": configuration_elapsed,
    "context": overview["context"],
    "configurationCount": overview["configurationCount"],
    "configurationContextMatches": configurations["context"] == overview["context"],
    "configurationPageComplete": configurations["nextCursor"] is None,
    "inspections": [],
}
for configuration in configurations["configurations"]:
    route = configuration["route"]
    if (route["providerID"], route["modelID"], route["variant"]) not in targets:
        continue
    inspection, inspection_elapsed = read("inspect", {
        "snapshotID": snapshot,
        "configurationID": configuration["configurationID"],
        "contributorLimit": 1,
        "selectedTaskID": None,
    })
    retained = {key: inspection.get(key) for key in [
        "status", "cohort", "efficiency", "estimate", "referenceEstimate", "knownUsageMarket",
    ]}
    retained.update({
        "configurationID": configuration["configurationID"],
        "route": route,
        "elapsedMs": inspection_elapsed,
        "contextMatches": inspection["context"] == overview["context"],
    })
    receipt["inspections"].append(retained)
destination = ROOT / f"{label}-api.json"
destination.write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps({
    "receipt": str(destination),
    "snapshotID": snapshot,
    "inspections": [{"route": x["route"], "status": x["status"], "knownUsageMarketStatus": (x.get("knownUsageMarket") or {}).get("status")} for x in receipt["inspections"]],
}))
