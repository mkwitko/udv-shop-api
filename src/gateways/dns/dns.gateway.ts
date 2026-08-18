import { promises as dns } from "node:dns";

export type DnsGateway = {
  /** CNAMEs do host. Lista vazia quando o registro não existe. */
  resolveCname(host: string): Promise<string[]>;
};

/**
 * Verificação de domínio próprio: só o CNAME importa. Nenhum erro de DNS derruba a
 * requisição — "não encontrei" é resposta legítima, e a tela precisa dizer isso à loja.
 */
export function createDnsGateway(): DnsGateway {
  return {
    resolveCname: async (host) => {
      try {
        const records = await dns.resolveCname(host);
        return records.map((record) => record.toLowerCase().replace(/\.$/, ""));
      } catch {
        return [];
      }
    },
  };
}
