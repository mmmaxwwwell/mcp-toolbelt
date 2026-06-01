{
  description = "test-runner — Nix packaging for privsim/mcp-test-runner (pinned to commit 83c84ed)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        rev = "83c84ed053f534774f7de935aeaa7698a5e5f9dc";
        src = pkgs.fetchFromGitHub {
          owner = "privsim";
          repo = "mcp-test-runner";
          inherit rev;
          hash = "sha256-bS/FH4n+SEfibj9UgCtHrmHqVgiTwh0Jt69HtCT33W4=";
        };

        mcp-test-runner = pkgs.buildNpmPackage {
          pname = "mcp-test-runner";
          version = "0.2.0-unstable-2025-11-09";
          inherit src;

          npmDepsHash = "sha256-EbT6cUN42N5WmrsoUprrvY3bhInU11J61yx/5ATX9Jo=";

          # Build the TypeScript source.
          npmBuildScript = "build";

          # No bin field in package.json — install manually.
          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/node_modules/@modelcontextprotocol/server-test-runner
            cp -r build package.json node_modules $out/lib/node_modules/@modelcontextprotocol/server-test-runner/
            mkdir -p $out/bin
            echo '#!/usr/bin/env bash' > $out/bin/mcp-test-runner
            echo "exec ${pkgs.nodejs}/bin/node $out/lib/node_modules/@modelcontextprotocol/server-test-runner/build/index.js \"\$@\"" >> $out/bin/mcp-test-runner
            chmod +x $out/bin/mcp-test-runner
            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "MCP server that executes tests across multiple frameworks and parses structured results";
            homepage = "https://github.com/privsim/mcp-test-runner";
            license = licenses.mit;
            mainProgram = "mcp-test-runner";
          };
        };
      in
      {
        packages = {
          inherit mcp-test-runner;
          default = mcp-test-runner;
        };
      }
    );
}
