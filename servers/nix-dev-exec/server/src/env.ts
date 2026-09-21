import { spawn } from "node:child_process";

interface EnvInfoCache {
  fetched_at: number;
  env: Record<string, string>;
  key_binaries: Record<string, string | null>;
  dev_shell_store_path: string | null;
  error: string | null;
}

interface WhichCache {
  [binary: string]: { path: string | null; fetched_at: number };
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const KEY_BINARIES = ["node", "pnpm", "npm", "python", "python3", "cargo", "go", "make", "tsc"];

let envCache: EnvInfoCache | null = null;
const whichCache: WhichCache = {};

function runNix(
  argv: string[],
  cwd: string,
  timeoutMs = 30000
): Promise<{ stdout: string; stderr: string; code: number | null; error: string | null }> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn("nix", argv, {
        cwd,
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolvePromise({ stdout: "", stderr: "", code: null, error: (err as Error).message });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on("data", (d) => out.push(d));
    child.stderr!.on("data", (d) => err.push(d));
    const t = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(t);
      const msg =
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? "nix binary not found on PATH"
          : e.message;
      resolvePromise({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code: null,
        error: msg,
      });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolvePromise({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code,
        error: null,
      });
    });
  });
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq);
    const v = line.slice(eq + 1);
    env[k] = v;
  }
  return env;
}

export async function getEnvInfo(cwd: string): Promise<EnvInfoCache> {
  if (envCache && Date.now() - envCache.fetched_at < CACHE_TTL_MS) {
    return envCache;
  }
  const envRun = await runNix(["develop", "-c", "env"], cwd);
  if (envRun.error || envRun.code !== 0) {
    const cache: EnvInfoCache = {
      fetched_at: Date.now(),
      env: {},
      key_binaries: {},
      dev_shell_store_path: null,
      error:
        envRun.error ||
        `nix develop -c env exited ${envRun.code}: ${envRun.stderr.slice(0, 500)}`,
    };
    envCache = cache;
    return cache;
  }
  const env = parseEnv(envRun.stdout);

  const key_binaries: Record<string, string | null> = {};
  await Promise.all(
    KEY_BINARIES.map(async (b) => {
      const r = await runNix(["develop", "-c", "command", "-v", b], cwd, 15000);
      key_binaries[b] = r.code === 0 ? r.stdout.trim() || null : null;
    })
  );

  let dev_shell_store_path: string | null = null;
  const eval1 = await runNix(
    ["eval", "--raw", ".#devShells.${builtins.currentSystem}.default.outPath"],
    cwd,
    15000
  );
  if (eval1.code === 0 && eval1.stdout.startsWith("/nix/store/")) {
    dev_shell_store_path = eval1.stdout.trim();
  }

  const cache: EnvInfoCache = {
    fetched_at: Date.now(),
    env,
    key_binaries,
    dev_shell_store_path,
    error: null,
  };
  envCache = cache;
  return cache;
}

export async function whichBinary(
  cwd: string,
  binary: string
): Promise<{ binary: string; path: string | null; cached: boolean; error: string | null }> {
  if (!/^[a-zA-Z0-9_.\-+]+$/.test(binary)) {
    return {
      binary,
      path: null,
      cached: false,
      error: "binary name contains disallowed characters",
    };
  }
  const cached = whichCache[binary];
  if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) {
    return { binary, path: cached.path, cached: true, error: null };
  }
  const r = await runNix(["develop", "-c", "command", "-v", binary], cwd, 15000);
  if (r.error) {
    return { binary, path: null, cached: false, error: r.error };
  }
  const path = r.code === 0 ? r.stdout.trim() || null : null;
  whichCache[binary] = { path, fetched_at: Date.now() };
  return { binary, path, cached: false, error: null };
}

export function clearCaches(): void {
  envCache = null;
  for (const k of Object.keys(whichCache)) delete whichCache[k];
}
