import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";

export interface ProjectRoot {
  root: string;
  hasLockfile: boolean;
  packageManager: string | null;
}

export function findProjectRoot(startDir: string): ProjectRoot | null {
  let dir = startDir;
  const { root: fsRoot } = parse(dir);

  while (true) {
    const pkgPath = join(dir, "package.json");
    const lockPath = join(dir, "pnpm-lock.yaml");
    const hasLock = existsSync(lockPath);
    let pmField: string | null = null;

    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (typeof pkg.packageManager === "string") {
          pmField = pkg.packageManager;
        }
      } catch {
        // ignore malformed package.json — keep walking
      }
    }

    const isPnpmProject =
      hasLock || (pmField !== null && pmField.startsWith("pnpm@"));

    if (isPnpmProject) {
      return {
        root: dir,
        hasLockfile: hasLock,
        packageManager: pmField,
      };
    }

    if (dir === fsRoot) return null;
    dir = dirname(dir);
  }
}

export function configPath(root: string): string {
  return join(root, ".pnpm-wrapper.toml");
}
