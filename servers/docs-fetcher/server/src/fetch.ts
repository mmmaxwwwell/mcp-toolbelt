import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export interface FetchedDoc {
  url: string;
  title: string;
  markdown: string;
}

export async function fetchViaChild(
  child: Client,
  url: string
): Promise<FetchedDoc> {
  const result = await child.callTool({
    name: "fetch_url",
    arguments: { url },
  });
  const r = result as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  if (r.isError) throw new Error(`fetcher-mcp reported error for ${url}`);
  if (!r.content || !Array.isArray(r.content))
    throw new Error(`fetcher-mcp returned no content for ${url}`);
  const markdown = r.content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");
  if (!markdown.trim()) throw new Error(`empty content for ${url}`);

  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : url;

  return { url, title, markdown };
}

// PyPI's JSON endpoint returns a full metadata document instead of markdown.
// If we detect a JSON shape with `info.description`, extract that as the
// markdown body so section splitting can operate on the real README.
export function normalizePypiJson(doc: FetchedDoc): FetchedDoc {
  const trimmed = doc.markdown.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return doc;
  try {
    const parsed = JSON.parse(trimmed) as {
      info?: {
        name?: string;
        description?: string;
        summary?: string;
        project_urls?: Record<string, string>;
      };
    };
    const info = parsed.info;
    if (!info || typeof info.description !== "string") return doc;
    const header = info.name ? `# ${info.name}\n\n` : "";
    const summary = info.summary ? `${info.summary}\n\n` : "";
    return {
      url: doc.url,
      title: info.name || doc.title,
      markdown: header + summary + info.description,
    };
  } catch {
    return doc;
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
