# Interview Notes: Package Upstream MCP Servers

**Date**: 2026-05-23
**Preset**: local
**Nix available**: yes
**Payment integration**: none
**code-review-graph**: wired at phase 0, watcher active, CLAUDE.md stanza pending

## Key Decisions

1. **Scope: packaging only** — User explicitly chose to package 7 upstream MCP servers into Nix flakes. No custom server implementation (edit-surface graph ops, fs-fallback ACLs, pnpm-wrapper verbs, nix-dev-exec registry). Rationale: get the packaging infrastructure solid first, build custom features later.

2. **Linux only** — User explicitly said "nix only". No macOS/Darwin support. Simplifies Playwright/Chromium handling and avoids cross-platform Nix builder headaches.

3. **Direct-to-main** — Solo developer workflow, no feature branches or PRs needed.

4. **nix-mcp-proxy deferred** — Upstream not buildable yet. Keep the placeholder slot.

## Alternatives Considered and Rejected

- **Building custom servers from scratch** — Rejected by user; too ambitious for first pass. The design docs exist for future reference.
- **macOS support** — Rejected by user; Linux only.
- **Docker packaging** — Not considered; project is Nix-first by constitution.

## User Priorities

1. Get all 7 upstream servers buildable via Nix
2. Each server independently consumable as a standalone flake
3. `claude-with-servers` composition working with all servers
4. Test infrastructure per RUNBOOK (3 levels)

## Non-Obvious Requirements

- `fetcher-mcp` (web-browser) needs Playwright + Chromium — expected to be the hardest server to package. May need a wrapper script to set `PLAYWRIGHT_BROWSERS_PATH`.
- Several Python/TypeScript upstreams may pin transitive deps too tightly — `pythonRelaxDeps` pattern from code-graph will likely be needed repeatedly.
- Some servers may need `--stdio` or `serve` flags to force stdio transport — must be researched per-server.

## Enterprise Infrastructure Summary

| Topic | Decision |
|-------|----------|
| Logging | N/A (packaging project) |
| Error handling | N/A |
| Config | Generated `.mcp.json` |
| CI/CD | GitHub Actions — build + test all servers |
| Branching | Direct-to-main |
| DX | `nix develop` + `claude-with-servers` |
| Shutdown | Already implemented (trap in launcher) |
| Health checks | N/A (stdio processes) |
| Security scanning | Tier 1 (Gitleaks) |
