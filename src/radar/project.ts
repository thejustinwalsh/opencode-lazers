/** Keep the host's canonical preference key separate from its native project identity. */
export function radarProjectIdentity(project: { id: string; canonical: string }) {
  return { project: project.canonical, projectID: project.id }
}
