#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type Database from "better-sqlite3";
import {
  openDb,
  upsertSection,
  isIndexed,
  searchDocs,
  listIndexed,
  getSection,
  purge,
  type Language,
} from "./db.js";
import {
  discoverManifests,
  parseManifest,
  type Dep,
} from "./manifests.js";
import { resolveDocsUrl } from "./resolvers.js";
import { fetchViaChild, normalizePypiJson, delay } from "./fetch.js";
import { splitSections } from "./sections.js";

const DEFAULT_DELAY_MS = Number(process.env.DOCS_FETCHER_DELAY_MS || 200);

const TOOLS = [
  {
    name: "list_deps",
    description:
      "Enumerate dependencies from project manifests (package.json, Cargo.toml, pyproject.toml). Returns each dep with its ecosystem, language tag, resolved version, canonical docs URL, and whether it is already indexed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        manifest_path: {
          type: "string",
          description:
            "Optional explicit manifest path. If omitted, manifests are auto-discovered from cwd.",
        },
      },
    },
  },
  {
    name: "list_manifests",
    description:
      "List all dependency manifests discovered in the project (walks down from cwd and up to filesystem root).",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "warm_docs",
    description:
      "For each dep in the project (or one manifest), resolve its canonical docs URL and fetch it via fetcher-mcp, indexing sections into the FTS5 cache. Skips deps already indexed unless `force` is true.",
    inputSchema: {
      type: "object" as const,
      properties: {
        manifest_path: { type: "string" },
        force: {
          type: "boolean",
          description: "Refetch even if the package/version is already indexed.",
        },
      },
    },
  },
  {
    name: "search",
    description:
      "FTS5 BM25 search across cached docs. Optional tag filters: `tech` (rust|typescript|python|go), `package` (exact name), `version` (exact string). Returns section-level hits with snippets.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "FTS5 MATCH expression." },
        tech: {
          type: "string",
          enum: ["typescript", "rust", "python", "go"],
          description: "Filter by language tag.",
        },
        package: { type: "string" },
        version: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_indexed",
    description:
      "List packages currently indexed in the cache. Optional `tech` / `package` filters.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tech: { type: "string", enum: ["typescript", "rust", "python", "go"] },
        package: { type: "string" },
      },
    },
  },
  {
    name: "get_section",
    description: "Return the full content of one cached section.",
    inputSchema: {
      type: "object" as const,
      properties: {
        package: { type: "string" },
        version: { type: "string" },
        section_path: { type: "string" },
      },
      required: ["package", "version", "section_path"],
    },
  },
  {
    name: "purge",
    description:
      "Drop cached docs for a package. If `version` is omitted, all versions are purged.",
    inputSchema: {
      type: "object" as const,
      properties: {
        package: { type: "string" },
        version: { type: "string" },
      },
      required: ["package"],
    },
  },
];

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function err(msg: string): ToolResult {
  return { content: [{ type: "text", text: msg }], isError: true };
}

function gatherDeps(
  manifestPath: string | undefined,
  warnings: string[]
): Dep[] {
  const manifests = manifestPath
    ? [
        {
          path: manifestPath,
          ecosystem: guessEcosystem(manifestPath),
        },
      ]
    : discoverManifests(process.cwd());
  const deps: Dep[] = [];
  const seen = new Set<string>();
  for (const m of manifests) {
    for (const d of parseManifest(m, warnings)) {
      const key = `${d.ecosystem}:${d.package}@${d.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deps.push(d);
    }
  }
  return deps;
}

function guessEcosystem(path: string): import("./db.js").Ecosystem {
  if (path.endsWith("package.json")) return "npm";
  if (path.endsWith("Cargo.toml")) return "cargo";
  if (path.endsWith("pyproject.toml")) return "pypi";
  if (path.endsWith("go.mod")) return "go";
  throw new Error(`unrecognised manifest path: ${path}`);
}

async function handleWarm(
  db: Database.Database,
  child: Client,
  args: { manifest_path?: string; force?: boolean }
): Promise<ToolResult> {
  const warnings: string[] = [];
  const deps = gatherDeps(args.manifest_path, warnings);
  const fetched: Array<{ package: string; version: string; sections: number }> = [];
  const skipped: Array<{ package: string; version: string }> = [];
  const failed: Array<{ package: string; version: string; error: string }> = [];

  for (const dep of deps) {
    if (!args.force && isIndexed(db, dep.package, dep.version)) {
      skipped.push({ package: dep.package, version: dep.version });
      continue;
    }
    try {
      const { url } = resolveDocsUrl(dep);
      let doc = await fetchViaChild(child, url);
      if (dep.ecosystem === "pypi") doc = normalizePypiJson(doc);
      const sections = splitSections(doc.markdown);
      for (const s of sections) {
        upsertSection(db, {
          url,
          ecosystem: dep.ecosystem,
          language: dep.language,
          package: dep.package,
          version: dep.version,
          section_path: s.section_path,
          title: s.title || doc.title,
          content: s.content,
        });
      }
      fetched.push({
        package: dep.package,
        version: dep.version,
        sections: sections.length,
      });
      await delay(DEFAULT_DELAY_MS);
    } catch (e) {
      failed.push({
        package: dep.package,
        version: dep.version,
        error: (e as Error).message,
      });
    }
  }
  return ok({
    fetched: fetched.length,
    skipped: skipped.length,
    failed,
    details: { fetched, skipped },
    warnings,
  });
}

function handleTool(
  db: Database.Database,
  child: Client,
  name: string,
  args: Record<string, unknown>
): ToolResult | Promise<ToolResult> {
  switch (name) {
    case "list_deps": {
      const warnings: string[] = [];
      const deps = gatherDeps(args.manifest_path as string | undefined, warnings);
      const enriched = deps.map((d) => {
        const { url } = resolveDocsUrl(d);
        return {
          ecosystem: d.ecosystem,
          language: d.language,
          package: d.package,
          version: d.version,
          resolved_url: url,
          indexed: isIndexed(db, d.package, d.version),
          manifest_path: d.manifest_path,
        };
      });
      return ok({ deps: enriched, warnings });
    }
    case "list_manifests": {
      const manifests = discoverManifests(process.cwd());
      return ok({ manifests });
    }
    case "warm_docs":
      return handleWarm(db, child, args as { manifest_path?: string; force?: boolean });
    case "search": {
      const query = args.query as string;
      if (!query) return err("query is required");
      const results = searchDocs(
        db,
        query,
        {
          language: args.tech as Language | undefined,
          package: args.package as string | undefined,
          version: args.version as string | undefined,
        },
        (args.limit as number) || 10
      );
      return ok(results);
    }
    case "list_indexed": {
      const results = listIndexed(db, {
        language: args.tech as Language | undefined,
        package: args.package as string | undefined,
      });
      return ok(results);
    }
    case "get_section": {
      const row = getSection(
        db,
        args.package as string,
        args.version as string,
        args.section_path as string
      );
      if (!row)
        return err(
          `no section found for ${args.package}@${args.version} at "${args.section_path}"`
        );
      return ok(row);
    }
    case "purge": {
      const changes = purge(
        db,
        args.package as string,
        args.version as string | undefined
      );
      return ok({ deleted_sections: changes });
    }
    default:
      return err(`unknown tool: ${name}`);
  }
}

async function main() {
  const db = openDb();

  const childTransport = new StdioClientTransport({
    command: "fetcher-mcp",
    args: [],
  });
  const child = new Client({
    name: "docs-fetcher-client",
    version: "0.1.0",
  });
  await child.connect(childTransport);

  const server = new Server(
    { name: "docs-fetcher", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleTool(db, child, name, args || {});
    } catch (e) {
      return err(`${name} failed: ${(e as Error).message}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("docs-fetcher fatal:", e);
  process.exit(1);
});
