import type { FastifyRequest } from "fastify";
import { type AccessClaims, verifyAccessToken } from "../../lib/jwt.js";

export async function optionalUser(req: FastifyRequest): Promise<AccessClaims | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  try {
    return await verifyAccessToken(header.slice("Bearer ".length));
  } catch {
    return null;
  }
}
