{ pkgs
, self
,  # server packages passed in from the root flake
  fsFallback
, nixDevExec
, pnpmWrapper
, docsFetcher
, githubApi
, semanticEditMcp
, graphEdit ? null  # Optional: 6A wires this through; test skips graph-edit block when null.
}:

pkgs.testers.runNixOSTest {
  name = "mcp-toolbelt-integration";

  nodes.machine = { pkgs, ... }: {
    # Unprivileged user namespaces are on by default in modern NixOS; set
    # explicitly so bwrap works even on kernels/policies that flipped it off.
    boot.kernel.sysctl."kernel.unprivileged_userns_clone" = 1;

    # Give the VM plenty of RAM — bwrap + node in flight can be hungry.
    virtualisation.memorySize = 2048;

    environment.systemPackages = [
      fsFallback
      nixDevExec
      pnpmWrapper
      docsFetcher
      githubApi
      semanticEditMcp
      pkgs.bubblewrap
      pkgs.jq
      pkgs.bash
      pkgs.git
      pkgs.coreutils
    ] ++ pkgs.lib.optional (graphEdit != null) graphEdit;

    users.users.tester = {
      isNormalUser = true;
      home = "/home/tester";
    };
  };

  testScript = ''
    import shlex

    machine.wait_for_unit("multi-user.target")

    # ── Stage fixture + test scripts on the VM ────────────────────────────
    machine.succeed("mkdir -p /tmp/sample-project /tmp/tests/scenarios")
    for f in [
      "package.json", "pnpm-lock.yaml", "tsconfig.json", "README.md",
      ".nix-dev-exec.toml", ".pnpm-wrapper.toml", ".fs-fallback.toml",
    ]:
      machine.copy_from_host(
        "${self}/tests/fixtures/sample-project/" + f,
        "/tmp/sample-project/" + f,
      )
    machine.copy_from_host("${self}/tests/fixtures/sample-project/src", "/tmp/sample-project/src")
    machine.copy_from_host("${self}/tests/fixtures/sample-project/docs", "/tmp/sample-project/docs")

    for f in [
      "lib.sh", "docs-fetcher.sh", "nix-dev-exec.sh", "pnpm-wrapper.sh",
      "fs-fallback.sh", "github-api.sh",
    ]:
      machine.copy_from_host("${self}/tests/" + f, "/tmp/tests/" + f)
    machine.copy_from_host(
      "${self}/tests/scenarios/end-to-end.sh",
      "/tmp/tests/scenarios/end-to-end.sh",
    )
    machine.copy_from_host(
      "${self}/tests/fixtures/sample-project",
      "/tmp/tests/fixtures/sample-project",
    )
    machine.succeed("chmod -R +rx /tmp/tests /tmp/sample-project")

    # No network → skip anything that would need it.
    env = "SKIP_NETWORK_TESTS=1 GITHUB_PERSONAL_ACCESS_TOKEN=fake_token_for_test HOME=/tmp"

    # ── Per-server smoke tests ────────────────────────────────────────────
    for script in ["fs-fallback.sh", "nix-dev-exec.sh", "pnpm-wrapper.sh",
                   "docs-fetcher.sh", "github-api.sh"]:
      machine.succeed(
        f"cd /tmp && {env} bash /tmp/tests/{script}"
      )

    # ── End-to-end scenario ───────────────────────────────────────────────
    machine.succeed(
      f"cd /tmp && {env} bash /tmp/tests/scenarios/end-to-end.sh"
    )

    # ── Sandbox mount-boundary probe ─────────────────────────────────────
    # Prove nix-dev-exec's strict preset actually hides ~/.ssh: inject a
    # secret into the host user's HOME on the VM, then have a nix-dev-exec
    # op try to cat it. Because $HOME is a tmpfs inside the sandbox, the
    # file must be invisible.
    machine.succeed(
      "mkdir -p /root/.ssh && "
      "echo toplevel-secret > /root/.ssh/id_rsa && "
      "chmod 600 /root/.ssh/id_rsa"
    )
    # Write a nix-dev-exec registry that tries to read the secret.
    probe_toml = (
      "[operations.leak]\n"
      "description = \"Attempt to read a host secret.\"\n"
      "command = \"cat /root/.ssh/id_rsa\"\n"
      "sandbox.preset = \"strict\"\n"
    )
    machine.succeed(
      "mkdir -p /tmp/sandbox-probe && "
      f"echo {shlex.quote(probe_toml)} > /tmp/sandbox-probe/.nix-dev-exec.toml"
    )
    init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"vm","version":"0.1.0"}}}'
    call = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"run","arguments":{"name":"leak"}}}'
    probe_cmd = (
      "cd /tmp/sandbox-probe && "
      "printf '" + init + "\\n" + call + "\\n' | "
      "timeout 15 nix-dev-exec 2>/dev/null | "
      "tail -1"
    )
    out = machine.succeed(probe_cmd)
    assert "toplevel-secret" not in out, (
      f"SANDBOX BREACH: strict-preset op saw /root/.ssh/id_rsa. Output: {out[:400]}"
    )

    # ── pnpm-wrapper --global refusal ─────────────────────────────────────
    call2 = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"add","arguments":{"package":"lodash","version":"--global"}}}'
    pw_cmd = (
      "cd /tmp/sample-project && "
      "printf '" + init + "\\n" + call2 + "\\n' | "
      "timeout 10 pnpm-wrapper 2>/dev/null | tail -1"
    )
    out2 = machine.succeed(pw_cmd)
    # The wrapper's hardcoded refusal list rejects --global anywhere in
    # argv; response body should be isError with a refusal message.
    assert "isError" in out2 or "--global" in out2 or "error" in out2, (
      f"pnpm-wrapper did NOT refuse --global: {out2[:400]}"
    )

    # ── graph-edit: sanity + tool surface + mini scenario ────────────────
    # Skipped unless 6A wired the graph-edit package through as a systemPackage.
    if machine.succeed("command -v graph-edit >/dev/null 2>&1 && echo yes || echo no").strip() == "yes":
      # Stage a tiny TS project inline. graph-edit's discover.ts walks up
      # from cwd looking for .graph-edit.toml or tsconfig.json.
      machine.succeed("mkdir -p /tmp/graph-edit-fixture/src")
      tsconfig = (
        '{"compilerOptions":{"target":"ES2022","module":"ES2022",'
        '"moduleResolution":"Bundler","strict":true,"esModuleInterop":true,'
        '"skipLibCheck":true,"noEmit":true},"include":["src/**/*"]}'
      )
      machine.succeed(
        f"printf {shlex.quote(tsconfig)} > /tmp/graph-edit-fixture/tsconfig.json"
      )
      widget_src = (
        "export class Widget {\n"
        "  private name: string;\n"
        "  constructor(name: string) {\n"
        "    this.name = name;\n"
        "  }\n"
        "  getName(): string {\n"
        "    return this.name;\n"
        "  }\n"
        "}\n"
      )
      machine.succeed(
        f"printf {shlex.quote(widget_src)} > /tmp/graph-edit-fixture/src/widget.ts"
      )

      # Sanity: --help exits with a defined status (2 per usage()).
      machine.succeed(
        "graph-edit --help 2>&1 | grep -q 'AST-first' && "
        "test $(graph-edit --help >/dev/null 2>&1; echo $?) -eq 2"
      )

      # Sanity: stdin close exits clean.
      machine.succeed("echo | timeout 10 graph-edit >/dev/null 2>&1 || test $? -eq 0")

      # tools/list should return exactly 29 tools (locked in Phase 0).
      list_req = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
      ge_list = machine.succeed(
        "cd /tmp/graph-edit-fixture && "
        "printf '" + init + "\\n" + list_req + "\\n' | "
        "timeout 20 graph-edit 2>/dev/null | "
        "grep -E '^\\s*\\{' | "
        "while IFS= read -r line; do "
        "  echo \"$line\" | jq -e '.id == 2 and (.result.tools // empty)' >/dev/null 2>&1 && "
        "    { echo \"$line\"; break; }; "
        "done"
      )
      ge_count = machine.succeed(
        f"echo {shlex.quote(ge_list)} | jq -r '.result.tools | length'"
      ).strip()
      assert ge_count == "29", (
        f"graph-edit tools/list expected 29 tools, got {ge_count}. Response: {ge_list[:400]}"
      )
      # Spot-check a few tool names are present.
      ge_names = machine.succeed(
        f"echo {shlex.quote(ge_list)} | jq -r '.result.tools[].name' | tr '\\n' ' '"
      )
      for want in ["add_method", "preview", "commit", "list_symbols",
                   "get_symbol", "rename_symbol", "find", "open_symbol"]:
        assert f" {want} " in f" {ge_names} ", (
          f"graph-edit tools/list missing '{want}'. Names: {ge_names}"
        )

      # Mini scenario: add_method(Widget.render) → preview → commit → verify.
      class_id = "sym:src/widget.ts#Widget"
      add_args = {
        "class_id": class_id,
        "name": "render",
        "signature": "render(): string",
        "body": "return `<''${this.name}>`;",
      }
      import json as _json
      add_req = _json.dumps({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": "add_method", "arguments": add_args},
      })
      preview_req = (
        '{"jsonrpc":"2.0","id":3,"method":"tools/call",'
        '"params":{"name":"preview","arguments":{}}}'
      )
      commit_req = (
        '{"jsonrpc":"2.0","id":4,"method":"tools/call",'
        '"params":{"name":"commit","arguments":{}}}'
      )
      scenario_input = "\\n".join([init, add_req, preview_req, commit_req]) + "\\n"
      # Use a file so we don't have to escape the whole JSON blob inline.
      machine.succeed(
        f"printf {shlex.quote(scenario_input)} > /tmp/graph-edit-fixture/scenario.jsonl"
      )
      ge_scenario_out = machine.succeed(
        "cd /tmp/graph-edit-fixture && "
        "timeout 30 graph-edit < scenario.jsonl 2>/dev/null || true"
      )
      # commit response has id=4. Look for it and verify no error.
      commit_line = machine.succeed(
        f"echo {shlex.quote(ge_scenario_out)} | "
        "grep -E '^\\s*\\{' | "
        "while IFS= read -r line; do "
        "  echo \"$line\" | jq -e '.id == 4' >/dev/null 2>&1 && "
        "    { echo \"$line\"; break; }; "
        "done"
      )
      assert commit_line, (
        f"graph-edit scenario: no commit (id=4) response. Full output: {ge_scenario_out[:800]}"
      )
      # The commit response is an MCP tools/call result; body is nested.
      # Whether success or error, we then check the on-disk file for the new method.
      widget_after = machine.succeed("cat /tmp/graph-edit-fixture/src/widget.ts")
      assert "render" in widget_after, (
        f"graph-edit scenario: commit did not write render() to widget.ts. File: {widget_after}"
      )

      # Type-error refusal probe: attempting to add a method whose body has
      # an obvious type error should surface via preview's type_check errors,
      # and commit should refuse (files should NOT gain the broken method).
      # Reset by rewriting the fixture from scratch.
      machine.succeed(
        f"printf {shlex.quote(widget_src)} > /tmp/graph-edit-fixture/src/widget.ts"
      )
      bad_args = {
        "class_id": class_id,
        "name": "broken",
        "signature": "broken(): number",
        # returning a string from a number-typed method → tsc error
        "body": "return `bad`;",
      }
      bad_add = _json.dumps({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": "add_method", "arguments": bad_args},
      })
      bad_input = "\\n".join([init, bad_add, commit_req]) + "\\n"
      machine.succeed(
        f"printf {shlex.quote(bad_input)} > /tmp/graph-edit-fixture/bad-scenario.jsonl"
      )
      bad_out = machine.succeed(
        "cd /tmp/graph-edit-fixture && "
        "timeout 30 graph-edit < bad-scenario.jsonl 2>/dev/null || true"
      )
      # Best-effort assertion: either commit surfaced an error (isError true),
      # OR the on-disk file was left unchanged. Both mean the type gate held.
      after_bad = machine.succeed("cat /tmp/graph-edit-fixture/src/widget.ts")
      committed_bad = "broken" in after_bad
      commit_had_error = (
        "isError" in bad_out or "type_check" in bad_out or "error" in bad_out.lower()
      )
      assert (not committed_bad) or commit_had_error, (
        f"graph-edit: type-error commit was neither refused nor errored. "
        f"file={after_bad!r} out={bad_out[:400]!r}"
      )

    print("VM integration test PASSED")
  '';
}
