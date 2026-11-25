# Install or upgrade LAZERS

LAZERS 0.2.0 targets OpenCode 2.3.0. Install the npm package with OpenCode's plugin installer:

```sh
opencode plugin add opencode-lazers@0.2.0
```

Restart Desktop and its service, then select **Architect** and open **Tasks**.
The package includes the server, Desktop bundle, worker scripts, and Fallow WebAssembly modules. No plugin build is needed.

When upgrading from a local checkout or archive, remove its LAZERS entry from the existing global `plugins` list so only the npm installation remains. Keep every other plugin entry. Also remove any legacy project copy under `.opencode/plugins/lazers`.

To update later, use `opencode plugin add opencode-lazers@X.Y.Z` with the published version. See the [official plugin installation guide](https://opencode.ai/docs/plugins/).

## Previous archive release

The published v0.1.0 archive targets OpenCode Desktop 2.2.6. These instructions remain available for that release.

## Install v0.1.0

Run these commands in a terminal with Bun installed:

```sh
(
  set -e
  install_dir="$HOME/.local/share/opencode/lazers-plugin"
  mkdir -p "$install_dir"
  cd "$install_dir"
  curl --fail --location \
    --output opencode-lazers-0.1.0.tgz \
    "https://github.com/thejustinwalsh/opencode-lazers/releases/download/v0.1.0/opencode-lazers-0.1.0.tgz"
  bun add --ignore-scripts ./opencode-lazers-0.1.0.tgz
  printf '%s/node_modules/opencode-lazers\n' "$PWD"
)
```

Copy the absolute path from the last command. Add that path to OpenCode's `plugins` list, usually in `~/.config/opencode/opencode.json` or `~/.config/opencode/opencode.jsonc`:

```json
{
  "plugins": ["/absolute/path/from-the-last-command/node_modules/opencode-lazers"]
}
```

Merge the LAZERS path into the existing global `plugins` list. Remove any older LAZERS path, including a development checkout. Keep every other plugin entry.

See the [OpenCode plugin configuration guide](https://opencode.ai/docs/plugins/) for config locations and plugin loading rules.

Check the project before you add the global entry. OpenCode can also auto-discover a project plugin under `.opencode/plugins/`. Move any legacy `.opencode/plugins/lazers` copy out of that folder. Remove any project-level `plugins` entry for LAZERS. Keep one LAZERS load path total.

Restart OpenCode Desktop and its background service. Select **Architect** from the agent list. Open **Tasks** or run `/lz-tasks` to check that the panel loads.

The archive includes the plugin source and built Desktop bundle. The install command skips lifecycle scripts. You do not need to build the plugin.

## Upgrade from a release archive

Keep the same install directory and plugin path. Find the new version and archive name on the [GitHub releases page](https://github.com/thejustinwalsh/opencode-lazers/releases).

Replace `X.Y.Z` in these commands with the published version:

```sh
(
  set -e
  cd "$HOME/.local/share/opencode/lazers-plugin"
  version="X.Y.Z"
  curl --fail --location \
    --output "opencode-lazers-${version}.tgz" \
    "https://github.com/thejustinwalsh/opencode-lazers/releases/download/v${version}/opencode-lazers-${version}.tgz"
  bun add --ignore-scripts "./opencode-lazers-${version}.tgz"
)
```

Keep one LAZERS path in the global `plugins` list. Restart OpenCode Desktop and its background service after the install.

## Optional local inference

The task workflow uses your selected OpenCode model. Local inference does not need to be on.

Local WebGPU features live in **Settings → LAZERS**. The Omni files total about 1.6 GB. D1 weights and its tokenizer total about 625 MB. Each model downloads on first use, independently of the other model.

See [user controls](../reference/user-controls.md#local-inference) for feature switches and cache controls.
