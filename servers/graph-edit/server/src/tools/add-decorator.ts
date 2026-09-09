import { TsMorphBackend } from "../backends/ts-morph.js";
import * as imports from "../backends/ts-morph-imports.js";
import { RefusalError } from "../errors.js";
import type { Session } from "../session.js";
import type {
  MutationResponse,
  PendingMutation,
  SymbolId,
  Warning,
} from "../types.js";

export interface AddDecoratorArgs {
  id: SymbolId;
  decorator_source: string;
}

export async function handleAddDecorator(
  session: Session,
  args: AddDecoratorArgs
): Promise<MutationResponse<PendingMutation | null>> {
  await session.ensureLoaded();
  const backend = session.backend;
  if (!(backend instanceof TsMorphBackend)) {
    throw new Error("add_decorator: only ts-morph backend supported in v1");
  }
  try {
    const mut = await imports.addDecorator(
      backend.read.getProject(),
      backend.read.getRoot(),
      args.id,
      args.decorator_source
    );
    return imports.toMutationResponse(mut);
  } catch (err) {
    if (err instanceof RefusalError) {
      const warnings: Warning[] = [
        { kind: err.reason, message: err.message, symbol_id: args.id },
      ];
      return { data: null, warnings };
    }
    throw err;
  }
}
