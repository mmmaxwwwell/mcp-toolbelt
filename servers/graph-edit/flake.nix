{
  description = "graph-edit — AST-first source-code editing MCP server (TypeScript v1) backed by ts-morph";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        graph-edit-unwrapped = pkgs.buildNpmPackage {
          pname = "graph-edit";
          version = "0.1.0";
          src = ./server;

          npmDepsHash = "sha256-mvBcBVK0cdARNc1slz0j4GCkL41soIpfABSZeS9ozA8=";

          nativeBuildInputs = with pkgs; [
            python3
            pkg-config
          ];

          buildInputs = with pkgs; [
            nodejs_22
          ];

          makeCacheWritable = true;

          npmBuildScript = "build";

          meta = with pkgs.lib; {
            description = "MCP server for AST-first source-code editing (TypeScript v1) backed by ts-morph";
            homepage = "https://github.com/mmmaxwwwell/mcp-toolbelt";
            license = licenses.mit;
            mainProgram = "graph-edit";
          };
        };

        # Wrap so `prettier` (formatter) and `node` are on PATH at runtime.
        graph-edit = pkgs.symlinkJoin {
          name = "graph-edit-0.1.0";
          paths = [ graph-edit-unwrapped ];
          nativeBuildInputs = [ pkgs.makeWrapper ];
          postBuild = ''
            wrapProgram $out/bin/graph-edit \
              --prefix PATH : "${pkgs.lib.makeBinPath [ pkgs.nodejs_22 pkgs.prettier ]}"
          '';
        };
      in
      {
        packages = {
          inherit graph-edit;
          default = graph-edit;
        };
      }
    );
}
