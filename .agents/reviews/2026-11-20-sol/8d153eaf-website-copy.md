# 8d153eaf — website-copy

## Findings

### 8d153eaf-1 — minor / confirmed

- **Where:** `website/src/Sections.tsx:796-799`.
- **What:** Copy says Fallow static analysis gates every task and only passing mechanical checks reach review. The contract deliberately permits acceptance with remaining Fallow findings or an unavailable analyzer.
- **Failure scenario:** A user relies on this claim when shipping an accepted task with a failing advisory Fallow receipt; the advertised guarantee is stronger than the runtime provides.
- **Evidence:** `decideVerification` only sends Fallow findings through an available repair; contributor contracts line 53 explicitly say Fallow alone never fails/holds and unavailable analysis is accepted.
- **Suggested fix / test:** Describe Fallow as review evidence with one repair, not a mandatory passing gate. Add copy-contract checks covering remaining findings/unavailable analysis, or review those exact scenarios before publishing.

## Checked and sound

- Copy retains normal OpenCode permissions and separates Architect judgment from runtime scheduling.
- No runtime code or model execution route changes are included.

## Not reviewed

- Binary OG image not visually audited; no website/browser build.
