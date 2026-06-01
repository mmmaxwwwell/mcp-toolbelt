{
  description = "web-browser — fetcher-mcp + FTS5 sidecar (pinned to v0.3.9)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        version = "0.3.9";
        src = pkgs.fetchFromGitHub {
          owner = "jae-jae";
          repo = "fetcher-mcp";
          rev = "8754aff66e3d9207502207bf82a493f45f556bb8";
          hash = "sha256-CH9qTU+BS3/zCs9QVIHPqoHdul9qpaha1D+gZzoLteY=";
        };

        fetcher-mcp-unwrapped = pkgs.buildNpmPackage {
          pname = "fetcher-mcp";
          inherit version src;

          npmDepsHash = "sha256-waLaOeDaCsgltLrri0kjjFJPazOE/cY+2F+Yu0i55Cg=";

          # Playwright tries to download browsers during postinstall — skip in sandbox.
          env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          npmFlags = [ "--ignore-scripts" ];

          npmBuildScript = "build";

          meta = with pkgs.lib; {
            description = "MCP server for fetching web content using Playwright headless browser";
            homepage = "https://github.com/jae-jae/fetcher-mcp";
            license = licenses.isc;
            mainProgram = "fetcher-mcp";
          };
        };

        # Playwright browser compatibility layer.
        # fetcher-mcp v0.3.9 bundles Playwright 1.51.1 which expects browsers at
        # revision-specific paths (e.g. chromium_headless_shell-1161/chrome-linux/headless_shell).
        # nixpkgs' playwright-driver may ship a newer revision with a different directory
        # layout (e.g. chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell).
        # This derivation creates symlinks mapping the expected paths to the available binaries.
        playwrightBrowsersCompat = pkgs.runCommand "playwright-browsers-compat" {
          nativeBuildInputs = [ pkgs.jq ];
        } ''
          mkdir -p $out

          # Link all existing browser directories as-is
          for dir in ${pkgs.playwright-driver.browsers}/*/; do
            ln -s "$dir" "$out/$(basename "$dir")"
          done

          browsers_json="${fetcher-mcp-unwrapped}/lib/node_modules/fetcher-mcp/node_modules/playwright-core/browsers.json"

          # Create compat dirs for chromium_headless_shell
          expected=$(jq -r '.browsers[] | select(.name == "chromium-headless-shell") | .revision' "$browsers_json")
          if [ -n "$expected" ] && [ ! -e "$out/chromium_headless_shell-$expected" ]; then
            actual_dir=$(ls -d $out/chromium_headless_shell-*/  2>/dev/null | head -1)
            if [ -n "$actual_dir" ]; then
              actual_real=$(readlink -f "$actual_dir")
              src_dir=$(ls -d "$actual_real"/*/ | head -1)
              mkdir -p "$out/chromium_headless_shell-$expected/chrome-linux"
              for f in "$src_dir"/*; do
                ln -s "$f" "$out/chromium_headless_shell-$expected/chrome-linux/"
              done
              if [ -e "$src_dir/chrome-headless-shell" ]; then
                ln -sf "$src_dir/chrome-headless-shell" \
                       "$out/chromium_headless_shell-$expected/chrome-linux/headless_shell"
              fi
            fi
          fi

          # Create compat dir for chromium
          expected=$(jq -r '.browsers[] | select(.name == "chromium") | .revision' "$browsers_json")
          if [ -n "$expected" ] && [ ! -e "$out/chromium-$expected" ]; then
            actual_dir=$(ls -d $out/chromium-*/  2>/dev/null | head -1)
            if [ -n "$actual_dir" ]; then
              actual_real=$(readlink -f "$actual_dir")
              src_dir=$(ls -d "$actual_real"/*/ | head -1)
              mkdir -p "$out/chromium-$expected/chrome-linux"
              for f in "$src_dir"/*; do
                ln -s "$f" "$out/chromium-$expected/chrome-linux/"
              done
            fi
          fi
        '';

        fetcher-mcp = pkgs.symlinkJoin {
          name = "fetcher-mcp-${version}";
          paths = [ fetcher-mcp-unwrapped ];
          nativeBuildInputs = [ pkgs.makeWrapper ];
          postBuild = ''
            wrapProgram $out/bin/fetcher-mcp \
              --set PLAYWRIGHT_BROWSERS_PATH "${playwrightBrowsersCompat}" \
              --set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD "1"
          '';
        };

        sidecar-unwrapped = pkgs.buildNpmPackage {
          pname = "web-browser-sidecar";
          version = "0.1.0";
          src = ./sidecar;

          npmDepsHash = "sha256-E1ZxTfpBhc0TA3PWxxe28xI3jtkEUVElbnLOqB20rRo=";

          # better-sqlite3 uses node-gyp for its native addon.
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
            description = "MCP sidecar wrapping fetcher-mcp with FTS5 page cache";
            homepage = "https://github.com/mmmaxwwwell/mcp-toolbelt";
            license = licenses.mit;
            mainProgram = "web-browser-sidecar";
          };
        };

        # Wrap the sidecar so fetcher-mcp is on its PATH.
        web-browser-sidecar = pkgs.symlinkJoin {
          name = "web-browser-sidecar-0.1.0";
          paths = [ sidecar-unwrapped ];
          nativeBuildInputs = [ pkgs.makeWrapper ];
          postBuild = ''
            wrapProgram $out/bin/web-browser-sidecar \
              --prefix PATH : "${pkgs.lib.makeBinPath [ fetcher-mcp ]}"
          '';
        };
      in
      {
        packages = {
          inherit fetcher-mcp web-browser-sidecar;
          default = web-browser-sidecar;
        };
      }
    );
}
