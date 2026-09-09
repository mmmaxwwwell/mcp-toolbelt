import { EventBus } from "../events/event-bus.js";

export interface UserRecord {
  id: string;
  name: string;
  active: boolean;
}

/**
 * @public
 * Manages user lifecycle (load, save, activation state).
 */
export class UserService {
  public id: string = "";
  public active: boolean = true;
  private eventBus: EventBus;
  private cache: Map<string, UserRecord> = new Map();

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  async load(id: string): Promise<UserRecord | undefined> {
    this.id = id;
    return this.cache.get(id);
  }

  async save(record: UserRecord): Promise<void> {
    this.cache.set(record.id, record);
    this.eventBus.emit("user.saved", { id: record.id });
  }
}
