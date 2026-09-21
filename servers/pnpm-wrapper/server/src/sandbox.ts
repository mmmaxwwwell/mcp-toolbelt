// Sandbox module — builds bwrap argv for wrapping pnpm invocations.
//
// Every pnpm invocation flows through this module. Presets are hardcoded;
// only a small [sandbox] config surface is exposed (extra_rw/extra_ro,
// per-script preset overrides for `script`-kind verbs, and an opt-out map
// that must be explicitly configured per-verb).
//
// Designed to be aligned with a parallel sandbox module in nix-dev-exec so
// the two can be extracted to a shared package later.

import { existsSync, statSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir, userInfo } from "node:os";

export type SandboxPreset = "install" | "readonly" | "script" | "strict";

export interface SandboxSpec {
  mode: "bwrap";
  preset: SandboxPreset;
  network: boolean;
  projectRoot: string;
  home: string;
  user: string;
  extraRw: string[];
  extraRo: string[];
}

export interface SandboxDisabled {
  mode: "off";
  reason: string;
}

export type SandboxDecision = SandboxSpec | SandboxDisabled;

export interface BuildOpts {
  preset: SandboxPreset;
  projectRoot: string;
  extraRw?: string[];
  extraRo?: string[];
  home?: string;
  user?: string;
}

// Normalizes a path: expands ~, resolves to absolute. Returns null if the
// input isn't a plausible host path (empty, contains null bytes, relative
// with no clear anchor).
export function normalizeHostPath(p: string, home: string): string | null {
  if (!p || typeof p !== "string") return null;
  if (p.includes("\0")) return null;
  let expanded = p;
  if (expanded === "~") {
    expanded = home;
  } else if (expanded.startsWith("~/")) {
    expanded = home + expanded.slice(1);
  }
  if (!isAbsolute(expanded)) return null;
  return resolve(expanded);
}

// Returns true iff bwrap is on PATH.
export function isBwrapAvailable(): boolean {
  const r = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
  return r.status === 0;
}

// Startup precondition. Throws with a clear, actionable message when bwrap
// is missing so operators don't get a mysterious ENOENT later.
export function assertBwrapAvailable(): void {
  if (!isBwrapAvailable()) {
    throw new Error(
      "pnpm-wrapper requires bubblewrap (bwrap) on PATH. " +
        "Install with `nix profile install nixpkgs#bubblewrap` " +
        "or on Debian/Ubuntu `apt install bubblewrap`."
    );
  }
}

// Produces the bwrap argv for a given spec. The resulting argv is intended
// to be invoked as `spawn("bwrap", [...argv, "--", "pnpm", ...pnpmArgv])`.
export function buildBwrapArgv(opts: BuildOpts): string[] {
  const home = opts.home ?? homedir();
  const user = opts.user ?? userInfo().username;
  const projectRoot = resolve(opts.projectRoot);

  const argv: string[] = [];

  // System roots (read-only). /nix and /etc cover NixOS; /usr and /bin
  // cover Debian/Ubuntu-style layouts (and any postinstall script that
  // hardcodes /usr/bin/env or /bin/sh). All are -try because none of them
  // exist universally.
  argv.push("--ro-bind-try", "/nix", "/nix");
  argv.push("--ro-bind-try", "/usr", "/usr");
  argv.push("--ro-bind-try", "/bin", "/bin");
  argv.push("--ro-bind-try", "/sbin", "/sbin");
  argv.push("--ro-bind-try", "/lib", "/lib");
  argv.push("--ro-bind-try", "/lib64", "/lib64");
  argv.push("--ro-bind-try", "/run/current-system", "/run/current-system");
  argv.push("--ro-bind", "/etc", "/etc");

  // Virtual filesystems.
  argv.push("--dev", "/dev");
  argv.push("--proc", "/proc");
  argv.push("--tmpfs", "/tmp");

  // Project root — always RW.
  argv.push("--bind", projectRoot, projectRoot);

  // HOME baseline is a tmpfs; presets overlay RW/RO binds on top.
  argv.push("--tmpfs", home);

  // Preset-specific mounts.
  applyPresetMounts(argv, opts.preset, home);

  // User-supplied extras (validated by caller — see policy.ts). We
  // still re-normalize here as defense-in-depth.
  const extraRw = (opts.extraRw ?? [])
    .map((p) => normalizeHostPath(p, home))
    .filter((p): p is string => p !== null);
  const extraRo = (opts.extraRo ?? [])
    .map((p) => normalizeHostPath(p, home))
    .filter((p): p is string => p !== null);

  for (const p of extraRw) {
    argv.push("--bind-try", p, p);
  }
  for (const p of extraRo) {
    argv.push("--ro-bind-try", p, p);
  }

  // Environment: keep only HOME/USER; the caller passes the full env into
  // spawn(), so PATH etc. propagate normally. bwrap runs the child under
  // the same env; --setenv here just guarantees HOME/USER match the
  // sandbox view even if the parent scrubbed them.
  argv.push("--setenv", "HOME", home);
  argv.push("--setenv", "USER", user);

  // Working directory (inside the sandbox).
  argv.push("--chdir", projectRoot);

  // Namespace isolation.
  argv.push("--unshare-user");
  argv.push("--unshare-ipc");
  argv.push("--unshare-pid");
  argv.push("--unshare-uts");
  argv.push("--unshare-cgroup-try");

  // Lifetime + session.
  argv.push("--die-with-parent");
  argv.push("--new-session");

  // Network: OFF for readonly/strict presets; ON for install/script.
  if (!presetHasNetwork(opts.preset)) {
    argv.push("--unshare-net");
  }

  return argv;
}

function applyPresetMounts(
  argv: string[],
  preset: SandboxPreset,
  home: string
): void {
  switch (preset) {
    case "install":
    case "script": {
      // Writable caches for pnpm/npm.
      const rw = [
        `${home}/.cache`,
        `${home}/.local/share/pnpm`,
        `${home}/.pnpm-store`,
        `${home}/.npm`,
      ];
      const ro = [`${home}/.npmrc`, `${home}/.yarnrc`, `${home}/.gitconfig`];
      for (const p of rw) argv.push("--bind-try", p, p);
      for (const p of ro) argv.push("--ro-bind-try", p, p);
      return;
    }
    case "readonly": {
      // Network is off for this preset; the RO bind is symmetry only.
      argv.push("--ro-bind-try", `${home}/.npmrc`, `${home}/.npmrc`);
      return;
    }
    case "strict": {
      // No cache mounts, no config mounts. $HOME stays a bare tmpfs.
      return;
    }
  }
}

function presetHasNetwork(preset: SandboxPreset): boolean {
  return preset === "install" || preset === "script";
}

// Diagnose a bwrap failure. bwrap surfaces "setting up uid map: Permission
// denied" when unprivileged user namespaces are disabled — worth calling
// out because the fix is a sysctl toggle, not a code change.
export function interpretBwrapError(stderr: string): string | null {
  if (/setting up uid map: Permission denied/i.test(stderr)) {
    return (
      "bwrap failed to set up a user namespace (uid map: Permission denied). " +
      "Unprivileged user namespaces appear to be disabled on this host. " +
      "Enable with: `sudo sysctl -w kernel.unprivileged_userns_clone=1` " +
      "(Debian/Ubuntu) or set `security.unprivilegedUsernsClone = true` " +
      "on NixOS."
    );
  }
  return null;
}

// Convenience wrapper used by response builders.
export function sandboxToJson(d: SandboxDecision): Record<string, unknown> {
  if (d.mode === "off") {
    return { mode: "off", reason: d.reason };
  }
  return {
    mode: "bwrap",
    preset: d.preset,
    network: d.network,
  };
}

// Existence check helper — used by describe_sandbox to annotate which host
// paths will actually be mounted (bwrap's -try flags silently skip
// missing paths, so listing them without this hint can mislead).
export function pathExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return existsSync(p);
  }
}
