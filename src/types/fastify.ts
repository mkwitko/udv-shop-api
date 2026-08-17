import type { EmailGateway } from "../gateways/email/email.gateway.js";
import type { GoogleGateway } from "../gateways/google/google.gateway.js";

export type Gateways = {
  email: EmailGateway;
  google: GoogleGateway;
};
