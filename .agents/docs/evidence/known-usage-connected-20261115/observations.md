# Connected known-usage acceptance probe — partial / native gate blocked

Observed on local 2026-11-15 (API timestamps are 2026-11-16 UTC). No implementation,
commits, model inference, route/settings/config changes, lifecycle changes, reload,
restart, extra Desktop profile, permission grant, or direct database access.

## Identity and access

- Existing supported `opencode service status`: `http://127.0.0.1:49374`.
- Authenticated `opencode api get /api/info`: OpenCode **2.2.6**, PID **77332**,
  unchanged at the end. No service credential was read or printed.
- Native window title: `LAZERS roadmap and renewal-context fix · OpenCode`.
  Exact title search followed by `session.get` confirmed
  **ses_e568438ebffeaoFbF9nBb942XM**, Architect, project directory
  `/Users/tjw/Documents/ChatGPT/opencode-lazers`. Its selected native route was
  `openai/gpt-6.1-sol#high`; it was not changed.
- Explicit `location.get` confirmed canonical project ID
  `b5da4cadd97e51f2f6c88ff71daa1006f6a5b7df`. The API's unqualified default location
  is `/Users/tjw`, so every feature read explicitly supplied the confirmed project.
- Project-scoped `plugin.list` reports `lazers` active, local source path
  `/Users/tjw/Documents/ChatGPT/opencode-lazers`, server and GUI features present.
  Disk HEAD was **50d5aea8a6180d2c2428308b77e716eb8238592b**; both requested commits
  are HEAD ancestors. The inventory does **not** expose an exact loaded server
  module revision or GUI bundle commit, so those identities remain unknown.
- System Events accessibility was available but exposed only native window groups,
  not rendered controls. Native menu/window operations worked. Normal CoreGraphics
  mouse clicks (explicit click state and separated down/up) and wheel events worked.
  No JavaScript, DevTools, private app hooks, or implementation handlers were used.

## Actual Refresh and read evidence

Opened the existing Models tab through native mouse input, then clicked its actual
**Refresh** once. Qwen medium selection remained. The Sources disclosure showed
freshly retrieved counts matching the supported authenticated `sourceEvidence`
read:

| Source            | State     | Generation | Records | Retrieved UTC |
| ----------------- | --------- | ---------: | ------: | ------------- |
| Native catalog    | succeeded |        255 |     482 | 01:39:35.405  |
| OpenRouter models | succeeded |        255 |     432 | 01:39:36.054  |
| Coding benchmarks | succeeded |        255 |     153 | 01:39:35.589  |
| Kimi endpoints    | succeeded |        110 |      24 | 01:39:35.489  |
| Qwen endpoints    | succeeded |        110 |       2 | 01:39:35.514  |
| Luna endpoints    | succeeded |        110 |       8 | 01:39:35.490  |

`before-refresh-api.json` and `after-refresh-api.json` retain only allowlisted
overview context and three inspections, excluding contributors, task prose,
messages and native reported charges. Reads used registered production
`lazers.models.decision.v2` RPC over `opencode api`, not direct handlers. Configuration
IDs were discovered from the complete configurations page, not invented. All
three inspections and configurations matched their pinned overview context.

After-refresh snapshot:
`models-decision-v2:a97c7ad7-8ccb-4978-b6d7-20a89a6d6267`.

### Returned knownUsageMarket — not endpoint-specific scenarios

All three inspections returned scenario ID **configured-current-market**. They did
**not** return `kimi-moonshot-mxfp4`, `qwen-alibaba`, or `luna-openai-standard`.
This is a substantive limit on the requested exact-endpoint acceptance, not a
claim that the endpoint source was unavailable: the refreshed endpoint records
actually contain the requested providers/tags.

| Exact execution route              | Status  | Amount / subtotal USD                                          | Returned pricing provenance                                                                                    |
| ---------------------------------- | ------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `opencode-go/kimi-k3.1-pro#high`   | exact   | 3.0050338                                                      | native-catalog quote; provider null; tag `kimi-k3.1-pro`; service tier null                                    |
| `opencode-go/qwen3.8-flash#medium` | exact   | 0.181143852                                                    | native-catalog quote; provider null; tag `qwen3.8-flash`; service tier null                                    |
| `openai/gpt-6-luna#max`            | partial | full value/range null; known subtotal 61.16300958–116.84775616 | OpenRouter model **average**, not an endpoint quote; provider null; tag `openai/gpt-6-luna`; service tier null |

Kimi and Qwen provenance pins native snapshot
`cf5a836f-0c3c-4b95-8eb1-d380acee4d1b`, generation255, records34/142. Luna pins
OpenRouter model snapshot `87aee915-e45d-4765-8e89-7306d55d3103`, generation255,
record74. All say refresh succeeded / current at capture time. Missing provider
or service tier was not filled from a different source.

Returned rate sets (USD/token, order input / completion / cache-read / cache-write):

- Kimi default: `0.000002 / 0.00001 / 0.0000002 / 0.000002`.
- Qwen default: `0.00000015 / 0.00000047 / 0.000000016 / 0.0000002`.
- Luna base: `0.0000001 / 0.0000005 / 0.00000001 / 0.000000125`;
  prompt override **greater than272000 per call**:
  `0.0000002 / 0.00000075 / 0.00000002 / 0.00000025`.

Kimi/Qwen tier attribution is `not-required / single-published-rate-scenario`,
callCount0. Luna is **unresolved / aggregate-tier-envelope**, callCount0; both
tiers retained, no exact per-call tier assignment claimed.

### Usage and retry coverage

Categories below are retained observed tokens, not predicted use. Order:
uncached input / output / reasoning / cache-read / cache-write.

- Kimi: **11629 /32156 /15151 /10595369 /194816**. Two of two sessions and
  attempts route-matched/included; complete usage2/2; one retry, no failed attempts.
- Qwen: **582 /52040 /0 /6330547 /276545**. One of one session/attempt
  route-matched/included; complete usage1/1; no retries or failed attempts.
- Luna: **100562423 /6650010 /15263042 /4015024128 /0**.190/192 sessions and
  attempts matched/included; two unknown-route attempts;29 failed attempts,47
  retries; complete usage190/192, failed29/29, retry46/47. Thus subtotal only.
- All three explicitly say `known-route-matched-retained-usage`,
  `wholeTaskBound:false`; no actual-charge or complete-task bound is inferred.

### Endpoint and caching caveats

`refreshed-source-evidence.json` retains public source status and endpoint pricing
records only. The matching refreshed standard records are present:

- **Moonshot AI / moonshotai/mxfp4 / serviceTier:null**: prompt2e-6,
  completion1e-5, cache-read2e-7; no endpoint cache-write field. The retained,
  exact-scoped documentation policy supports cache-write zero, retrieved
  **2026-11-05T23:11:25.854Z**. Its policy documentation is older than the endpoint
  refresh, not newly refetched by this probe. `supportsImplicitCaching:true`.
- **Alibaba / alibaba / serviceTier:null**, Qwen: prompt1.5e-7,
  completion4.7e-7, cache-read1.6e-8, cache-write2e-7.
  `supportsImplicitCaching:false` despite published cache prices.
- **OpenAI / openai / serviceTier:null**, Luna: base/272000 override rates
  retained, `supportsImplicitCaching:false`.

The actual knownUsageMarket Kimi scenario instead uses a **native quote** with
nonzero cache-write2e-6. It does not demonstrate the Moonshot scoped-zero policy.
Qwen's visible evidence correctly says the native quote does not establish
general cache-write capability or availability. Luna's aggregate envelope and
partial retry attribution are not a confident whole-task range.

Snapshots are cache-pinned/as-of-capture. Before Refresh, the producer called
retained November11 sources current; after Refresh it used new generation255
sources. This probe does not assert a wall-clock TTL, provider cache hits on new
inference, cache portability, or future execution rates. No inference was run.

## Native observations and screenshots

The original panel was approximately520 points wide in a1512×949 window. To avoid
an unrelated system notification in captures, the window was temporarily moved
to(0,140) and800 points high. Captures are **real native screen crops of the Models
panel**, not static renderings or browser screenshots; unrelated chat/sidebar and
notifications are excluded.

- `01-qwen-refresh-sources-default.png`: actual freshly retrieved source counts.
- `02-qwen-disclosure-default.png`: Estimate basis disclosure opened normally.
- `03-qwen-lower-scroll-default.png`: lower inspector scrolled while the upper
  Sources/chart remained fixed; exact `opencode-go/qwen3.8-flash · medium` visible.
- `04-qwen-known-usage-default.png`: known-usage scenario amount, native source,
  provider unavailable/service tier not specified, explicit not-actual-charges
  and not-complete-task-bound copy.
- `05-qwen-evidence-disclosure-default.png`: Evidence & assumptions opened
  normally; exact scope/tier caveats visible.
- `06-qwen-rates-and-cache-default.png`: further independent lower scrolling,
  retry coverage, cache-write caveat and source provenance. Upper scrolling was
  also observed independently (header moved out and Chart data became visible
  while lower content stayed at its prior location). Chart/inspector split stayed
  usable; selected Qwen label stayed contained above the x ticks.

Native selection of Kimi and Luna was **not completed**. Qwen was already selected
when Models opened, and Refresh preserved it. This is not proof of a fresh exact
route-selection interaction. Both sources and inspector disclosures were exercised;
the reference-source sub-disclosure and Chart data were not exercised.

## Stop condition and restoration

Widening the panel through its native divider succeeded (left edge moved from
about992 to656 points). During the following capture, macOS showed:
**“OpenCode” is requesting to bypass the system private window picker and directly
access your screen and audio.** Buttons were Allow and Open System Settings.

No permission was granted, no settings opened, and native feature interaction
stopped. `07-native-capture-permission-block.png` is a bounded crop of that actual
system prompt; the obstructed wide screenshot containing adjacent chat fragments
was not retained. There is **no unobstructed wide-layout pass**. The missing
capability is continued native capture/access without a new screen/audio system
permission grant; any authorized human resolution is outside this probe.

Only the outer window's original position(0,33) and size1512×949 were restored
through native accessibility and read back. The panel remains widened, Models
selected, Qwen selected, Sources collapsed, inspector evidence open/scrolled.
The permission prompt was left untouched; no further clicks were used to restore
the panel or tab. Service PID77332 remained unchanged.

## Acceptance boundary

**Observed:** connected Refresh; authenticated coherent exact-configuration reads;
current source/provenance replacement; honest partial Luna usage/tier limits;
Qwen disclosure/cost/caching copy; default-width containment and independent scroll.

**Unresolved:** requested endpoint-specific knownUsageMarket scenarios (configured
scenarios returned despite matching endpoint records being retained); real Kimi/Luna
route selection and disclosure use; complete unobstructed wide geometry; Architect/
Terra screenshot review. This probe does not accept the combined plan or mutate
any task/plan state.
