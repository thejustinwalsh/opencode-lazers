import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { TaskReviewInput } from "./task-review.ts"
import type { TaskReviewer } from "./task-review.ts"

export const REVIEW_COMMUNICATION =
  "Keep review mechanics inside tool results. The status and next fields route agent work: do not quote their literal values (such as completed_with_concerns or submit) in normal replies. Do not narrate round counts, question IDs, fingerprints, scores, dispositions, raw state, next-tool routing, or progression/budget mechanics to the user unless the current user request asks for diagnostics. Correct issues yourself when the request and evidence support the repair. Ask a concise native clarification only when missing information or a material user decision prevents a sound repair; never invent the answer. Ordinary completion should be one or two short sentences about the useful task improvements and any material unresolved concern; expand only when the user requests a report. Translate actual unresolved findings into their concrete subjects, such as weak cancellation checks or uncertain adapter scope; do not replace them with a generic statement that tests were not run. Do not recap workflow bookkeeping. Do not present advisory completion as proof of correctness or claim unexecuted tests passed."

export function registerTaskReviewTool(
  ctx: {
    tool: Pick<Plugin.Context["tool"], "transform">
    permission: Pick<Plugin.Context["permission"], "assert">
    location: Plugin.Context["location"]
  },
  reviewer: TaskReviewer,
  enabled: () => boolean = () => true,
) {
  return ctx.tool.transform((editor) => {
    if (!enabled()) return
    editor.add({
      name: "lz-verify-task",
      description:
        "Before submitting, verify task JSON with structural checks and fixed local System One questions about behavior coverage, measurable performance, weak verification, conflicts, assumptions, and scope. Supply the original user request and relevant evidence. No model or question selection needed. Returns one focused correction/clarification and the next tool to call. Reuse reviewID with revised task/evidence; at most three rounds total. Advisory: equal-or-better focused scores advance, and the limit continues with concerns. Does not persist a submitted task or execute work. " +
        REVIEW_COMMUNICATION,
      input: TaskReviewInput,
      options: { codemode: true, permission: "lz-verify-task" },
      execute: (input, context) =>
        Effect.suspend(() =>
          enabled()
            ? ctx.permission
                .assert({
                  sessionID: context.sessionID,
                  agent: context.agent,
                  action: "lz-verify-task",
                  resources: ["*"],
                })
                .pipe(
                  Effect.flatMap(() =>
                    Effect.tryPromise({
                      try: (signal) =>
                        reviewer.verify(
                          input,
                          JSON.stringify([
                            ctx.location.project.canonical,
                            context.sessionID,
                            context.agent,
                          ]),
                          signal,
                        ),
                      catch: (error) => new Tool.Error({ message: String(error) }),
                    }),
                  ),
                  Effect.map((result) => ({
                    content: JSON.stringify({ ...result, communication: REVIEW_COMMUNICATION }),
                  })),
                )
            : Effect.fail(
                new Tool.Error({
                  message:
                    "Local task review is turned off. Continue the ordinary Architect workflow without it.",
                }),
              ),
        ),
    })
  })
}
