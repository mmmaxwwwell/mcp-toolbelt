import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

function getDbPath(): string {
  const cacheHome =
    process.env.XDG_CACHE_HOME || join(process.env.HOME || "/tmp", ".cache");
  return join(cacheHome, "mcp-toolbelt", "docs-cache.db");
}

export type Ecosystem = "npm" | "cargo" | "pypi" | "go";
export type Language = "typescript" | "rust" | "python" | "go";

export interface DocRow {
  id: number;
  url: string;
  ecosystem: Ecosystem;
  language: Language;
  package: string;
  version: string;
  section_path: string;
  title: string;
  content: string;
  fetched_at: number;
}

export interface SearchHit {
  package: string;
  version: string;
  language: Language;
  ecosystem: Ecosystem;
  section_path: string;
  title: string;
  snippet: string;
  url: string;
}

export interface IndexedPackage {
  ecosystem: Ecosystem;
  language: Language;
  package: string;
  version: string;
  section_count: number;
  fetched_at: number;
}

export function openDb(): Database.Database {
  const dbPath = getDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL,
      ecosystem TEXT NOT NULL,
      language TEXT NOT NULL,
      package TEXT NOT NULL,
      version TEXT NOT NULL,
      section_path TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      fetched_at INTEGER NOT NULL,
      UNIQUE(package, version, section_path)
    );

    CREATE INDEX IF NOT EXISTS docs_pkg_ver_idx ON docs(package, version);
    CREATE INDEX IF NOT EXISTS docs_language_idx ON docs(language);
    CREATE INDEX IF NOT EXISTS docs_ecosystem_idx ON docs(ecosystem);

    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      package, version, title, content,
      content='docs', content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
      INSERT INTO docs_fts(rowid, package, version, title, content)
        VALUES (new.id, new.package, new.version, new.title, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
      INSERT INTO docs_fts(docs_fts, rowid, package, version, title, content)
        VALUES ('delete', old.id, old.package, old.version, old.title, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
      INSERT INTO docs_fts(docs_fts, rowid, package, version, title, content)
        VALUES ('delete', old.id, old.package, old.version, old.title, old.content);
      INSERT INTO docs_fts(rowid, package, version, title, content)
        VALUES (new.id, new.package, new.version, new.title, new.content);
    END;
  `);

  return db;
}

export function isIndexed(
  db: Database.Database,
  pkg: string,
  version: string
): boolean {
  const stmt = db.prepare(
    "SELECT 1 FROM docs WHERE package = ? AND version = ? LIMIT 1"
  );
  return !!stmt.get(pkg, version);
}

export function upsertSection(
  db: Database.Database,
  row: {
    url: string;
    ecosystem: Ecosystem;
    language: Language;
    package: string;
    version: string;
    section_path: string;
    title: string;
    content: string;
  }
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO docs
      (url, ecosystem, language, package, version, section_path, title, content, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    row.url,
    row.ecosystem,
    row.language,
    row.package,
    row.version,
    row.section_path,
    row.title,
    row.content,
    Math.floor(Date.now() / 1000)
  );
}

export function searchDocs(
  db: Database.Database,
  query: string,
  filters: {
    language?: Language;
    package?: string;
    version?: string;
  },
  limit: number
): SearchHit[] {
  const where: string[] = ["docs_fts MATCH ?"];
  const params: unknown[] = [query];
  if (filters.language) {
    where.push("d.language = ?");
    params.push(filters.language);
  }
  if (filters.package) {
    where.push("d.package = ?");
    params.push(filters.package);
  }
  if (filters.version) {
    where.push("d.version = ?");
    params.push(filters.version);
  }
  params.push(limit);
  const sql = `
    SELECT d.package, d.version, d.language, d.ecosystem,
           d.section_path, d.title, d.url,
           snippet(docs_fts, 3, '<mark>', '</mark>', '...', 64) AS snippet
    FROM docs_fts
    JOIN docs d ON d.id = docs_fts.rowid
    WHERE ${where.join(" AND ")}
    ORDER BY rank
    LIMIT ?
  `;
  return db.prepare(sql).all(...params) as SearchHit[];
}

export function listIndexed(
  db: Database.Database,
  filters: { language?: Language; package?: string }
): IndexedPackage[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.language) {
    where.push("language = ?");
    params.push(filters.language);
  }
  if (filters.package) {
    where.push("package = ?");
    params.push(filters.package);
  }
  const sql = `
    SELECT ecosystem, language, package, version,
           COUNT(*) AS section_count,
           MAX(fetched_at) AS fetched_at
    FROM docs
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    GROUP BY ecosystem, language, package, version
    ORDER BY package, version
  `;
  return db.prepare(sql).all(...params) as IndexedPackage[];
}

export function getSection(
  db: Database.Database,
  pkg: string,
  version: string,
  section_path: string
): DocRow | undefined {
  const stmt = db.prepare(
    "SELECT * FROM docs WHERE package = ? AND version = ? AND section_path = ?"
  );
  return stmt.get(pkg, version, section_path) as DocRow | undefined;
}

export function purge(
  db: Database.Database,
  pkg: string,
  version?: string
): number {
  const stmt = version
    ? db.prepare("DELETE FROM docs WHERE package = ? AND version = ?")
    : db.prepare("DELETE FROM docs WHERE package = ?");
  const result = version ? stmt.run(pkg, version) : stmt.run(pkg);
  return result.changes;
}
