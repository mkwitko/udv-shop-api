import { logger } from "../../infra/observability/logger.js";
import type { EmailGateway } from "./email.gateway.js";

/**
 * Gateway de e-mail que só escreve no log. Entra quando não há RESEND_API_KEY — situação
 * normal em desenvolvimento e impossível em produção (o schema do env exige a chave lá).
 *
 * Sem isto, sem chave o envio ia para a Resend, falhava, e o evento do outbox morria em
 * `failed` depois de cinco tentativas: nenhum aviso de venda, de doação ou de chegada de
 * encomenda era testável na máquina de quem desenvolve. Um log é mentira menor que um
 * erro — o fluxo inteiro segue em frente e o conteúdo fica visível para conferência.
 */
export function createLogEmailGateway(): EmailGateway {
  return {
    async send(input) {
      logger.info(
        {
          to: input.to,
          subject: input.subject,
          // O corpo inteiro polui o terminal; o começo basta para conferir que o e-mail
          // certo saiu com o dado certo dentro.
          preview: input.html
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 240),
        },
        "e-mail não enviado (sem RESEND_API_KEY): conteúdo no log",
      );
    },
  };
}
