# fs-fallback (design only)

ACL-gated raw read/write for files the graph doesn't model — READMEs, JSON
configs, lockfiles, shell scripts, anything in a language without an
[`edit-surface`](../edit-surface/) backend. **Discouraged but present.** The
tool descriptions steer the agent toward `edit-surface` first; this is the
escape hatch.

## Status

Design only — no implementation yet.

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

## MCP tool surface (planned)

### Read

- `read_file(path)` — full contents; path must match allowlist
- `read_file_range(path, start_line, end_line)` — partial read for big files
- `stat_file(path)` — size, mtime, presence
- `list_dir(path)` — directory contents
- `glob(pattern, base?)` — pattern match within allowed roots

### Write

- `write_file(path, content)` — full overwrite; rejected if path is a
  language with an `edit-surface` backend (response: "use edit-surface
  instead — `edit_function_body`/`replace_symbol`")
- `append_file(path, content)`
- `delete_file(path)` — soft-delete to `.fs-fallback-trash/` for N days

### Audit

- `recent_writes()` — last N write operations with diffs
- `why_blocked(path)` — explains the allowlist decision

## Security model

Same shape as [`nix-mcp-proxy`](../nix-mcp-proxy/) — declarative per-project
policy. Example `.fs-fallback.toml`:

```toml
[read]
allow = ["**/*"]
deny  = [".env", ".env.*", "secrets/**", "**/.aws/**"]

[write]
allow = ["docs/**", "*.md", "*.json", "*.toml", "*.yaml", "scripts/**"]
deny  = ["src/**/*.ts", "src/**/*.py"]  # forces edit-surface for these
soft_deny = ["package.json", "pnpm-lock.yaml"]  # warns + requires --confirm

[audit]
log = ".fs-fallback/audit.jsonl"
```

`soft_deny` is the interesting one — the agent *can* write the file, but the
tool response includes a prominent warning ("you're editing a lockfile
manually — did you mean `pnpm-wrapper.add`?"). This nudges without blocking.

## Briefing pattern

Every write-tool description leads with: *"Use [`edit-surface`](../edit-surface/)
for source code. This tool is for configs, docs, and non-code files only."*

The `start_session` response (from `edit-surface`) lists which paths are
`fs-fallback`-only vs `edit-surface`-routed, so the agent doesn't have to
guess.

## Composition

Sits behind [`nix-mcp-proxy`](../nix-mcp-proxy/), like every other server.
The proxy can layer additional policy on top of `.fs-fallback.toml` (e.g.
per-agent allowlists, time-of-day restrictions for CI).

## Open design questions

- **Symlink handling.** Follow, refuse, or per-policy?
- **Binary files.** Allow `write_file` with base64? Or refuse and require a
  dedicated upload tool?
- **Large files.** Hard cap on `write_file` size? Streaming write API?
- **Diff vs. full write.** Add `patch_file(path, unified_diff)` as a third
  write primitive, or keep the surface minimal?
- **Encoding.** Always UTF-8, or detect-and-preserve?
