import { importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";
import { env } from "../config/env.js";
import { UnauthorizedError } from "../shared/errors.js";

export type AccessClaims = {
  sub: string;
  platformAdmin: boolean;
  roles: Record<string, string>;
};

const privateKey = await importPKCS8(
  Buffer.from(env.JWT_PRIVATE_KEY_B64, "base64").toString("utf8"),
  "EdDSA",
);
const publicKey = await importSPKI(
  Buffer.from(env.JWT_PUBLIC_KEY_B64, "base64").toString("utf8"),
  "EdDSA",
);

export async function signAccessToken(user: {
  id: string;
  platformAdmin: boolean;
  roles: Record<string, string>;
}): Promise<string> {
  return new SignJWT({ platformAdmin: user.platformAdmin, roles: user.roles })
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_S}s`)
    .sign(privateKey);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, publicKey, { algorithms: ["EdDSA"] });
    return {
      sub: String(payload.sub),
      platformAdmin: payload.platformAdmin === true,
      roles: (payload.roles ?? {}) as Record<string, string>,
    };
  } catch {
    throw new UnauthorizedError("invalid_token");
  }
}
