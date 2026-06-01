{
  description = "web-search — Nix packaging for pskill9/web-search (pinned to commit 1b3ead8)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        rev = "1b3ead82b45e81af4e27467f1db90168b22fe7ef";
        src = pkgs.fetchFromGitHub {
          owner = "pskill9";
          repo = "web-search";
          inherit rev;
          hash = "sha256-AGPjgSrW+OvK98zGoNXVqfRGX31xUo1KwVI8I/pG7AY=";
        };

        web-search = pkgs.buildNpmPackage {
          pname = "web-search";
          version = "0.0.0-unstable-2024-12-30";
          inherit src;

          npmDepsHash = "sha256-dvJ5vtvPBrMAAtWNC6IMazBqu9r9HQm/JrgZVwkePhI=";

          # Build the TypeScript source.
          npmBuildScript = "build";

          meta = with pkgs.lib; {
            description = "MCP server for web search via Google scraping (no API key required)";
            homepage = "https://github.com/pskill9/web-search";
            mainProgram = "web-search";
          };
        };
      in
      {
        packages = {
          inherit web-search;
          default = web-search;
        };
      }
    );
}
