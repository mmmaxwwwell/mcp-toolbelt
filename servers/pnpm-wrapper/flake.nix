{
  description = "pnpm-wrapper — fixed-verb MCP wrapper around pnpm";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        pnpm-wrapper-unwrapped = pkgs.buildNpmPackage {
          pname = "pnpm-wrapper";
          version = "0.1.0";
          src = ./server;

          npmDepsHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

          buildInputs = with pkgs; [ nodejs ];

          makeCacheWritable = true;

          npmBuildScript = "build";

          meta = with pkgs.lib; {
            description = "Fixed-verb MCP wrapper around pnpm";
            homepage = "https://github.com/mmmaxwwwell/mcp-toolbelt";
            license = licenses.mit;
            mainProgram = "pnpm-wrapper";
          };
        };

        pnpm-wrapper = pkgs.symlinkJoin {
          name = "pnpm-wrapper-0.1.0";
          paths = [ pnpm-wrapper-unwrapped ];
          nativeBuildInputs = [ pkgs.makeWrapper ];
          postBuild = ''
            wrapProgram $out/bin/pnpm-wrapper \
              --prefix PATH : "${pkgs.lib.makeBinPath [ pkgs.nodePackages.pnpm ]}"
          '';
        };
      in
      {
        packages = {
          inherit pnpm-wrapper;
          default = pnpm-wrapper;
        };
      }
    );
}
