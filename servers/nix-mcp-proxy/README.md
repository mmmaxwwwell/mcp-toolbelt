# nix-mcp-proxy (placeholder)

Slot for [`mmmaxwwwell/nix-mcp-proxy`](https://github.com/mmmaxwwwell/nix-mcp-proxy)
— a typed, sealed, middleware-driven MCP proxy that sits between agents and
upstream MCP servers, enforcing a whitelist of allowed tools / paths / fields
via a registry of pluggable validator functions and an ASP.NET-style
middleware pipeline. Built TypeScript-first with first-class Nix support.

## Status

Upstream is in spec-kit phase 6 — `tasks.md` is generated, implementation
hasn't started. This slot will become a real passthrough flake (and the root
`mcp-toolbelt` flake will wire it into `mkShellHook`) once upstream ships a
buildable Nix package.

## Why a proxy belongs in the toolbelt

Agents accumulate MCP servers fast. A proxy in front of them lets you:

- Whitelist exactly which tools, paths, and fields an agent can touch
  per-project — instead of inheriting whatever the upstream server exposes.
- Apply middleware (logging, rate limiting, redaction, request shaping)
  uniformly without modifying each upstream server.
- Seal the surface area for higher-risk environments (CI, autonomous loops,
  shared boxes) without giving up the underlying server functionality.

## Track progress

Watch [the upstream repo](https://github.com/mmmaxwwwell/nix-mcp-proxy)
or check `specs/001-core-proxy/tasks.md` there for the current implementation
plan.
