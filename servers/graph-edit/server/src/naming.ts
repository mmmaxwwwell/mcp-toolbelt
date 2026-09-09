import type { PolicyConfig, SymbolKind } from "./types.js";

export type NamingConvention =
  | "camelCase"
  | "PascalCase"
  | "SCREAMING_SNAKE_CASE"
  | "kebab-case"
  | "snake_case";

const KNOWN_CONVENTIONS: readonly NamingConvention[] = [
  "camelCase",
  "PascalCase",
  "SCREAMING_SNAKE_CASE",
  "kebab-case",
  "snake_case",
];

export function isKnownConvention(v: string): v is NamingConvention {
  return (KNOWN_CONVENTIONS as readonly string[]).includes(v);
}

// SymbolKind → policy.naming key. Only kinds with a natural naming policy map here.
const KIND_TO_POLICY_KEY: Partial<Record<SymbolKind, string>> = {
  function: "functions",
  class: "classes",
  interface: "types",
  type: "types",
  enum: "enums",
  variable: "constants",
  method: "functions",
  property: "functions",
  namespace: "types",
};

function conventionFor(kind: SymbolKind, policy: PolicyConfig): NamingConvention | null {
  const key = KIND_TO_POLICY_KEY[kind];
  if (!key) return null;
  const v = policy.naming[key];
  if (typeof v === "string" && isKnownConvention(v)) return v;
  return null;
}

const RX: Record<NamingConvention, RegExp> = {
  camelCase: /^[a-z][a-zA-Z0-9]*$/,
  PascalCase: /^[A-Z][a-zA-Z0-9]*$/,
  SCREAMING_SNAKE_CASE: /^[A-Z][A-Z0-9_]*$/,
  "kebab-case": /^[a-z][a-z0-9-]*$/,
  snake_case: /^[a-z][a-z0-9_]*$/,
};

const EXAMPLE: Record<NamingConvention, string> = {
  camelCase: "fooBar",
  PascalCase: "FooBar",
  SCREAMING_SNAKE_CASE: "FOO_BAR",
  "kebab-case": "foo-bar",
  snake_case: "foo_bar",
};

export function validateSymbolName(
  name: string,
  kind: SymbolKind,
  policy: PolicyConfig
): { valid: boolean; hint?: string } {
  const conv = conventionFor(kind, policy);
  if (!conv) return { valid: true };
  if (RX[conv].test(name)) return { valid: true };
  return { valid: false, hint: `expected ${conv} like ${EXAMPLE[conv]}` };
}

// Break an identifier into lowercase word tokens for reformatting.
// Handles: kebab-case, snake_case, PascalCase, camelCase, SCREAMING_SNAKE_CASE,
// and mixed forms. Digits attach to the preceding token.
function tokenize(name: string): string[] {
  if (!name) return [];
  // First split on explicit separators, then split camel/Pascal boundaries.
  const parts = name.split(/[-_\s]+/).filter(Boolean);
  const words: string[] = [];
  for (const p of parts) {
    // Insert boundaries: lower→Upper (fooBar), Upper→UpperLower (URLSection → URL Section),
    // letter→digit and digit→letter.
    const withBoundaries = p
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
    for (const w of withBoundaries.split(/\s+/)) {
      if (w) words.push(w.toLowerCase());
    }
  }
  return words;
}

function toCamel(words: string[]): string {
  if (words.length === 0) return "";
  return (
    words[0] +
    words
      .slice(1)
      .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : ""))
      .join("")
  );
}

function toPascal(words: string[]): string {
  return words
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : ""))
    .join("");
}

export function normalizeName(name: string, convention: string): string {
  const words = tokenize(name);
  if (words.length === 0) return name;
  switch (convention) {
    case "camelCase":
      return toCamel(words);
    case "PascalCase":
      return toPascal(words);
    case "SCREAMING_SNAKE_CASE":
      return words.map((w) => w.toUpperCase()).join("_");
    case "kebab-case":
      return words.join("-");
    case "snake_case":
      return words.join("_");
    default:
      // Unknown convention: leave the name unchanged rather than mangle silently.
      return name;
  }
}
