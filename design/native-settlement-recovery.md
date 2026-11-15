# Native settlement recovery and cleanup follow-through

## Intent

The user authorized an actual read-only OpenCode settlement-recovery producer
and LAZERS consumer. Old missing or mismatched idle reports remain historical
uncertainty. Fix the missing observation capability rather than repeatedly
refreshing cleanup authorization or fabricating zero-background evidence.

## Native producer

Implement in the owned native checkout
`/Users/tjw/Documents/ChatGPT/opencode-native-settlement`, pinned to verified
2.2.6 revision `dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06`. Its detailed defining
section is `design/native-settlement-recovery.md` → `Native producer` there.
Do not edit the misleading commit-labelled `.opensrc` cache containing 2.3.0.

Deliver a public experimental read across Schema/Core/Protocol/Server, generated
clients and plugin forwarding. Anchor expected input/execution/success to authentic
ordered history and separately observe present complete native ownership/inventory,
including descendants, pending notices and unresolved recovery records. Detect
capture/ABA races; fail closed on missing, ambiguous, positive or unsupported facts.
The API must cause no prompt, replay, recovery, hook invocation or lifecycle mutation.
It is not a historical hook replay, general OS scan or cleanup lease.

## LAZERS consumer

After the producer's actual API and compatible artifacts are reviewed, add its
consumer only to explicit current-owner cleanup recovery. Keep fresh settlement
distinct from hook reports; preserve historical `NativeIdleStore` rows and holds.
Maintain exact owner/epoch, attempt/input/session/workspace/route, source,
integration, native registration, immediate revalidation and non-forced removal
fences. Unsupported hosts remain held, never assumed empty. Check compatibility
of native SDK/schema/plugin and Effect versions instead of blindly upgrading.

## Integration order and acceptance

The native producer is a separate native-project LAZERS feature task. The linked
LAZERS consumer waits for its reviewed contract and for overlapping LZ-207/LZ-208
source integration. Cross-project sequencing is owned here, not encoded as
unsupported same-project dependency references. No repair waits on the cleanup
that it is supposed to enable.

Combined verification exercises authentic retained history with missing old hook,
present complete empty and positive/unknown native inventory, descendant/pending/
recovery-only work, incompatible identity/input/execution, capture races and
unsupported backends. Assert zero observation-induced inference/state changes
and zero unauthorized removal or location retirement.

Native tests follow the native repository's package-local procedures and client
generation. LAZERS uses automatic fixes through `bun run verify` plus native,
idle and cleanup-convergence tests. Qualify compatible producer/consumer against
an isolated candidate or embedded native host before claiming installed capability.

Replacing or activating the running native service is a separate user decision;
no deployment, global configuration change, publication or upstream PR is
authorized here. After authorized activation, observe original held assignments
and retry public cleanup only on genuine passing evidence. Preserve holds otherwise.

The delegated-agent ceiling remains three including native coordination/helpers
and workers; the current owning Architect is excluded. Do not restart unrelated
workers or disturb the existing roadmap to obtain observation proof.
