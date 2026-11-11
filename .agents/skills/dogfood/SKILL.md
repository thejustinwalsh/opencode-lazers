---
name: dogfood
description: Drive LAZERS through OpenCode Desktop as the external Codex developer when the user explicitly requests dogfooding. Does not apply to Architect or workers, or to ordinary repair requests.
---

# Dogfood

Apply this workflow only to the external Codex driver when the user explicitly
asks to dogfood. Do not pass these driver instructions to Architect or workers.

Read README.md's progressive dogfood order and the current handoff. Present the
user's feature request through OpenCode Desktop, answer Architect's native
questions, and observe trajectories and delivered behavior. Use Architect to
specify and execute the work; runtime owns dispatch and task state.

Let Architect make repair, advice, reassessment, integration and takeover
decisions. Evaluate whether those decisions produced progress. Do not supply
unsolicited steering or substitute driver implementation for the workflow under
test. Architect asks the human when a material decision requires guidance.

A direct user instruction to fix or intervene authorizes that development work;
coordinate active writers, implement, verify and commit the correction, and check
its native behavior. Record the intervention and its cause separately from
autonomous recovery. Resume dogfooding when requested.

Report delivered changes, observed outcomes, remaining failures and driver
assistance. Message delivery, queued work and passing tests alone do not establish
that the product workflow completed.
