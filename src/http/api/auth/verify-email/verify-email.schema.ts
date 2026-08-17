import { z } from "zod";

export const VerifyEmailBody = z.object({ token: z.string().min(10) });
export type VerifyEmailBody = z.infer<typeof VerifyEmailBody>;
