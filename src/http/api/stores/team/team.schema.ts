import { z } from "zod";

/** Papéis que o dono concede. `owner` não se convida: nasce com a loja. */
export const InvitableRole = z.enum(["admin", "staff"]);
export type InvitableRole = z.infer<typeof InvitableRole>;

export const InviteBody = z.object({
  email: z
    .string()
    .email()
    .transform((v) => v.trim().toLowerCase()),
  role: InvitableRole,
});
export type InviteBody = z.infer<typeof InviteBody>;

export const UpdateMemberBody = z.object({ role: InvitableRole });
export type UpdateMemberBody = z.infer<typeof UpdateMemberBody>;

export const MemberResponse = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  role: z.enum(["owner", "admin", "staff"]),
});
export type MemberResponse = z.infer<typeof MemberResponse>;

export const InviteResponse = z.object({
  id: z.string(),
  email: z.string(),
  role: InvitableRole,
  expiresAt: z.string(),
  createdAt: z.string(),
});
export type InviteResponse = z.infer<typeof InviteResponse>;

export const TeamResponse = z.object({
  members: z.array(MemberResponse),
  invites: z.array(InviteResponse),
});

/** O que a página pública do convite mostra antes de a pessoa entrar. */
export const InvitePreviewResponse = z.object({
  storeName: z.string(),
  storeSlug: z.string(),
  role: InvitableRole,
  email: z.string(),
  expiresAt: z.string(),
});
