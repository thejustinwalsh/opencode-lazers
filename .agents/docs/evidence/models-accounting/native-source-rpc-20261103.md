# Registered Models source RPC observation

2026-11-03, 16:28 UTC. Observed installed Main: `9fff29bfc9fcfc6379030ae2ddcf70bdb6f89777`, including parser correction `17a5582` and public namespace change `9736261`.

This is current-source native RPC evidence, not an observation of the original LZ-77 artifact `8ebdce96529d8ec154905e2b9d20211c6818dba1` in isolation.

## Supported native path

Used the pinned Desktop CLI's authenticated `api post` operation against internal RPC `lazers.models`. Its internal ID is intentionally unchanged by the public-tool rename. Location was explicitly selected with the pinned protocol's `location[directory]` query parameter. Session: `ses_e68a9ed37ffeVqzPWRXN5SB7Uw`; project directory: `/Users/tjw/Documents/ChatGPT/opencode-lazers`.

An initial request using a plain `directory` query parameter selected the wrong location and was rejected with `Models scope is unavailable`. Correcting the deep-object location parameter succeeded; no authorization rule was changed.

1. `sourceEvidence`, limit 1: all three sources initially reported `never`, generation 0, no snapshot.
2. `refreshSources`: all three sources succeeded at generation 1.
3. Three separate `sourceEvidence` requests reopened the retained snapshot IDs, each with limit 1 and continuation cursor `1`.

| Source                | Snapshot ID                            | Records | Retrieved at               |
| --------------------- | -------------------------------------- | ------: | -------------------------- |
| Native catalog        | `dfb59d1b-6df3-407d-b507-65fea14632bf` |     471 | `2026-11-03T16:28:13.140Z` |
| OpenRouter models     | `19491c63-c474-47f4-ac49-fb465690592a` |     415 | `2026-11-03T16:28:13.570Z` |
| OpenRouter benchmarks | `b8bc0b2f-d2bf-4369-acb3-1d790157ca03` |     152 | `2026-11-03T16:28:13.542Z` |

Benchmark metadata retained Artificial Analysis coding provenance, source-as-of `2026-11-03T00:00:15.011Z`, version `v1`, citation and source URL. Effort remained unknown where not supplied.

Reopened native prices remained USD per million tokens; OpenRouter model prices remained USD per token. Missing cache-write pricing remained null rather than becoming zero. External benchmarks were not treated as LAZERS task outcomes.

No inference was requested. Credentials were resolved only by the installed server adapter; no keys, authorization headers or credential configuration were read, copied or saved by the Architect. The intentional writes were normal source-cache refreshes through the registered API, not direct database mutations.

## Acceptance boundary

Current-source refresh, bounded cached reads and per-call store reopening are observed. This does not prove comparison UI, historical task-cost estimates or a service-restart persistence ceremony.

The source RPC closes its store after each call, so the three independent reads exercise reopening rather than retaining one reader object.

A supported descendant-adoption request for LZ-77, plan `c5ff050c-0b5b-4f22-8b48-f729e26f4d94` v12, named its exact accepted attempt/artifact and current Main. It was refused with **“A conflicting worker prevents descendant adoption.”** The new comparison-read worker owns overlapping Models source scope. No worker was stopped, no scope was expanded, and no adoption or human-acceptance receipt was fabricated.

The original plan remains blocked. Do not attach this current-source observation to the old artifact as though that old artifact was the installed candidate. Revisit supported binding after the conflicting work settles; preserve the original attempt/tree/history and all remaining runtime guards.
