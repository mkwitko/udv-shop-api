import { randomBytes } from "node:crypto";
import type { StoreInvite } from "@prisma/client";
import type { EmailGateway } from "../../../../gateways/email/email.gateway.js";
import { logger } from "../../../../infra/observability/logger.js";
import {
  ConflictError,
  ForbiddenError,
  GoneError,
  NotFoundError,
  ValidationError,
} from "../../../../shared/errors.js";
import { hashToken } from "../../auth/tokens.service.js";
import { inviteEmailHtml } from "./team.emails.js";
import type { TeamRepository } from "./team.repository.js";
import type { InviteBody, InviteResponse, MemberResponse } from "./team.schema.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function toInviteResponse(inv: StoreInvite): InviteResponse {
  return {
    id: inv.id,
    email: inv.email,
    // owner nunca chega aqui: o schema de entrada só aceita admin|staff
    role: inv.role as InviteResponse["role"],
    expiresAt: inv.expiresAt.toISOString(),
    createdAt: inv.createdAt.toISOString(),
  };
}

export function createTeamService(deps: { repo: TeamRepository; email: EmailGateway }) {
  const { repo } = deps;

  async function invite(
    store: { id: string; name: string },
    invitedByUserId: string,
    body: InviteBody,
  ): Promise<StoreInvite> {
    if (await repo.findMemberByEmail(store.id, body.email)) {
      throw new ConflictError("already_member");
    }
    const raw = randomBytes(32).toString("base64url");
    const data = {
      role: body.role,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    };
    const pending = await repo.findPendingInviteByEmail(store.id, body.email);
    const saved = pending
      ? await repo.renewInvite(pending.id, data)
      : await repo.createInvite({ storeId: store.id, email: body.email, invitedByUserId, ...data });
    const { subject, html } = inviteEmailHtml({
      storeName: store.name,
      role: body.role,
      token: raw,
    });
    try {
      await deps.email.send({ to: body.email, subject, html });
    } catch (err) {
      logger.warn({ err, inviteId: saved.id }, "invite email send failed");
    }
    return saved;
  }

  /** Convite vivo pelo token cru. Aceito/revogado é 404 (não existe mais); vencido é 410. */
  async function findLive(rawToken: string) {
    const inv = await repo.findInviteByTokenHash(hashToken(rawToken));
    if (!inv || inv.acceptedAt || inv.revokedAt) throw new NotFoundError("invite_not_found");
    if (inv.expiresAt.getTime() <= Date.now()) throw new GoneError("invite_expired");
    return inv;
  }

  async function accept(rawToken: string, user: { id: string; email: string | null }) {
    const inv = await findLive(rawToken);
    // Convite é pessoal: conta com outro e-mail (ou sem e-mail, conta leve) não aceita.
    if (!user.email || user.email.toLowerCase() !== inv.email) {
      throw new ForbiddenError("invite_email_mismatch");
    }
    await repo.acceptInvite(inv, user.id);
    return inv;
  }

  async function listMembers(storeId: string): Promise<MemberResponse[]> {
    const rows = await repo.listMembers(storeId);
    return rows.map((r) => ({
      userId: r.user.id,
      name: r.user.name,
      email: r.user.email,
      role: r.role,
    }));
  }

  /** Owner não muda nem sai por aqui: transferir a loja é outra operação. */
  async function targetMember(storeId: string, userId: string) {
    const member = await repo.findMember(storeId, userId);
    if (!member) throw new NotFoundError("member_not_found");
    if (member.role === "owner") throw new ValidationError("owner_is_immutable");
    return member;
  }

  return {
    invite,
    findLive,
    accept,
    listMembers,
    async listInvites(storeId: string) {
      return (await repo.listPendingInvites(storeId)).map(toInviteResponse);
    },
    async revokeInvite(storeId: string, id: string) {
      const inv = await repo.findInviteById(storeId, id);
      if (!inv || inv.acceptedAt || inv.revokedAt) throw new NotFoundError("invite_not_found");
      await repo.revokeInvite(id);
    },
    async setRole(storeId: string, userId: string, role: "admin" | "staff") {
      await targetMember(storeId, userId);
      return repo.setMemberRole(storeId, userId, role);
    },
    async remove(storeId: string, userId: string) {
      await targetMember(storeId, userId);
      await repo.removeMember(storeId, userId);
    },
  };
}
