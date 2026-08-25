import type { PrismaClient, StoreInvite, StoreRole } from "@prisma/client";

export type TeamRepository = ReturnType<typeof createTeamRepository>;

export function createTeamRepository(db: PrismaClient) {
  return {
    listMembers: (storeId: string) =>
      db.userStoreRole.findMany({
        where: { storeId },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { user: { name: "asc" } },
      }),
    findMember: (storeId: string, userId: string) =>
      db.userStoreRole.findUnique({ where: { userId_storeId: { userId, storeId } } }),
    findMemberByEmail: (storeId: string, email: string) =>
      db.userStoreRole.findFirst({ where: { storeId, user: { email } } }),
    setMemberRole: (storeId: string, userId: string, role: StoreRole) =>
      db.userStoreRole.update({ where: { userId_storeId: { userId, storeId } }, data: { role } }),
    removeMember: (storeId: string, userId: string) =>
      db.userStoreRole.delete({ where: { userId_storeId: { userId, storeId } } }),

    /** Pendente = não aceito, não revogado, não vencido. */
    listPendingInvites: (storeId: string) =>
      db.storeInvite.findMany({
        where: { storeId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
      }),
    findPendingInviteByEmail: (storeId: string, email: string) =>
      db.storeInvite.findFirst({
        where: { storeId, email, acceptedAt: null, revokedAt: null },
      }),
    findInviteById: (storeId: string, id: string) =>
      db.storeInvite.findFirst({ where: { id, storeId } }),
    findInviteByTokenHash: (tokenHash: string) =>
      db.storeInvite.findUnique({ where: { tokenHash }, include: { store: true } }),
    createInvite: (data: {
      storeId: string;
      email: string;
      role: StoreRole;
      tokenHash: string;
      invitedByUserId: string;
      expiresAt: Date;
    }) => db.storeInvite.create({ data }),
    /** Reenvio: mesma linha, token e papel novos, prazo renovado. */
    renewInvite: (id: string, data: { role: StoreRole; tokenHash: string; expiresAt: Date }) =>
      db.storeInvite.update({ where: { id }, data }),
    revokeInvite: (id: string) =>
      db.storeInvite.update({ where: { id }, data: { revokedAt: new Date() } }),
    /** Aceite e papel na mesma transação: convite marcado sem papel gravado seria beco. */
    acceptInvite: (invite: StoreInvite, userId: string) =>
      db.$transaction([
        db.storeInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } }),
        db.userStoreRole.upsert({
          where: { userId_storeId: { userId, storeId: invite.storeId } },
          create: { userId, storeId: invite.storeId, role: invite.role },
          update: { role: invite.role },
        }),
      ]),
  };
}
