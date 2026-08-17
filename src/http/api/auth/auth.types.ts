import type { User } from "@prisma/client";

export type PublicUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
};

export type AuthResult = {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
};

export function toPublicUser(user: User): PublicUser {
  return { id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified };
}
