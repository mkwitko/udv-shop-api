import type { AiGateway } from "../gateways/ai/ai.gateway.js";
import type { DnsGateway } from "../gateways/dns/dns.gateway.js";
import type { EmailGateway } from "../gateways/email/email.gateway.js";
import type { GoogleGateway } from "../gateways/google/google.gateway.js";
import type { R2Gateway } from "../gateways/r2/r2.gateway.js";
import type { StripeGateway } from "../gateways/stripe/stripe.gateway.js";
import type { WooviGateway } from "../gateways/woovi/woovi.gateway.js";

export type Gateways = {
  ai: AiGateway;
  dns: DnsGateway;
  email: EmailGateway;
  google: GoogleGateway;
  r2: R2Gateway;
  stripe: StripeGateway;
  woovi: WooviGateway;
};
