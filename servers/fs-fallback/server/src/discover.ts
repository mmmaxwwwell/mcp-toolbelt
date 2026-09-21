import { existsSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

export const CONFIG_FILENAME = ".fs-fallback.toml";

export interface DiscoveryResult {
  configPath: string | null;
  projectRoot: string;
}

/**
 * Walk up from startDir until we find `.fs-fallback.toml`. If none found,
 * projectRoot falls back to startDir and configPath is null (caller applies
 * a restrictive default policy).
 */
export function discoverConfig(startDir: string): DiscoveryResult {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return { configPath: candidate, projectRoot: dir };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return { configPath: null, projectRoot: resolve(startDir) };
    }
    dir = parent;
  }
}
