import { existsSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

export const POLICY_FILENAME = ".graph-edit.toml";
export const TSCONFIG_FILENAME = "tsconfig.json";

export interface DiscoveredRoot {
  root: string;
  policyPath: string | null;
  tsconfigPath: string | null;
}

export function discoverProjectRoot(startDir: string): DiscoveredRoot | null {
  let dir = resolve(startDir);
  while (true) {
    const policy = join(dir, POLICY_FILENAME);
    if (existsSync(policy) && statSync(policy).isFile()) {
      const tsconfig = join(dir, TSCONFIG_FILENAME);
      return {
        root: dir,
        policyPath: policy,
        tsconfigPath: existsSync(tsconfig) && statSync(tsconfig).isFile() ? tsconfig : null,
      };
    }
    const tsconfig = join(dir, TSCONFIG_FILENAME);
    if (existsSync(tsconfig) && statSync(tsconfig).isFile()) {
      return { root: dir, policyPath: null, tsconfigPath: tsconfig };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
