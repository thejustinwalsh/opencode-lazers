# How to prompt a System One model

Read 2026-11-20 in a browser from the model maker's own material and the RDM author's site. Sources
at the end. This corrects the decision spike (`decision-spike.md`), whose questions were the wrong
kind.

## The rule we broke

"Jev makes judgments, code makes decisions." (TypeSafe, "Don't Call It a Decision Model".)

A System One model answers a gut check: a judgment a knowledgeable person makes in a few seconds
about what is in front of them. The decision is made by code that combines several such judgments.
The naive use is "give it all of your state, and have it make a decision about what should happen";
that leads to tuning long criteria prose case by case, and when it is wrong there is one number and
nothing to inspect.

The spike asked D1 for decisions:

| What we asked                                               | Why it is the wrong kind                                                                |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| "Would the Grounding agent help with this ask?" (per agent) | A prediction about a future process, weighing several factors. Not visible in the text. |
| "one task / a few tasks / a large effort"                   | A broad Choice with no criteria and no examples; it bundles count, risk and unknowns.   |
| "Which of the five agents?" (5-way)                         | One big Choice that is the decision itself.                                             |
| "Is this irrelevant?" (mirrored)                            | Inverted phrasing. The docs say to phrase so that a high value means yes.               |

## What the docs say to do

1. **Use code when you can.** Count, look up and compare in code; ask the model only where judgment
   is needed.
2. **Decompose the state.** Send only the context the questions need.
3. **Decompose the questions.** "Ask the most explicit, narrow, specific, atomic questions you can."
   One property per question. The docs call this the most important concept.
4. **One yes/no per Noul.** Two conditions in one question means the value means less; ask two and
   combine in code.
5. **Phrase so a high value means yes.** A statement works as well as a question ("The customer is
   requesting a refund").
6. **Make the yes/no boundary unambiguous.** "any" leaves no middle ground. When the boundary is
   subtle, add `criteria` with `true` and `false` descriptions: what it covers, what it is not for,
   examples.
7. **Ask many questions about one state in one request.** They are judged in parallel and in
   isolation; adding questions "barely changes the response time" on the hosted model.
8. **Combine in code:** rules, weighted sums, or the probabilities as features of a classical model.
9. **Route on uncertainty.** Starting thresholds for a Noul: above 0.7 is yes, below 0.3 is no, and
   the middle goes to a person or a slower model. Do not fit thresholds to a handful of cases.
10. **A Noul is not a scale.** For degree, use a Score with a description per level.

## Real question wordings

| Source                | State                                    | Question                                                                                                                                                                                             | Type        |
| --------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Noul docs             | one support message                      | "Is the customer asking for a human agent?"                                                                                                                                                          | Noul        |
| Noul docs             | same                                     | "Has the customer contacted support about this before?" + criteria                                                                                                                                   | Noul        |
| How to build          | ticket, customer, policy as named fields | "Does the customer explicitly request a refund or credit?"                                                                                                                                           | Noul        |
| How to build          | same                                     | "Does the message refer to a supplied open order?" (compare two paths)                                                                                                                               | Noul        |
| How to build          | same                                     | "Which team should handle `ticket.message`?" with what / not_for / examples per option                                                                                                               | Choice      |
| Decision-model post   | conversation + account                   | six Nouls: wants_money_back, reports_unauthorized, requests_human, threat_legal, wants_to_cancel, open_to_offer; code computes refund_eligible, small_refund, subscription_active and picks the exit | Noul + code |
| RDM site, search      | one entry and the headings under it      | "Is the answer to `inputs.question` stated in `inputs.text`?"                                                                                                                                        | Noul        |
| RDM site, smart home  | the request and a map of routines        | point at one routine by name and description, or `finish`                                                                                                                                            | Choice      |
| RDM slides, hierarchy | a listing and one level of categories    | rate the categories; follow each at least half as likely as the top                                                                                                                                  | Choice      |

Every one asks what the text says or contains. None asks what should be done.

## What this means for the planning step

- **D1 gets observations about the ask, not picks of agents.** Examples (to be tested, not final):
  "The text names a file, function or table.", "The text leaves a choice about behaviour open.",
  "The text states how the result is checked.", "The text describes more than one separate
  change.", "The text changes stored data or a schema.", "The text describes a symptom without its
  cause.", "The text asks for something that may already exist."
- **Code maps observations to agents and to size.** For example Grounding when files or existing
  behaviour are named; Readiness when a choice is open or no check is stated; Critic when stored
  data changes; Zoom out when it is a symptom or may already exist; size from the count of separate
  changes (a Score with a description per level, or counted in code from the pieces).
- **The middle band is the derived "none":** between 0.3 and 0.7 the Architect decides. This is the
  owner's rule, and the docs' own routing pattern.
- **The recorded data becomes useful:** per-observation scores can be checked one at a time against
  what the review found, which a single "agent helps" number never allowed.
- Running all five agents stays the first version's behaviour; the observations are recorded.

## D1's own published examples (web scout, 2026-11-20)

D1 is Liquid AI's model; its API is `system_one` and a question is `type`, `instructions`,
`criteria` (https://huggingface.co/LiquidAI/d1-omni-600M).

| State                                                          | Question                                                                    | Type   |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- | ------ |
| "I was charged twice this month, please refund one of them."   | "Is the customer asking for a refund?"                                      | noul   |
| same                                                           | "Which team should handle this?" with a description per option              | choice |
| same                                                           | "How urgent is this?" with "Can wait", "Today", "Blocking the customer now" | score  |
| a circuit-board image                                          | "Does this circuit board have a defect?"                                    | noul   |
| a ticket, in SQL: `d1(ticket, 'the customer wants to cancel')` | the condition string                                                        | noul   |

Patterns across them and the hosted model's SDK examples: one short sentence of 5 to 9 words; every
yes/no is a positive predicate; each option carries a description; 1 to 3 questions per call; score
levels ordered lowest to highest. Stated cautions: a different option order can change an answer;
"Calibrate any decision threshold on data from your own use"
(https://docs.liquid.ai/lfm/models/decision-models); a threshold tuned on one model does not carry
to another. Two papers the scout found by abstract only: swapping yes and no flips about half of
the hosted model's answers (arXiv:2610.00346), and answers depend on option order more as options
grow (arXiv:2610.18233). The spike saw both effects.

## The local D1 in ruNNtime (code scout, 2026-11-20)

- Prompt layout: state, then one question, then one masked slot per option; the head scores each
  slot (`packages/runntime/src/zoo/d1/prompt.ts:4-6`). A noul's default options read "false: no,
  the statement does not hold" and "true: yes, the statement holds".
- **Each question is its own pass and repeats the state** (`decider.ts:216-226`). Several questions
  in one request cost several passes here, unlike the hosted model, so the state must stay small.
- Criteria are supported and render as "label: description" per option. Score is supported.
- The demos ask what is in the text or image: "Is the customer angry or frustrated?", "Is the
  customer asking for money back?", "Is this comment spam, an ad or self-promotion?", "Is someone
  holding a phone?" (`playground/d1/triage.ts`, `mod.ts`, `webcam.ts`).
- Two authoring notes in the demos: a two-option choice caught what a yes/no missed ("As a yes/no
  this misses most real questions; as a choice it catches them", `mod.ts:48`); and option text that
  states the consequence lets the model compare descriptions instead of inferring (`snake.ts:109`).
- Only one demo asks what to do next (the snake move), and it puts the consequence of each move in
  the option text and keeps guards in code.
- The product's own task-review and handoff questions are long compound sentences ("Does the
  handoff preserve the source task's authorized outcome and current contract, while distinguishing
  ..."). They break the same rule and are worth the same rework later.
- Open discrepancy: LAZERS names the model "d1-omni-2b" with an 8,192-token context
  (`src/webgpu/system-one.ts:31`); ruNNtime calls it D1 Omni 600M with 16,384 positions.

## Not yet known

- Whether the local D1 in ruNNtime accepts `criteria` with true/false descriptions and the Score
  type the way the hosted API does, and whether several questions in one request cost one pass.
- How the reworded questions score on the 44 labelled asks.

## Sources

- https://typesafe.ai/blog/dont-call-it-a-decision-model
- https://typesafe.ai/blog/introducing-system-one-models-and-jev
- https://docs.typesafe.ai/introduction
- https://docs.typesafe.ai/concepts/how-to-build-with-system-one
- https://docs.typesafe.ai/primitives/noul
- https://docs.typesafe.ai/concepts/state
- https://recursivedecisionmodels.com and its slides at /aie-code-sf-2026/
