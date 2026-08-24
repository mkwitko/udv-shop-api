import { Prisma } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../../../infra/db/client.js";
import { ConflictError } from "../../../../shared/errors.js";
import { requireWritableStore } from "../../../hooks/store-role.js";
import { resolveStoreForRole } from "../../campaigns/manage.helpers.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import { checkPixKeyOwner, toConnectStatusResponse } from "../connect.helpers.js";
import { ConnectStatusResponse, PutWooviConnectBody } from "../connect.schema.js";

const Params = z.object({ slug: z.string() });

export const putWooviConnectRoute: FastifyPluginAsync = async (app) => {
  app.put(
    "/stores/:slug/connect/woovi",
    {
      config: {
        permissions: { any: ["store_owner"] },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      schema: {
        operationId: "putWooviConnect",
        tags: ["connect"],
        params: Params,
        body: PutWooviConnectBody,
        response: { 200: ConnectStatusResponse },
      },
    },
    async (req) => {
      const store = await resolveStoreForRole(req, "owner");
      requireWritableStore(req, store);
      const { pixKey } = req.body as PutWooviConnectBody;
      const stores = createStoresRepository(db);

      // Salvar a MESMA chave não cria subconta de novo: repetir o POST deixava um rastro
      // de subcontas idênticas na conta da plataforma a cada toque em "Salvar".
      if (store.wooviPixKey === pixKey) return toConnectStatusResponse(store);

      // Na Woovi a subconta É a chave: duas lojas na mesma chave operam a mesma subconta,
      // e a segunda passa a ver e a poder sacar o saldo da primeira. O dinheiro sempre cai
      // na chave, então não dá para roubar por aqui — o estrago é reembolso saindo de
      // subconta esvaziada por quem não devia, e receita de duas lojas num saldo só.
      const ocupada = await stores.findByWooviPixKey(pixKey);
      if (ocupada && ocupada.id !== store.id) {
        // chave Pix não entra em log: quem investiga precisa das duas lojas, não da chave
        req.log.warn(
          { storeId: store.id, ocupadaPor: ocupada.id },
          "chave Pix recusada: já cadastrada em outra loja",
        );
        throw new ConflictError("woovi_pix_key_taken");
      }

      // Consulta o DICT antes de gravar: é de graça, diz de quem é a chave e pega o erro
      // que mais acontece — chave digitada errada. Guardar o dono é o que permite, depois,
      // comparar com quem pagar o centavo da prova de posse.
      const owner = await checkPixKeyOwner(app, req, pixKey);

      // Trocar de chave com saldo na subconta antiga esconderia esse dinheiro para
      // sempre: a Woovi só saca para a chave da própria subconta, e a tela passa a olhar
      // a chave nova. Então esvaziamos a antiga primeiro, para a chave que o núcleo
      // escolheu quando aquele dinheiro entrou.
      if (store.wooviPixKey) {
        const anterior = await app.gateways.woovi.getSubAccount(store.wooviPixKey);
        if (anterior && anterior.balanceCents > 0) {
          const saque = await app.gateways.woovi.withdrawSubAccount(store.wooviPixKey);
          if (saque.status === "blocked") {
            // Recusar é melhor que trocar: com a troca feita, esse saldo sai da tela e
            // ninguém mais sabe que ele existe.
            req.log.error(
              { storeId: store.id, saldoCents: anterior.balanceCents, motivo: saque.message },
              "troca de chave Pix barrada: saldo na subconta antiga e saque bloqueado",
            );
            throw new ConflictError("woovi_withdraw_blocked");
          }
          req.log.info(
            { storeId: store.id, saldoCents: anterior.balanceCents },
            "saldo da subconta antiga sacado antes da troca de chave Pix",
          );
        }
      }

      // A subconta nasce na Woovi antes de gravarmos: sem ela o `SPLIT_SUB_ACCOUNT` da
      // cobrança falha, e uma chave gravada sem subconta viraria Pix quebrado no checkout.
      const { subAccountId } = await app.gateways.woovi.createSubAccount({
        name: store.name,
        pixKey,
      });
      // A subconta antiga fica lá, vazia. Apagar economizaria ruído, mas um saque pedido
      // segundos antes ainda está liquidando — não vale arriscar o dinheiro por limpeza.
      try {
        const updated = await stores.setWooviConnect(store.id, {
          pixKey,
          subaccountId: subAccountId,
          owner,
        });
        return toConnectStatusResponse(updated);
      } catch (err) {
        // duas lojas salvando a mesma chave no mesmo instante passam pela checagem acima:
        // o índice único é quem decide, e a segunda recebe o mesmo 409
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new ConflictError("woovi_pix_key_taken");
        }
        throw err;
      }
    },
  );
};
