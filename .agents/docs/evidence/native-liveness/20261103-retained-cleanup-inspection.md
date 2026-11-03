# Retained cleanup: supported inspection boundary

Observed on 2026-11-03 against Main `295925f1454c726d13451ac08369b49f2eb7b3ab`, after the authorized offline namespace restart. These are inspection findings, not cleanup receipts or assertions that all worker activity is zero.

## Individually checked resources

| Task  | Plan / version                              | Retained attempt                       | Exact clean HEAD, ancestor of Main         |
| ----- | ------------------------------------------- | -------------------------------------- | ------------------------------------------ |
| LZ-71 | `6c9cc71f-0897-4287-a44a-c52ec0c2c8a3` / 12 | `6e764af8-eaec-448e-8ba3-7fb53a1b3870` | `d891ea1f577629efde1e6d98c649510ad82a7a94` |
| LZ-75 | `e7308bed-1fe9-4c8a-b688-122abe42e1a3` / 10 | `c5fbffb0-b7b4-457a-805d-6380022f2951` | `f65d8cc23582506603ebb69b86ef56cb3067cf59` |
| LZ-79 | `21625514-8f61-4f9e-be16-65a609f4710e` / 17 | `e10ac4af-372c-45d7-bb63-98a5d7c2dfa8` | `7aabc4704265a997147ed869fadb8473293bf9e7` |

Each plan retains nine completed effects and one uncertain `worktree-remove` effect. Each worktree still exists under the runner's owned worktree directory; read-only Git status, including untracked files, was empty. Source integration is already recorded; removal is not.

## Native observations

Used the supported Desktop CLI `api get` path and the pinned V2 protocol. No database mutation, hook invocation, worker continuation, inference, interruption, archival or deletion was performed.

| Task  | Native session                         | Assigned input, also latest user input | Last assistant completion |
| ----- | -------------------------------------- | -------------------------------------- | ------------------------: |
| LZ-71 | `ses_ae6165e7d2eb43a0a7b4e30f3d842375` | `msg_088eb83949114ec0bbd927da669b8a89` |             1793649758971 |
| LZ-75 | `ses_19fd0710d651419091bf1891f2d97045` | `msg_6fe1458755d24024a5512cb678aadcf6` |             1793652080220 |
| LZ-79 | `ses_833e712f73f849b3a3f5f1e28e3ba5f4` | `msg_a6276b9a7a4f4b969f328e238af132b0` |             1793655116052 |

For each session, native metadata matched the canonical project, owned worktree directory, `lazers-implementor` agent and exact `lazersAttemptID`; outcome was `succeeded`. The active-session inventory did not contain the worker; its inbox was empty. Explicit worktree-location permission/form reads returned zero matching requests. Latest assistant had finish `stop` and a completion timestamp. No synthetic input was returned. LZ-75 and LZ-79 metadata was unchanged across bracketed inventory/message reads.

The LZ-71 full-context CLI response could not be parsed; bounded native message endpoints supplied the stated assistant/user/idle observations instead. This is not a claim of a successful complete adapter observation.

## Why this cannot authorize removal

The installed cleanup conjunction at `src/runner/runtime.ts:4423–4446` requires matching worker ownership, no foreground/pending/unstable activity or approvals, an outcome, a completed/interrupted turn, and no background blocker. The background check at `2498–2528` additionally requires a genuine observed report, zero background count and exact assigned/current-input lineage.

Independent source research confirmed that this background observation comes from the process-local `experimental.idle` listener (`src/progress/native.ts:344–424`, `src/runner/native.ts:156–258`). The supported public inventory reads above cannot retrieve or reconstruct that report. Missing reports stay unknown; listener disposal invalidates them. Empty inventories, old success/idle timestamps and clean merged Git history cannot be substituted for observed-zero background work.

No current public inspection establishes which complete fresh adapter observation would satisfy the guard. In particular, the observations above do **not** prove that background work is zero, that a report was retained in this host generation, or that the entire observation remained stable. The generic cleanup failure remains unresolved, rather than being relabelled as a confirmed single-conjunct diagnosis.

`session.background` is a mutating operation that backgrounds blocking tools, not a read-only background inventory. Do not call it to manufacture evidence. The current plan `audit` action returns stored audit information, not a fresh cleanup diagnostic.

## Required next capability

Resolve the retained resource through a supported runtime-owned reconciliation/observation boundary that positively establishes current ownership and quiescence, preserves old uncertainty and does not create a coding/model turn. Do not synthesize an idle hook, inject registry state, infer zero from empty controls, fabricate an old receipt or weaken the cleanup predicate. Future-only orderly idle preservation does not retroactively supply these old observations.

LZ-72's diagnostic source is retained at `e6a58ea5b1c1c0fd687983d257f48a2cf48e7f55`, not integrated or activated. Its own interrupted-check recovery and logical reservation remain separate limitations; they were not bypassed for this inspection.

Once the actual guard is supported and satisfied, reread the plan version and retry the existing `integrated` command without `taskID`, naming the exact accepted artifact and `targetBranch: main`. Let runtime perform non-forced removal and retain its actual receipt. Until then, preserve these resources and all historical attempts, findings and integration records. No cleanup retry was issued during this inspection.

## Subsequent LZ-82 inspection and requested guarded retry

After the three-plan inspection above, separately checked LZ-82 plan `e5a078b8-5364-49d2-a571-0710c70e8bbb` at version 14 against evidence-only Main `e02c0997f2a42de9b86b28fa33c91b173a912874`. Retained attempt `d2e45d4c-ccad-44ce-b9de-079c1589cb62` was clean, exactly at accepted `0e13a75d85852756ea958c92f4f89c8188ad0148`, an ancestor of Main. Thirteen effects were complete and one removal uncertain.

Native session `ses_71af5e28c324495b9ac5770def2b53bf` matched the project, worktree, agent and attempt metadata. Bracketed metadata was unchanged, outcome succeeded, foreground inactive, inbox empty, explicit location permission/form counts zero. Latest user input matched assigned `msg_831a427c7acb4a4597672c658d30cab3`; there were no synthetic inputs. Latest assistant finished `stop` at `1793655725112`. This still did not prove background quiescence.

Exercised the user's existing integration-command retry once: `integrated`, expected version 14, exact accepted artifact, no task ID, target `main`. The reason explicitly did not assert background quiescence and required all native ownership/idle/clean/ancestry guards to remain enforced. Runtime returned `cleanup-requested` at version 15, then `cleanup-blocked` at version 16 with the same inconclusive-idle reason. Thirteen effects remained complete, one removal uncertain; the tree was preserved. No repeated retry, product-check replay, model turn, persistent permission change or guard weakening followed. This failed guarded retry is not cleanup success or a recovered background report.
