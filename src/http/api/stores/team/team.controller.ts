import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { UnauthorizedError } from "../../../../shared/errors.js";
import { requireUser } from "../../../hooks/auth.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { createAuthRepository } from "../../auth/auth.repository.js";
import { toPublicUser } from "../../auth/auth.types.js";
import { setRefreshCookie } from "../../auth/cookies.js";
import { AuthResponse } from "../../auth/register/register.schema.js";
import { createTokensService } from "../../auth/tokens.service.js";
import { resolveStoreForRole } from "../manage.helpers.js";
import { createTeamRepository } from "./team.repository.js";
import {
  InviteBody,
  InvitePreviewResponse,
  InviteResponse,
  MemberResponse,
  TeamResponse,
  UpdateMemberBody,
} from "./team.schema.js";
import { createTeamService, toInviteResponse } from "./team.service.js";

const SlugParams = z.object({ slug: z.string() });
const SlugIdParams = z.object({ slug: z.string(), id: z.string().uuid() });
const SlugUserParams = z.object({ slug: z.string(), userId: z.string().uuid() });
const TokenParams = z.object({ token: z.string().min(16).max(128) });
const NoContent = z.null().describe("No Content");

/** Só o dono mexe na equipe. platform_admin passa por `requireStoreRole`. */
const OWNER = { permissions: { any: ["store_owner", "platform_admin"] } };

export const teamRoutes: FastifyPluginAsync = async (app) => {
  const service = () =>
    createTeamService({ repo: createTeamRepository(db), email: app.gateways.email });

  app.get(
    "/stores/:slug/team",
    {
      config: OWNER,
      schema: {
        operationId: "getStoreTeam",
        tags: ["stores"],
        params: SlugParams,
        response: { 200: TeamResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "owner");
      const svc = service();
      const [members, invites] = await Promise.all([
        svc.listMembers(store.id),
        svc.listInvites(store.id),
      ]);
      return { members, invites };
    },
  );

  app.post(
    "/stores/:slug/team/invites",
    {
      config: OWNER,
      schema: {
        operationId: "inviteStoreMember",
        tags: ["stores"],
        params: SlugParams,
        body: InviteBody,
        response: { 201: InviteResponse },
      },
    },
    async (req, reply) => {
      const store = await resolveStoreForRole(req, "owner");
      const user = requireWritableStore(req, store);
      const inv = await service().invite(store, user.sub, req.body as InviteBody);
      void reply.code(201).send(toInviteResponse(inv));
    },
  );

  app.delete(
    "/stores/:slug/team/invites/:id",
    {
      config: OWNER,
      schema: {
        operationId: "revokeStoreInvite",
        tags: ["stores"],
        params: SlugIdParams,
        response: { 204: NoContent },
      },
    },
    async (req, reply) => {
      const store = await resolveStoreForRole(req, "owner");
      await service().revokeInvite(store.id, (req.params as z.infer<typeof SlugIdParams>).id);
      void reply.code(204).send();
    },
  );

  app.patch(
    "/stores/:slug/team/:userId",
    {
      config: OWNER,
      schema: {
        operationId: "updateStoreMember",
        tags: ["stores"],
        params: SlugUserParams,
        body: UpdateMemberBody,
        response: { 200: MemberResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "owner");
      requireWritableStore(req, store);
      const { userId } = req.params as z.infer<typeof SlugUserParams>;
      await service().setRole(store.id, userId, (req.body as UpdateMemberBody).role);
      const members = await service().listMembers(store.id);
      return members.find((m) => m.userId === userId);
    },
  );

  app.delete(
    "/stores/:slug/team/:userId",
    {
      config: OWNER,
      schema: {
        operationId: "removeStoreMember",
        tags: ["stores"],
        params: SlugUserParams,
        response: { 204: NoContent },
      },
    },
    async (req, reply) => {
      const store = await resolveStoreForRole(req, "owner");
      requireWritableStore(req, store);
      await service().remove(store.id, (req.params as z.infer<typeof SlugUserParams>).userId);
      void reply.code(204).send();
    },
  );

  app.get(
    "/invites/:token",
    {
      config: { public: true, rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        operationId: "getInvite",
        tags: ["stores"],
        params: TokenParams,
        response: { 200: InvitePreviewResponse },
      },
    },
    async (req) => {
      const inv = await service().findLive((req.params as z.infer<typeof TokenParams>).token);
      return {
        storeName: inv.store.name,
        storeSlug: inv.store.slug,
        role: inv.role,
        email: inv.email,
        expiresAt: inv.expiresAt.toISOString(),
      };
    },
  );

  app.post(
    "/invites/:token/accept",
    {
      config: {
        permissions: { any: ["customer"] },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      schema: {
        operationId: "acceptInvite",
        tags: ["stores"],
        params: TokenParams,
        response: { 200: AuthResponse },
      },
    },
    async (req, reply) => {
      const { sub } = requireUser(req);
      const authRepo = createAuthRepository(db);
      const user = await authRepo.findUserById(sub);
      if (!user) throw new UnauthorizedError("user_not_found");
      await service().accept((req.params as z.infer<typeof TokenParams>).token, user);
      // Papel vive no JWT: sem token novo a pessoa aceitava e continuava sem acesso.
      const tokens = createTokensService({ repo: authRepo });
      const issued = await tokens.issue(user.id);
      setRefreshCookie(reply, issued.refreshToken);
      void reply.send({ accessToken: issued.accessToken, user: toPublicUser(user) });
    },
  );
};
