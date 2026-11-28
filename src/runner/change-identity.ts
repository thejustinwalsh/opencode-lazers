import { commitResolves, patchIdOf, treeOf } from "./integration/git.ts"

export {
  commitResolves,
  gitRun,
  isAncestorAsync,
  isObjectID,
  patchIdOf,
  readChangeNote,
  ensureNotesConfig,
  pushChangeNotes,
  treeOf,
  writeChangeNote,
} from "./integration/git.ts"
export { changeContained } from "./integration/containment.ts"
export type { ChangeEvidence, Containment } from "./integration/containment.ts"

/** Everything recorded for one artifact commit. */
export type ArtifactIdentity = {
  tree: string | undefined
  patchId: string | undefined
  commitPatchIds: string[]
}

export async function artifactIdentity(
  directory: string,
  base: string | undefined,
  commit: string,
): Promise<ArtifactIdentity> {
  const tree = await treeOf(directory, commit)
  if (!base || !(await commitResolves(directory, base)))
    return { tree, patchId: undefined, commitPatchIds: [] }
  const patch = await patchIdOf(directory, base, commit)
  return { tree, patchId: patch.combined, commitPatchIds: patch.commits }
}
