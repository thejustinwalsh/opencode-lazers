# Budget widget review

## Reproduce the isolated rendered fixture

Use `test/budget-widget/visual.ts` through the repository's Portless workflow,
for example `portless run --name lazers-budget bun test/budget-widget/visual.ts`.
Open the HTTPS URL printed by Portless (this run:
`https://lazers-budget.localhost:1355`). Stop only that fixture process afterwards.
This renders the real budget module; its host tooltip/switch and theme variables
are isolated representative fixtures. It does not access providers, installed
plugin stores, inference, or the separately owned native probe UI.

Cases include light/dark, Go 60%, Go 112.3% rolling with compact icon-only header,
OpenRouter nonzero tracked credit $120.4 + BYOK $60.2 (whole total `$181*`), first
observation neutral/dash, and a 360px settings card. Two headers per case exercise
shared reads. The star's tooltip gives configured-key scope and since-baseline
time; it is not an account-wide weekly claim.

## Observed

- Browser rendered all six cases at a 1000px viewport. Each light/dark card had
  `clientWidth = scrollWidth = 360`; no card overflow.
- Both OpenRouter theme cases rendered `$181*`, yellow raw 60.2% ring, and accessible
  descriptions containing `Credits $120 · BYOK $60`, coverage timestamp and local
  Sunday interval in America/Detroit.
- Go compact case retained an accessible 112% selected value with a capped full
  circle, red tone, alternate monthly percentage and both provider reset times.
- Initial OpenRouter tracking rendered a dash and neutral ring, not a numeric zero.
- The DOM behavior test exercises live enable/disable, provider/mode/budget changes,
  keyboard-focusable settings action, compact labels, reconnect and store reopen.

## Review boundary

The Desktop browser disconnected during capture, before a screenshot was retained.
No screenshot or native theme/tooltip visual sign-off is claimed. The isolated
fixture uses real module rendering but mocked host tooltip/switch surfaces; actual
installed Desktop context-widget adjacency, native tooltip keyboard presentation,
and final theme appearance remain Architect's native visual review. No main
settings, core UI, owned probe lifecycle or root hooks/guidance were changed to
obtain this evidence.
