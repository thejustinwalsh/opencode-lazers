# 49f6a84a — projects-settings

## Findings

### 49f6a84a-1 — major / confirmed

- **Where:** `src/projects/gui.tsx:41-51,93-94,301`.
- **What:** Each poll replaces all project objects, and Solid's identity-keyed `For` remounts every row. This destroys focused inputs and row-local pause drafts every three seconds (also after any save).
- **Failure scenario:** Start typing a project's pause reason; the next list response creates new row objects. The reason input disappears, the switch resets, and the draft is lost before Pause can be pressed.
- **Evidence:** `setListing` assigns the fresh RPC result; `<For each={listing()?.projects ?? []}>` maps object identity, while `asking` and `reason` are local to the remounted `PauseSwitch`.
- **Suggested fix / test:** Reconcile projects by stable key and keep editable state outside replaced row objects. Test a fresh-but-equal polling response while a reason input has text/focus; assert DOM identity, focus and draft survive.

## Checked and sound

- Owner controls are RPC-only, without added agent tools or permission prompts.
- Invalid/taken code edits preserve the stored value and return typed refusals.
- Clearing numeric settings restores defaults; unpause requests a scheduler wake.

## Not reviewed

- No native GUI walkthrough or DOM bundle test execution.
- Limit/weight settings' eventual global scheduling implementation is outside this unit; these fields alone do not prove enforcement.
