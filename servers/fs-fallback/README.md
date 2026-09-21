# fs-fallback

ACL-gated raw filesystem MCP server for the files [`edit-surface`](../edit-surface/)
doesn't handle — READMEs, JSON/YAML/TOML configs, lockfiles, shell scripts,
docs. Every tool call is checked against a declarative policy in
`.fs-fallback.toml`. Attempts to `write_file` a source file are refused with
a pointer at `edit-surface`; attempts to write a lockfile are soft-denied
with a hint at the correct wrapper (`pnpm-wrapper`, `nix-dev-exec`, ...).

## Status

Packaged. Node/TypeScript MCP server, distributed as a Nix flake.

## Why this slot exists

The graph-routed [`edit-surface`](../edit-surface/) is the *primary* code
path, but a real project has files that aren't code:

- READMEs, design docs, changelogs
- JSON/YAML/TOML configs (`package.json`, `pyproject.toml`, `tsconfig.json`)
- Lockfiles (`pnpm-lock.yaml`, `flake.lock`, `Cargo.lock`)
- Generated migrations, fixtures, snapshots
- Files in languages `edit-surface` doesn't have a backend for yet

Without a fallback, the agent gets stuck. With a *paths-and-strings* fallback
that *also* enforces the same security policy as edit-surface, we get
ergonomics without losing safety.

## MCP tools

### Read

| Tool | Description |
|---|---|
| `read_file(path)` | Full contents. Rejected if `[read]` denies. Returns `{path, size, content, encoding}`. Files containing NUL bytes come back as base64 with `encoding: "binary"` and a warning field. |
| `read_file_range(path, start_line, end_line)` | 1-indexed inclusive line range. Same policy gate. |
| `stat_file(path)` | `{path, exists, size, mtime, is_dir, is_symlink, target?}`. Denied paths return `{exists: false, denied: true, reason}`. |
| `list_dir(path)` | Directory contents; each entry filtered against `[read]`. |
| `glob(pattern, base?)` | micromatch pattern within `base` (default: project root). Results filtered by `[read]` before returning. |

### Write

| Tool | Description |
|---|---|
| `write_file(path, content, confirm?)` | Full overwrite. See policy chain below. |
| `append_file(path, content, confirm?)` | Append. Same policy chain. |
| `delete_file(path, confirm?)` | **Soft-delete** — moves file to `.fs-fallback-trash/<YYYY-MM-DD>/`. Nothing is truly removed until trash retention expires. |

### Audit

| Tool | Description |
|---|---|
| `recent_writes(n?)` | Last N writes (default 20) with timestamp, path, size delta, and diff line counts. In-memory ring buffer + JSONL persistence. |
| `why_blocked(path)` | Trace the policy chain for a path. Returns `{read, write, matched_rule, hint?}` for each. |

## Write policy chain

Every write tool runs the same ordered checks. The **edit-surface refusal**
is first — that's the whole point of the server: nudge the agent toward AST
edits before it tries a raw overwrite of a `.ts` / `.py` / `.rs` file.

1. **`edit_surface_refuse`** — path matches a language `edit-surface` handles.
   Refused with:
   > This path is source code — use edit-surface (edit_function_body / replace_symbol)
   > instead of raw write. If you really need a raw write, add this path to
   > `[write.allow_source_override]` in `.fs-fallback.toml`.

   Default refusal patterns: `**/*.ts`, `**/*.tsx`, `**/*.js`, `**/*.jsx`,
   `**/*.py`, `**/*.go`, `**/*.rs`, `**/*.nix`. Override the list per-project
   via `[write] edit_surface_refuse = [...]`.

2. **`deny`** — path matches `[write.deny]`. Hard refusal; `confirm` cannot bypass.

3. **`soft_deny`** — path matches a `[write.soft_deny]` rule. The response
   includes the rule's `hint` and refuses unless the caller passes
   `confirm: true`. Every soft_deny bypass is recorded in the audit log with
   the hint text that was overridden.

4. **`allow`** — path matches `[write.allow]`. Permitted.

5. **no match** — refused with "add pattern to `[write.allow]`".

## Config walkthrough

See [`.fs-fallback.toml.example`](./.fs-fallback.toml.example). The server
walks upward from `cwd` to find `.fs-fallback.toml`; set
`FS_FALLBACK_CONFIG=/abs/path` to skip discovery.

```toml
[read]
allow = ["**/*"]
deny  = [".env", ".env.*", "secrets/**", "**/.aws/**", "**/.ssh/**", "**/id_rsa*", "**/*.pem"]

[write]
allow = ["docs/**", "*.md", "*.json", "*.toml", "*.yaml", "*.yml", "scripts/**"]
deny  = []
allow_source_override = []                       # exceptions to edit_surface_refuse
soft_deny = [
  { pattern = "package.json",   hint = "editing package.json manually — did you mean pnpm-wrapper.add / .remove?" },
  { pattern = "pnpm-lock.yaml", hint = "lockfiles are auto-managed — use pnpm-wrapper.install to regenerate" },
  { pattern = "Cargo.lock",     hint = "lockfiles are auto-managed — use cargo/nix commands via nix-dev-exec" },
  { pattern = "flake.lock",     hint = "run `nix flake lock --update-input <name>` via nix-dev-exec" },
]

[trash]
retention_days = 7

[audit]
log     = ".fs-fallback/audit.jsonl"
enabled = true
```

If no config is found, the server falls back to a **restrictive default**:
reads permissive-minus-secrets, all writes refused with a hint to create
`.fs-fallback.toml`.

Pattern syntax is [micromatch](https://github.com/micromatch/micromatch)
(`**` = any depth, `*` = single segment). Patterns match against
project-root-relative paths.

## Path handling

- Every `path` argument is resolved against the project root (dir containing
  `.fs-fallback.toml`, or `cwd` if unconfigured).
- Paths that escape the root via `..` or absolute paths are rejected with
  "outside project root".
- **Symlink escape check** runs on the resolved realpath, so a well-formed
  relative path pointing at a symlink whose target lives outside the project
  is still rejected — a plain string check on the pre-realpath path would
  miss that.
- v0.1 refuses to write *through* an existing symlink (`write_file`,
  `append_file`, `delete_file`). Reading through a symlink is allowed as
  long as both the link and its target realpath sit inside the project root.

## Soft-delete & trash

`delete_file` never calls `unlink`. It moves the file to
`<projectRoot>/.fs-fallback-trash/<YYYY-MM-DD>/<flattened-path>`. The
directory-per-day bucket makes retention trivial: on startup the server
`rmSync`s buckets whose UTC date-stamp is older than
`[trash] retention_days` (default 7). Bucket collisions inside a single day
get a numeric suffix (`.1`, `.2`, ...) so nothing overwrites nothing.

To recover a deleted file, look inside `.fs-fallback-trash/<date>/`, restore
the file, and reverse the `__` separator flattening if needed.

## Audit log

Every mutation (write / append / delete) is appended to
`[audit].log` (default `.fs-fallback/audit.jsonl`) as one JSON line:

```json
{
  "ts": "2026-09-08T22:57:09.575Z",
  "tool": "write_file",
  "path": "README.md",
  "size_before": 0,
  "size_after": 12,
  "diff_lines_added": 1,
  "diff_lines_removed": 0
}
```

Soft-deny bypasses carry the extra fields `confirm: true` and
`soft_deny_bypassed: "<hint text>"` so a reviewer can grep for "who confirmed
what". The same records are held in a 200-entry in-memory ring for
`recent_writes()`.

## Packaging (Nix)

Standalone:

```bash
cd servers/fs-fallback
nix build
./result/bin/fs-fallback --help
```

No runtime PATH additions are needed — the server is pure Node with three
small pure-JS deps (`@modelcontextprotocol/sdk`, `@iarna/toml`, `micromatch`,
`diff`). Package/binary name: `fs-fallback`.

## Standalone use

```nix
{
  inputs.fs-fallback.url = "github:mmmaxwwwell/mcp-toolbelt?dir=servers/fs-fallback";

  outputs = { self, nixpkgs, flake-utils, fs-fallback }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = import nixpkgs { inherit system; }; in
      {
        devShells.default = pkgs.mkShell {
          packages = [ fs-fallback.packages.${system}.default ];
        };
      });
}
```

MCP client wiring:

```json
{
  "mcpServers": {
    "fs-fallback": {
      "command": "fs-fallback"
    }
  }
}
```

Discovery walks up from the launching process's `cwd`; override with
`FS_FALLBACK_CONFIG=/abs/path/.fs-fallback.toml`.

## Composition

Sits behind [`nix-mcp-proxy`](../nix-mcp-proxy/) like every other server.
The proxy can layer additional policy on top of `.fs-fallback.toml` (e.g.
per-agent allowlists, time-of-day restrictions for CI).

## Open design questions

Answered by this implementation:

- **Discovery.** Walks up from `cwd` to find `.fs-fallback.toml`; no config
  → restrictive default.
- **Encoding.** UTF-8 for reads and writes; NUL-byte sniff switches reads
  to base64 (`encoding: "binary"`).
- **Trash lifetime.** UTC date-stamped buckets, purged on startup.

Still open:

- **Binary writes.** `write_file` currently accepts a string argument only;
  no first-class base64 write path. Round-tripping a binary file via
  `read_file` → `write_file` would corrupt it. Needs an explicit
  `write_file_binary(path, content_base64)` tool.
- **Per-symlink policy.** v0.1 refuses to write through *any* symlink and
  allows reading through symlinks that resolve inside the project root.
  A per-project `[symlinks] mode = "refuse"|"follow"|"per-target"` knob is
  out of scope for this pass.
- **`patch_file(path, unified_diff)`.** Third write primitive — smaller
  edits without shipping the full file contents. Attractive but overlaps
  meaningfully with `edit-surface`; deferred until we see the friction.
- **Large-file caps.** No hard byte limit on `write_file` yet. Node's
  default `writeFileSync` will happily allocate GBs. A `max_bytes` policy
  key should ship before the first large-blob accident.
- **Streaming.** MCP is call/response; no streaming write API is planned.
