import { encodeProjectID } from "../tasks/links.ts"

export const PLAN_LINK_PREFIX = ".lazers/plans/"

/** `[Full plan](.lazers/plans/<hex(projectID)>/<planningID>)`, distinct per plan and project. */
export function planMarkdownLink(planningID: string, projectID: string): string {
  return `[Full plan](${PLAN_LINK_PREFIX}${encodeProjectID(projectID)}/${planningID})`
}
