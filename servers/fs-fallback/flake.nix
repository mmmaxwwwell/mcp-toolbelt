{
  description = "fs-fallback — ACL-gated raw filesystem MCP server that steers agents toward edit-surface for source code";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        fs-fallback-unwrapped = pkgs.buildNpmPackage {
          pname = "fs-fallback";
          version = "0.1.0";
          src = ./server;

          npmDepsHash = "sha256-fOjehV5CX++Ip6QLe62c33va1fyHF3Fhw5bxPLN9sH8=";

          buildInputs = with pkgs; [
            nodejs
          ];

          makeCacheWritable = true;

          npmBuildScript = "build";

          meta = with pkgs.lib; {
            description = "MCP server for ACL-gated raw filesystem read/write on files that edit-surface does not handle";
            homepage = "https://github.com/mmmaxwwwell/mcp-toolbelt";
            license = licenses.mit;
            mainProgram = "fs-fallback";
          };
        };

        # Pure Node — no runtime PATH additions needed. Wrap only to keep the
        # symlinkJoin idiom consistent with the sibling servers.
        fs-fallback = pkgs.symlinkJoin {
          name = "fs-fallback-0.1.0";
          paths = [ fs-fallback-unwrapped ];
        };
      in
      {
        packages = {
          inherit fs-fallback;
          default = fs-fallback;
        };
      }
    );
}
