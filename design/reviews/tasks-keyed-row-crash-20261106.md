# Tasks row-removal crash and native Start observation

## Repair

Native Desktop DevTools captured `TypeError: Cannot read properties of undefined (reading status)` while changing task state filters. The rest of Desktop remained responsive.

`mapByKey` exposed a removed key as undefined before Solid disposed its reactive owner. A reactive consumer added to the existing identity fixture reproduced the exception before the fix. Commit `7f5133b` retains the last value until owner disposal. Surviving keys still update normally; disposal counts remain exact.

Validation: reactive identity and mounted Tasks activity tests passed (2 tests, 52 assertions); native Bun lint and type checks passed; GUI build and bundle evaluation passed. No service restart or inference-setting changes.

## Native observation

After GUI activation, Tasks recovered. Selected LZ-153, clicked Start, and observed Queued → Running / foreground active. Then changed Queued → Running filter; the list and selected inspector remained rendered.

At Unix milliseconds 1793937696533, public native session activity confirmed:

- LZ-153: attempt `4e7fb2d5-e54f-4f9c-a153-58a38aa87dc2`, session `ses_bb1ddbbe1ca84e498de9597792c602f6`, active OpenAI gpt-6-luna/max.
- LZ-152: attempt `6c5b0677-3a6e-4956-ad23-cb8e3f54f70c`, session `ses_06ae893559b2433d88f788baaf2e966c`, active OpenAI gpt-6-luna/max.
- LZ-147 original worker and Luna retained-recovery reviewer were also active.

The two Models attempts have distinct native worktree paths matching their attempt IDs. This proves parallel dispatch/activity, not finished implementation or acceptance.

## Remaining work

Tera High completed screenshot review: visual acceptance remains open. Use compact title-first rows, a concise truthful state/waiting indicator, full hold reasons in the selected inspector, and preserve LZ-149 grouping scope. Architect has sent a genuine tagged correction to the original LZ-147 worker. LZ-138 review and Models 152/153 implementation continue. No further activation should interrupt their live execution witnesses.
