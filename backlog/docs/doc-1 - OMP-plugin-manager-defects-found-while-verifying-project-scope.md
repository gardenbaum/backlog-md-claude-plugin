---
id: doc-1
title: OMP plugin manager defects found while verifying project scope
type: other
created_date: '2026-08-31 09:16'
updated_date: '2026-08-31 09:17'
---
Two defects in OMP's plugin manager, both found while verifying project-scope
installation of this plugin against **OMP 18.0.11** on macOS 26.6.2 (2026-08-31).
Every run used a temporary `HOME`, so nothing of the real configuration is
involved. Filed here so the reproduction survives; not yet reported upstream.

## 1. Uninstalling one scope deletes a marketplace copy the other scope still uses

A marketplace install keeps exactly one copy in the user cache and points every
scope at it. Uninstalling either scope removes that copy without checking the
other, which leaves a registry entry whose directory is gone.

### Reproduction

```sh
export HOME=$(mktemp -d)                      # isolated config
omp plugin marketplace add <local-marketplace-dir>
mkdir -p "$HOME/project" && cd "$HOME/project"

omp plugin install <plugin>@<marketplace> --scope project
omp plugin install <plugin>@<marketplace> --scope user
omp plugin list --json                        # user entry: "shadowedBy": "project"

omp plugin uninstall <plugin>@<marketplace> --scope user
```

### What the project install looks like before the uninstall

- registry entry: `<project>/.omp/plugins/installed_plugins.json`, `"scope": "project"`
- the copy itself: `$HOME/.omp/plugins/cache/plugins/<marketplace>___<plugin>___<version>`
- joined by a symlink: `<project>/.omp/plugins/node_modules/<plugin>`
- the user-scope install links the *same* copy from `$HOME/.omp/plugins/node_modules/<plugin>`

### Expected

Uninstalling one scope removes that scope's registry entry and its symlink. The
shared copy is removed only once no scope references it — or the uninstall
refuses while another scope still does.

### Actual

The shared copy is deleted. The project registry entry still names it, and
`omp plugin list` still reports the plugin as installed. The plugin is dead:

```
Failed to load extension .../omp/index.mjs: Failed to load extension: Cannot find module ...
```

Reinstalling refuses, because the registry says it is already there:

```
✘ Failed to install <plugin>@<marketplace>: Error: Plugin "<plugin>@<marketplace>"
  is already installed. Use force option to reinstall.
```

Only `omp plugin install <plugin>@<marketplace> --scope project --force` repairs it.

### Impact

Any plugin installed at project scope. The failure is silent at install time and
surfaces later as a missing module, which points at the plugin rather than at the
plugin manager.

## 2. `PI_CONFIG_DIR` is not honoured for the marketplace store

With `PI_CONFIG_DIR` set to an absolute config root, `omp plugin marketplace`
reports `No marketplaces configured` although `$PI_CONFIG_DIR/marketplaces.json`
exists and lists one. Setting the variable to exactly the directory `HOME`
already implies is enough to trigger it, so this is not a relocation that failed
— the variable's presence alone breaks the marketplace lookup.

The visible consequence is that a marketplace install silently degrades to an npm
install:

```
Warning: --scope is only supported for marketplace installs (name@marketplace).
  Ignoring for <plugin>@<marketplace>.
✘ Failed to install <plugin>@<marketplace>: Error: bun install failed
  error: GET https://registry.npmjs.org/<plugin> - 404
```

### Reproduction

```sh
env HOME=<temp> omp plugin marketplace                          # lists gardenbaum
env HOME=<temp> PI_CONFIG_DIR=<temp>/.omp omp plugin marketplace # "No marketplaces configured"
```

Same directory in both runs; only the variable differs. Whether a genuinely
relocated config root behaves any better was not tested.
