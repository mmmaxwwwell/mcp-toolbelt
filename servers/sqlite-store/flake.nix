{
  description = "sqlite-store — Nix packaging for sqlite-memory-mcp (pinned to v3.12.0)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        python = pkgs.python312;

        version = "3.12.0";
        src = pkgs.fetchFromGitHub {
          owner = "RMANOV";
          repo = "sqlite-memory-mcp";
          rev = "v${version}";
          hash = "sha256-1ORRtUX2P+b0vt0dz0IUz4aylVske1qWRq9pC9YTLrM=";
        };

        sqlite-memory-mcp = python.pkgs.buildPythonApplication {
          pname = "sqlite-memory-mcp";
          inherit version src;
          pyproject = true;

          build-system = with python.pkgs; [ setuptools ];

          dependencies = with python.pkgs; [
            fastmcp
          ];

          doCheck = false;

          pythonImportsCheck = [ "server" ];

          meta = with pkgs.lib; {
            description = "SQLite-backed MCP memory server with knowledge graph, FTS5 search, and WAL concurrent safety";
            homepage = "https://github.com/RMANOV/sqlite-memory-mcp";
            license = licenses.mit;
            mainProgram = "sqlite-memory-mcp";
          };
        };
      in
      {
        packages = {
          inherit sqlite-memory-mcp;
          default = sqlite-memory-mcp;
        };
      }
    );
}
