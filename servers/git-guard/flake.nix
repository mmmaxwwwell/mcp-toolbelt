{
  description = "git-guard — Nix packaging for mcp-server-git (pinned to 2026.1.14)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        python = pkgs.python312.override {
          packageOverrides = self: super: {
            mcp = super.mcp.overridePythonAttrs (_: { doCheck = false; });
          };
        };

        version = "2026.1.14";
        src = pkgs.fetchPypi {
          pname = "mcp_server_git";
          inherit version;
          hash = "sha256-LNdHBMeycase174mYSDCCuiufMAeUtxsVJeQQCutK0Q=";
        };

        mcp-server-git = python.pkgs.buildPythonApplication {
          pname = "mcp-server-git";
          inherit version src;
          pyproject = true;

          build-system = with python.pkgs; [ hatchling ];

          dependencies = with python.pkgs; [
            click
            gitpython
            mcp
            pydantic
          ];

          # Wrap git onto PATH — gitpython shells out to the git binary.
          nativeBuildInputs = [ pkgs.makeWrapper ];
          postFixup = ''
            wrapProgram $out/bin/mcp-server-git \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.git ]}
          '';

          doCheck = false;

          pythonImportsCheck = [ "mcp_server_git" ];

          meta = with pkgs.lib; {
            description = "MCP server providing Git repository tools for LLMs";
            homepage = "https://github.com/modelcontextprotocol/servers/tree/main/src/git";
            license = licenses.mit;
            mainProgram = "mcp-server-git";
          };
        };
      in
      {
        packages = {
          inherit mcp-server-git;
          default = mcp-server-git;
        };
      }
    );
}
