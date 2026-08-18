import type { Store } from "@prisma/client";
import { env } from "../../../config/env.js";
import { hostOf, isSameOrSubdomain, normalizeDomain } from "../../../lib/domain.js";
import { ValidationError } from "../../../shared/errors.js";

export function domainTarget(): string {
  return env.CUSTOM_DOMAIN_TARGET.trim().toLowerCase();
}

export function toDomainStatus(store: Store) {
  const target = domainTarget();
  return {
    domain: store.customDomain,
    verified: store.customDomainVerifiedAt !== null,
    verifiedAt: store.customDomainVerifiedAt?.toISOString() ?? null,
    target,
    enabled: target !== "",
  };
}

/**
 * Aceita o que a pessoa colou e devolve a forma canônica, ou recusa com um motivo.
 * A loja não pode reivindicar o endereço da plataforma nem o alvo do CNAME — seria
 * capturar tráfego que não é dela.
 */
export function parseStoreDomain(raw: string): string {
  const target = domainTarget();
  if (target === "") throw new ValidationError("custom_domain_disabled");

  const domain = normalizeDomain(raw);
  if (!domain) throw new ValidationError("invalid_domain");

  const platformHost = hostOf(env.WEB_ORIGIN);
  if (platformHost && isSameOrSubdomain(domain, platformHost)) {
    throw new ValidationError("domain_belongs_to_platform");
  }
  if (isSameOrSubdomain(domain, target)) {
    throw new ValidationError("domain_belongs_to_platform");
  }
  return domain;
}
