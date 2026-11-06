# Native supported plugin reload observation

Root integrated reviewed3ea8b5d/2610e9f at canonical7e80cac, built GUI, quit/reopened
idle Desktop with native service71027 surviving. Root then clicked the ordinary
Extensions → Plugins → Reload, returned to LAZERS settings and clicked Run locally.
Visible result: “local GPU ready.”,19input/4outputtokens. All six inference switches
were ON and unload Never before/after reload. No private lifecycle hook was called.

Root subsequently used native Help → Export Logs. Local bundle:
`/Users/tjw/Downloads/opencode-debug-20261106T110239.zip`.
Current desktop main log: `desktop/20261106T104644/main.log`; read-only extraction
`/private/tmp/lz-native-export-current-main.log`. The complete bundle stays local.

Relevant current-main records (local America/Detroit timestamps):

-05:46:48.846 acquire: window1,generationSequence1,
 generationf68bb355-86b7-45ef-b5e1-f239615eaed3,
 providerb4431c07-5cc6-46b5-8285-c9455b4bed39.
-05:47:39.374 handoff: window1,generationSequence2,
 generation0dcb4ae9-02db-4a98-a8fc-243482610ac0,
 provider360c28b8-1512-4db2-8054-d085c66c3531,
 operation9ab19199-b422-4c53-be4b-732bdc35e808,
 retirement7e347b41-dac9-4acc-a682-461cbd452e1c.
-05:47:46.788 successor renderer session-ready.
-05:48:01.756 actual questions job0b668e61-76c0-4625-b653-67b7ac042ff1
 completed425ms,19input/4outputtokens, matching Root's visible probe.

`main.ts` logs handoff initiation, not its resolved result. Correlate subsequent
success with the mechanical acquire/ensure/attach and renderer disposal predicates
before deciding native acceptance. Per-request trace stage dispose is not evidence
of whole-model teardown. No claim covers every cancellation/lost-reply race or
absence of all hidden failures. Root queued the exact native logs to Architect for
bounded reuse of existing Luna review; native gate disposition remains pending.
