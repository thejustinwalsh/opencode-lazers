# Pierre diffs

`pierre-diffs-1.5.2-oaink.6.tgz` is `@pierre/diffs` built from the fork
https://github.com/thejustinwalsh/pierre, branch `oaink/trim-keeps-annotation`, commit `626f860f`
(on top of `300bb3ee`). The base is upstream `diffs-v1.5.2`. sha256:
`08cc410890eb44ab4822d70bab9ae8ecb16137d8eed65a8263a77df4ae9e4da9`.

Fork changes: host-supplied intra-line ranges, `createStructuralDiff`, neutral one-sided rows,
`CodeView` `overscrollSize`, partial render offsets, `DiffLineAnnotation.estimatedHeight`, the
fast `highlights` highlighter type, and keeping the last retained annotation row during trimming.

It is a devDependency because Vite inlines it, with its runtime dependencies, into the shipped
GUI bundle `dist/gui-experimental.cjs`. License notices live in
[`licenses/pierre/`](../../licenses/pierre/PROVENANCE.md).

## Rebuild

In the fork checkout:

1. Set the version in `packages/diffs/package.json`.
2. `moon run diffs:build`
3. From `packages/diffs`: `pnpm pack --pack-destination <dest>`

Copy the tarball here, update `package.json` and `bun.lock`, and refresh the sha256 and version in
`licenses/pierre/PROVENANCE.md` and this file. Regenerate `licenses/pierre/THIRD-PARTY-NOTICES.md`
if the dependency set changed.
