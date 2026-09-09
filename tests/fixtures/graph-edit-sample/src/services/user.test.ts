import { UserService } from "./user.js";
import { EventBus } from "../events/event-bus.js";

export async function testUserServiceLoad(): Promise<boolean> {
  const bus = new EventBus();
  const svc = new UserService(bus);
  const result = await svc.load("u-1");
  return result === undefined;
}
