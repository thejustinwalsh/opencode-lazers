# Integrated-plan source and filesystem audit

Observed at Unix milliseconds `1793867309726` against main `ad293b0`.

**35 integrated plans / 43 accepted task nodes.** Every plan has a recorded integration landing whose commit is on current main. No uncertain effect belongs to these integrated plans. No isolated attempt workspace remains on disk; remaining shared-checkout paths are the canonical repository and must not be deleted.

This is a source/resource reconciliation, not a repeat of each feature’s behavioral acceptance. It does not certify unintegrated plans, historical native gates, registry cleanup beyond separately observed records, or the unfinished end-to-end product. No state was mutated and no file-content hashes were used as evidence.

| Plan       | Tasks                             | Recorded landing on main |
| ---------- | --------------------------------- | ------------------------ |
| `6d1d3afe` | LZ-1                              | `28c4e67f0585`           |
| `7d903c35` | LZ-7                              | `46bcf90f7ec5`           |
| `bc4d5dc0` | LZ-8, LZ-9                        | `dade430d964f`           |
| `e07cea4d` | LZ-10                             | `bcade2eaa6f0`           |
| `aa71e2c0` | LZ-12                             | `bcade2eaa6f0`           |
| `b9e55d09` | LZ-13                             | `d9ef1988677f`           |
| `db24c4b4` | LZ-16, LZ-15                      | `a8d6c11aeae3`           |
| `7b602667` | LZ-17                             | `9b0ab5efec71`           |
| `6ed421e4` | LZ-18                             | `a8d6c11aeae3`           |
| `b50a1a71` | LZ-19, LZ-20, LZ-21, LZ-22, LZ-23 | `0c5de84e3ee3`           |
| `8d505ab3` | LZ-24                             | `5d86e86253db`           |
| `58146c54` | LZ-25, LZ-26                      | `23df5d37967c`           |
| `5074d494` | LZ-27                             | `920ff0e369b3`           |
| `caa8c80c` | LZ-29                             | `a771bc3b2c9e`           |
| `1d4a866e` | LZ-30                             | `82596ceb86ce`           |
| `fdba0229` | LZ-31                             | `2536084b0146`           |
| `c4be742b` | LZ-32                             | `d4695e44495c`           |
| `6a7c2c02` | LZ-35                             | `2536084b0146`           |
| `8332f91a` | LZ-37                             | `95be47080e23`           |
| `aee3ba37` | LZ-40                             | `214adcb561b5`           |
| `c4f5e9be` | LZ-41                             | `63d828a7709c`           |
| `bff93c8b` | LZ-42                             | `86835fba4f69`           |
| `ae4cea99` | LZ-44                             | `7e38bf86bfdb`           |
| `45c80906` | LZ-45                             | `bf2cef67d276`           |
| `9ae669d7` | LZ-48                             | `ab2dd5dc72ca`           |
| `59987993` | LZ-49                             | `e18b826bcc73`           |
| `1cf7467a` | LZ-51                             | `e18b826bcc73`           |
| `907c6403` | LZ-52                             | `e18b826bcc73`           |
| `1cc98779` | LZ-54, LZ-55                      | `fa7b5a5dd80e`           |
| `af09b8ea` | LZ-73                             | `bf4d6673ef50`           |
| `e1e809c7` | LZ-98                             | `f50d2b18bc02`           |
| `5e57d2d2` | LZ-113                            | `428c6ad39392`           |
| `10964078` | LZ-132                            | `cf46320948d0`           |
| `ad6cb637` | LZ-136                            | `6bf4a8bab40b`           |
| `181baf24` | LZ-137                            | `cf46320948d0`           |

Raw SELECT-only snapshot: `/private/tmp/lazers-integrated-plan-audit-20261105.json`. Source ancestry used `git merge-base --is-ancestor` on recorded integration heads. Filesystem presence was checked separately from runtime acceptance; shared checkout existence is expected. Integrated nodes were all `accepted`; prior failed attempts remain historical facts.
