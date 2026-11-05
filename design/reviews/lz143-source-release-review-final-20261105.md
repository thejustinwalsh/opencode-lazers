## Recommendation: clear the source-safety blockers on `747a386`

I independently confirmed **HEAD `747a38693e349bbe672356446e73ce0f97617868` is clean**. The exact `fdadbf3` → `747a386` delta contains only `src/runner/runtime.ts` and `src/runner/runtime.test.ts`.

The remaining availability blocker is closed: sealed guard recovery no longer requires the historical review to remain the current input. Recovery still validates the stored pin’s structure, the quarantine and worker assignment bindings, and the replacement guard before restoring exclusion. With a healthy guard, the fast path still avoids native message-history reads. Pending admission continues to require the exact completed, tagged review; the final delta does not change those admission/archive/seal checks.

The added tests cover later handoff on healthy and restored guards, write denial and handoff allowance, one-winner concurrent supersession, and no sealed-pin retargeting. Pending supersession audit/history and old-request replay checks remain in the candidate. The actual tool-hook behavior is also exercised in `roles.test.ts`; the new runtime tests additionally assert the helper directly. I found **no remaining source-write blocker**.

**Verification qualification:** I did not run tests or read the active compatibility log. Root’s 40 focused tests / 405 assertions and quality pass are reported, not independently verified. The 569-test / 7,185-assertion result applies to an older candidate; the final compatibility run remains pending. The runtime recovery tests use a host adapter rather than a live native process, so this is not an end-to-end Desktop qualification.
