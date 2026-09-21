#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { discoverRegistry, REGISTRY_FILENAME } from "./discover.js";
import { loadRegistry, RegistryError, type Registry, type Operation } from "./registry.js";
import {
  expandTemplate,
  runOperation,
  buildSandboxPrefix,
  ValidationError,
  ExecError,
} from "./exec.js";
import { assertBwrapAvailable } from "./sandbox.js";
import { RingBuffer } from "./history.js";
import { getEnvInfo, whichBinary } from "./env.js";

const HISTORY_DEFAULT = 20;

const TOOLS = [
  {
    name: "list_operations",
    description:
      "List every operation registered in .nix-dev-exec.toml with its description. This is your shell vocabulary — start here.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "describe_operation",
    description:
      "Show the full schema for one operation: description, command template, and each arg's type + validation rules.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Operation name" },
      },
      required: ["name"],
    },
  },
  {
    name: "dry_run",
    description:
      "Expand the operation's command with the given args and return the argv that would be executed. Does not run anything.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Operation name" },
        args: {
          type: "object",
          description: "Arguments for the operation",
          additionalProperties: true,
        },
      },
      required: ["name"],
    },
  },
  {
    name: "run",
    description:
      "Execute a registered operation via `nix develop -c <expanded argv>`. Returns structured stdout, stderr, exit_code, duration_ms, and the expanded_command actually invoked. This is your only shell.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Operation name" },
        args: {
          type: "object",
          description: "Arguments for the operation",
          additionalProperties: true,
        },
      },
      required: ["name"],
    },
  },
  {
    name: "env_info",
    description:
      "Return the environment inside `nix develop`: env vars, key binary paths, and the dev-shell store path if resolvable. Cached for 5 minutes.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "which",
    description:
      "Resolve a binary's path inside `nix develop` (equivalent to `nix develop -c command -v <binary>`). Cached for 5 minutes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        binary: { type: "string", description: "Binary name to resolve" },
      },
      required: ["binary"],
    },
  },
  {
    name: "describe_sandbox",
    description:
      "Show the sandbox configuration for one operation: mode (bwrap|off), preset, network policy, and the full bwrap argv that would prefix execution. Use this to audit what a run actually confines.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Operation name" },
      },
      required: ["name"],
    },
  },
  {
    name: "recent_runs",
    description:
      "Return the last N operation executions (default 20) with timing, exit codes, and byte counts. Ring buffer; not persisted across restarts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        n: { type: "number", description: "How many recent runs to return (default 20)" },
      },
    },
  },
];

function textResult(obj: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function describe(op: Operation, projectRoot: string) {
  const sandboxPrefix = buildSandboxPrefix(op, projectRoot);
  const sandbox =
    op.sandbox.mode === "off"
      ? { mode: "off" as const }
      : {
          mode: "bwrap" as const,
          preset: op.sandbox.preset,
          network: sandboxPrefix?.network ?? true,
          extra_rw: op.sandbox.extraRw ?? [],
          extra_ro: op.sandbox.extraRo ?? [],
        };
  return {
    name: op.name,
    description: op.description,
    command: op.command,
    argv_template: op.argv,
    cwd: op.cwd,
    interactive: op.interactive,
    timeout_ms: op.timeout_ms,
    max_output_bytes: op.max_output_bytes,
    sandbox,
    args: Object.fromEntries(
      Object.entries(op.args).map(([k, v]) => [
        k,
        {
          type: v.type,
          ...(v.default !== undefined ? { default: v.default } : {}),
          ...(v.validate ? { validate: v.validate } : {}),
          ...(v.must_exist !== undefined ? { must_exist: v.must_exist } : {}),
          ...(v.must_match ? { must_match: v.must_match } : {}),
          ...(v.values ? { values: v.values } : {}),
          ...(v.description ? { description: v.description } : {}),
        },
      ])
    ),
  };
}

function describeSandbox(op: Operation, projectRoot: string) {
  if (op.sandbox.mode === "off") {
    return {
      operation: op.name,
      mode: "off",
      warning:
        "Sandbox is DISABLED for this operation (sandbox = \"off\" in registry). " +
        "Execution will run directly with no filesystem or network isolation.",
    };
  }
  const built = buildSandboxPrefix(op, projectRoot)!;
  return {
    operation: op.name,
    mode: "bwrap",
    preset: built.preset,
    network: built.network,
    home: built.home,
    user: built.user,
    extra_rw: op.sandbox.extraRw ?? [],
    extra_ro: op.sandbox.extraRo ?? [],
    bwrap_argv: built.argv,
    // The command line that will actually be spawned.
    full_command_prefix: ["bwrap", ...built.argv, "--", "nix", "develop", "-c"],
  };
}

async function serve(registry: Registry) {
  const history = new RingBuffer(200);

  const server = new Server(
    { name: "nix-dev-exec", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs || {}) as Record<string, unknown>;
    try {
      switch (name) {
        case "list_operations":
          return textResult(
            Array.from(registry.operations.values()).map((op) => ({
              name: op.name,
              description: op.description,
            }))
          );

        case "describe_operation": {
          const opName = args.name as string;
          const op = registry.operations.get(opName);
          if (!op) return errorResult(`Unknown operation: ${opName}`);
          return textResult(describe(op, registry.projectRoot));
        }

        case "describe_sandbox": {
          const opName = args.name as string;
          const op = registry.operations.get(opName);
          if (!op) return errorResult(`Unknown operation: ${opName}`);
          return textResult(describeSandbox(op, registry.projectRoot));
        }

        case "dry_run": {
          const opName = args.name as string;
          const op = registry.operations.get(opName);
          if (!op) return errorResult(`Unknown operation: ${opName}`);
          try {
            const { argv, fullArgv } = expandTemplate(
              op,
              (args.args as Record<string, unknown>) || {}
            );
            const prefix = buildSandboxPrefix(op, registry.projectRoot);
            const sandbox =
              prefix === null
                ? { mode: "off" as const }
                : {
                    mode: "bwrap" as const,
                    preset: prefix.preset,
                    network: prefix.network,
                    bwrap_argv: prefix.argv,
                  };
            const full_argv =
              prefix === null
                ? ["nix", ...fullArgv]
                : ["bwrap", ...prefix.argv, "--", "nix", ...fullArgv];
            return textResult({
              operation: op.name,
              expanded_command: argv,
              full_argv,
              cwd: op.cwd,
              sandbox,
            });
          } catch (err) {
            if (err instanceof ValidationError) return errorResult(err.message);
            throw err;
          }
        }

        case "run": {
          const opName = args.name as string;
          const op = registry.operations.get(opName);
          if (!op) return errorResult(`Unknown operation: ${opName}`);
          const opArgs = (args.args as Record<string, unknown>) || {};
          const startedAt = Date.now();
          try {
            const result = await runOperation(op, opArgs, registry);
            history.push({
              name: op.name,
              args: opArgs,
              expanded_command: result.expanded_command,
              exit_code: result.exit_code,
              signal: result.signal,
              duration_ms: result.duration_ms,
              timed_out: result.timed_out,
              started_at: startedAt,
              stdout_bytes: Buffer.byteLength(result.stdout, "utf8"),
              stderr_bytes: Buffer.byteLength(result.stderr, "utf8"),
              truncated_stdout: result.truncated_stdout,
              truncated_stderr: result.truncated_stderr,
            });
            const isError = result.exit_code !== 0;
            return textResult(result, isError);
          } catch (err) {
            if (err instanceof ValidationError || err instanceof ExecError) {
              return errorResult(err.message);
            }
            throw err;
          }
        }

        case "env_info": {
          const info = await getEnvInfo(registry.projectRoot);
          return textResult(info, info.error !== null);
        }

        case "which": {
          const binary = args.binary as string;
          if (typeof binary !== "string" || binary.length === 0) {
            return errorResult("which: 'binary' arg is required.");
          }
          const info = await whichBinary(registry.projectRoot, binary);
          return textResult(info, info.error !== null);
        }

        case "recent_runs": {
          const n = typeof args.n === "number" ? args.n : HISTORY_DEFAULT;
          return textResult(history.recent(n));
        }

        default:
          return errorResult(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return errorResult(`Internal error in tool '${name}': ${(err as Error).message}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function usage(): never {
  process.stderr.write(
    `nix-dev-exec — MCP server for running allowlisted ops via \`nix develop -c\`\n\n` +
      `Usage:\n` +
      `  nix-dev-exec               Start the MCP server on stdio (discovers ${REGISTRY_FILENAME} upward from cwd).\n` +
      `  nix-dev-exec --check PATH  Load + validate a registry file and print the parsed operations.\n` +
      `  nix-dev-exec --help        Show this help.\n\n` +
      `Env:\n` +
      `  NIX_DEV_EXEC_REGISTRY      Override registry path (skips discovery).\n`
  );
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--help" || argv[0] === "-h") usage();

  if (argv[0] === "--check") {
    const path = argv[1];
    if (!path) usage();
    try {
      const reg = loadRegistry(path);
      const ops = Array.from(reg.operations.values()).map((op) => ({
        ...describe(op, reg.projectRoot),
        sandbox_resolved: describeSandbox(op, reg.projectRoot),
      }));
      process.stdout.write(
        JSON.stringify(
          {
            path: reg.path,
            projectRoot: reg.projectRoot,
            sandbox_defaults: reg.sandboxDefaults,
            operations: ops,
          },
          null,
          2
        ) + "\n"
      );
      process.exit(0);
    } catch (err) {
      if (err instanceof RegistryError) {
        process.stderr.write(`registry error: ${err.message}\n`);
      } else {
        process.stderr.write(`error: ${(err as Error).message}\n`);
      }
      process.exit(1);
    }
  }

  const override = process.env.NIX_DEV_EXEC_REGISTRY;
  const path = override || discoverRegistry(process.cwd());
  if (!path) {
    process.stderr.write(
      `nix-dev-exec: no ${REGISTRY_FILENAME} found walking up from ${process.cwd()}. ` +
        `Create one or set NIX_DEV_EXEC_REGISTRY=/path/to/${REGISTRY_FILENAME}.\n`
    );
    process.exit(1);
  }
  let registry: Registry;
  try {
    registry = loadRegistry(path);
  } catch (err) {
    if (err instanceof RegistryError) {
      process.stderr.write(`nix-dev-exec: ${err.message}\n`);
    } else {
      process.stderr.write(`nix-dev-exec: failed to load registry: ${(err as Error).message}\n`);
    }
    process.exit(1);
  }

  // Sandbox is on by default; bwrap is a hard requirement at server startup.
  try {
    assertBwrapAvailable();
  } catch (err) {
    process.stderr.write(`nix-dev-exec: ${(err as Error).message}\n`);
    process.exit(1);
  }

  process.stderr.write(
    `nix-dev-exec: loaded ${registry.operations.size} operation(s) from ${registry.path}\n`
  );
  process.stderr.write(
    `nix-dev-exec: bwrap sandbox ENABLED (default preset: ${registry.sandboxDefaults.default_preset})\n`
  );

  await serve(registry);
}

main().catch((err) => {
  process.stderr.write(`nix-dev-exec fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
