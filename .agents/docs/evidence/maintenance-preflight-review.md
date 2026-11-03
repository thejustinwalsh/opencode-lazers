# Maintenance preparation source review

Reviewed 2026-11-03. Plan `b048598f-ab73-4494-980c-1368fa9342c7`
accepted combined artifact `4ec7e84b1f655964f362d3f2ad7630c914427f68`,
but independent review did not clear the preflight for source integration.
Passing task checks do not override the production-contract failures below.

## LZ-95: retain for focused repair

Source: `08911cefd0138689ca727ccaeaefac64667a876c`. Its five files are
unchanged in the combined artifact. Review session:
`ses_e5cf6941cffeihHBAWB74n11S6`.

- `src/verification/maintenance/contract.ts:31,113` requires UUID effect IDs,
  but the runner uses SHA-256 fingerprints (`src/runner/runtime.ts:2029`,
  `src/identity.ts:17–18`). An offline production-generated ID was rejected at
  both binding and effect fields. The CLI returned `invalid-request` with no
  handoff binding. Accept the actual runner identity contract, not fabricated
  UUID substitutes.
- `contract.ts:170` limits `environmentIdentity` to 256 characters. The production
  environment identity from `src/runner/artifacts.ts:332–340` was 2,603 characters;
  a valid receipt was rejected as invalid. Preserve its complete exact binding.
- `preflight.ts:238–256` ignores a newer same-kind verification effect whose
  valid JSON lacks `check.id`. An injected later `verify:runner` payload `{}`
  left `bindingMatched: true` without a binding blocker. Malformed competing
  effects must remain uncertainty, not disappear from the decision.
- `preflight.ts:370–379` takes both candidate Git samples before reading manifest
  and receipt evidence. An injected candidate change during the manifest read
  still reported a clean matching candidate. Samples must bracket inspection.

The existing focused suite passed 9 tests / 66 assertions; whitespace checks
passed and the tree stayed clean. Supplemental offline probes exposed these
four defects. All exercised outputs correctly retained `executionPermitted:
false`, coordination required and unproven containment. Repair must preserve
those safety boundaries, original attempts and uncertainty. No service action,
recovery or retained-evidence mutation occurred. These checks do not establish
LZ-72 cessation or current live containment.

## LZ-94: separately integrated foundation

Source: `a448d4c560e31cf1120e56a7b381d9e827584e38`. Independent review found
no blockers, including mutation, malformed-input, clock and network probes.
Architect reran the exact candidate checks: 10 tests / 93 assertions and
formatter, lint, typecheck and whitespace checks passed. Main merge
`b3f95fab3da0bcb30bf3480b037f09827c998556` passed 57 Models tests / 776
assertions and the same quality checks. Runtime recorded only LZ-94's source
landing at plan version 37. This does not activate live routing.

Combined integration and cleanup remain unclaimed while LZ-95 is withheld.
Do not remove either retained worktree or repeat an unchanged cleanup hold.
