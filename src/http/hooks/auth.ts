import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyAccessToken } from "../../lib/jwt.js";
import { AppError, ForbiddenError, UnauthorizedError } from "../../shared/errors.js";
import { type Persona, personasOf } from "../../shared/permissions.js";

export async function authHook(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (req.routeOptions.config.public === true) {
    // Rota de fluxo sem conta: quem chegou logado continua sendo ele mesmo em vez de virar
    // uma conta leve nova. Sem header, segue anônimo — mas um Bearer que não vale ainda é um
    // 401: quem se apresentou com credencial ruim não é tratado como visitante.
    if (req.routeOptions.config.optionalAuth === true && header !== undefined) {
      if (!header.startsWith("Bearer ")) throw new UnauthorizedError("missing_bearer_token");
      const claims = await verifyAccessToken(header.slice("Bearer ".length));
      req.user = { sub: claims.sub, platformAdmin: claims.platformAdmin, roles: claims.roles };
    }
    return;
  }
  if (!header?.startsWith("Bearer ")) throw new UnauthorizedError("missing_bearer_token");
  const claims = await verifyAccessToken(header.slice("Bearer ".length));
  req.user = { sub: claims.sub, platformAdmin: claims.platformAdmin, roles: claims.roles };
}

export async function permissionsHook(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const config = req.routeOptions.config;
  if (config.public === true) return;
  const declared = config.permissions;
  if (!declared || (!declared.any?.length && !declared.all?.length)) {
    throw new AppError("AUTH_NO_PERMISSIONS", 500, "route declared no permissions");
  }
  const user = requireUser(req);
  const personas = personasOf(user);
  if (declared.any?.length && !declared.any.some((p) => personas.has(p as Persona))) {
    throw new ForbiddenError("insufficient_persona");
  }
  if (declared.all?.length && !declared.all.every((p) => personas.has(p as Persona))) {
    throw new ForbiddenError("insufficient_persona");
  }
}

export function requireUser(req: FastifyRequest): {
  sub: string;
  platformAdmin: boolean;
  roles: Record<string, string>;
} {
  if (!req.user) throw new UnauthorizedError("unauthenticated");
  return req.user;
}
