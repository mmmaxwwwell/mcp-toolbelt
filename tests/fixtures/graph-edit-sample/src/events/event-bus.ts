export class EventBus {
  private handlers: Map<string, Array<(payload: unknown) => void>> = new Map();

  emit(event: string, payload: unknown): void {
    const list = this.handlers.get(event) ?? [];
    for (const h of list) h(payload);
  }

  on(event: string, handler: (payload: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }
}
