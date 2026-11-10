# Provider budget widget

LZ-194 follows the user's updated `/key` authority: useful **configured-key**
OpenRouter tracking, not the provisional unavailable-only/account-wide target.
No analytics access or new credential is required.

## Use

Open plugin settings → **Provider budget**. The widget defaults off. Enable it,
choose OpenCode Go or OpenRouter, choose Go monthly/rolling 5-hour, and set a
positive finite weekly USD budget (default $300). Settings use the host's durable
global store and update mounted headers. The header button opens these settings;
Tab focuses it, Enter/Space activates it, and the host tooltip supplies details.
Compact headers retain the ring/button and accessible description, not the label.

- **Go:** reads `https://opencode.ai/zen/go/v1/usage` through configured
  `opencode-go` key access. Selected percentage is provider-reported, not derived
  dollars. Tooltip includes both percentages and reset times. Raw percentages
  drive yellow at 60% and red at 90%; geometry alone caps at 100%.
- **OpenRouter:** reads `https://openrouter.ai/api/v1/key`, taking only lifetime
  `data.usage` and `data.byok_usage` counters. After baseline acquisition, the
  widget shows their observed deltas as whole-dollar total, with separately rounded
  credit/BYOK tooltip components. The ring uses the unrounded sum / weekly budget.
  `$181` has no suffix. Separate native JSX tooltip lines give credit/BYOK amounts,
  configured-key scope, baseline time, unknown earlier usage and local reset.
  It is not a full-week or account-wide total. Rounding components separately need
  not equal rounded total. Go tooltip lines retain both periods and reset times;
  accessible button labels stay short instead of repeating the tooltip.
- **Unknown:** a dash/neutral ring means loading, first observation, disconnected,
  missing access, invalid data or failed read. It never means zero. A later valid
  observation with unchanged counters may truthfully show `$0` since its baseline.

## Sunday-local and persistence

The renderer supplies its computer-local Sunday 00:00 → next Sunday 00:00 interval
and IANA timezone on each read. Calendar date arithmetic handles 167/169-hour DST
weeks. No UTC Monday or provider `usage_weekly` fields are used. The active polling
lease refreshes at the earlier of one minute or the Sunday boundary. It rejects a
response acquired across a local-week/timezone change.

Private server plugin storage retains
`budget.baseline.<one-way-key-identity>.<one-way-timezone-identity>`:
period, timezone, observation timestamp, baseline and latest credit/BYOK counters.
It contains no credential values. A restart in the same week resumes that baseline.
Different local timezones retain separate baselines, so alternating clients cannot
overwrite one another. A timezone without prior coverage starts a fresh baseline;
returning to a previously tracked timezone can resume its same-week coverage.
Legacy unscoped baselines are left unused rather than guessing their timezone ownership.
First midweek observation, missed Sunday, clock reversal or counter
rollback starts a new baseline and **does not allocate a cross-boundary delta** to
the new week. A replacement key has a different baseline identity. Unknown earlier
spend remains unknown. Turning the widget off does not run a boundary collector;
re-enabling after a missed Sunday starts fresh observed coverage.

Exact historic Sunday totals and account-wide credit-plus-BYOK qualification remain
unresolved and are **not claimed** by this configured-key feature. Key spending
limits, lifetime totals themselves, UTC weekly counters and account credits never
masquerade as this week's observed spending.

## Security and lifecycle

Provider requests run only in the trusted server adapter using public
`integration.connection.active/resolve`. Canonical HTTPS origins are fixed;
redirects are rejected. RPC replies carry only validated percentages, deltas,
coverage times and fixed safe messages. No raw authorization/error payload is
logged, returned, snapshotted or retained. Reads do not invoke inference, configure
credentials, or alter valuation, Models, workers or enforcement.

Visible active headers share one polling lease/event subscription per live server
client/provider. Backend reads coalesce/cache for one minute per credential and
local period. Each backend reader has its own cancellable wait; the provider/storage
operation uses a separate signal and survives cancellation of its first caller
while another reader remains. The last cancelled reader aborts and evicts pending
work; it cannot poison the next request's cache. Hidden/disabled/disposed consumers release their leases, abort work,
and stop timers. Reconnect/client replacement clears previous view state; credential
events invalidate it; backend re-resolves identity before returning in-flight data.
Polling also recovers after ordinary read/event-stream failures. Failed reads discard
numeric UI state instead of leaving an apparently current value.

## Checks and observed evidence

Run from the repository:

```sh
bun run verify
bun test src/budget test/budget-widget
bun run build:gui
bun test/budget-widget/live-probe.ts
```

The explicit live probe discovers the already running service, reuses active
configured credentials only in the backend process, and makes read-only usage
requests. It prints sanitized usage facts, never credentials or raw responses.
It does not deploy/reload a plugin, modify settings, retain baseline receipts or
perform inference. On this run Go reported monthly **20%**, rolling **0%**, with
provider reset times. OpenRouter supplied valid credit/BYOK counters; two real
observations yielded **$0 credit + $0 BYOK since the probe baseline**, not zero
earlier weekly spending. Nonzero tracking is covered by fixtures, not fabricated
as live account usage.

Behavior tests cover native registration/reactive controls/compact form/focus,
nonzero $181 tracked total and both components, raw thresholds, invalid data,
transport origins/no redirects, sharing/abort/retry, durable baseline restart,
rotation, in-flight connection replacement, rollback, Sunday and DST changes.
Registered RPC regressions also cancel the first of two readers, cancel the last
reader and retry, and alternate Detroit/Tokyo readers across registration restarts.
GUI regressions check suffix-free values and distinct JSX tooltip data-point nodes;
mock-tooltip DOM assertions are not native host visual acceptance. No additional
live provider read was needed for this repair: transport and access are unchanged.
See `design/reviews/budget-widget/README.md` for rendered fixture observations and
the explicit remaining native visual-review boundary.
