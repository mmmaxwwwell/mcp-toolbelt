{
  description = "nix-dev-exec — MCP shell substrate that runs allowlisted operations via `nix develop -c`";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        nix-dev-exec-unwrapped = pkgs.buildNpmPackage {
          pname = "nix-dev-exec";
          version = "0.1.0";
          src = ./server;

          npmDepsHash = "sha256-uBYRTC+e0iE6/C+Eew+HltJJfZkn69V9EWWmBNYIFzI=";

          buildInputs = with pkgs; [
            nodejs
          ];

          makeCacheWritable = true;

          npmBuildScript = "build";

          meta = with pkgs.lib; {
            description = "MCP server exposing a registry of allowlisted operations, each run via `nix develop -c`";
            homepage = "https://github.com/mmmaxwwwell/mcp-toolbelt";
            license = licenses.mit;
            mainProgram = "nix-dev-exec";
          };
        };

        # Wrap so `nix develop` AND `bwrap` are on PATH at runtime.
        # bwrap is a hard requirement — every op runs inside a bubblewrap sandbox by default.
        nix-dev-exec = pkgs.symlinkJoin {
          name = "nix-dev-exec-0.1.0";
          paths = [ nix-dev-exec-unwrapped ];
          nativeBuildInputs = [ pkgs.makeWrapper ];
          postBuild = ''
            wrapProgram $out/bin/nix-dev-exec \
              --prefix PATH : "${pkgs.nix}/bin:${pkgs.bubblewrap}/bin"
          '';
        };
      in
      {
        packages = {
          inherit nix-dev-exec;
          default = nix-dev-exec;
        };
      }
    );
}
