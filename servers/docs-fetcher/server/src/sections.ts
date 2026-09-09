export interface Section {
  section_path: string;
  title: string;
  content: string;
}

// Split markdown by top-level (#/##) headings. Each section becomes one row so
// BM25 relevance stays meaningful — one giant README would drown short queries.
// section_path is "Title" for H1 and "Parent/Child" for H2 under an H1.
export function splitSections(markdown: string): Section[] {
  const lines = markdown.split(/\r?\n/);
  const sections: Section[] = [];
  const preamble: string[] = [];
  let current: { title: string; path: string; buf: string[] } | null = null;
  let topTitle = "";

  const flush = () => {
    if (current) {
      const content = current.buf.join("\n").trim();
      if (content || current.title) {
        sections.push({
          section_path: current.path,
          title: current.title,
          content,
        });
      }
    }
  };

  for (const line of lines) {
    const m = /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      const level = m[1].length;
      const title = m[2].trim();
      flush();
      if (level === 1) {
        topTitle = title;
        current = { title, path: title, buf: [] };
      } else {
        current = {
          title,
          path: topTitle ? `${topTitle}/${title}` : title,
          buf: [],
        };
      }
    } else if (current) {
      current.buf.push(line);
    } else {
      preamble.push(line);
    }
  }
  flush();

  if (sections.length === 0) {
    const content = markdown.trim();
    if (content) sections.push({ section_path: "", title: "", content });
  } else if (preamble.some((l) => l.trim())) {
    sections.unshift({
      section_path: "",
      title: "",
      content: preamble.join("\n").trim(),
    });
  }

  return sections;
}
