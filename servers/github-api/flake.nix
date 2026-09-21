{
  description = "github-api — Nix packaging for github/github-mcp-server (pinned to v1.12.1)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        version = "1.12.1";
        src = pkgs.fetchFromGitHub {
          owner = "github";
          repo = "github-mcp-server";
          rev = "v${version}";
          hash = "sha256-rRGHJewnE+FYaKeuseWvIrH48c1ImWyfEI6l7b+Q0Dg=";
        };

        github-mcp-server = pkgs.buildGoModule {
          pname = "github-mcp-server";
          inherit version src;

          vendorHash = "sha256-dqn9W2gOb3ZCfppzfSczDO2bvpwsGyPe4I/h6y3JL9A=";

          # Upstream ships two binaries under cmd/. Only build the MCP server;
          # mcpcurl is a developer-only debugging helper.
          subPackages = [ "cmd/github-mcp-server" ];

          # Bake version metadata into the binary the same way upstream's
          # goreleaser build does.
          ldflags = [
            "-s"
            "-w"
            "-X main.version=${version}"
            "-X main.commit=v${version}"
            "-X main.date=1970-01-01T00:00:00Z"
          ];

          # No CGO required; this is a pure Go project talking to HTTPS APIs.
          env.CGO_ENABLED = "0";

          # Tests hit network / mock GitHub in ways that don't survive the
          # sandbox. Upstream CI runs them separately.
          doCheck = false;

          meta = with pkgs.lib; {
            description = "Official GitHub MCP server: issues, PRs, code search, releases, projects via GitHub API";
            homepage = "https://github.com/github/github-mcp-server";
            license = licenses.mit;
            mainProgram = "github-mcp-server";
          };
        };
      in
      {
        packages = {
          inherit github-mcp-server;
          default = github-mcp-server;
        };
      }
    );
}
