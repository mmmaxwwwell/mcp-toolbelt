import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import toml from "@iarna/toml";
import type { Ecosystem, Language } from "./db.js";

export interface Dep {
  ecosystem: Ecosystem;
  language: Language;
  package: string;
  version: string;
  manifest_path: string;
}

export interface ManifestFile {
  path: string;
  ecosystem: Ecosystem;
}

export function ecosystemToLanguage(e: Ecosystem): Language {
  switch (e) {
    case "npm":
      return "typescript";
    case "cargo":
      return "rust";
    case "pypi":
      return "python";
    case "go":
      return "go";
  }
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".next",
  ".cache",
  "vendor",
]);

const MANIFEST_NAMES: { [k: string]: Ecosystem } = {
  "package.json": "npm",
  "Cargo.toml": "cargo",
  "pyproject.toml": "pypi",
  "go.mod": "go",
};

export function findManifestsUp(startDir: string): ManifestFile[] {
  const found: ManifestFile[] = [];
  let dir = resolve(startDir);
  while (true) {
    for (const [name, eco] of Object.entries(MANIFEST_NAMES)) {
      const p = join(dir, name);
      if (existsSync(p)) found.push({ path: p, ecosystem: eco });
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

export function findManifestsDown(startDir: string, maxDepth = 4): ManifestFile[] {
  const found: ManifestFile[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry.startsWith(".")) {
        // Still check for manifests at the root even if starts with dot
        if (!SKIP_DIRS.has(entry) && depth === 0 && MANIFEST_NAMES[entry]) {
          found.push({ path: join(dir, entry), ecosystem: MANIFEST_NAMES[entry] });
        }
        continue;
      }
      const full = join(dir, entry);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        walk(full, depth + 1);
      } else if (MANIFEST_NAMES[entry]) {
        found.push({ path: full, ecosystem: MANIFEST_NAMES[entry] });
      }
    }
  };
  walk(resolve(startDir), 0);
  return found;
}

export function discoverManifests(cwd: string): ManifestFile[] {
  // Prefer walking down from cwd, then de-dupe with anything found upward
  const down = findManifestsDown(cwd);
  const up = findManifestsUp(cwd);
  const seen = new Set<string>();
  const all: ManifestFile[] = [];
  for (const m of [...down, ...up]) {
    if (seen.has(m.path)) continue;
    seen.add(m.path);
    all.push(m);
  }
  return all;
}

export function parseManifest(
  manifest: ManifestFile,
  warnings: string[]
): Dep[] {
  try {
    switch (manifest.ecosystem) {
      case "npm":
        return parseNpm(manifest.path, warnings);
      case "cargo":
        return parseCargo(manifest.path, warnings);
      case "pypi":
        return parsePypi(manifest.path, warnings);
      case "go":
        warnings.push(`go.mod adapter is a stub in v0.1: ${manifest.path}`);
        return [];
    }
  } catch (err) {
    warnings.push(
      `failed to parse ${manifest.path}: ${(err as Error).message}`
    );
    return [];
  }
}

function parseNpm(pkgJsonPath: string, warnings: string[]): Dep[] {
  const raw = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const wanted = new Set<string>([
    ...Object.keys(raw.dependencies || {}),
    ...Object.keys(raw.devDependencies || {}),
    ...Object.keys(raw.peerDependencies || {}),
  ]);
  if (wanted.size === 0) return [];

  const dir = dirname(pkgJsonPath);
  const resolved = new Map<string, string>();

  // package-lock.json first
  const lockPath = join(dir, "package-lock.json");
  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
        packages?: Record<string, { version?: string }>;
        dependencies?: Record<string, { version?: string }>;
      };
      if (lock.packages) {
        // npm v2/v3: keys are "node_modules/<name>" or "node_modules/<name>/node_modules/<name>"
        for (const [key, val] of Object.entries(lock.packages)) {
          if (!key.startsWith("node_modules/")) continue;
          // top-level only: exactly one "node_modules/" segment
          const stripped = key.slice("node_modules/".length);
          if (stripped.includes("/node_modules/")) continue;
          const name = stripped;
          if (val?.version && wanted.has(name) && !resolved.has(name)) {
            resolved.set(name, val.version);
          }
        }
      }
      if (lock.dependencies) {
        // npm v1 fallback
        for (const [name, val] of Object.entries(lock.dependencies)) {
          if (val?.version && wanted.has(name) && !resolved.has(name)) {
            resolved.set(name, val.version);
          }
        }
      }
    } catch (err) {
      warnings.push(`failed to parse ${lockPath}: ${(err as Error).message}`);
    }
  }

  // pnpm-lock.yaml (very light parser: look for "  /<name>@<version>:" or "  '<name>@<ver>':")
  const pnpmLockPath = join(dir, "pnpm-lock.yaml");
  if (existsSync(pnpmLockPath) && resolved.size < wanted.size) {
    try {
      const y = readFileSync(pnpmLockPath, "utf8");
      const re = /^\s{2}['"]?\/?((?:@[^/@\s'"]+\/)?[^/@\s'"]+)@([^:\s'"]+)['"]?:/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(y)) !== null) {
        const [, name, ver] = m;
        if (wanted.has(name) && !resolved.has(name)) {
          // strip peer suffix e.g. 1.2.3(react@18)
          const clean = ver.replace(/\(.*$/, "");
          resolved.set(name, clean);
        }
      }
    } catch (err) {
      warnings.push(`failed to parse ${pnpmLockPath}: ${(err as Error).message}`);
    }
  }

  // Fallback to declared version spec if unresolved
  const declared: Record<string, string> = {
    ...(raw.dependencies || {}),
    ...(raw.devDependencies || {}),
    ...(raw.peerDependencies || {}),
  };
  const out: Dep[] = [];
  for (const name of wanted) {
    let ver = resolved.get(name);
    if (!ver) {
      const spec = declared[name] || "";
      ver = normalizeVersionSpec(spec);
      if (!ver) {
        warnings.push(`npm: no resolvable version for ${name}`);
        continue;
      }
    }
    out.push({
      ecosystem: "npm",
      language: "typescript",
      package: name,
      version: ver,
      manifest_path: pkgJsonPath,
    });
  }
  return out;
}

function parseCargo(cargoTomlPath: string, warnings: string[]): Dep[] {
  const dir = dirname(cargoTomlPath);
  const lockPath = join(dir, "Cargo.lock");

  const cargoToml = toml.parse(readFileSync(cargoTomlPath, "utf8")) as {
    dependencies?: Record<string, unknown>;
    "dev-dependencies"?: Record<string, unknown>;
    "build-dependencies"?: Record<string, unknown>;
    workspace?: {
      dependencies?: Record<string, unknown>;
      members?: string[];
    };
  };
  const wanted = new Set<string>([
    ...Object.keys(cargoToml.dependencies || {}),
    ...Object.keys(cargoToml["dev-dependencies"] || {}),
    ...Object.keys(cargoToml["build-dependencies"] || {}),
    ...Object.keys(cargoToml.workspace?.dependencies || {}),
  ]);

  const out: Dep[] = [];
  if (existsSync(lockPath)) {
    try {
      const lock = toml.parse(readFileSync(lockPath, "utf8")) as {
        package?: Array<{ name: string; version: string }>;
      };
      const seen = new Set<string>();
      for (const pkg of lock.package || []) {
        // If wanted is empty (workspace root without listed deps), include all lockfile pkgs
        if (wanted.size > 0 && !wanted.has(pkg.name)) continue;
        const key = `${pkg.name}@${pkg.version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          ecosystem: "cargo",
          language: "rust",
          package: pkg.name,
          version: pkg.version,
          manifest_path: cargoTomlPath,
        });
      }
    } catch (err) {
      warnings.push(`failed to parse ${lockPath}: ${(err as Error).message}`);
    }
  } else {
    warnings.push(
      `cargo: no Cargo.lock next to ${cargoTomlPath}; versions may be inexact`
    );
    for (const name of wanted) {
      const spec = cargoToml.dependencies?.[name];
      const version = extractCargoVersionSpec(spec);
      if (!version) {
        warnings.push(`cargo: no version for ${name}`);
        continue;
      }
      out.push({
        ecosystem: "cargo",
        language: "rust",
        package: name,
        version,
        manifest_path: cargoTomlPath,
      });
    }
  }
  return out;
}

function extractCargoVersionSpec(spec: unknown): string {
  if (typeof spec === "string") return normalizeVersionSpec(spec);
  if (spec && typeof spec === "object") {
    const v = (spec as { version?: string }).version;
    if (typeof v === "string") return normalizeVersionSpec(v);
  }
  return "";
}

function parsePypi(pyprojectPath: string, warnings: string[]): Dep[] {
  const dir = dirname(pyprojectPath);
  const raw = toml.parse(readFileSync(pyprojectPath, "utf8")) as {
    project?: {
      dependencies?: string[];
      "optional-dependencies"?: Record<string, string[]>;
    };
    tool?: {
      poetry?: {
        dependencies?: Record<string, unknown>;
        "dev-dependencies"?: Record<string, unknown>;
      };
      uv?: {
        sources?: Record<string, unknown>;
      };
    };
  };

  const specs = new Map<string, string>();

  // PEP 621 project.dependencies (list of PEP 508 strings)
  for (const dep of raw.project?.dependencies || []) {
    const parsed = parsePep508(dep);
    if (parsed) specs.set(parsed.name, parsed.version);
  }
  for (const list of Object.values(raw.project?.["optional-dependencies"] || {})) {
    for (const dep of list) {
      const parsed = parsePep508(dep);
      if (parsed && !specs.has(parsed.name)) specs.set(parsed.name, parsed.version);
    }
  }

  // Poetry
  const poetryDeps = {
    ...(raw.tool?.poetry?.dependencies || {}),
    ...(raw.tool?.poetry?.["dev-dependencies"] || {}),
  };
  for (const [name, val] of Object.entries(poetryDeps)) {
    if (name === "python") continue;
    let ver = "";
    if (typeof val === "string") ver = normalizeVersionSpec(val);
    else if (val && typeof val === "object") {
      const v = (val as { version?: string }).version;
      if (typeof v === "string") ver = normalizeVersionSpec(v);
    }
    if (!specs.has(name)) specs.set(name, ver);
  }

  // uv.sources — often just aliases; not a version source, but keep names visible
  for (const name of Object.keys(raw.tool?.uv?.sources || {})) {
    if (!specs.has(name)) specs.set(name, "");
  }

  // Lockfile resolution
  const resolved = new Map<string, string>();
  const uvLock = join(dir, "uv.lock");
  const poetryLock = join(dir, "poetry.lock");
  if (existsSync(uvLock)) {
    try {
      const l = toml.parse(readFileSync(uvLock, "utf8")) as {
        package?: Array<{ name: string; version: string }>;
      };
      for (const p of l.package || []) resolved.set(p.name, p.version);
    } catch (err) {
      warnings.push(`failed to parse ${uvLock}: ${(err as Error).message}`);
    }
  } else if (existsSync(poetryLock)) {
    try {
      const l = toml.parse(readFileSync(poetryLock, "utf8")) as {
        package?: Array<{ name: string; version: string }>;
      };
      for (const p of l.package || []) resolved.set(p.name, p.version);
    } catch (err) {
      warnings.push(`failed to parse ${poetryLock}: ${(err as Error).message}`);
    }
  }

  const out: Dep[] = [];
  for (const [name, spec] of specs) {
    const version = resolved.get(name) || spec;
    if (!version) {
      warnings.push(`pypi: no resolvable version for ${name}`);
      continue;
    }
    out.push({
      ecosystem: "pypi",
      language: "python",
      package: name,
      version,
      manifest_path: pyprojectPath,
    });
  }
  return out;
}

function parsePep508(spec: string): { name: string; version: string } | null {
  // Handle e.g. "requests>=2.28,<3.0", "flask==2.3.2", "numpy ; python_version < '3.10'"
  const m = /^\s*([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])?\s*([^;]*?)?\s*(?:;.*)?$/.exec(spec);
  if (!m) return null;
  const name = m[1];
  const rest = (m[2] || "").trim();
  return { name, version: normalizeVersionSpec(rest) };
}

function normalizeVersionSpec(spec: string): string {
  if (!spec) return "";
  // Trim leading operators (^, ~, >=, ==, >, etc.), keep the version literal
  const m = /(\d[\w.\-+]*)/.exec(spec);
  return m ? m[1] : "";
}
