# LZ-163 review: the retained worker has multiple supported transfers

The in-progress `hasPlanOwnerTransfer` checks for one direct `from`/`to` record.
That does not cover the actual LZ-129 worker which this repair must unblock.

Read-only native and database observation:

- Plan: `243f8093-7c3c-44e3-bda5-e06870e4f680`.
- Worker: `ses_aeff3e9ac5d24c6c944d35e31b050963`, original parent
  `ses_e68a9ed37ffeVqzPWRXN5SB7Uw`; OpenAI Luna Max, original native workspace.
- Attempt started at Unix milliseconds `1793833121829`.
- Supported plan-level ownership changes after that start:

| Event            | From                                 | To                                   | Unix milliseconds |
| ---------------- | ------------------------------------ | ------------------------------------ | ----------------- |
| OWNER_CONTINUED  | ses_e68a9ed37ffeVqzPWRXN5SB7Uw       | ses_09ce60a14ec948fc8573f95912e5536a | 1793840504832     |
| OWNER_CONTINUED  | ses_09ce60a14ec948fc8573f95912e5536a | ses_4e3bba0f29fc4972a4d51a28409c497d | 1793842310949     |
| OWNER_CONTINUED  | ses_4e3bba0f29fc4972a4d51a28409c497d | ses_5aa94658965844ed85f4b0ebdd5266cb | 1793844116161     |
| OWNER_REASSIGNED | ses_5aa94658965844ed85f4b0ebdd5266cb | ses_e568438ebffeaoFbF9nBb942XM       | 1793848354034     |

There is no direct original-parent→current-owner record. The exact retained worker
must remain usable after this supported sequence. Add a focused regression and
correct the existing patch; preserve current owner/epoch and exact worker/input
checks. This requires no archival prerequisite, native ancestor scan, new lineage
system, replacement worker or specification expansion. Routine implementation is
the worker's choice. This is an early source review, not a delivered-artifact pass.
