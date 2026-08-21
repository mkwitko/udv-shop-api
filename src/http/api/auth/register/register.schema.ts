import { z } from "zod";

export const RegisterBody = z.object({
  name: z.string().min(2).max(120),
  email: z
    .string()
    .email()
    .transform((v) => v.toLowerCase()),
  password: z.string().min(10).max(200),
});
export type RegisterBody = z.infer<typeof RegisterBody>;

export const PublicUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Nulável: conta leve criada num fluxo sem conta pode não ter e-mail. */
  email: z.string().nullable(),
  emailVerified: z.boolean(),
  platformAdmin: z.boolean(),
});

export const AuthResponse = z.object({
  accessToken: z.string(),
  user: PublicUserSchema,
});
