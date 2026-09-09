{
  description = "docs-fetcher — MCP server that indexes version-pinned dependency docs (FTS5 + tags)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    web-browser.url = "path:../web-browser";
  };

  outputs = { self, nixpkgs, flake-utils, web-browser }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        fetcher-mcp = web-browser.packages.${system}.fetcher-mcp;

        docs-fetcher-unwrapped = pkgs.buildNpmPackage {
          pname = "docs-fetcher";
          version = "0.1.0";
          src = ./server;

          npmDepsHash = "sha256-eCu227+hA6k+IY7DZvjwjk7e9UIVufIk1cTuLn9XpvU=";

          nativeBuildInputs = with pkgs; [
            python3
            pkg-config
          ];

          buildInputs = with pkgs; [
            nodejs
          ];

          makeCacheWritable = true;
          npmBuildScript = "build";

          meta = with pkgs.lib; {
            description = "MCP server that fetches version-pinned dependency docs, splits them into sections, and exposes tech-tagged FTS5 search";
            homepage = "https://github.com/mmmaxwwwell/mcp-toolbelt";
            license = licenses.mit;
            mainProgram = "docs-fetcher";
          };
        };

        # Wrap so fetcher-mcp is on PATH for the child-process fetch pipeline.
        docs-fetcher = pkgs.symlinkJoin {
          name = "docs-fetcher-0.1.0";
          paths = [ docs-fetcher-unwrapped ];
          nativeBuildInputs = [ pkgs.makeWrapper ];
          postBuild = ''
            wrapProgram $out/bin/docs-fetcher \
              --prefix PATH : "${pkgs.lib.makeBinPath [ fetcher-mcp ]}"
          '';
        };
      in
      {
        packages = {
          inherit docs-fetcher;
          default = docs-fetcher;
        };
      }
    );
}
