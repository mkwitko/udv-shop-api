import { describe, expect, it } from "vitest";
import {
  type GuestIdentityRepo,
  type GuestUser,
  normalizePhone,
  resolveActor,
} from "../../src/lib/guest-identity.js";

function fakeRepo(seed: GuestUser[] = []) {
  const rows = [...seed];
  let next = seed.length;
  const created: { name: string; phone: string; email: string | null }[] = [];
  const filled: { id: string; phone: string }[] = [];
  const repo: GuestIdentityRepo = {
    findByEmail: async (email) => rows.find((r) => r.email === email) ?? null,
    findByPhone: async (phone) => rows.find((r) => r.phone === phone) ?? null,
    create: async (data) => {
      created.push(data);
      next += 1;
      const row: GuestUser = {
        id: `u${next}`,
        name: data.name,
        email: data.email,
        phone: data.phone,
        passwordHash: null,
        googleId: null,
      };
      rows.push(row);
      return { id: row.id };
    },
    fillPhone: async (id, phone) => {
      filled.push({ id, phone });
      const row = rows.find((r) => r.id === id);
      if (row) row.phone = phone;
    },
  };
  return { repo, created, filled };
}

const CONTACT = { name: "Maria Silva", phone: "(11) 98888-7777" };

describe("normalizePhone", () => {
  it("aceita 11 dígitos com máscara e prefixa o DDI", () => {
    expect(normalizePhone("(11) 98888-7777")).toBe("5511988887777");
  });

  it("aceita 10 dígitos (fixo sem nono dígito)", () => {
    expect(normalizePhone("1133334444")).toBe("551133334444");
  });

  it("aceita número que já vem com DDI", () => {
    expect(normalizePhone("+55 11 98888-7777")).toBe("5511988887777");
  });

  it("recusa número curto", () => {
    expect(() => normalizePhone("98888")).toThrow(/invalid_phone/);
  });

  // Contar dígitos não basta: um número de outro país tem os mesmos 11 dígitos de um celular
  // brasileiro, e viraria um telefone falso na chave de identidade.
  it("recusa DDI que não é 55", () => {
    expect(() => normalizePhone("+1 415 555 2671")).toThrow(/invalid_phone/);
  });

  it("recusa 11 dígitos sem o nono dígito de celular", () => {
    expect(() => normalizePhone("11 38888-7777")).toThrow(/invalid_phone/);
  });

  it("recusa DDD inexistente", () => {
    expect(() => normalizePhone("01 98888-7777")).toThrow(/invalid_phone/);
  });
});

describe("resolveActor", () => {
  it("sessão vence o contato do formulário", async () => {
    const { repo, created } = fakeRepo();
    const actor = await resolveActor(repo, { sessionUserId: "logado", contact: CONTACT });
    expect(actor).toEqual({ userId: "logado", guest: false });
    expect(created).toHaveLength(0);
  });

  it("sem sessão e sem contato exige login", async () => {
    const { repo } = fakeRepo();
    await expect(resolveActor(repo, {})).rejects.toThrow(/login_required/);
  });

  it("cria conta leve sem senha quando ninguém casa", async () => {
    const { repo, created } = fakeRepo();
    const actor = await resolveActor(repo, { contact: { ...CONTACT, email: "maria@example.org" } });
    expect(actor.guest).toBe(true);
    expect(created[0]).toEqual({
      name: "Maria Silva",
      phone: "5511988887777",
      email: "maria@example.org",
    });
  });

  it("casa por e-mail e grava o telefone que faltava", async () => {
    const { repo, filled, created } = fakeRepo([
      {
        id: "u1",
        name: "Maria",
        email: "maria@example.org",
        phone: null,
        passwordHash: null,
        googleId: null,
      },
    ]);
    const actor = await resolveActor(repo, { contact: { ...CONTACT, email: "maria@example.org" } });
    expect(actor).toEqual({ userId: "u1", guest: true });
    expect(filled).toEqual([{ id: "u1", phone: "5511988887777" }]);
    expect(created).toHaveLength(0);
  });

  it("casa por telefone quando não há e-mail no formulário", async () => {
    const { repo, created } = fakeRepo([
      {
        id: "u1",
        name: "Maria",
        email: null,
        phone: "5511988887777",
        passwordHash: null,
        googleId: null,
      },
    ]);
    const actor = await resolveActor(repo, { contact: CONTACT });
    expect(actor).toEqual({ userId: "u1", guest: true });
    expect(created).toHaveLength(0);
  });

  it("anexa a conta com senha sem reescrever nada dela", async () => {
    const { repo, filled } = fakeRepo([
      {
        id: "u1",
        name: "Maria Membro",
        email: "maria@example.org",
        phone: null,
        passwordHash: "hash",
        googleId: null,
      },
    ]);
    const actor = await resolveActor(repo, { contact: { ...CONTACT, email: "maria@example.org" } });
    expect(actor).toEqual({ userId: "u1", guest: true });
    expect(filled).toHaveLength(0);
  });

  it("não rouba telefone que já pertence a outra linha", async () => {
    const { repo, filled } = fakeRepo([
      {
        id: "u1",
        name: "Maria",
        email: "maria@example.org",
        phone: null,
        passwordHash: null,
        googleId: null,
      },
      {
        id: "u2",
        name: "Outra",
        email: null,
        phone: "5511988887777",
        passwordHash: null,
        googleId: null,
      },
    ]);
    const actor = await resolveActor(repo, { contact: { ...CONTACT, email: "maria@example.org" } });
    expect(actor.userId).toBe("u1");
    expect(filled).toHaveLength(0);
  });
});
