import type { Dep } from "./manifests.js";

export interface ResolvedUrl {
  url: string;
  // If true, fetcher-mcp should render JS. docs.rs pages are Rust-generated
  // static HTML but rely on JS for search index — the content we care about
  // (item summaries, examples) is present in the initial HTML.
  needs_js: boolean;
}

export function resolveDocsUrl(dep: Dep): ResolvedUrl {
  switch (dep.ecosystem) {
    case "npm":
      // unpkg serves the package README as raw text — plain HTTP is enough
      return {
        url: `https://unpkg.com/${dep.package}@${dep.version}/README.md`,
        needs_js: false,
      };
    case "cargo":
      // Crate root page. Rendered docs.rs content is largely in the initial
      // HTML; heavier per-item pages (traits, structs) live at sub-paths but
      // we deliberately fetch just the crate root for v0.1 to keep unpkg-like
      // per-package cost bounded.
      return {
        url: `https://docs.rs/${dep.package}/${dep.version}/${dep.package.replace(/-/g, "_")}/`,
        needs_js: true,
      };
    case "pypi":
      // The PyPI JSON API returns description (README) + project_urls. We fetch
      // the JSON directly; the sections splitter will fall back to a single
      // "" section if the payload isn't markdown-shaped.
      return {
        url: `https://pypi.org/pypi/${dep.package}/${dep.version}/json`,
        needs_js: false,
      };
    case "go":
      return {
        url: `https://pkg.go.dev/${dep.package}@${dep.version}`,
        needs_js: true,
      };
  }
}
