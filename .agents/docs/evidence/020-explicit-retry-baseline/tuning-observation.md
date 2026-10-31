# Worker-only retry recovery observation

## Provenance and limits

Source: `/private/tmp/lazers-tuning-014-observation.json`, a read-only
observation of native `session.get` and `runner_attempts`, recorded on
2026-10-31. It covers worker attempts for task
`970b0feb-1fd3-40bb-a61d-f8decccb8a9f`, plan
`bc4d5dc0-3ad1-458c-bbde-fa9ce8cc1dc9` only. Architect, driver, runtime
verification, and the earlier readable-fetch task are excluded. These are
measured effort and observed recovery causes, not comparative model-quality
evidence. Subscription charge was not inferred; API-equivalent cost is unknown.

## Observed causes

- The original worker artifact `fd80616` left two optional
  `policyReference` caller type errors outside its write scope; Architect
  corrected them in `5b41706`.
- A requested shared retry `baseCommit` was recorded in `plan.body`, but
  dispatch chose `attempts.at(-1)?.artifact` before that baseline. The supported
  cancel/resume path with `baseCommit` recovered the change.
- The final worker verified the corrected baseline and produced documentation
  commit `dade430`. Failed-attempt usage remains included in the totals.

## Worker-only totals

| Measure                 |                               Observed total |
| ----------------------- | -------------------------------------------: |
| Attempts                |                     4 (3 failed, 1 accepted) |
| Tool calls              |                     267 (137 + 39 + 40 + 51) |
| Non-cached input tokens |                                      744,233 |
| Visible output tokens   |                                       23,243 |
| Reasoning tokens        |                                       54,955 |
| Cache-read tokens       |                                   11,832,448 |
| Cache-write tokens      |                                            0 |
| API-equivalent cost     | Unknown; no dated route/tier pricing applied |

These counts describe the recovery episode only. They do not establish that a
model is better or worse, nor do they estimate savings from the correction.
