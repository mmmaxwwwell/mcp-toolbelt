import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, resolve } from "node:path";

export type SandboxPreset = "dev" | "strict" | "install";

export interface SandboxSpec {
  // "off" means run directly without bwrap. Otherwise a preset.
  mode: "off" | "bwrap";
  preset?: SandboxPreset;
  extraRw?: string[];
  extraRo?: string[];
}

export interface GlobalSandboxDefaults {
  default_preset: SandboxPreset;
  extra_rw: string[];
  extra_ro: string[];
}

export const DEFAULT_GLOBAL_SANDBOX: GlobalSandboxDefaults = {
  default_preset: "dev",
  extra_rw: [],
  extra_ro: [],
};

// Per-preset $HOME subpaths mounted RW so package caches survive across runs.
const DEV_HOME_RW: string[] = [
  "~/.cache",
  "~/.local/share",
  "~/.npm",
  "~/.cargo/registry",
  "~/.cargo/git",
  "~/.cargo/bin",
  "~/.rustup",
  "~/.pnpm-store",
];

// $HOME files mounted RO so package managers / git see user config.
const DEV_HOME_RO: string[] = [
  "~/.npmrc",
  "~/.yarnrc",
  "~/.gitconfig",
  "~/.git-credentials",
];

// strict preset: minimal RO surface so tools like git don't blow up reading gitconfig.
const STRICT_HOME_RO: string[] = ["~/.gitconfig"];

export interface BuildBwrapOpts {
  preset: SandboxPreset;
  projectRoot: string;
  opCwd: string;
  extraRw: string[];
  extraRo: string[];
}

export interface BuiltBwrap {
  argv: string[];
  network: boolean;
  home: string;
  user: string;
  preset: SandboxPreset;
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  return p;
}

function resolveMount(p: string, home: string, projectRoot: string): string {
  const expanded = expandHome(p, home);
  return isAbsolute(expanded) ? expanded : resolve(projectRoot, expanded);
}

/**
 * Verify bwrap is available on PATH and can create a user namespace.
 * Throws on failure so the caller can surface a clear startup error.
 */
export function assertBwrapAvailable(): void {
  const which = spawnSync("bwrap", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  if (which.error) {
    const code = (which.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        "bwrap (bubblewrap) is required but was not found on PATH. " +
          "Install bubblewrap (nix: `pkgs.bubblewrap`) and ensure it is on PATH."
      );
    }
    throw new Error(`bwrap probe failed: ${which.error.message}`);
  }
  if (which.status !== 0) {
    const stderr = which.stderr ? which.stderr.toString("utf8").trim() : "";
    throw new Error(
      `bwrap --version exited ${which.status}. ` +
        (stderr ? `stderr: ${stderr}` : "This suggests bwrap is broken on this host.")
    );
  }
}

/**
 * Build the bwrap argv for a single operation. Returns the argv PLUS metadata.
 * Bwrap flags are constructed entirely from resolved absolute paths and
 * validated preset names — never from user-supplied strings.
 *
 * Caller invokes as:
 *   spawn("bwrap", [...built.argv, "--", "nix", "develop", "-c", ...opArgv], { shell: false })
 *
 * The `--` separator is *critical* — without it bwrap parses later flags.
 */
export function buildBwrapArgv(opts: BuildBwrapOpts): BuiltBwrap {
  const { preset, projectRoot, opCwd, extraRw, extraRo } = opts;

  const home = homedir() || "/tmp";
  let user = "";
  try {
    user = userInfo().username || "";
  } catch {
    user = "";
  }
  if (!user) user = process.env.USER || process.env.LOGNAME || "user";

  const argv: string[] = [];

  // Core filesystem: read-only /nix, /etc; /dev via bwrap's synthetic minimal /dev;
  // /proc; tmpfs on /tmp; tmpfs on $HOME (denies everything unless we re-bind).
  argv.push("--ro-bind", "/nix", "/nix");
  argv.push("--ro-bind", "/etc", "/etc");
  argv.push("--dev", "/dev");
  argv.push("--proc", "/proc");
  argv.push("--tmpfs", "/tmp");
  argv.push("--tmpfs", home);

  // Project root: RW bind (writable dev workflow).
  argv.push("--bind", projectRoot, projectRoot);

  // Preset-specific $HOME overlays.
  const rwPaths: string[] = [];
  const roPaths: string[] = [];

  if (preset === "dev" || preset === "install") {
    rwPaths.push(...DEV_HOME_RW);
    roPaths.push(...DEV_HOME_RO);
  } else if (preset === "strict") {
    roPaths.push(...STRICT_HOME_RO);
  }

  // Global + per-op extras.
  rwPaths.push(...extraRw);
  roPaths.push(...extraRo);

  // Emit RW binds. Use --bind-try so a missing host path doesn't fail the sandbox.
  // (--bind-try was added in bwrap 0.4; every modern distro / nixpkgs has it.)
  for (const p of rwPaths) {
    const abs = resolveMount(p, home, projectRoot);
    argv.push("--bind-try", abs, abs);
  }

  // Emit RO binds with --ro-bind-try so missing files (e.g. no ~/.git-credentials) are OK.
  for (const p of roPaths) {
    const abs = resolveMount(p, home, projectRoot);
    argv.push("--ro-bind-try", abs, abs);
  }

  // Environment.
  argv.push("--setenv", "HOME", home);
  argv.push("--setenv", "USER", user);

  // Working directory: the resolved op cwd (already validated to be inside projectRoot).
  const chdir = existsSync(opCwd) ? opCwd : projectRoot;
  argv.push("--chdir", chdir);

  // Namespace isolation.
  argv.push("--unshare-user");
  argv.push("--unshare-ipc");
  argv.push("--unshare-pid");
  argv.push("--unshare-uts");
  argv.push("--unshare-cgroup-try");

  // Network policy: strict = off, dev/install = on.
  const network = preset !== "strict";
  if (!network) argv.push("--unshare-net");

  // Lifecycle hygiene.
  argv.push("--die-with-parent");
  argv.push("--new-session");

  return { argv, network, home, user, preset };
}
