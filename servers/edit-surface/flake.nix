{
  description = "edit-surface — Nix packaging for jbr/semantic-edit-mcp (pinned to v0.2.1)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        version = "0.2.1";
        src = pkgs.fetchFromGitHub {
          owner = "jbr";
          repo = "semantic-edit-mcp";
          rev = "v${version}";
          hash = "sha256-8s2mx2vvDwKvV+dVkVOJq4DDt2uv1jRrjyUd9vbwBpI=";
        };

        semantic-edit-mcp = pkgs.rustPlatform.buildRustPackage {
          pname = "semantic-edit-mcp";
          inherit version src;

          cargoLock.lockFile = ./Cargo.lock;

          # Snapshot tests fail in the Nix sandbox (read-only filesystem)
          doCheck = false;

          meta = with pkgs.lib; {
            description = "MCP server for AST-aware code editing using tree-sitter";
            homepage = "https://github.com/jbr/semantic-edit-mcp";
            license = with licenses; [ mit asl20 ];
            mainProgram = "semantic-edit-mcp";
          };
        };
      in
      {
        packages = {
          inherit semantic-edit-mcp;
          default = semantic-edit-mcp;
        };
      }
    );
}
