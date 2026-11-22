/**
 * Archived is how the owner says a session is done, not a limit on what it may read: reads treat
 * an archived session of the project as a live one (owner decision, 2026-11-22). A change made
 * from an archived session is refused with this plain reason instead of a scope error; the owner
 * reopens (unarchives) the session in OpenCode to make changes.
 */
export const ARCHIVED_SESSION_MESSAGE = "This session is archived. Reopen it to make changes."

export class ArchivedSessionError extends Error {
  constructor() {
    super(ARCHIVED_SESSION_MESSAGE)
    this.name = "ArchivedSessionError"
  }
}
