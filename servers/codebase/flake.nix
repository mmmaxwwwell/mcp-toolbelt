{
  description = "codebase — Nix packaging for tree-sitter-mcp (pinned to v2.8.2)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        version = "2.8.2";
        src = pkgs.fetchFromGitHub {
          owner = "nendotools";
          repo = "tree-sitter-mcp";
          rev = "v${version}";
          hash = "sha256-UfrkxkQSzXf+1cIb231X2rVWlTSNPDccqWyYGHPja5E=";
        };

        tree-sitter-mcp = pkgs.buildNpmPackage {
          pname = "tree-sitter-mcp";
          inherit version src;

          npmDepsHash = "sha256-ywpmjn/Z4oQJUkcGUjbqlcZee9xKk1MVv6Db6utuhb8=";
          makeCacheWritable = true;

          # Native tree-sitter grammars require node-gyp + python3 at build time.
          nativeBuildInputs = with pkgs; [
            python3
            pkg-config
          ];

          buildInputs = with pkgs; [
            nodejs
          ];

          # Build the TypeScript source.
          npmBuildScript = "build";

          meta = with pkgs.lib; {
            description = "MCP server providing tree-sitter-powered code search and analysis for LLMs";
            homepage = "https://github.com/nendotools/tree-sitter-mcp";
            license = licenses.gpl3Only;
            mainProgram = "tree-sitter-mcp";
          };
        };
      in
      {
        packages = {
          inherit tree-sitter-mcp;
          default = tree-sitter-mcp;
        };
      }
    );
}
