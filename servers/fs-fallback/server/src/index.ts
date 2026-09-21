#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolve, relative, isAbsolute } from "node:path";
import { discoverConfig, CONFIG_FILENAME } from "./discover.js";
import { loadPolicy, defaultPolicy, whyBlocked, type Policy } from "./policy.js";
import {
  readFileTool,
  readFileRangeTool,
  statFileTool,
  listDirTool,
  globTool,
  writeFileTool,
  appendFileTool,
  deleteFileTool,
  resolveInsideRoot,
  PolicyError,
  OutsideRootError,
} from "./fs.js";
import { AuditLog } from "./audit.js";
import { ensureTrashDir, purgeExpiredTrash } from "./trash.js";

const EDIT_SURFACE_BRIEFING =
  "Prefer edit-surface (edit_function_body / replace_symbol) for source code. " +
  "This tool is for configs, docs, lockfiles, scripts, and non-code files.";

const TOOLS = [
  {
    name: "read_file",
    description:
      "Read a whole file. Policy-gated by [read] in .fs-fallback.toml. Returns {path, size, content, encoding}; binary files come back base64-encoded with encoding='binary'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Path relative to project root (absolute paths inside the root are also accepted)." },
      },
      required: ["path"],
    },
  },
  {
    name: "read_file_range",
    description:
      "Read a 1-indexed inclusive line range from a text file. Same policy gate as read_file.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
        start_line: { type: "number", description: "1-indexed first line (inclusive)" },
        end_line: { type: "number", description: "1-indexed last line (inclusive)" },
      },
      required: ["path", "start_line", "end_line"],
    },
  },
  {
    name: "stat_file",
    description:
      "Stat a path. Returns {exists, size, mtime, is_dir, is_symlink, target?}. Denied paths return {exists:false, denied:true, reason}.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description:
      "List directory contents. Entries denied by [read] policy are silently filtered.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "glob",
    description:
      "Return every file under `base` (default: project root) whose relative path matches the pattern AND passes the [read] policy. Uses micromatch syntax (** for any depth, * for single segment).",
    inputSchema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "micromatch glob pattern (e.g. \"**/*.md\")" },
        base: { type: "string", description: "Optional base dir (project-root-relative)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "write_file",
    description:
      "Overwrite a file. " + EDIT_SURFACE_BRIEFING +
      " Policy chain: (1) refuse source code (edit-surface refusal), (2) hard-deny, (3) soft-deny (requires confirm:true), (4) allow. Returns diff line counts + matched policy rule.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
        content: { type: "string", description: "Full new contents (UTF-8)" },
        confirm: { type: "boolean", description: "Set true to bypass a soft_deny warning" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "append_file",
    description:
      "Append to a file. Same policy chain as write_file. " + EDIT_SURFACE_BRIEFING,
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "delete_file",
    description:
      "Soft-delete a file. The file is MOVED to .fs-fallback-trash/<YYYY-MM-DD>/ under the project root; nothing is truly removed until trash retention expires. Same policy chain as write_file.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["path"],
    },
  },
  {
    name: "recent_writes",
    description:
      "Return the last N write/append/delete operations (default 20) with timestamp, path, size delta, and diff line counts. In-memory ring buffer AND persisted to the configured audit log.",
    inputSchema: {
      type: "object" as const,
      properties: {
        n: { type: "number", description: "How many recent writes to return (default 20)" },
      },
    },
  },
  {
    name: "why_blocked",
    description:
      "Trace the policy chain for a path and return {read, write, matched_rule, hint?} for each. Use this to debug why a read or write was refused.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
];

function textResult(obj: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function errorPayload(err: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  if (err instanceof PolicyError) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { error: err.message, ...err.payload },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
  if (err instanceof OutsideRootError) {
    return {
      content: [{ type: "text" as const, text: `outside project root: ${err.message}` }],
      isError: true,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

async function serve(projectRoot: string, policy: Policy) {
  const audit = new AuditLog(projectRoot, policy.audit.log, policy.audit.enabled);

  const server = new Server(
    { name: "fs-fallback", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs || {}) as Record<string, unknown>;
    try {
      switch (name) {
        case "read_file": {
          const p = String(args.path ?? "");
          return textResult(readFileTool(projectRoot, policy, p));
        }
        case "read_file_range": {
          const p = String(args.path ?? "");
          const start = Number(args.start_line);
          const end = Number(args.end_line);
          return textResult(readFileRangeTool(projectRoot, policy, p, start, end));
        }
        case "stat_file": {
          const p = String(args.path ?? "");
          return textResult(statFileTool(projectRoot, policy, p));
        }
        case "list_dir": {
          const p = String(args.path ?? ".");
          return textResult(listDirTool(projectRoot, policy, p));
        }
        case "glob": {
          const pattern = String(args.pattern ?? "");
          const base = args.base !== undefined ? String(args.base) : undefined;
          return textResult(globTool(projectRoot, policy, pattern, base));
        }
        case "write_file": {
          const p = String(args.path ?? "");
          const content = String(args.content ?? "");
          const confirm = args.confirm === true;
          return textResult(writeFileTool(projectRoot, policy, audit, p, content, confirm));
        }
        case "append_file": {
          const p = String(args.path ?? "");
          const content = String(args.content ?? "");
          const confirm = args.confirm === true;
          return textResult(appendFileTool(projectRoot, policy, audit, p, content, confirm));
        }
        case "delete_file": {
          const p = String(args.path ?? "");
          const confirm = args.confirm === true;
          return textResult(deleteFileTool(projectRoot, policy, audit, p, confirm));
        }
        case "recent_writes": {
          const n = typeof args.n === "number" ? args.n : 20;
          return textResult(audit.recent(n));
        }
        case "why_blocked": {
          const p = String(args.path ?? "");
          // Resolve to rel path but don't require existence.
          let relPath = p;
          try {
            const r = resolveInsideRoot(projectRoot, p);
            relPath = r.relPath;
          } catch (err) {
            if (err instanceof OutsideRootError) {
              return textResult(
                {
                  path: p,
                  error: "outside project root",
                  message: err.message,
                },
                true
              );
            }
            throw err;
          }
          return textResult(whyBlocked(policy, p, relPath));
        }
        default:
          return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (err) {
      return errorPayload(err);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function usage(): never {
  process.stderr.write(
    `fs-fallback — ACL-gated raw filesystem MCP server\n\n` +
      `Usage:\n` +
      `  fs-fallback               Start the MCP server on stdio (discovers ${CONFIG_FILENAME} upward from cwd).\n` +
      `  fs-fallback --check PATH  Load + validate a config file and print the parsed policy.\n` +
      `  fs-fallback --help        Show this help.\n\n` +
      `Env:\n` +
      `  FS_FALLBACK_CONFIG        Override config path (skips discovery). Its dirname becomes the project root.\n` +
      `  FS_FALLBACK_ROOT          Force the project root (used when no config is present).\n`
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
      const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
      const p = loadPolicy(abs);
      process.stdout.write(JSON.stringify(p, null, 2) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(`fs-fallback: ${(err as Error).message}\n`);
      process.exit(1);
    }
  }

  const override = process.env.FS_FALLBACK_CONFIG;
  let configPath: string | null;
  let projectRoot: string;
  let policy: Policy;

  if (override) {
    configPath = resolve(override);
    projectRoot = resolve(configPath, "..");
    try {
      policy = loadPolicy(configPath);
    } catch (err) {
      process.stderr.write(`fs-fallback: ${(err as Error).message}\n`);
      process.exit(1);
    }
  } else {
    const disc = discoverConfig(process.cwd());
    configPath = disc.configPath;
    projectRoot = process.env.FS_FALLBACK_ROOT
      ? resolve(process.env.FS_FALLBACK_ROOT)
      : disc.projectRoot;
    if (configPath) {
      try {
        policy = loadPolicy(configPath);
      } catch (err) {
        process.stderr.write(`fs-fallback: ${(err as Error).message}\n`);
        process.exit(1);
      }
    } else {
      policy = defaultPolicy();
      process.stderr.write(
        `fs-fallback: no ${CONFIG_FILENAME} found walking up from ${process.cwd()}. ` +
          `Using restrictive default (reads permissive-minus-secrets, all writes refused). ` +
          `Create ${CONFIG_FILENAME} at the project root to enable writes.\n`
      );
    }
  }

  try {
    ensureTrashDir(projectRoot);
    const purged = purgeExpiredTrash(projectRoot, policy.trash.retention_days);
    if (purged > 0) {
      process.stderr.write(
        `fs-fallback: purged ${purged} expired trash bucket(s) (retention ${policy.trash.retention_days}d)\n`
      );
    }
  } catch (err) {
    process.stderr.write(
      `fs-fallback: trash setup warning: ${(err as Error).message}\n`
    );
  }

  process.stderr.write(
    `fs-fallback: project root = ${projectRoot}\n` +
      `fs-fallback: config = ${configPath ?? "(restrictive default)"}\n` +
      `fs-fallback: audit log = ${policy.audit.enabled ? policy.audit.log : "(disabled)"}\n`
  );

  await serve(projectRoot, policy);
}

main().catch((err) => {
  process.stderr.write(`fs-fallback fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
