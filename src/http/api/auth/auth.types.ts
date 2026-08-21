import type { User } from "@prisma/client";

export type PublicUser = {
  id: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  platformAdmin: boolean;
};

export type AuthResult = {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
};

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    name: user.name,
    // Nulável: conta leve criada por um fluxo sem conta pode não ter e-mail.
    email: user.email,
    emailVerified: user.emailVerified,
    platformAdmin: user.platformAdmin,
  };
}
