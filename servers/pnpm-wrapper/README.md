# pnpm-wrapper

Fixed-verb MCP wrapper around `pnpm`. The agent calls `add`, `remove`,
`run`, `test`, etc. — not arbitrary `pnpm <anything>`. Argv-only invocation
(no shell), hardcoded refusals for dangerous flags, and declarative policy
for what packages/scripts are agent-callable.

## Status

Packaged. Node/TypeScript MCP server, distributed as a Nix flake.

## Why a wrapper instead of just letting `nix-dev-exec` run pnpm

[`nix-dev-exec`](../nix-dev-exec/) covers *any* allowlisted command —
`pnpm`, `pytest`, `go test`, `cargo build`. That's the general path. But
package-manager operations have enough quirks that a dedicated wrapper pays
for itself:

- **Manifest mutations need policy.** `pnpm add foo` mutates `package.json`
  and `pnpm-lock.yaml`. A free-form shell wrapper can't easily enforce
  "agent can add deps from this allowlist only" or "no `--global`, ever".
- **Output digestion.** Raw pnpm output is noisy. The wrapper snapshots
  the direct-dep tree before/after and returns a structured
  `{added, removed, updated}` delta.
- **Structured audit/outdated.** JSON-parsed to primary fields the agent
  can act on without re-parsing text.
- **No `dlx` / `exec` / arbitrary scripts.** A free-form shell can `pnpm
  dlx evil-script`. This wrapper simply doesn't expose them.

## Sandbox

**Every pnpm invocation runs inside a [`bubblewrap`](https://github.com/containers/bubblewrap)
sandbox.** This is not optional per-call — the only knobs are configured in
`.pnpm-wrapper.toml`. `bwrap` is a hard runtime requirement: the server
refuses to start if it isn't on `PATH`.

### Verb → preset mapping

| Verb kind | Verbs | Preset | Network | Notes |
|---|---|---|---|---|
| install | `add`, `remove`, `update`, `install`, `install_frozen`, `prune` | `install` | ON | RW: project root, `~/.cache`, `~/.local/share/pnpm`, `~/.pnpm-store`, `~/.npm`. RO: `~/.npmrc`, `~/.yarnrc`, `~/.gitconfig`. |
| readonly | `list`, `why`, `outdated`, `list_scripts`, `licenses` | `readonly` | OFF | RW: project root. `$HOME` is a tmpfs. RO: `~/.npmrc` (symmetry). |
| script | `run`, `test`, `lint`, `typecheck`, `audit` | `install` (default) | ON | Arbitrary user scripts — network on so tests can hit fixtures/mocks. Per-script override via `[sandbox.scripts]`. |

Common flags applied to **every** invocation:

- `--ro-bind /nix /nix` `--ro-bind /etc /etc`
- `--dev /dev` `--proc /proc` `--tmpfs /tmp`
- `--bind $PROJECT $PROJECT` `--chdir $PROJECT`
- `--tmpfs $HOME` (then preset overlays)
- `--setenv HOME $HOME` `--setenv USER $USER`
- `--unshare-user` `--unshare-ipc` `--unshare-pid` `--unshare-uts` `--unshare-cgroup-try`
- `--die-with-parent` `--new-session`
- `--unshare-net` when the preset has network OFF

### Per-script overrides (`[sandbox.scripts]`)

Only the `script`-kind verbs are overridable. Allowed presets:

- `install` — network + writable pnpm caches (default for script kind)
- `readonly` — network off, tmpfs `$HOME`, `~/.npmrc` RO
- `strict` — network off, tmpfs `$HOME`, project RW only, no cache mounts

```toml
[sandbox.scripts]
default_preset = "install"
"test" = "strict"        # tests get no network
"lint" = "strict"
"audit" = "install"      # audit needs the registry
```

### `describe_sandbox(verb, script?)`

Read-only MCP tool that returns the exact bwrap argv that would be used
for a given verb — useful for auditing and for debugging why a script
can't reach the network.

```json
{
  "verb": "add",
  "sandbox": { "mode": "bwrap", "preset": "install", "network": true },
  "bwrap_argv": [ "--ro-bind", "/nix", "/nix", ... ],
  "mounts": [ { "kind": "bind", "src": "/home/…", "dst": "/home/…", "exists": true } ]
}
```

### Escape hatch

`[sandbox.disabled]` lets you opt a specific verb out of the sandbox
entirely. Every entry MUST set `off = true` and supply a `reason` string;
anything else is a config error at startup.

```toml
[sandbox.disabled.some_verb]
off = true
reason = "Must talk to the private registry over an SSH-forwarded socket."
```

Prefer not populating this. There is no per-call disable — it must be
config.

### Requirements

- **`bwrap` on PATH.** Install with `nix profile install nixpkgs#bubblewrap`
  or (Debian/Ubuntu) `apt install bubblewrap`. The Nix flake wires it in
  automatically.
- **Unprivileged user namespaces enabled.** If bwrap fails with
  `setting up uid map: Permission denied`, enable them:
  - Debian/Ubuntu: `sudo sysctl -w kernel.unprivileged_userns_clone=1`
  - NixOS: `security.unprivilegedUsernsClone = true;`
  - The server appends a diagnosis note to `stderr` when it detects this.

Every tool response includes a `sandbox` field:

```json
{ "mode": "bwrap", "preset": "install", "network": true }
```

or `{ "mode": "off", "reason": "…" }` when disabled.

## MCP tools

### Dependency management

| Tool | Description |
|---|---|
| `add(package, dev?, version?)` | `pnpm add [--save-dev] <pkg>[@ver]`. Policy-gated. Returns delta + output. |
| `remove(package)` | `pnpm remove <pkg>`. Returns delta + output. |
| `update(package?)` | `pnpm update [pkg]`. Honors `[update].default` (patch/minor/latest). Returns delta. |
| `list(filter?)` | `pnpm list --depth=0 --json [--filter <name>]`. |
| `why(package)` | `pnpm why <pkg> --json`. |
| `outdated()` | `pnpm outdated --format json`, parsed. |

### Scripts

| Tool | Description |
|---|---|
| `run(script, args?)` | Runs a `package.json` script. Script must exist and pass `[run]` allow/deny. Args appended argv-style. |
| `list_scripts()` | Returns `[{name, command}]` from `package.json.scripts`. |
| `test(filter?, watch?)` | Shortcut for `run("test", [filter])`. Refuses `watch: true` (MCP cannot stream). |
| `lint(fix?)` | Shortcut for `run("lint" [, "--fix"])`. |
| `typecheck()` | Shortcut for `run("typecheck")`. Refuses if the script is not defined — add one (e.g. `"typecheck": "tsc --noEmit"`). |

### Install

| Tool | Description |
|---|---|
| `install()` | `pnpm install`. Returns delta. |
| `install_frozen()` | `pnpm install --frozen-lockfile` (CI parity). |
| `prune()` | `pnpm prune`. |

### Audit

| Tool | Description |
|---|---|
| `audit()` | `pnpm audit --json` → `{vulnerabilities, summary}`. |
| `licenses()` | `pnpm licenses list --json`. |

### Introspection

| Tool | Description |
|---|---|
| `describe_sandbox(verb, script?)` | Returns the exact bwrap argv that would wrap `pnpm <verb …>` and the list of host mounts (with `exists` flags). Read-only. |

## Hardcoded refusals

Independent of policy — you cannot turn these off:

- `--global` / `-g` anywhere in argv.
- `--registry=` override.
- `dlx`, `exec` — arbitrary code / installed-binary escape hatches.
- Non-registry package specifiers: anything starting with `git+`, `file:`,
  `http:`, `https:`.

For `run` the wrapper additionally requires the script to be present in
`package.json.scripts` — arbitrary command execution is not exposed.

## Policy config

Drop `.pnpm-wrapper.toml` at the project root. Missing = fully permissive
(hardcoded refusals still apply).

```toml
[add]
allow = []                        # empty = allow anything (subject to deny)
deny  = ["evil-package"]
require_dev = ["@types/*", "eslint-*", "prettier", "vitest*"]

[run]
allow = ["build", "test", "lint", "typecheck", "format"]
deny  = ["release", "deploy", "publish"]

[update]
default = "patch"                 # patch | minor | latest
```

See [.pnpm-wrapper.toml.example](./.pnpm-wrapper.toml.example).

Glob matching for `require_dev` uses `*` as a wildcard.

## Working directory

Auto-detected by walking up from `cwd` looking for either
`pnpm-lock.yaml` or a `package.json` with a `packageManager: "pnpm@..."`
field. If neither is found, every tool returns a clean error.

## Output digestion (delta)

For mutating tools (`add`, `remove`, `update`, `install`, `install_frozen`,
`prune`) the wrapper snapshots direct dependencies via
`pnpm list --depth=0 --json` before and after the operation, then diffs
name+version+dev to produce:

```json
{
  "added":   [{ "name": "...", "version": "...", "dev": false }],
  "removed": [{ "name": "...", "version": "...", "dev": false }],
  "updated": [{ "name": "...", "from": "...", "to": "...", "dev": false }]
}
```

The delta is the primary result. Raw `stdout`/`stderr` are returned as
secondary fields for debugging.

## Packaging

Nix flake at `./flake.nix`. Uses `buildNpmPackage` (npm-based build inside
the sandbox), then wraps the resulting binary so `pnpm` is on its PATH.

```
nix build
./result/bin/pnpm-wrapper   # stdio MCP server; waits on stdin
```

Package/binary name: `pnpm-wrapper`.

## Standalone use

```nix
{
  inputs.pnpm-wrapper.url = "github:mmmaxwwwell/mcp-toolbelt?dir=servers/pnpm-wrapper";

  outputs = { self, nixpkgs, flake-utils, pnpm-wrapper }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = import nixpkgs { inherit system; }; in
      {
        devShells.default = pkgs.mkShell {
          packages = [ pnpm-wrapper.packages.${system}.default ];
        };
      });
}
```

Then wire it into your `.mcp.json`:

```json
{
  "mcpServers": {
    "pnpm-wrapper": {
      "command": "pnpm-wrapper"
    }
  }
}
```

## Composition

Per the [DESIGN](../../DESIGN.md), this server sits behind
[`nix-mcp-proxy`](../nix-mcp-proxy/) for whitelisting/rate limiting/audit
logging. The proxy layer enforces cross-server invariants; this server
enforces pnpm-specific ones.

Future work: invoke pnpm via
[`nix-dev-exec`](../nix-dev-exec/) so the pnpm binary always matches the
project's pinned Node/pnpm version. v0.1 spawns `pnpm` directly from
`PATH` (which the Nix wrapper points at `pkgs.pnpm`).

## Not implemented

- **Monorepo `-F <pkg>` filtering.** No workspace-scoped verbs yet.
- **Catalog handling.** `pnpm` catalogs (workspace-pinned versions) change
  the semantics of `add`; the wrapper doesn't detect or reason about them.
- **Lockfile conflict resolution.** If `add` produces a merge conflict, the
  underlying pnpm error surfaces via `stderr`; the wrapper does not try to
  auto-resolve.
- **npm/yarn parity.** No sibling wrappers or auto-routing by
  package-manager detection.

## Open design questions

- Should `test`/`lint` fall back to `run(<script>)` with args, or become
  fully first-class (e.g. detect Vitest/Jest and parse structured
  results)? Current impl keeps them as thin shortcuts.
- Should `update.default = "minor"` translate to an explicit pnpm flag,
  or continue to rely on the package.json semver range?
- Should `audit` short-circuit success responses when the summary shows
  zero vulnerabilities, or always return the full advisory list for
  auditability?
