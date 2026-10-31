# Jevspresso and LAZERS

Reviewed 2026-10-31. Primary source: https://github.com/statelyai/jevspresso (README fetched directly from its main branch). This example uses XState v6 and `@xstate/jev`; LAZERS currently pins XState v5.33.3 and does not install that integration.

The useful pattern is a closed set of events: enumerate actions the machine currently accepts, ask a decision model to choose, then recheck the event against current state before applying it. Its agent supplies the predicted transition as decision context. Order parsing and genuinely ambiguous orders are separate decision boundaries. Seeded scenarios compare correctness and cost across models.

LAZERS applies this at orchestration decisions, such as choosing among admitted repair/replan actions. The runtime still owns readiness, budgets, dispatch, effect reconciliation, verification and acceptance. A small model may advise among legal alternatives; it cannot manufacture events, establish completion, or replace deterministic policy. Recheck expected versions and allowed actions transactionally after inference. Ordinary progress needs no decision-model call.

The existing local System One implementation belongs to the parallel WebGPU work. Reuse its typed decisions when a concrete decision boundary warrants inference; do not add another local inference service or routine supervisor loop. Evaluate it on held-out task scenarios with correctness, accepted work, tokens, latency and dated equivalent API prices.
