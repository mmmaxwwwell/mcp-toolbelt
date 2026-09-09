import { TsMorphBackend } from "./backends/ts-morph.js";
import type { Backend } from "./types.js";

export type { Backend } from "./types.js";

export function backendForExtension(ext: string): Backend | null {
  const lower = ext.toLowerCase();
  const ts = new TsMorphBackend();
  if (ts.extensions.includes(lower)) return ts;
  return null;
}

export function defaultBackend(): Backend {
  return new TsMorphBackend();
}
