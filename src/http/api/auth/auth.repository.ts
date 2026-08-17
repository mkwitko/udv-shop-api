import type { PrismaClient, RefreshToken, User } from "@prisma/client";

export interface AuthRepository {
  findUserByEmail(email: string): Promise<User | null>;
  findUserById(id: string): Promise<User | null>;
  findUserByGoogleId(googleId: string): Promise<User | null>;
  createUser(data: {
    email: string;
    name: string;
    passwordHash?: string;
    googleId?: string;
    emailVerified?: boolean;
  }): Promise<User>;
  linkGoogleId(userId: string, googleId: string): Promise<void>;
  setPassword(userId: string, passwordHash: string): Promise<void>;
  markEmailVerified(userId: string): Promise<void>;
  userRoles(userId: string): Promise<Record<string, string>>;

  insertRefreshToken(data: {
    userId: string;
    familyId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<RefreshToken>;
  findRefreshTokenByHash(tokenHash: string): Promise<RefreshToken | null>;
  markReplaced(id: string, replacedById: string): Promise<void>;
  revokeFamily(familyId: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<void>;

  insertEmailToken(data: {
    userId: string;
    type: "verify_email" | "password_reset";
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void>;
  findEmailTokenByHash(tokenHash: string): Promise<{
    id: string;
    userId: string;
    type: "verify_email" | "password_reset";
    expiresAt: Date;
    usedAt: Date | null;
  } | null>;
  markEmailTokenUsed(id: string): Promise<void>;
}

export function createAuthRepository(db: PrismaClient): AuthRepository {
  return {
    findUserByEmail: (email) => db.user.findUnique({ where: { email } }),
    findUserById: (id) => db.user.findUnique({ where: { id } }),
    findUserByGoogleId: (googleId) => db.user.findUnique({ where: { googleId } }),
    createUser: (data) =>
      db.user.create({
        data: {
          email: data.email,
          name: data.name,
          passwordHash: data.passwordHash ?? null,
          googleId: data.googleId ?? null,
          emailVerified: data.emailVerified ?? false,
        },
      }),
    linkGoogleId: async (userId, googleId) => {
      await db.user.update({ where: { id: userId }, data: { googleId } });
    },
    setPassword: async (userId, passwordHash) => {
      await db.user.update({ where: { id: userId }, data: { passwordHash } });
    },
    markEmailVerified: async (userId) => {
      await db.user.update({ where: { id: userId }, data: { emailVerified: true } });
    },
    userRoles: async (userId) => {
      const rows = await db.userStoreRole.findMany({
        where: { userId },
        select: { storeId: true, role: true },
      });
      return Object.fromEntries(rows.map((r) => [r.storeId, r.role]));
    },

    insertRefreshToken: (data) => db.refreshToken.create({ data }),
    findRefreshTokenByHash: (tokenHash) => db.refreshToken.findUnique({ where: { tokenHash } }),
    markReplaced: async (id, replacedById) => {
      await db.refreshToken.update({ where: { id }, data: { replacedById } });
    },
    revokeFamily: async (familyId) => {
      await db.refreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    },
    revokeAllForUser: async (userId) => {
      await db.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    },

    insertEmailToken: async (data) => {
      await db.emailToken.create({ data });
    },
    findEmailTokenByHash: (tokenHash) =>
      db.emailToken.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true, type: true, expiresAt: true, usedAt: true },
      }),
    markEmailTokenUsed: async (id) => {
      await db.emailToken.update({ where: { id }, data: { usedAt: new Date() } });
    },
  };
}
