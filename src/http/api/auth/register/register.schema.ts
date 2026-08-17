import { z } from "zod";

export const RegisterBody = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().transform((v) => v.toLowerCase()),
  password: z.string().min(10).max(200),
});
export type RegisterBody = z.infer<typeof RegisterBody>;

export const PublicUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
});

export const AuthResponse = z.object({
  accessToken: z.string(),
  user: PublicUserSchema,
});
