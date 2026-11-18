/**
 * Resolve a worker script. Source runs load `<sourcePath>.ts` relative to the caller; the
 * server bundle (dist/server.js) loads the prebuilt `./<basename>.js` emitted beside it by
 * build:server. Pass the caller's `import.meta.url` as `base`.
 */
export const workerURL = (sourcePath: `./${string}`, base: string) => {
  const bundled = !new URL(base).pathname.endsWith(".ts")
  return new URL(bundled ? `${sourcePath.split("/").pop()}.js` : `${sourcePath}.ts`, base)
}
