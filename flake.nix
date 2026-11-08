{
  description = "mcp-toolbelt — a Nix flake collection of MCP servers useful to coding agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    # Each server is itself a flake under ./servers/<name>, composed here so
    # the root flake can re-export all of them.
    #
    # These were `path:./servers/<name>`, and that spelling CANNOT be consumed
    # transitively. A relative path input locks as the literal string
    # "path:./servers/<name>", which is resolved against whatever flake is the
    # ROOT of the evaluation — not against this one. So the moment a consumer
    # is itself consumed as an input (homelab -> claude-runner -> here, which
    # is exactly what colmena does when it copies the hive), Nix looks for
    # <root>/servers/<name>/flake.nix and fails.
    #
    # `?dir=` on an absolute URL is root-independent, so it survives nesting.
    #
    # COST: this flake now names its own repository, so a change to a server
    # takes two commits — one for the change, one to relock the self-reference
    # onto it. At the GitHub cutover this URL has to move with the repo.
        code-graph.url = "git+file:///home/max/git/mcp-toolbelt?dir=servers/code-graph";
    code-graph.inputs.nixpkgs.follows = "nixpkgs";
    code-graph.inputs.flake-utils.follows = "flake-utils";

    git-guard.url = "git+file:///home/max/git/mcp-toolbelt?dir=servers/git-guard";
    git-guard.inputs.nixpkgs.follows = "nixpkgs";
    git-guard.inputs.flake-utils.follows = "flake-utils";

    codebase.url = "git+file:///home/max/git/mcp-toolbelt?dir=servers/codebase";
    codebase.inputs.nixpkgs.follows = "nixpkgs";
    codebase.inputs.flake-utils.follows = "flake-utils";

    web-browser.url = "git+file:///home/max/git/mcp-toolbelt?dir=servers/web-browser";
    web-browser.inputs.nixpkgs.follows = "nixpkgs";
    web-browser.inputs.flake-utils.follows = "flake-utils";

    web-search.url = "git+file:///home/max/git/mcp-toolbelt?dir=servers/web-search";
    web-search.inputs.nixpkgs.follows = "nixpkgs";
    web-search.inputs.flake-utils.follows = "flake-utils";

    task-runner.url = "git+file:///home/max/git/mcp-toolbelt?dir=servers/task-runner";
    task-runner.inputs.nixpkgs.follows = "nixpkgs";
    task-runner.inputs.flake-utils.follows = "flake-utils";

    test-runner.url = "git+file:///home/max/git/mcp-toolbelt?dir=servers/test-runner";
    test-runner.inputs.nixpkgs.follows = "nixpkgs";
    test-runner.inputs.flake-utils.follows = "flake-utils";

    edit-surface.url = "git+file:///home/max/git/mcp-toolbelt?dir=servers/edit-surface";
    edit-surface.inputs.nixpkgs.follows = "nixpkgs";
    edit-surface.inputs.flake-utils.follows = "flake-utils";

    sqlite-store.url = "git+file:///home/max/git/mcp-toolbelt?dir=servers/sqlite-store";
    sqlite-store.inputs.nixpkgs.follows = "nixpkgs";
    sqlite-store.inputs.flake-utils.follows = "flake-utils";

    docs-fetcher.url = "git+file:///home/max/git/mcp-toolbelt?dir=servers/docs-fetcher";
    docs-fetcher.inputs.nixpkgs.follows = "nixpkgs";
    docs-fetcher.inputs.flake-utils.follows = "flake-utils";

    nix-dev-exec.url = "git+file:///home/max/git/mcp-toolbelt?dir=servers/nix-dev-exec";
    nix-dev-exec.inputs.nixpkgs.follows = "nixpkgs";
    nix-dev-exec.inputs.flake-utils.follows = "flake-utils";

    pnpm-wrapper.url = "git+file:///home/max/git/mcp-toolbelt?dir=servers/pnpm-wrapper";
    pnpm-wrapper.inputs.nixpkgs.follows = "nixpkgs";
    pnpm-wrapper.inputs.flake-utils.follows = "flake-utils";

    fs-fallback.url = "git+file:///home/max/git/mcp-toolbelt?dir=servers/fs-fallback";
    fs-fallback.inputs.nixpkgs.follows = "nixpkgs";
    fs-fallback.inputs.flake-utils.follows = "flake-utils";

    github-api.url = "git+file:///home/max/git/mcp-toolbelt?dir=servers/github-api";
    github-api.inputs.nixpkgs.follows = "nixpkgs";
    github-api.inputs.flake-utils.follows = "flake-utils";

    graph-edit.url = "git+file:///home/max/git/mcp-toolbelt?dir=servers/graph-edit";
    graph-edit.inputs.nixpkgs.follows = "nixpkgs";
    graph-edit.inputs.flake-utils.follows = "flake-utils";

    # nix-mcp-proxy's core is implemented upstream (~/git/nix-mcp-proxy main,
    # unpushed), with a credential-injection + HTTP-upstream branch in
    # ~/git/nix-mcp-proxy-broker (broker-secrets, also unpushed). This slot
    # still has no flake.nix of its own — see servers/nix-mcp-proxy/README.md
    # for what's left before this input can point at a real package.
    # nix-mcp-proxy.url = "github:mmmaxwwwell/nix-mcp-proxy";
  };

  outputs = { self, nixpkgs, flake-utils, code-graph, git-guard, codebase, web-browser, web-search, task-runner, test-runner, edit-surface, sqlite-store, docs-fetcher, nix-dev-exec, pnpm-wrapper, fs-fallback, github-api, graph-edit, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        codeGraphPkg = code-graph.packages.${system}.code-review-graph;
        mcpServerGit = git-guard.packages.${system}.mcp-server-git;
        treeSitterMcp = codebase.packages.${system}.tree-sitter-mcp;
        webBrowserSidecar = web-browser.packages.${system}.web-browser-sidecar;
        webSearchPkg = web-search.packages.${system}.web-search;
        shellMcpPkg = task-runner.packages.${system}.shell-mcp;
        mcpTestRunner = test-runner.packages.${system}.mcp-test-runner;
        semanticEditMcp = edit-surface.packages.${system}.semantic-edit-mcp;
        sqliteMemoryMcp = sqlite-store.packages.${system}.sqlite-memory-mcp;
        docsFetcherPkg = docs-fetcher.packages.${system}.default;
        nixDevExecPkg = nix-dev-exec.packages.${system}.default;
        pnpmWrapperPkg = pnpm-wrapper.packages.${system}.default;
        fsFallbackPkg = fs-fallback.packages.${system}.default;
        githubApiPkg = github-api.packages.${system}.github-mcp-server;
        graphEditPkg = graph-edit.packages.${system}.default;

        # claude-with-servers: wrapper script that starts all configured MCP
        # servers and launches claude with a merged .mcp.json.
        claude-with-servers = pkgs.writeShellScriptBin "claude-with-servers" (
          builtins.readFile ./scripts/claude-with-servers
        );

        # Composite mkShellHook — accepts a `servers` attrset where each key
        # toggles a server on/off and forwards its per-server options.
        # Currently only `codeGraph` produces a hook; future servers
        # (docsFetcher, nixMcpProxy) will plug into the same shape.
        mkShellHook =
          { projectName ? "project"
          , servers ? { }
          }:
          let
            cg = servers.codeGraph or { enable = false; };
            codeGraphHook =
              if cg.enable or false
              then code-graph.lib.${system}.mkShellHook ({
                inherit projectName;
              } // (removeAttrs cg [ "enable" ]))
              else "";
          in
          codeGraphHook;
      in
      {
        packages = {
          # Re-export the underlying server packages so consumers can pull
          # individual binaries without going through mkShellHook.
          code-review-graph = codeGraphPkg;
          mcp-server-git = mcpServerGit;
          tree-sitter-mcp = treeSitterMcp;
          web-browser-sidecar = webBrowserSidecar;
          inherit (web-search.packages.${system}) web-search;
          shell-mcp = shellMcpPkg;
          mcp-test-runner = mcpTestRunner;
          semantic-edit-mcp = semanticEditMcp;
          sqlite-memory-mcp = sqliteMemoryMcp;
          docs-fetcher = docsFetcherPkg;
          nix-dev-exec = nixDevExecPkg;
          pnpm-wrapper = pnpmWrapperPkg;
          fs-fallback = fsFallbackPkg;
          github-mcp-server = githubApiPkg;
          graph-edit = graphEditPkg;
          inherit claude-with-servers;
          default = claude-with-servers;
        };

        lib = {
          inherit mkShellHook;

          # mkDevShell — one-call setup for consuming projects.
          # Returns a devShell with selected MCP servers on PATH,
          # claude-with-servers launcher, and a shellHook that
          # configures code-review-graph if enabled.
          mkDevShell =
            { pkgs ? import nixpkgs { inherit system; }
            , projectName ? "project"
            , servers ? {}
            , extraPackages ? []
            , extraShellHook ? ""
            }:
            let
              # Server enable flags with defaults
              srv = {
                codeGraph   = (servers.codeGraph or {}).enable or true;
                codebase    = (servers.codebase or {}).enable or true;
                editSurface = (servers.editSurface or {}).enable or true;
                gitGuard    = (servers.gitGuard or {}).enable or true;
                taskRunner  = (servers.taskRunner or {}).enable or true;
                testRunner  = (servers.testRunner or {}).enable or true;
                webBrowser  = (servers.webBrowser or {}).enable or false;
                webSearch   = (servers.webSearch or {}).enable or false;
                sqliteStore = (servers.sqliteStore or {}).enable or false;
                docsFetcher = (servers.docsFetcher or {}).enable or false;
                nixDevExec  = (servers.nixDevExec or {}).enable or false;
                pnpmWrapper = (servers.pnpmWrapper or {}).enable or false;
                fsFallback  = (servers.fsFallback or {}).enable or false;
                githubApi   = (servers.githubApi or {}).enable or false;
                graphEdit   = (servers.graphEdit or {}).enable or false;
              };

              # Map enabled flags to packages
              serverPackages =
                pkgs.lib.optional srv.codeGraph   codeGraphPkg
                ++ pkgs.lib.optional srv.codebase    treeSitterMcp
                ++ pkgs.lib.optional srv.editSurface semanticEditMcp
                ++ pkgs.lib.optional srv.gitGuard    mcpServerGit
                ++ pkgs.lib.optional srv.taskRunner  shellMcpPkg
                ++ pkgs.lib.optional srv.testRunner  mcpTestRunner
                ++ pkgs.lib.optional srv.webBrowser  webBrowserSidecar
                ++ pkgs.lib.optional srv.webSearch   webSearchPkg
                ++ pkgs.lib.optional srv.sqliteStore sqliteMemoryMcp
                ++ pkgs.lib.optional srv.docsFetcher docsFetcherPkg
                ++ pkgs.lib.optional srv.nixDevExec  nixDevExecPkg
                ++ pkgs.lib.optional srv.pnpmWrapper pnpmWrapperPkg
                ++ pkgs.lib.optional srv.fsFallback  fsFallbackPkg
                ++ pkgs.lib.optional srv.githubApi   githubApiPkg
                ++ pkgs.lib.optional srv.graphEdit   graphEditPkg;

              hook = mkShellHook {
                inherit projectName;
                servers = {
                  codeGraph = (servers.codeGraph or {}) // {
                    enable = srv.codeGraph;
                  };
                };
              };
            in
            pkgs.mkShell {
              packages = serverPackages ++ [ claude-with-servers pkgs.git pkgs.jq ] ++ extraPackages;
              shellHook = hook + extraShellHook;
            };
        };

        # Dev shell for hacking on the toolbelt itself — gives you the
        # code-review-graph CLI on PATH so you can sanity-check the vendored
        # flake without entering a consumer project.
        # claude-with-servers is included so you can test the launcher.
        devShells.default = pkgs.mkShell {
          packages = [
            codeGraphPkg mcpServerGit treeSitterMcp webBrowserSidecar webSearchPkg
            shellMcpPkg mcpTestRunner semanticEditMcp sqliteMemoryMcp
            docsFetcherPkg nixDevExecPkg pnpmWrapperPkg fsFallbackPkg githubApiPkg
            graphEditPkg
            claude-with-servers pkgs.git pkgs.jq pkgs.uv pkgs.bubblewrap
          ];
        };

        # Automated test coverage — reachable via `nix flake check`.
        # smoke-tests: fast per-server + integration bash tests in the nix
        #   sandbox. No network, no unpriv userns; skips anything gated by
        #   either at the test level.
        # vm-integration: NixOS VM boot + full battery including the
        #   fs-fallback / nix-dev-exec / pnpm-wrapper scenario, plus a
        #   bwrap mount-boundary probe and a pnpm-wrapper --global refusal.
        #   Requires KVM in the build environment.
        checks = {
          smoke-tests = pkgs.runCommand "mcp-toolbelt-smoke-tests"
            {
              nativeBuildInputs = [
                pkgs.bash pkgs.jq pkgs.git pkgs.bubblewrap pkgs.coreutils
                codeGraphPkg mcpServerGit treeSitterMcp webBrowserSidecar
                webSearchPkg shellMcpPkg mcpTestRunner semanticEditMcp
                sqliteMemoryMcp docsFetcherPkg nixDevExecPkg pnpmWrapperPkg
                fsFallbackPkg githubApiPkg graphEditPkg claude-with-servers
              ];
            } ''
              set -euo pipefail
              cp -r ${self} $TMPDIR/src
              chmod -R +w $TMPDIR/src
              cd $TMPDIR/src
              export HOME=$TMPDIR/home
              mkdir -p $HOME
              export GITHUB_PERSONAL_ACCESS_TOKEN=fake_token_for_test
              # Sandbox-safe subset — omitted tests need something the nix
              # build sandbox can't provide:
              #   git-guard      → needs a real .git directory
              #   integration    → claude-with-servers can't exec fake `claude`
              #   env-toggles    → same
              #   web-browser    → spins up a python http fixture, needs net
              #   test-runner    → mcp-test-runner initialize hangs offline
              SAFE=(
                tests/lib.sh
                tests/codebase.sh
                tests/edit-surface.sh
                tests/task-runner.sh
                tests/sqlite-store.sh
                tests/web-search.sh
                tests/docs-fetcher.sh
                tests/nix-dev-exec.sh
                tests/pnpm-wrapper.sh
                tests/fs-fallback.sh
                tests/github-api.sh
              )
              fail=0
              for t in "''${SAFE[@]}"; do
                echo "--- $t ---"
                bash "$t" || fail=1
              done
              if [ "$fail" -ne 0 ]; then
                echo "FAIL: some smoke tests failed"
                exit 1
              fi
              touch $out
            '';

          vm-integration = import ./tests/vm/default.nix {
            inherit pkgs self;
            fsFallback         = fsFallbackPkg;
            nixDevExec         = nixDevExecPkg;
            pnpmWrapper        = pnpmWrapperPkg;
            docsFetcher        = docsFetcherPkg;
            githubApi          = githubApiPkg;
            semanticEditMcp    = semanticEditMcp;
          };
        };
      }
    );
}
