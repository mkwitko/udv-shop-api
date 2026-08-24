import { z } from "zod";
import { GuestContact } from "../../../lib/guest-identity.js";

export const INTEREST_STATUSES = ["open", "notified", "converted", "cancelled"] as const;

export const CreateInterestBody = z
  .object({
    storeSlug: z.string().min(1),
    /** Produto esgotado OU evento lotado — um dos dois, nunca os dois. */
    productSlug: z.string().min(1).optional(),
    eventSlug: z.string().min(1).optional(),
    qty: z.number().int().min(1).max(99).default(1),
    note: z.string().max(500).optional(),
    /** Quem está pedindo o aviso, quando não há sessão. Ignorado se houver Bearer token. */
    contact: GuestContact.optional(),
    /**
     * Desafio anti-abuso, exigido de quem não tem sessão quando a plataforma tem Turnstile
     * configurado. Ignorado quando o desafio está desligado.
     */
    captchaToken: z.string().max(4096).optional(),
  })
  // Um alvo, exatamente um: fila sem alvo não tem o que avisar, e com dois não se sabe o
  // que a pessoa está esperando.
  .refine((body) => Boolean(body.productSlug) !== Boolean(body.eventSlug), {
    message: "informe productSlug ou eventSlug",
    path: ["productSlug"],
  });
export type CreateInterestBody = z.infer<typeof CreateInterestBody>;

/** O que a pessoa está esperando. Preenchido conforme `kind` — o outro vem nulo. */
export const InterestSubject = {
  kind: z.enum(["produto", "evento"]),
  product: z
    .object({
      slug: z.string(),
      name: z.string(),
      priceCents: z.number().int(),
      availability: z.string(),
    })
    .nullable(),
  event: z
    .object({
      slug: z.string(),
      name: z.string(),
      priceCents: z.number().int(),
      at: z.string(),
      location: z.string().nullable(),
    })
    .nullable(),
};

export const InterestResponse = z.object({
  id: z.string(),
  store: z.object({ slug: z.string(), name: z.string() }),
  ...InterestSubject,
  qty: z.number().int(),
  status: z.string(),
  note: z.string().nullable(),
  notifiedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const InterestsPageResponse = z.object({
  items: z.array(InterestResponse),
  nextCursor: z.string().nullable(),
});

/**
 * Fila vista pela loja: precisa de quem é a pessoa para combinar a entrega. O telefone sai
 * mascarado por padrão — a lista inteira não é lugar de dado de contato completo — e o número
 * inteiro só aparece para owner e admin, que são quem avisa por WhatsApp quem deixou só
 * telefone. Mesma fronteira que já governa quem pode disparar o aviso de chegada.
 */
export const StoreInterestResponse = InterestResponse.extend({
  customer: z.object({
    name: z.string(),
    phoneMasked: z.string().nullable(),
    phone: z.string().nullable(),
  }),
});

export const StoreInterestsPageResponse = z.object({
  items: z.array(StoreInterestResponse),
  nextCursor: z.string().nullable(),
});

export const InterestsListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
  status: z.enum(INTEREST_STATUSES).optional(),
});

export const StoreInterestsQuery = InterestsListQuery.extend({
  productSlug: z.string().min(1).optional(),
  eventSlug: z.string().min(1).optional(),
});

export const InterestDemandResponse = z.object({
  items: z.array(
    z.object({
      ...InterestSubject,
      openCount: z.number().int(),
      notifiedCount: z.number().int(),
      totalQty: z.number().int(),
    }),
  ),
});

export const NotifyInterestsResponse = z.object({ notified: z.number().int() });

// Teto da resposta de demanda: a lista paginada de interesses cobre o caso detalhado.
export const DEMAND_MAX_SUBJECTS = 100;
