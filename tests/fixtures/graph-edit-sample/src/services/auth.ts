import { EventBus } from "../events/event-bus.js";
import { UserService } from "./user.js";

/**
 * @public
 * Handles login / logout using UserService to resolve user records.
 */
export class AuthService {
  private users: UserService;
  private eventBus: EventBus;

  constructor(users: UserService, eventBus: EventBus) {
    this.users = users;
    this.eventBus = eventBus;
  }

  async login(id: string): Promise<boolean> {
    const record = await this.users.load(id);
    if (!record) return false;
    this.eventBus.emit("auth.login", { id });
    return true;
  }

  async logout(id: string): Promise<void> {
    this.eventBus.emit("auth.logout", { id });
  }
}
