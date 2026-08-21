import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { UnauthorizedError, ValidationError } from "../shared/errors.js";

/**
 * Contato de quem participa sem conta. Telefone é obrigatório porque é o canal que a loja usa
 * de fato — quem cuida do núcleo liga ou manda mensagem. E-mail é opcional, e é o que habilita
 * o aviso automático.
 */
export const GuestContact = z.object({
  name: z.string().min(2).max(120),
  phone: z.string().min(8).max(20),
  email: z
    .string()
    .email()
    .transform((v) => v.toLowerCase())
    .optional(),
});
export type GuestContact = z.infer<typeof GuestContact>;

/**
 * Número nacional brasileiro: 11 dígitos de celular (DDD + 9 + 8 dígitos) ou 10 de fixo
 * (DDD + 2..5 + 7 dígitos). A forma importa porque só contar dígitos aceitaria um número de
 * outro país como se fosse daqui — "+1 415 555 2671" tem os mesmos 11 dígitos de um celular.
 */
function isBrazilianNational(digits: string): boolean {
  const ddd = Number(digits.slice(0, 2));
  if (ddd < 11 || ddd > 99) return false;
  if (digits.length === 11) return digits[2] === "9";
  return digits[2] !== undefined && digits[2] >= "2" && digits[2] <= "5";
}

/**
 * Telefone brasileiro em dígitos com DDI: "5511988887777". É chave única de identidade, então
 * tem que ter uma forma só — "(11) 98888-7777" e "+55 11 98888 7777" são a mesma pessoa.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  const national =
    (digits.length === 12 || digits.length === 13) && digits.startsWith("55")
      ? digits.slice(2)
      : digits;
  if ((national.length === 10 || national.length === 11) && isBrazilianNational(national)) {
    return `55${national}`;
  }
  throw new ValidationError("invalid_phone");
}

export type GuestUser = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  passwordHash: string | null;
  googleId: string | null;
};

export type GuestIdentityRepo = {
  findByEmail(email: string): Promise<GuestUser | null>;
  findByPhone(phone: string): Promise<GuestUser | null>;
  create(data: { name: string; phone: string; email: string | null }): Promise<{ id: string }>;
  fillPhone(id: string, phone: string): Promise<void>;
};

const SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  passwordHash: true,
  googleId: true,
} as const;

export function createGuestIdentityRepo(db: PrismaClient): GuestIdentityRepo {
  return {
    findByEmail: (email) => db.user.findUnique({ where: { email }, select: SELECT }),
    findByPhone: (phone) => db.user.findUnique({ where: { phone }, select: SELECT }),
    create: (data) =>
      db.user.create({
        data: { name: data.name, phone: data.phone, email: data.email },
        select: { id: true },
      }),
    fillPhone: async (id, phone) => {
      await db.user.update({ where: { id }, data: { phone } });
    },
  };
}

/**
 * Quem é o dono desta ação. Com sessão, é quem está logado — o formulário nunca fala mais alto
 * que o token. Sem sessão, o contato vira uma conta leve (sem senha), reaproveitando a que já
 * existir para aquele e-mail ou telefone.
 *
 * Nenhuma sessão é emitida aqui: o convidado ganha um registro, não acesso. É por isso que
 * casar com a conta de outra pessoa não vaza nada — no máximo põe um pedido no histórico de
 * quem foi citado.
 */
export async function resolveActor(
  repo: GuestIdentityRepo,
  input: { sessionUserId?: string | undefined; contact?: GuestContact | undefined },
): Promise<{ userId: string; guest: boolean }> {
  if (input.sessionUserId) return { userId: input.sessionUserId, guest: false };
  if (!input.contact) throw new UnauthorizedError("login_required");

  const phone = normalizePhone(input.contact.phone);
  const email = input.contact.email ?? null;
  const byEmail = email ? await repo.findByEmail(email) : null;
  const byPhone = await repo.findByPhone(phone);
  const existing = byEmail ?? byPhone;

  if (existing) {
    // Conta com credencial não é reescrita por formulário de convidado. Conta leve ganha o
    // telefone que faltava — mas só se ninguém mais o tiver, senão o unique estoura.
    const credentialed = existing.passwordHash !== null || existing.googleId !== null;
    const phoneFree = byPhone === null || byPhone.id === existing.id;
    if (!credentialed && existing.phone === null && phoneFree) {
      await repo.fillPhone(existing.id, phone);
    }
    return { userId: existing.id, guest: true };
  }

  const created = await repo.create({ name: input.contact.name, phone, email });
  return { userId: created.id, guest: true };
}
