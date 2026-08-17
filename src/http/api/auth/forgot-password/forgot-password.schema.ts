import { z } from "zod";

export const ForgotPasswordBody = z.object({
  email: z
    .string()
    .email()
    .transform((v) => v.toLowerCase()),
});
export type ForgotPasswordBody = z.infer<typeof ForgotPasswordBody>;
