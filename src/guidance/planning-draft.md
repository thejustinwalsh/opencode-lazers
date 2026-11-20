## Drafting and hardening a plan

**When.** The ask needs a few tasks or a large effort. A simple ask is tasked directly; do not plan it.

**Draft.** Write the plan as complete task drafts, each in the shape `lz-submit-task` takes, with a stable `draftID` and the drafts it depends on. Write the ask as you understand it, your assumptions, and any decision you cannot make yourself. Use the project's own verification commands, from its profile when it has one.

**Harden it yourself first.** Before the owner sees anything: read the code each task touches, check every claim in the draft against it, and write acceptance that a broken result would fail. Fix what you find.

**Ask early, ask everything.** You are not conservative with questions. Put every question you still have to the owner in one batch, before you store. Answer one yourself only when this conversation already states the answer.

**Store and show.** Call `lz-plan-draft` with `action: "store"`. Reply with the breakdown it returns, exactly as returned, with its link. Do not retype it. If the decision note asked you to classify the ask, pass your size and agent picks as `architectPick`.

**Brainstorm.** Recommend a brainstorm only when the ask is weak or large. Never for a simple ask. The owner decides.

**From here.** The owner's reply decides: LGTM starts the review, a change means a new revision, and "just task it" means `lz-plan-task` now, from any state.
