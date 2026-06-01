{
  description = "task-runner — Nix packaging for devrelopers/shell-mcp (pinned to v0.1.1)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        version = "0.1.1";
        src = pkgs.fetchFromGitHub {
          owner = "devrelopers";
          repo = "shell-mcp";
          rev = "v${version}";
          hash = "sha256-XoLqggr/7HpQv6HSYC6hK+6xoIDG2unmIlAzIVCfp2s=";
        };

        shell-mcp = pkgs.rustPlatform.buildRustPackage {
          pname = "shell-mcp";
          inherit version src;

          cargoLock.lockFile = ./Cargo.lock;

          postPatch = ''
            cp ${./Cargo.lock} Cargo.lock
          '';

          meta = with pkgs.lib; {
            description = "MCP server providing scoped, allowlisted shell access for LLMs";
            homepage = "https://github.com/devrelopers/shell-mcp";
            license = licenses.mit;
            mainProgram = "shell-mcp";
          };
        };
      in
      {
        packages = {
          inherit shell-mcp;
          default = shell-mcp;
        };
      }
    );
}
