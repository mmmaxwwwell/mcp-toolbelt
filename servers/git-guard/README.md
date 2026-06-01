# git-guard

Nix packaging for [`mcp-server-git`](https://github.com/modelcontextprotocol/servers/tree/main/src/git)
(MIT, pinned to 2026.1.14) — a Model Context Protocol server providing tools
to read, search, and manipulate Git repositories via LLMs.

## Upstream research

| Field | Value |
|---|---|
| PyPI package | [`mcp-server-git`](https://pypi.org/project/mcp-server-git/) |
| Latest release | **2026.1.14** (calver; prior releases used semver 0.x) |
| Repository | [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) (monorepo, `src/git/`) |
| License | MIT |
| Python | >=3.10 |
| Build system | hatchling |
| Entry point | `mcp-server-git` (console script: `mcp_server_git:main`) |
| Stdio mode | Default transport is stdio; no special flags required |
| CLI flags | `--repository <path>` — sets the git repo to operate on |

### Runtime dependencies

| Package | Version constraint |
|---|---|
| click | >=8.1.7 |
| gitpython | >=3.1.45 |
| mcp | >=1.0.0 |
| pydantic | >=2.0.0 |

### MCP tools provided

The server exposes 12 git operations over MCP:

- `git_status` — working directory state
- `git_diff_unstaged` — uncommitted changes
- `git_diff_staged` — staged modifications
- `git_diff` — compare branches or commits
- `git_commit` — record changes with a message
- `git_add` — stage file contents
- `git_reset` — unstage all changes
- `git_log` — commit history (supports date filtering)
- `git_create_branch` — create a new branch
- `git_checkout` — switch branches
- `git_show` — display commit contents
- `git_branch` — list branches (with filtering)

## Packaging notes

- Source is in a monorepo (`src/git/`). For Nix, fetch from PyPI sdist or use
  `fetchFromGitHub` with `sourceRoot = "src/git"`.
- The version scheme switched from semver to calver at 2025.1.14. Pin to the
  calver release on PyPI.
- `gitpython` requires `git` at runtime — ensure `git` is on `PATH` or wrapped.
- All four runtime deps (`click`, `gitpython`, `mcp`, `pydantic`) are available
  in nixpkgs `python3Packages`.
- Use `buildPythonApplication` with `hatchling` as build system.

## Standalone use

```nix
{
  inputs.git-guard.url = "github:mmmaxwwwell/mcp-toolbelt?dir=servers/git-guard";

  outputs = { self, nixpkgs, flake-utils, git-guard }:
    flake-utils.lib.eachDefaultSystem (system: {
      devShells.default = nixpkgs.legacyPackages.${system}.mkShell {
        packages = [ git-guard.packages.${system}.mcp-server-git ];
      };
    });
}
```
