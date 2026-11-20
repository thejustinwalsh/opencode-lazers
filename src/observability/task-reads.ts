import type { TaskRepository } from "../storage.ts"
import { GetInput, GetOutput } from "../tasks/contract.ts"
import { TaskReads } from "../tasks/read.ts"
import { sessionAssociations } from "./associations.ts"

/** Extends the Tasks RPC's session view with persisted plan-owner/worker links. */
export class AssociationTaskReads extends TaskReads {
  constructor(repository: TaskRepository) {
    super(repository)
  }

  override get(input: unknown) {
    const query = GetInput.parse(input)
    if (query.allProjects) throw new Error("An all-projects read is read with getAll")
    if (!query.sessionID) return super.get(input)
    const taskID = this.repository.resolveTaskID(query.taskID)
    if (!taskID) return GetOutput.parse({ status: "not_found" })
    const linked = this.repository.atomic((db) =>
      sessionAssociations(db, this.repository.projectDirectory, query.sessionID!).taskIDs.has(
        taskID,
      ),
    )
    if (!linked) return GetOutput.parse({ status: "not_found" })
    return super.get({
      taskID: query.taskID,
      ...(query.revision ? { revision: query.revision } : {}),
      ...(query.classificationRevision !== undefined
        ? { classificationRevision: query.classificationRevision }
        : {}),
    })
  }
}
