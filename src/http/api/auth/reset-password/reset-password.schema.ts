import { z } from "zod";

export const ResetPasswordBody = z.object({
  token: z.string().min(10),
  password: z.string().min(10).max(200),
});
export type ResetPasswordBody = z.infer<typeof ResetPasswordBody>;
