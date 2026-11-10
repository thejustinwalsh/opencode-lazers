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
OpenRouter nonzero tracked credit $120.4 + BYOK $60.2 (whole total `$181`), first
observation neutral/dash, and a 360px settings card. Two headers per case exercise
shared reads. Native JSX tooltip content uses separate data-point lines for rounded
credit/BYOK, configured-key scope, baseline time and reset, with no value suffix.
It is not an account-wide weekly claim.

## Initial browser observations (before retained repair)

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

## Retained repair evidence

The registered fixture now asserts suffix-free `$181`, separate JSX tooltip nodes
for `Credits $120`, `BYOK $60`, configured-key baseline coverage, unknown earlier
usage and reset. Go retains separate monthly/5-hour lines with reset times. Compact
mode retains useful short accessible labels instead of the old long paragraph.
The tooltip content uses grid rows, bounded width and wrapping with inherited
typography; its fixture host now mounts JSX content rather than a string attribute.

Backend registered-RPC cases exercise first-caller cancellation with a remaining
reader, last-reader cancellation and retry, and independent Detroit/Tokyo durable
baselines across registration restart. Existing entry-point wiring is unchanged.
Native visual/integration review still belongs to Architect; these mock-host DOM
assertions do not establish actual native tooltip line layout or final theme fit.

Retained repair checks passed: `bun run verify`,
`bun test src/budget test/budget-widget` (14 tests, 130 assertions), and
`bun run build:gui`. No extra live probe or Desktop interaction was performed;
provider adapters/access and entry-point wiring are unchanged.
