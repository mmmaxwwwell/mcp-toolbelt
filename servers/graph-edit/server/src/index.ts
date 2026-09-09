#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { defaultBackend } from "./backend.js";
import { discoverProjectRoot, POLICY_FILENAME } from "./discover.js";
import { NotImplementedError, LayoutAmbiguousError, RefusalError } from "./errors.js";
import { defaultPolicy, loadPolicy } from "./policy.js";
import { Session } from "./session.js";
import { ALL_TOOLS, buildRegistry } from "./tools/registry.js";

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

async function serve() {
  const registry = buildRegistry();

  const discovered = discoverProjectRoot(process.cwd());
  const root = discovered?.root ?? process.cwd();
  const policy = discovered?.policyPath ? loadPolicy(discovered.policyPath) : defaultPolicy();
  const backend = defaultBackend();
  const session = new Session({ root, policy, backend });

  process.stderr.write(
    `graph-edit: root=${root} policy=${discovered?.policyPath ?? "(default)"} ` +
      `tools=${ALL_TOOLS.length}\n`
  );

  const server = new Server(
    { name: "graph-edit", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // Serialize tool invocations. Session state (pending, in-memory ts-morph
  // Project) is not concurrency-safe: two writes racing would corrupt the
  // pending list AND ts-morph itself. The MCP SDK dispatches requests as
  // they arrive, which is fine for read-only servers but not for a stateful
  // editor. We queue every call through a rolling promise.
  let queue: Promise<unknown> = Promise.resolve();
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs || {}) as Record<string, unknown>;
    const entry = registry.get(name);
    if (!entry) return errorResult(`Unknown tool: ${name}`);
    const task = queue.then(async () => {
      try {
        const result = await entry.handler(session, args);
        return textResult(result);
      } catch (err) {
        if (
          err instanceof NotImplementedError ||
          err instanceof LayoutAmbiguousError ||
          err instanceof RefusalError
        ) {
          return errorResult(err.message);
        }
        return errorResult(`Internal error in tool '${name}': ${(err as Error).message}`);
      }
    });
    queue = task.catch(() => undefined);
    return task;
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function usage(): never {
  process.stderr.write(
    `graph-edit — AST-first source-code editing MCP server (TypeScript v1)\n\n` +
      `Usage:\n` +
      `  graph-edit                Start the MCP server on stdio (discovers ${POLICY_FILENAME} or tsconfig.json upward from cwd).\n` +
      `  graph-edit --help         Show this help.\n\n` +
      `Env:\n` +
      `  GRAPH_EDIT_ROOT           Override project root (skips discovery).\n`
  );
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--help" || argv[0] === "-h") usage();

  await serve();
}

main().catch((err) => {
  process.stderr.write(`graph-edit fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
