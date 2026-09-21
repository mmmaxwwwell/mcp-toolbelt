#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import { findProjectRoot, configPath } from "./discover.js";
import {
  loadPolicy,
  checkAdd,
  checkRun,
  effectiveSandbox,
  KNOWN_VERBS,
  type Policy,
  type Verb,
} from "./policy.js";
import {
  runPnpm,
  guardPackageSpec,
  guardArgs,
  type RunSandboxInput,
} from "./pnpm.js";
import { snapshotDeps, computeDelta } from "./delta.js";
import {
  assertBwrapAvailable,
  buildBwrapArgv,
  pathExists,
  sandboxToJson,
  type SandboxDecision,
} from "./sandbox.js";

interface ToolContent {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function ok(data: unknown): ToolContent {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function err(message: string): ToolContent {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

interface Ctx {
  root: string;
  policy: Policy;
}

function resolveCtx(): Ctx | { error: string } {
  const info = findProjectRoot(process.cwd());
  if (!info) {
    return {
      error:
        "No pnpm project found. Walked up from cwd without finding pnpm-lock.yaml or package.json with packageManager: pnpm@...",
    };
  }
  const policy = loadPolicy(configPath(info.root));
  return { root: info.root, policy };
}

// Builds the sandbox input for a given verb (and optional script name).
function makeSandbox(
  ctx: Ctx,
  verb: Verb,
  scriptName?: string
): RunSandboxInput {
  const eff = effectiveSandbox(ctx.policy, verb, scriptName);
  if (eff.disabled) {
    return {
      disabled: true,
      reason: eff.reason ?? "disabled by policy",
      projectRoot: ctx.root,
    };
  }
  return {
    disabled: false,
    preset: eff.preset!,
    projectRoot: ctx.root,
    extraRw: ctx.policy.sandbox.extra_rw,
    extraRo: ctx.policy.sandbox.extra_ro,
  };
}

// Sandbox spec for the internal pre/post-list snapshots that back the
// mutating verbs. Always uses the `install` preset (mounts the pnpm store
// so the snapshot sees the same view as the main invocation).
function snapshotSandbox(ctx: Ctx): RunSandboxInput {
  const eff = effectiveSandbox(ctx.policy, "list");
  if (eff.disabled) {
    // Snapshot verb (`list`) itself opted out — mirror that.
    return {
      disabled: true,
      reason: eff.reason ?? "disabled by policy",
      projectRoot: ctx.root,
    };
  }
  // Use `install` preset for the snapshot even though `list` is normally
  // `readonly` — the install-preset mounts of ~/.local/share/pnpm etc.
  // ensure the pre/post view matches whatever the mutating verb touched.
  return {
    disabled: false,
    preset: "install",
    projectRoot: ctx.root,
    extraRw: ctx.policy.sandbox.extra_rw,
    extraRo: ctx.policy.sandbox.extra_ro,
  };
}

function readScripts(root: string): Record<string, string> {
  const p = join(root, "package.json");
  if (!existsSync(p)) return {};
  try {
    const pkg = JSON.parse(readFileSync(p, "utf8"));
    if (pkg.scripts && typeof pkg.scripts === "object") {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(pkg.scripts)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // ignore
  }
  return {};
}

function assemblePackageArg(pkg: string, version?: string): string {
  if (!version) return pkg;
  return `${pkg}@${version}`;
}

// ---- Tool handlers ----

async function toolAdd(args: Record<string, unknown>): Promise<ToolContent> {
  const ctx = resolveCtx();
  if ("error" in ctx) return err(ctx.error);

  const pkg = args.package;
  if (typeof pkg !== "string" || !pkg) return err("package (string) required");
  const dev = args.dev === true;
  const version = typeof args.version === "string" ? args.version : undefined;

  const specGuard = guardPackageSpec(pkg);
  if (specGuard) return err(specGuard.error);
  if (version) {
    const vGuard = guardPackageSpec(version);
    if (vGuard) return err(vGuard.error);
  }

  const decision = checkAdd(ctx.policy, pkg, dev);
  if (!decision.allowed) return err(decision.reason ?? "Refused by policy");

  const sandbox = makeSandbox(ctx, "add");
  const snapSandbox = snapshotSandbox(ctx);

  const before = await snapshotDeps(snapSandbox);
  const pnpmArgs = ["add"];
  if (dev) pnpmArgs.push("--save-dev");
  pnpmArgs.push(assemblePackageArg(pkg, version));

  const argGuard = guardArgs(pnpmArgs);
  if (argGuard) return err(argGuard.error);

  const r = await runPnpm(pnpmArgs, sandbox);
  const after = await snapshotDeps(snapSandbox);
  const delta = computeDelta(before, after);

  return ok({
    exit_code: r.code,
    delta,
    sandbox: sandboxToJson(r.sandbox),
    stdout: r.stdout,
    stderr: r.stderr,
    timed_out: r.timedOut,
    truncated: r.truncated,
  });
}

async function toolRemove(args: Record<string, unknown>): Promise<ToolContent> {
  const ctx = resolveCtx();
  if ("error" in ctx) return err(ctx.error);

  const pkg = args.package;
  if (typeof pkg !== "string" || !pkg) return err("package (string) required");

  const specGuard = guardPackageSpec(pkg);
  if (specGuard) return err(specGuard.error);

  const sandbox = makeSandbox(ctx, "remove");
  const snapSandbox = snapshotSandbox(ctx);

  const before = await snapshotDeps(snapSandbox);
  const r = await runPnpm(["remove", pkg], sandbox);
  const after = await snapshotDeps(snapSandbox);
  const delta = computeDelta(before, after);

  return ok({
    exit_code: r.code,
    delta,
    sandbox: sandboxToJson(r.sandbox),
    stdout: r.stdout,
    stderr: r.stderr,
    timed_out: r.timedOut,
    truncated: r.truncated,
  });
}

async function toolUpdate(args: Record<string, unknown>): Promise<ToolContent> {
  const ctx = resolveCtx();
  if ("error" in ctx) return err(ctx.error);

  const pkg = typeof args.package === "string" ? args.package : undefined;
  if (pkg) {
    const g = guardPackageSpec(pkg);
    if (g) return err(g.error);
  }

  const pnpmArgs = ["update"];
  if (ctx.policy.update.default === "latest") pnpmArgs.push("--latest");
  if (pkg) pnpmArgs.push(pkg);

  const sandbox = makeSandbox(ctx, "update");
  const snapSandbox = snapshotSandbox(ctx);

  const before = await snapshotDeps(snapSandbox);
  const r = await runPnpm(pnpmArgs, sandbox);
  const after = await snapshotDeps(snapSandbox);
  const delta = computeDelta(before, after);

  return ok({
    exit_code: r.code,
    policy_default: ctx.policy.update.default,
    delta,
    sandbox: sandboxToJson(r.sandbox),
    stdout: r.stdout,
    stderr: r.stderr,
    timed_out: r.timedOut,
    truncated: r.truncated,
  });
}

async function toolList(args: Record<string, unknown>): Promise<ToolContent> {
  const ctx = resolveCtx();
  if ("error" in ctx) return err(ctx.error);

  const pnpmArgs = ["list", "--depth=0", "--json"];
  const filter = typeof args.filter === "string" ? args.filter : undefined;
  if (filter) {
    pnpmArgs.push("--filter", filter);
  }
  const sandbox = makeSandbox(ctx, "list");
  const r = await runPnpm(pnpmArgs, sandbox, { timeoutMs: 60_000 });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    // fall through
  }
  return ok({
    exit_code: r.code,
    result: parsed,
    sandbox: sandboxToJson(r.sandbox),
    stderr: r.stderr,
  });
}

async function toolWhy(args: Record<string, unknown>): Promise<ToolContent> {
  const ctx = resolveCtx();
  if ("error" in ctx) return err(ctx.error);

  const pkg = args.package;
  if (typeof pkg !== "string" || !pkg) return err("package (string) required");
  const g = guardPackageSpec(pkg);
  if (g) return err(g.error);

  const sandbox = makeSandbox(ctx, "why");
  const r = await runPnpm(["why", pkg, "--json"], sandbox, {
    timeoutMs: 60_000,
  });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    // pnpm why may emit non-JSON in some paths; fall back to raw
  }
  return ok({
    exit_code: r.code,
    result: parsed ?? r.stdout,
    sandbox: sandboxToJson(r.sandbox),
    stderr: r.stderr,
  });
}

async function toolOutdated(): Promise<ToolContent> {
  const ctx = resolveCtx();
  if ("error" in ctx) return err(ctx.error);
  const sandbox = makeSandbox(ctx, "outdated");
  const r = await runPnpm(["outdated", "--format", "json"], sandbox, {
    timeoutMs: 120_000,
  });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    // pnpm outdated exits nonzero when outdated deps exist; empty stdout is normal for "all up to date"
  }
  return ok({
    exit_code: r.code,
    result: parsed ?? {},
    sandbox: sandboxToJson(r.sandbox),
    stderr: r.stderr,
  });
}

async function toolRun(
  args: Record<string, unknown>,
  verb: Verb = "run"
): Promise<ToolContent> {
  const ctx = resolveCtx();
  if ("error" in ctx) return err(ctx.error);

  const script = args.script;
  if (typeof script !== "string" || !script)
    return err("script (string) required");
  const extraArgs = Array.isArray(args.args)
    ? args.args.filter((x): x is string => typeof x === "string")
    : [];

  const scripts = readScripts(ctx.root);
  const decision = checkRun(ctx.policy, script, Object.keys(scripts));
  if (!decision.allowed) return err(decision.reason ?? "Refused by policy");

  const pnpmArgs = ["run", script, ...extraArgs];
  const argGuard = guardArgs(pnpmArgs);
  if (argGuard) return err(argGuard.error);

  // For the `run` verb, the effective script name selects the preset;
  // for `test`/`lint`/`typecheck`/`audit`, the verb itself is the key.
  const sandbox = makeSandbox(ctx, verb, verb === "run" ? script : undefined);
  const r = await runPnpm(pnpmArgs, sandbox);
  return ok({
    exit_code: r.code,
    sandbox: sandboxToJson(r.sandbox),
    stdout: r.stdout,
    stderr: r.stderr,
    timed_out: r.timedOut,
    truncated: r.truncated,
  });
}

function toolListScripts(): ToolContent {
  const ctx = resolveCtx();
  if ("error" in ctx) return err(ctx.error);
  const scripts = readScripts(ctx.root);
  const list = Object.entries(scripts).map(([name, command]) => ({
    name,
    command,
  }));
  return ok(list);
}

async function toolTest(args: Record<string, unknown>): Promise<ToolContent> {
  if (args.watch === true) {
    return err(
      "watch mode is not supported (MCP cannot stream). Run the script in a terminal instead."
    );
  }
  const scripts: string[] = [];
  if (typeof args.filter === "string" && args.filter) scripts.push(args.filter);
  return await toolRun({ script: "test", args: scripts }, "test");
}

async function toolLint(args: Record<string, unknown>): Promise<ToolContent> {
  const extras: string[] = [];
  if (args.fix === true) extras.push("--fix");
  return await toolRun({ script: "lint", args: extras }, "lint");
}

async function toolTypecheck(): Promise<ToolContent> {
  const ctx = resolveCtx();
  if ("error" in ctx) return err(ctx.error);
  const scripts = readScripts(ctx.root);
  if (!("typecheck" in scripts)) {
    return err(
      'No "typecheck" script defined in package.json. Add one (e.g. "typecheck": "tsc --noEmit") and retry.'
    );
  }
  return await toolRun({ script: "typecheck", args: [] }, "typecheck");
}

async function toolInstall(): Promise<ToolContent> {
  const ctx = resolveCtx();
  if ("error" in ctx) return err(ctx.error);
  const sandbox = makeSandbox(ctx, "install");
  const snapSandbox = snapshotSandbox(ctx);
  const before = await snapshotDeps(snapSandbox);
  const r = await runPnpm(["install"], sandbox);
  const after = await snapshotDeps(snapSandbox);
  return ok({
    exit_code: r.code,
    delta: computeDelta(before, after),
    sandbox: sandboxToJson(r.sandbox),
    stdout: r.stdout,
    stderr: r.stderr,
    timed_out: r.timedOut,
    truncated: r.truncated,
  });
}

async function toolInstallFrozen(): Promise<ToolContent> {
  const ctx = resolveCtx();
  if ("error" in ctx) return err(ctx.error);
  const sandbox = makeSandbox(ctx, "install_frozen");
  const snapSandbox = snapshotSandbox(ctx);
  const before = await snapshotDeps(snapSandbox);
  const r = await runPnpm(["install", "--frozen-lockfile"], sandbox);
  const after = await snapshotDeps(snapSandbox);
  return ok({
    exit_code: r.code,
    delta: computeDelta(before, after),
    sandbox: sandboxToJson(r.sandbox),
    stdout: r.stdout,
    stderr: r.stderr,
    timed_out: r.timedOut,
    truncated: r.truncated,
  });
}

async function toolPrune(): Promise<ToolContent> {
  const ctx = resolveCtx();
  if ("error" in ctx) return err(ctx.error);
  const sandbox = makeSandbox(ctx, "prune");
  const snapSandbox = snapshotSandbox(ctx);
  const before = await snapshotDeps(snapSandbox);
  const r = await runPnpm(["prune"], sandbox);
  const after = await snapshotDeps(snapSandbox);
  return ok({
    exit_code: r.code,
    delta: computeDelta(before, after),
    sandbox: sandboxToJson(r.sandbox),
    stdout: r.stdout,
    stderr: r.stderr,
    timed_out: r.timedOut,
    truncated: r.truncated,
  });
}

async function toolAudit(): Promise<ToolContent> {
  const ctx = resolveCtx();
  if ("error" in ctx) return err(ctx.error);
  const sandbox = makeSandbox(ctx, "audit");
  const r = await runPnpm(["audit", "--json"], sandbox, {
    timeoutMs: 180_000,
  });
  let parsed: any = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    // ignore
  }
  const vulnerabilities = parsed?.advisories
    ? Object.values(parsed.advisories)
    : parsed?.vulnerabilities ?? [];
  const summary = parsed?.metadata?.vulnerabilities ?? parsed?.summary ?? {};
  return ok({
    exit_code: r.code,
    vulnerabilities,
    summary,
    sandbox: sandboxToJson(r.sandbox),
    stderr: r.stderr,
  });
}

async function toolLicenses(): Promise<ToolContent> {
  const ctx = resolveCtx();
  if ("error" in ctx) return err(ctx.error);
  const sandbox = makeSandbox(ctx, "licenses");
  const r = await runPnpm(["licenses", "list", "--json"], sandbox, {
    timeoutMs: 120_000,
  });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    // ignore
  }
  return ok({
    exit_code: r.code,
    result: parsed ?? {},
    sandbox: sandboxToJson(r.sandbox),
    stderr: r.stderr,
  });
}

function toolDescribeSandbox(
  args: Record<string, unknown>
): ToolContent {
  const ctx = resolveCtx();
  if ("error" in ctx) return err(ctx.error);

  const verbRaw = args.verb;
  if (typeof verbRaw !== "string" || !verbRaw)
    return err("verb (string) required");
  if (!(KNOWN_VERBS as readonly string[]).includes(verbRaw)) {
    return err(
      `Unknown verb "${verbRaw}". Known verbs: ${KNOWN_VERBS.join(", ")}`
    );
  }
  const verb = verbRaw as Verb;
  const scriptName =
    typeof args.script === "string" && args.script ? args.script : undefined;

  const eff = effectiveSandbox(ctx.policy, verb, scriptName);
  if (eff.disabled) {
    return ok({
      verb,
      sandbox: { mode: "off", reason: eff.reason },
    });
  }

  const preset = eff.preset!;
  const bwrapArgv = buildBwrapArgv({
    preset,
    projectRoot: ctx.root,
    extraRw: ctx.policy.sandbox.extra_rw,
    extraRo: ctx.policy.sandbox.extra_ro,
  });

  // Annotate which host paths in the bwrap argv actually exist right now
  // (bwrap --*-bind-try silently skips missing paths).
  const home = homedir();
  const mounts = summarizeMounts(bwrapArgv, home);

  return ok({
    verb,
    script: scriptName,
    sandbox: {
      mode: "bwrap",
      preset,
      network: preset === "install" || preset === "script",
    },
    bwrap_command: "bwrap",
    bwrap_argv: bwrapArgv,
    invocation_example: [
      "bwrap",
      ...bwrapArgv,
      "--",
      "pnpm",
      "<verb-argv...>",
    ],
    mounts,
    home,
    user: userInfo().username,
  });
}

interface MountSummary {
  kind: "bind" | "ro-bind" | "bind-try" | "ro-bind-try" | "tmpfs" | "dev" | "proc";
  src?: string;
  dst: string;
  exists?: boolean;
}

function summarizeMounts(argv: string[], _home: string): MountSummary[] {
  const out: MountSummary[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--bind":
      case "--ro-bind":
      case "--bind-try":
      case "--ro-bind-try": {
        const src = argv[i + 1];
        const dst = argv[i + 2];
        const kind = a.replace(/^--/, "") as MountSummary["kind"];
        out.push({ kind, src, dst, exists: pathExists(src) });
        i += 2;
        break;
      }
      case "--tmpfs":
        out.push({ kind: "tmpfs", dst: argv[i + 1] });
        i += 1;
        break;
      case "--dev":
        out.push({ kind: "dev", dst: argv[i + 1] });
        i += 1;
        break;
      case "--proc":
        out.push({ kind: "proc", dst: argv[i + 1] });
        i += 1;
        break;
    }
  }
  return out;
}

// ---- Tool schema ----

const TOOLS = [
  {
    name: "add",
    description:
      "Add a dependency via pnpm add. Refuses --global, dlx, non-registry specifiers. Policy-gated by allow/deny/require_dev. Runs inside a bwrap sandbox (install preset).",
    inputSchema: {
      type: "object" as const,
      properties: {
        package: { type: "string", description: "Package name (e.g. lodash or @scope/name)" },
        dev: { type: "boolean", description: "Install as devDependency" },
        version: { type: "string", description: "Version spec (e.g. ^1.2.3)" },
      },
      required: ["package"],
    },
  },
  {
    name: "remove",
    description: "Remove a dependency via pnpm remove. Sandboxed (install preset).",
    inputSchema: {
      type: "object" as const,
      properties: { package: { type: "string" } },
      required: ["package"],
    },
  },
  {
    name: "update",
    description:
      "Update deps via pnpm update. Honors [update].default policy (patch|minor|latest). Sandboxed (install preset).",
    inputSchema: {
      type: "object" as const,
      properties: {
        package: {
          type: "string",
          description: "Optional single package to update; omit to update all",
        },
      },
    },
  },
  {
    name: "list",
    description: "List direct dependencies (pnpm list --depth=0 --json). Sandboxed (readonly preset).",
    inputSchema: {
      type: "object" as const,
      properties: {
        filter: { type: "string", description: "Optional --filter <name>" },
      },
    },
  },
  {
    name: "why",
    description: "Show why a package is installed (pnpm why <pkg>). Sandboxed (readonly preset).",
    inputSchema: {
      type: "object" as const,
      properties: { package: { type: "string" } },
      required: ["package"],
    },
  },
  {
    name: "outdated",
    description: "Report outdated deps (pnpm outdated --format json). Sandboxed (readonly preset).",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "run",
    description:
      "Run a package.json script. Script must exist and satisfy [run] allow/deny policy. Sandboxed (script preset — default install; per-script override via [sandbox.scripts]).",
    inputSchema: {
      type: "object" as const,
      properties: {
        script: { type: "string" },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["script"],
    },
  },
  {
    name: "list_scripts",
    description: "List package.json scripts as [{name, command}]. No pnpm invocation.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "test",
    description:
      "Shortcut for run(\"test\"). Refuses watch mode (MCP cannot stream). Sandboxed (script preset).",
    inputSchema: {
      type: "object" as const,
      properties: {
        filter: { type: "string", description: "Extra arg forwarded to the test script" },
        watch: { type: "boolean" },
      },
    },
  },
  {
    name: "lint",
    description: "Shortcut for run(\"lint\"); with fix=true appends --fix. Sandboxed (script preset).",
    inputSchema: {
      type: "object" as const,
      properties: { fix: { type: "boolean" } },
    },
  },
  {
    name: "typecheck",
    description:
      "Shortcut for run(\"typecheck\"). Refuses if no typecheck script is defined. Sandboxed (script preset).",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "install",
    description: "pnpm install (lockfile sync). Sandboxed (install preset).",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "install_frozen",
    description: "pnpm install --frozen-lockfile (CI parity). Sandboxed (install preset).",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "prune",
    description: "pnpm prune (remove extraneous packages). Sandboxed (install preset).",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "audit",
    description: "Structured vulnerability report (pnpm audit --json). Sandboxed (script preset — needs registry access).",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "licenses",
    description: "License summary (pnpm licenses list --json). Sandboxed (readonly preset).",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "describe_sandbox",
    description:
      "Return the effective bwrap argv for a given verb (and optional script name for the `run` verb). Read-only; performs no pnpm invocation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        verb: {
          type: "string",
          description:
            "One of: add, remove, update, install, install_frozen, prune, list, why, outdated, list_scripts, run, test, lint, typecheck, audit, licenses",
        },
        script: {
          type: "string",
          description:
            "Optional: only meaningful for verb=\"run\". Names a script.json entry so per-script overrides are honored.",
        },
      },
      required: ["verb"],
    },
  },
];

async function main() {
  // Fail fast if bwrap is missing — every pnpm invocation depends on it.
  assertBwrapAvailable();

  const server = new Server(
    { name: "pnpm-wrapper", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<any> => {
    const { name, arguments: rawArgs } = request.params;
    const args = rawArgs ?? {};
    try {
      switch (name) {
        case "add":
          return await toolAdd(args);
        case "remove":
          return await toolRemove(args);
        case "update":
          return await toolUpdate(args);
        case "list":
          return await toolList(args);
        case "why":
          return await toolWhy(args);
        case "outdated":
          return await toolOutdated();
        case "run":
          return await toolRun(args, "run");
        case "list_scripts":
          return toolListScripts();
        case "test":
          return await toolTest(args);
        case "lint":
          return await toolLint(args);
        case "typecheck":
          return await toolTypecheck();
        case "install":
          return await toolInstall();
        case "install_frozen":
          return await toolInstallFrozen();
        case "prune":
          return await toolPrune();
        case "audit":
          return await toolAudit();
        case "licenses":
          return await toolLicenses();
        case "describe_sandbox":
          return toolDescribeSandbox(args);
        default:
          return err(`Unknown tool: ${name}`);
      }
    } catch (e) {
      return err(`Tool "${name}" failed: ${(e as Error).message}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("pnpm-wrapper fatal:", err);
  process.exit(1);
});
