import { z } from "zod";

export const UserSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  email: z.string().email().optional(),
});

export type User = z.infer<typeof UserSchema>;

export function parseUser(input: unknown): User {
  return UserSchema.parse(input);
}

export function greet(user: User): string {
  return `Hello, ${user.name}!`;
}

export function sum(a: number, b: number): number {
  return a + b;
}
