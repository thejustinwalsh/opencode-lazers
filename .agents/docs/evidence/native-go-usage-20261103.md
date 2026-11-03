# Go Kimi usage — 2026-11-03

Read from native OpenCode session records at Unix ms1793745317861. These are
worker-only measurements, not whole-project/Architect usage or an invoice.

| Session                                      | Native execution (America/Detroit) | Duration | Tool calls | Outcome                                                |
| -------------------------------------------- | ---------------------------------- | -------- | ---------- | ------------------------------------------------------ |
| LZ100 · ses_186dbc76c2a64b3cbd0ff0fcd4836ff9 | 16:39:30–17:10:55                  | 31m25s   | 125        | Component returned c00d163; source review remains open |
| LZ104 · ses_6cc6c30440b04f47804b106673549ae2 | 17:18:59–17:19:29                  | 30s      | 9          | Go quota error                                         |

Elapsed from first busy timestamp1793741970326 to the quota error1793744369112:
39m59s. Summed native execution spans:31m55s. There was no second full Go run.

| Native usage category                          |      LZ100 |  LZ104 |   Combined |
| ---------------------------------------------- | ---------: | -----: | ---------: |
| Uncached input                                 |     11,363 |    266 |     11,629 |
| Output excluding separately reported reasoning |     31,426 |    730 |     32,156 |
| Reasoning                                      |     15,032 |    119 |     15,151 |
| Cache read                                     | 10,592,553 |  2,816 | 10,595,369 |
| Cache write                                    |    161,024 | 33,792 |    194,816 |
| Total recorded token processing                | 10,811,398 | 37,723 | 10,849,121 |

Cache reads are97.66% of the total; reads plus writes99.46%. These are repeated
processed context tokens, not10.85 million newly generated tokens. Native cost
is0 for both subscription sessions; that is not proof of free usage.

## Allowance reconciliation

Current [OpenCode Go documentation](https://opencode.ai/v2/docs/console/go/)
checked2026-11-03 publishes Kimi K3.1 Pro rates per million: input$2,
output$10, cached read$0.20, cached write$2. Repricing the recorded categories
(including separately reported reasoning as completion output) gives:

- Uncached input: $0.023258
- Output and reasoning: $0.473070
- Cache reads: $2.1190738
- Cache writes: $0.389632
- Total estimate: $3.0050338

This estimate explains Go allowance use; it is separate from the Models panel's
common OpenRouter market-equivalent index and is not an invoice.

The base Go plan lists a$15 monthly Kimi allowance and a five-hour limit of20%,
or$3. Weekly is50%. Limits are per model. The observed$3.005 total closely
matches the base-plan five-hour cap. This is an inference, not an observed account
meter: the native usage-limits endpoint returned `{location:...,data:null}`.
The account plan, preceding usage, exact exhausted window and reset time were
not verified. Do not claim that the whole monthly subscription was exhausted.

The native service log records `AI.Error.QuotaExceeded: Go usage limit exceeded`
at2026-11-03T22:19:29.112Z for LZ104. The runtime instead foregrounds an unknown
background-observation hold, obscuring the useful provider cause.

The first run returned a chart/read-contract component, not the finished Models
panel. Observed churn included SVG test selectors/geometry and strict TypeScript
repairs; Root also found reactivity, literal-tooltip and zero-acceptance defects.
No model-cost or quality ranking against Luna follows from these unequal tasks.
The human selected OpenAI Luna Max for remaining UI work after the Go failure.

## Returned product-code cross-check

At Unix ms1793745728368, Root exercised LZ102's returned
`projectTaskValuation` from commit266dd76 against these actual native session
records and the exact stored native Go quote. Snapshot
`05ec11c5-eab1-4af1-9260-9d944d650023` was retrieved2026-11-03T22:07:50.778Z.
The two separately projected tasks returned$2.9278646 and$0.0771692; their sum
was$3.0050338, matching the independent calculation above. Native-reported
subscription cost remained0 in a separate output field. No source records,
prices, task state or usage were mutated and no inference was launched.

This proves the returned arithmetic on real usage/current native quotes. It
does not prove common OpenRouter identity association, complete provider-call
history, registered RPC integration or the final Models UI.
