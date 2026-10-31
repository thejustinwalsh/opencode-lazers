# Speech driver review and repair handoff

Task `3af64c61-ff16-43a9-8983-a11763ccf415` returned
`7dc6b4ad10a20601f6a3a0c960c9c0eb591d956b`. Its exact-artifact runtime
focused/full/quality checks passed. Independent source review found defects
not covered by those checks; passing receipts do not establish final safety.

At the user's request, original speech source was normally merged into
canonical main as `68a1c5d9ec3be300e36e6a23e766d7c638fe8069` so Root can repair
it there. Diagnostics `ec3c882` are preserved. The driver has not edited speech
implementation, rebuilt the GUI after this merge, or marked the feature plan
integrated. Root now owns speech source/test repairs and native audio captures.

## Independently reproduced cases

Two added regression cases in the isolated
`/Users/tjw/.local/share/opencode/worktree/b5da4c/driver-speech-review` checkout
failed against the worker implementation: `bun test src/webgpu/speech-events.test.ts`
returned **6 pass / 2 fail / 14 expectations**. The additional tests are not
merged into main; the checkout is intentionally retained with those changes.

1. **Discarded code-line position.** Feed final-answer ordinal 0
   `"```ts\ninside_code "`, then ordinal 1
   `"```\nPRIVATE_CODE_CANARY\n```\nSafe prose."`, followed by stopped step
   and successful execution. Only `Safe prose.` should reach TTS. Actual output
   was `PRIVATECODECANARY`. `SpeechMarkdownParser.push` discards an incomplete
   code line but forgets that the next fragment is not a new line; an inline
   delimiter is then misclassified as a closing fence. Preserve line-position
   state when dropping code fragments, not just the delimiter candidate.
2. **Repeated unmarked completion.** Deliver unmarked text `Unmarked final
once.`, its stopped step and success, then replay the step/success. Actual
   output contains that sentence twice. Part deduplication does not deduplicate
   the fallback in `finish()`. Keep the supported unmarked-provider fallback;
   make successful-final delivery idempotent instead of deleting it.

## Root's independent reproduced case

Root reported a separate **duplicate execution-start** reset: after ordinal 0
opens a fence, replaying the same native start clears parser/message state but
not `seenParts`. The duplicate ordinal 0 is discarded, so ordinal 1's code
continuation is spoken. Native event envelope identity (`id`/durable sequence)
must make duplicate starts idempotent and preserve Stop suppression. Started
event data has only sessionID; no execution ID should be invented there.

The whole b50 acceptance boundary remains open: reviewed repairs, combined
verification and native speech/Radar/Trajectory observation are still needed.
Projection and dependent execution must continue without duplicate Runs or
schedule changes. No inference setting/runtime/diagnostic repair is owned by
this handoff.
