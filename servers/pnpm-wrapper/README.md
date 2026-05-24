# pnpm-wrapper (design only)

Fixed-verb MCP wrapper around `pnpm`. The agent calls `pnpm.add`,
`pnpm.test`, `pnpm.run` — not arbitrary `pnpm <anything>`. Mechanical input
shaping, output digestion, no shell escape.

## Status

Design only — no implementation yet.

## Why a wrapper instead of just letting `nix-dev-exec` run pnpm

[`nix-dev-exec`](../nix-dev-exec/) covers *any* allowlisted command —
`pnpm`, `pytest`, `go test`, `cargo build`. That's the general path. But
package-manager operations have enough quirks that a dedicated wrapper pays
for itself:

- **Manifest mutations need policy.** `pnpm add foo` mutates `package.json`
  and `pnpm-lock.yaml`. A free-form shell wrapper can't easily enforce
  "agent can add deps from this allowlist only" or "no `--global`, ever".
- **Output digestion.** Raw pnpm output is noisy (progress bars, peer-dep
  warnings, deprecation notices). A wrapper returns just the deltas: what
  was added/updated/removed, with versions.
- **Test results are structured.** `pnpm test` → structured Jest/Vitest
  results, not stdout to parse. The agent gets pass/fail counts and
  failure messages without re-parsing.
- **No `dlx` / `exec` / arbitrary scripts.** A free-form shell can `pnpm
  dlx evil-script`. A fixed-verb wrapper just doesn't expose `dlx`.

## MCP tool surface (planned)

### Dependency management

- `add(package, dev?, version?)` — add a single dep; allowlist-gated
- `remove(package)` — uninstall
- `update(package?)` — bump deps (single or all); honors `--latest` policy
- `list(filter?)` — `pnpm list` filtered to direct deps by default
- `why(package)` — `pnpm why` — dep tree for one package
- `outdated()` — structured outdated report

### Scripts

- `run(script, args?)` — runs a `package.json` script; the script name must
  exist in `package.json` (no arbitrary commands)
- `list_scripts()` — what's in `package.json.scripts`
- `test(filter?, watch?)` — `pnpm test`, structured output
- `lint(fix?)` — `pnpm lint` (or the configured equivalent)
- `typecheck()` — `tsc --noEmit` or equivalent

### Install

- `install()` — `pnpm install` (full lockfile sync)
- `install_frozen()` — `--frozen-lockfile` for CI parity
- `prune()` — remove extraneous

### Audit

- `audit()` — structured vulnerability report
- `licenses()` — dep license summary

## What is **not** exposed

- `pnpm dlx` (arbitrary script execution)
- `pnpm exec` (escape hatch into installed bins)
- `pnpm publish` (release ops belong elsewhere)
- `pnpm config set` (environment mutation)
- `--global` flag (anywhere)
- Custom registries (must be configured in `.npmrc` ahead of time)

If the agent needs something not on the surface, it's intentional friction:
the tool description points to `.npmrc` / project README / human.

## Security model

Same declarative policy shape as [`nix-mcp-proxy`](../nix-mcp-proxy/).
Example `.pnpm-wrapper.toml`:

```toml
[add]
# Empty = allow anything. Populate to whitelist.
allow = []
deny = ["evil-package", "package-with-known-cve"]
require_dev = ["@types/*", "eslint-*", "prettier", "vitest*"]
# These can only be added as devDeps. Production deps for these are refused.

[run]
# Which package.json scripts are agent-callable.
# Empty = all scripts in package.json.
allow = ["build", "test", "lint", "typecheck", "format"]
deny  = ["release", "deploy", "publish"]

[update]
# Major version bumps require human confirmation; default behavior is patch-only.
default = "patch"  # patch | minor | latest
```

## Briefing pattern

Tool description for `pnpm.add`:

> **Add a dependency.** Use this instead of editing `package.json` directly.
> **When to use.** Adding a new library you need.
> **Invariant.** Updates lockfile atomically; no half-installed state.
> **Refused.** Globals, dlx, packages outside the allowlist.

## Composition

Sits behind [`nix-mcp-proxy`](../nix-mcp-proxy/). Under the hood, every call
shells out via [`nix-dev-exec`](../nix-dev-exec/) so the pnpm binary always
matches the project's pinned Node/pnpm version.

## Open design questions

- **Monorepos.** `pnpm -F <pkg> add foo` for workspace filtering — first-class
  arg or separate `workspace_add` op?
- **Lockfile conflicts.** What happens when an `add` produces a merge conflict
  with the existing lockfile? Auto-resolve via re-install? Surface to agent?
- **npm/yarn parity.** Should there be a sibling `npm-wrapper` /
  `yarn-wrapper`? Or detect package manager and route?
- **Catalog support.** `pnpm` catalogs (workspace-pinned versions) change the
  semantics of `add` — does the wrapper warn or auto-route?
