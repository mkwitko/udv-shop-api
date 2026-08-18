import { z } from "zod";

export const PutDomainBody = z.object({
  /** Aceita o que a pessoa colar; a API normaliza (protocolo, porta, ponto final). */
  domain: z.string().min(3).max(255),
});
export type PutDomainBody = z.infer<typeof PutDomainBody>;

export const DomainStatusResponse = z.object({
  domain: z.string().nullable(),
  verified: z.boolean(),
  verifiedAt: z.string().nullable(),
  /** Para onde o CNAME precisa apontar. Vazio significa feature desligada na plataforma. */
  target: z.string(),
  enabled: z.boolean(),
});

export const VerifyDomainResponse = DomainStatusResponse.extend({
  /** O que o DNS respondeu agora — a loja precisa ver o motivo quando não bate. */
  found: z.array(z.string()),
});
