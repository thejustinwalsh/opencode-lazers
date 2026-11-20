# 42c5ff4a — fallow-audit-review

## Findings

### 42c5ff4a-1 — major / confirmed

- **Where:** `src/audit/fallow-dispositions.ts:27-34`.
- **What:** Any added suppression anywhere in the same file is treated as suppressing every vanished finding there, without checking kind or location. The recorded disposition/reason can be false.
- **Failure scenario:** First audit finds complexity in `a.ts` and an unused export elsewhere in that file. Repair fixes complexity and suppresses only the unused export. The fixed complexity finding is reported as suppressed with the export's reason.
- **Evidence:** Lookup is only `waivers.find(w => w.file === finding.file)` despite the function comment claiming matching rule. The later suppression unit changed the metadata shape, not this predicate.
- **Executed reproduction:** `review-invariants-reproduction.test.ts` feeds fixed complexity at line 1 and an unused-export waiver at line 100 of the same file; the actual disposition is `suppressed` with the unrelated reason.
- **Suggested fix / test:** Match suppression kind and covered declaration/line, distinguish file-level comments, and mark a genuinely fixed unrelated finding fixed. Add a same-file mixed-rule repair test.

## Checked and sound

- Current and legacy Fallow check/effect names are both recognized.
- Authored verification cannot use either reserved check ID.
- Missing-config holds have an automatic release path once config exists.
- Remaining findings after the one repair and unavailable analysis do not independently hold/fail work.
- GUI start replies accept the typed missing-config refusal.

## Not reviewed

- No native/WASM builds or runtime fixture execution.
- Vendored Rust changes and every engine report variant were not independently re-proven; schema adapters, package construction and runtime decisions received the focus.
- Inherited findings are still summarized with a limited context list; no claim of complete finding-level output is made here.
