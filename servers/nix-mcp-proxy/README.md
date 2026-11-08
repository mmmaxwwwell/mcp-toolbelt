# nix-mcp-proxy (not yet packaged here)

Slot for [`mmmaxwwwell/nix-mcp-proxy`](https://github.com/mmmaxwwwell/nix-mcp-proxy)
— a typed, sealed, middleware-driven MCP proxy that sits between agents and
upstream MCP servers, enforcing a whitelist of allowed tools / paths / fields
via a registry of pluggable validator functions and an ASP.NET-style
middleware pipeline. Built TypeScript-first with first-class Nix support.

## Status

**Implemented upstream, not yet integrated here.** This directory still has
no `flake.nix` (unlike `servers/github-api/`, `servers/web-search/` and the
other packaged slots), and the root `flake.nix` does not reference it.

### What upstream does today (`nix-mcp-proxy`, branch `main`)

The `001-core-proxy` spec is implemented, including the E2E workflow suite
(W-AGENT-1..12, W-CONS-1..7, W-SYS-1..6, W-BROWSER-1..6, W-DEV-2..7) wired
into `pnpm run pre-pr`.

- **Proxy core**: `createProxy` builds a proxy from a config object; the
  agent-facing side is served over stdio (SSE server transport also exists),
  upstreams are stdio or SSE.
- **Whitelist + validation**: only allowlisted tools are exposed (namespaced by
  upstream id by default); each allowed field is checked by a validator.
  Built-ins: `regex`, `enum`, `pathAllow`, `range`, `requiredFields`,
  `jsonSchema`; custom ones via `extraValidators`. Rejections come back as
  structured errors with stable codes (`tool_not_allowed`,
  `validator_rejected`, ...).
- **`proxy.describe`**: an introspection tool returning the narrowed schema,
  so the agent sees only what it is permitted to call.
- **Sealed config**: the config is a Zod schema (exported as JSON Schema at
  `schema/config.json`). The flake's `lib.mkProxy { config, extraValidators,
  extraMiddleware }` validates a Nix-native config at build time (JSON-pointer
  errors) and produces a derivation with the config sealed read-only.
  `packages.default` is the proxy itself; `examples/minimal-consumer/` is a
  working consumer flake.
- Built-in middleware is error mapping, request-size limit and validation;
  anything else (rate limiting, redaction, ...) is custom middleware.

### Active successor: `nix-mcp-proxy-broker` (branch `broker-secrets`)

`~/git/nix-mcp-proxy-broker` is a git worktree of the same repository on
branch `broker-secrets`, three commits ahead of `main` and not yet merged:

- **`${SECRET:name}` credential injection** in upstream header/env values
  (e.g. `"Bearer ${SECRET:ha-bench}"`), read at connect time from files in
  `NIX_MCP_PROXY_SECRETS_DIR` or systemd's `CREDENTIALS_DIRECTORY`
  (`LoadCredential=`), never from the environment or inline config. The
  credential reaches the upstream and nowhere else.
- **Streamable-HTTP upstream** transport (`kind: "http"`), alongside stdio
  and SSE.
- **`checks.broker-e2e`**: agent -> sealed `mkProxy` binary -> recording HTTP
  upstream standing in for Home Assistant's MCP server; asserts the agent sees
  exactly the allowlist, a non-allowlisted value is `validator_rejected`, a
  hidden tool is `tool_not_allowed`, and every upstream request carried the
  brokered bearer.
- Runtime closure trimmed to production dependencies (232 -> 40 MiB
  `node_modules`).

### Where it is headed: claude-runner's `mcp-upstream` grant

claude-runner's `docs/local-agents-plan.md` makes nix-mcp-proxy the broker
**engine** (D5, owner input O1): a grant `{kind: "mcp-upstream", upstream,
credential, tools, fields}` lets one agent reach one external MCP server (first
consumer: Home Assistant) through a sealed proxy config holding one vault
credential, which the agent never sees. Milestone M2 ("nix-mcp-proxy
`${SECRET:}` from files, streamable HTTP upstream, socket serve; claude-runner
broker renders `mcp-upstream` grants") is partly done:

- Done: `${SECRET:}` from files and streamable HTTP (the broker branch above).
- Done in isolation: claude-runner's `broker/mcp-upstream.js` validates grants
  and renders them to a nix-mcp-proxy config, tested by
  `checks.mcp-upstream-unit`.
- Not done: serving the proxy over a socket/loopback behind claude-runner's
  gate (the server side is still stdio/SSE), and actually launching
  nix-mcp-proxy at runtime. Nothing outside that unit test imports
  `mcp-upstream.js`, and `lib/mcp-registry.nix` (the MCP servers agents get)
  does not list nix-mcp-proxy.

## Why a proxy belongs in the toolbelt

Agents accumulate MCP servers fast. A proxy in front of them lets you:

- Whitelist exactly which tools, paths, and fields an agent can touch
  per-project — instead of inheriting whatever the upstream server exposes.
- Apply middleware (logging, rate limiting, redaction, request shaping)
  uniformly without modifying each upstream server.
- Seal the surface area for higher-risk environments (CI, autonomous loops,
  shared boxes) without giving up the underlying server functionality.
- Hold an upstream's credential on the agent's behalf (`${SECRET:name}`), so a
  sandboxed agent can use a service without ever holding its key.

## Track progress

- [`nix-mcp-proxy`](https://github.com/mmmaxwwwell/nix-mcp-proxy) `main`:
  the core proxy. Note that the local `~/git/nix-mcp-proxy` `main` is well
  ahead of `origin/main` (the E2E work is not pushed yet), so the GitHub view
  lags.
- `nix-mcp-proxy` branch `broker-secrets` (local worktree
  `~/git/nix-mcp-proxy-broker`): secret injection + HTTP upstream.
- claude-runner `docs/local-agents-plan.md` D5 / M2: the integration plan.

**Remaining step for this slot**: add `servers/nix-mcp-proxy/flake.nix` that
passes through upstream's `packages.default` and `lib.mkProxy` (pinned to a
pushed rev, ideally after `broker-secrets` merges to `main`), then wire it into
the root `flake.nix` (the commented-out `nix-mcp-proxy` input there) and
`mkShellHook`.
