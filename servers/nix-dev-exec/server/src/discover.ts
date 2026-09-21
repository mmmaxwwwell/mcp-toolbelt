import { existsSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

export const REGISTRY_FILENAME = ".nix-dev-exec.toml";

export function discoverRegistry(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, REGISTRY_FILENAME);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
