import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

function getDbPath(): string {
  const cacheHome =
    process.env.XDG_CACHE_HOME || join(process.env.HOME || "/tmp", ".cache");
  return join(cacheHome, "mcp-toolbelt", "web-cache.db");
}

export interface Page {
  id: number;
  url: string;
  title: string;
  fetched_at: number;
  markdown: string;
}

export interface SearchResult {
  url: string;
  title: string;
  fetched_at: number;
  snippet: string;
}

export function openDb(): Database.Database {
  const dbPath = getDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY,
      url TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      fetched_at INTEGER NOT NULL,
      markdown TEXT NOT NULL DEFAULT ''
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
      title, markdown, content='pages', content_rowid='id'
    );

    -- Triggers to keep FTS in sync with the content table.
    CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
      INSERT INTO pages_fts(rowid, title, markdown)
        VALUES (new.id, new.title, new.markdown);
    END;

    CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
      INSERT INTO pages_fts(pages_fts, rowid, title, markdown)
        VALUES ('delete', old.id, old.title, old.markdown);
    END;

    CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
      INSERT INTO pages_fts(pages_fts, rowid, title, markdown)
        VALUES ('delete', old.id, old.title, old.markdown);
      INSERT INTO pages_fts(rowid, title, markdown)
        VALUES (new.id, new.title, new.markdown);
    END;
  `);

  return db;
}

export function upsertPage(
  db: Database.Database,
  url: string,
  title: string,
  markdown: string
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO pages (url, title, fetched_at, markdown)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(url, title, Math.floor(Date.now() / 1000), markdown);
}

export function searchCached(
  db: Database.Database,
  query: string,
  limit: number = 10
): SearchResult[] {
  const stmt = db.prepare(`
    SELECT p.url, p.title, p.fetched_at,
           snippet(pages_fts, 1, '<mark>', '</mark>', '...', 64) AS snippet
    FROM pages_fts
    JOIN pages p ON p.id = pages_fts.rowid
    WHERE pages_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);
  return stmt.all(query, limit) as SearchResult[];
}

export function getCached(
  db: Database.Database,
  url: string
): Page | undefined {
  const stmt = db.prepare("SELECT * FROM pages WHERE url = ?");
  return stmt.get(url) as Page | undefined;
}

export function listCached(
  db: Database.Database,
  limit: number = 50,
  offset: number = 0
): Pick<Page, "url" | "title" | "fetched_at">[] {
  const stmt = db.prepare(
    "SELECT url, title, fetched_at FROM pages ORDER BY fetched_at DESC LIMIT ? OFFSET ?"
  );
  return stmt.all(limit, offset) as Pick<Page, "url" | "title" | "fetched_at">[];
}

export function purgeCached(db: Database.Database, url: string): boolean {
  const stmt = db.prepare("DELETE FROM pages WHERE url = ?");
  const result = stmt.run(url);
  return result.changes > 0;
}
