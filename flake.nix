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

    # nix-mcp-proxy is still under construction (spec-kit phase 6 — tasks
    # generated, not implemented). When it ships a buildable package the
    # passthrough server under ./servers/nix-mcp-proxy will start re-exporting
    # it; until then the slot just carries documentation.
    # nix-mcp-proxy.url = "github:mmmaxwwwell/nix-mcp-proxy";
  };

  outputs = { self, nixpkgs, flake-utils, code-graph, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        codeGraphPkg = code-graph.packages.${system}.code-review-graph;

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
          packages = [ codeGraphPkg claude-with-servers pkgs.git pkgs.jq ];
        };
      }
    );
}
