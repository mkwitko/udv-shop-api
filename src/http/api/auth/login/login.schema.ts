import { z } from "zod";
export { AuthResponse } from "../register/register.schema.js";

export const LoginBody = z.object({
  email: z.string().email().transform((v) => v.toLowerCase()),
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof LoginBody>;
