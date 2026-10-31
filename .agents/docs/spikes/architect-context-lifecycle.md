# Architect lifecycle follow-up — held

Task `239f45a9-3247-4cba-b339-19c8267d0800` is queued in draft plan
`8253ff59-57a5-45fd-8847-acd971438af8`. It has not run. Keep it behind scheduler
integration, supported native reload and actionable wake-up verification. Its
execution baseline must preserve intervening reviewed work.

The user selected a configurable **30-minute** idle default; busy/recent Architects
are reused. Durable handoff and current-owner transfer precede native archival.
No automatic old-transcript summary is permitted. Input/ownership safety during
renewal is unproven on the pinned host API; if it cannot be established, retain
the live owner and block archival rather than lose input. Exact-artifact native
dogfood must observe input/outcome races, archive visibility, workers continuing,
wake-context size and public cache usage before acceptance.

## Cache research, checked 2026-10-31

[Official OpenAI prompt caching, cache lifetime](https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime)
states that GPT-5.6 and later, including GPT-6.1 Sol, use a default `30m` minimum
cache lifetime in the Responses API; a qualifying 30-minute read refreshes that
coverage. It also states that maintaining a session does not guarantee a cache
hit and that minimum lifetime does not guarantee tensor reuse or lower latency.
This supports the initial timing heuristic, not an exact idle expiry/cache miss
equivalence. ChatGPT/subscription-route retention remains **unverified**. Do not
change inference configuration or claim API billing rates apply to that route.
