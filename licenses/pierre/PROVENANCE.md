# Pierre diffs provenance

The GUI diff renderer is `@pierre/diffs` 1.5.2-oaink.6, an Apache-2.0 package from
[Pierre](https://github.com/pierrecomputer/pierre). LAZERS uses a fork build, vendored as
[`vendor/pierre/pierre-diffs-1.5.2-oaink.6.tgz`](../../vendor/pierre/pierre-diffs-1.5.2-oaink.6.tgz)
(sha256 `08cc410890eb44ab4822d70bab9ae8ecb16137d8eed65a8263a77df4ae9e4da9`). The tarball ships
`LICENSE.md` and no `NOTICE` file; the license is preserved as
[`LICENSE-pierre-diffs.md`](LICENSE-pierre-diffs.md).

| Field         | Value                                    |
| ------------- | ---------------------------------------- |
| Fork          | https://github.com/thejustinwalsh/pierre |
| Branch        | `oaink/trim-keeps-annotation`            |
| Commit        | `626f860f`, on top of `300bb3ee`         |
| Upstream base | `diffs-v1.5.2`                           |

The fork adds to upstream `diffs-v1.5.2`:

- host-supplied intra-line ranges;
- `createStructuralDiff`;
- neutral one-sided rows;
- `CodeView` `overscrollSize`;
- partial render offsets;
- `DiffLineAnnotation.estimatedHeight`;
- the fast `highlights` highlighter type;
- keeping the last retained annotation row during trimming.

The package is a devDependency. Vite inlines it, with its runtime dependencies, into the
single-file GUI bundle `dist/gui-experimental.cjs`; its portable highlight worker
`@pierre/diffs/dist/worker/worker-portable.js` is inlined as text. The runtime dependencies
and their license texts are indexed in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
