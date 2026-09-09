export class NotImplementedError extends Error {
  readonly tool: string;
  constructor(tool: string, detail?: string) {
    super(detail ? `NotImplemented: ${tool} — ${detail}` : `NotImplemented: ${tool}`);
    this.name = "NotImplementedError";
    this.tool = tool;
  }
}

export class LayoutAmbiguousError extends Error {
  readonly kind: string;
  readonly symbolName: string;
  constructor(kind: string, symbolName: string, hint?: string) {
    super(
      hint
        ? `file placement ambiguous for ${kind} '${symbolName}' — ${hint}`
        : `file placement ambiguous for ${kind} '${symbolName}' — add a [layout] rule or pass module=`
    );
    this.name = "LayoutAmbiguousError";
    this.kind = kind;
    this.symbolName = symbolName;
  }
}

export class RefusalError extends Error {
  readonly reason: string;
  readonly hint?: string;
  constructor(reason: string, hint?: string) {
    super(hint ? `${reason} — ${hint}` : reason);
    this.name = "RefusalError";
    this.reason = reason;
    this.hint = hint;
  }
}
