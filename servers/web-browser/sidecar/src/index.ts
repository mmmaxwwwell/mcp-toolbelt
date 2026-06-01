#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  openDb,
  upsertPage,
  searchCached,
  getCached,
  listCached,
  purgeCached,
} from "./db.js";
import type Database from "better-sqlite3";

const SIDECAR_TOOLS = [
  {
    name: "search_cached",
    description:
      "Full-text search across previously fetched web pages. Returns matching URLs with title, timestamp, and a text snippet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "FTS5 search query (supports AND, OR, NOT, phrases)",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (default: 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_cached",
    description:
      "Retrieve the full cached markdown for a previously fetched URL.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to retrieve from cache",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "list_cached",
    description:
      "List all cached pages with their URL, title, and fetch timestamp. Ordered by most recently fetched.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Maximum pages to return (default: 50)",
        },
        offset: {
          type: "number",
          description: "Number of pages to skip (default: 0)",
        },
      },
    },
  },
  {
    name: "purge_cached",
    description: "Remove a cached page by URL.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to purge from cache",
        },
      },
      required: ["url"],
    },
  },
];

const SIDECAR_TOOL_NAMES = new Set(SIDECAR_TOOLS.map((t) => t.name));

function handleSidecarTool(
  db: Database.Database,
  name: string,
  args: Record<string, unknown>
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  switch (name) {
    case "search_cached": {
      const results = searchCached(
        db,
        args.query as string,
        (args.limit as number) || 10
      );
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }
    case "get_cached": {
      const page = getCached(db, args.url as string);
      if (!page) {
        return {
          content: [
            { type: "text", text: `No cached page found for URL: ${args.url}` },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                url: page.url,
                title: page.title,
                fetched_at: page.fetched_at,
                markdown: page.markdown,
              },
              null,
              2
            ),
          },
        ],
      };
    }
    case "list_cached": {
      const pages = listCached(
        db,
        (args.limit as number) || 50,
        (args.offset as number) || 0
      );
      return {
        content: [{ type: "text", text: JSON.stringify(pages, null, 2) }],
      };
    }
    case "purge_cached": {
      const deleted = purgeCached(db, args.url as string);
      return {
        content: [
          {
            type: "text",
            text: deleted
              ? `Purged cached page: ${args.url}`
              : `No cached page found for URL: ${args.url}`,
          },
        ],
      };
    }
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}

function extractPageData(
  toolName: string,
  toolArgs: Record<string, unknown>,
  result: unknown
): { url: string; title: string; markdown: string } | null {
  // The upstream fetcher-mcp returns content as an array of { type, text } objects.
  // The URL comes from the tool call arguments.
  const r = result as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  if (r.isError) return null;
  if (!r.content || !Array.isArray(r.content)) return null;

  const url = (toolArgs.url as string) || "";
  if (!url) return null;

  // Concatenate all text content
  const markdown = r.content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");

  if (!markdown) return null;

  // Try to extract title from the first markdown heading
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : url;

  return { url, title, markdown };
}

async function main() {
  const db = openDb();

  // Connect to the upstream fetcher-mcp as a child process
  const childTransport = new StdioClientTransport({
    command: "fetcher-mcp",
    args: [],
  });

  const child = new Client({
    name: "web-browser-sidecar",
    version: "0.1.0",
  });

  await child.connect(childTransport);

  // Create the server that faces the agent
  const server = new Server(
    {
      name: "web-browser-sidecar",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // tools/list: forward to child, then append our sidecar tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const upstream = await child.listTools();
    return {
      tools: [...upstream.tools, ...SIDECAR_TOOLS],
    };
  });

  // tools/call: route to child or handle locally
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (SIDECAR_TOOL_NAMES.has(name)) {
      return handleSidecarTool(db, name, args || {});
    }

    // Forward to upstream
    const result = await child.callTool({
      name,
      arguments: args || {},
    });

    // On success, try to cache the page
    const pageData = extractPageData(name, args || {}, result);
    if (pageData) {
      try {
        upsertPage(db, pageData.url, pageData.title, pageData.markdown);
      } catch {
        // Don't fail the tool call if caching fails
      }
    }

    return result;
  });

  // Start the server on stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("web-browser-sidecar fatal:", err);
  process.exit(1);
});
