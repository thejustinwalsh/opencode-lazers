# 91b29dd4 — multi-project-design

No actionable runtime finding established in this design-only unit.

## Checked and sound

- Design separates pause, contact pause and running-work completion.
- Identity groups clones/worktrees under the stored project key without rekeying historical task rows.
- All-projects reads explicitly require paging and no owner access prompts.
- Global slots/fairness are described as a later stage, not claimed as shipped by this commit.

## Not reviewed

- No fairness simulation or external OpenCode identity experiment; proposals are not executable guarantees.
