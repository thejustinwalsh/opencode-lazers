# Publish a release

The tag workflow in `.github/workflows/release.yml` builds and tests the plugin, publishes the tested archive to npm, and publishes a GitHub release with the same archive and changelog. It uses npm trusted publishing; no npm write token belongs in GitHub secrets.

## One-time npm configuration

Run this as the npm package maintainer and complete npm's one-time authentication:

```sh
npm trust github opencode-lazers --file release.yml --repo thejustinwalsh/opencode-lazers --allow-publish --yes
```

This grants direct publishing to that workflow, without a stage-only permission or a GitHub environment requirement. The same configuration is available under Trusted publishing in the npm package settings.

The publish job grants `id-token: write`, runs on a GitHub-hosted Ubuntu runner, and uses Node 24 with npm 12.2.3. It runs `npm publish`, not `npm stage publish`. See [npm's trusted-publishing documentation](https://docs.npmjs.com/trusted-publishers/).

## Cut a version

1. Integrate the intended changes. Set `package.json` to the release version.
2. Write human-facing notes in `docs/releases/VERSION.md` or the matching `CHANGELOG.md` section. The workflow falls back to grouped Git history when neither exists.
3. Run `bun run verify` and the relevant behavior tests, then commit the version and notes.
4. Create and push its matching tag, for example `git tag -a v0.3.0 -m 'LAZERS v0.3.0'` and `git push github v0.3.0`.
5. Check the release workflow and verify that the version is available from npm.

The package version must match the tag. The workflow publishes `CHANGELOG.md` as a release asset and uses its content as the GitHub release body. An existing published archive is reused; rerunning the workflow does not replace a published npm version with different bytes.

To retry an existing tag using the latest workflow, run `gh workflow run release.yml --repo thejustinwalsh/opencode-lazers --ref main -f version=v0.2.1 -F publish=true`. Without `publish=true`, a manual run produces a test artifact only.
