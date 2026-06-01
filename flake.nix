{
  description = "mcp-toolbelt — a Nix flake collection of MCP servers useful to coding agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    # Each server is itself a flake under ./servers/<name>. Pulling them in as
    # path inputs keeps versioning local (one flake.lock per server) while
    # still letting the root flake compose them.
    code-graph.url = "path:./servers/code-graph";
    code-graph.inputs.nixpkgs.follows = "nixpkgs";
    code-graph.inputs.flake-utils.follows = "flake-utils";

    git-guard.url = "path:./servers/git-guard";
    git-guard.inputs.nixpkgs.follows = "nixpkgs";
    git-guard.inputs.flake-utils.follows = "flake-utils";

    codebase.url = "path:./servers/codebase";
    codebase.inputs.nixpkgs.follows = "nixpkgs";
    codebase.inputs.flake-utils.follows = "flake-utils";

    web-browser.url = "path:./servers/web-browser";
    web-browser.inputs.nixpkgs.follows = "nixpkgs";
    web-browser.inputs.flake-utils.follows = "flake-utils";

    web-search.url = "path:./servers/web-search";
    web-search.inputs.nixpkgs.follows = "nixpkgs";
    web-search.inputs.flake-utils.follows = "flake-utils";

    task-runner.url = "path:./servers/task-runner";
    task-runner.inputs.nixpkgs.follows = "nixpkgs";
    task-runner.inputs.flake-utils.follows = "flake-utils";

    test-runner.url = "path:./servers/test-runner";
    test-runner.inputs.nixpkgs.follows = "nixpkgs";
    test-runner.inputs.flake-utils.follows = "flake-utils";

    # nix-mcp-proxy is still under construction (spec-kit phase 6 — tasks
    # generated, not implemented). When it ships a buildable package the
    # passthrough server under ./servers/nix-mcp-proxy will start re-exporting
    # it; until then the slot just carries documentation.
    # nix-mcp-proxy.url = "github:mmmaxwwwell/nix-mcp-proxy";
  };

  outputs = { self, nixpkgs, flake-utils, code-graph, git-guard, codebase, web-browser, web-search, task-runner, test-runner, ... }:
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
          inherit claude-with-servers;
          default = claude-with-servers;
        };

        lib = {
          inherit mkShellHook;
        };

        # Dev shell for hacking on the toolbelt itself — gives you the
        # code-review-graph CLI on PATH so you can sanity-check the vendored
        # flake without entering a consumer project.
        # claude-with-servers is included so you can test the launcher.
        devShells.default = pkgs.mkShell {
          packages = [ codeGraphPkg mcpServerGit treeSitterMcp webBrowserSidecar webSearchPkg shellMcpPkg mcpTestRunner claude-with-servers pkgs.git pkgs.jq pkgs.uv ];
        };
      }
    );
}
