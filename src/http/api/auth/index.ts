import type { FastifyPluginAsync } from "fastify";
import { loginRoute } from "./login/login.controller.js";
import { registerRoute } from "./register/register.controller.js";
import { verifyEmailRoute } from "./verify-email/verify-email.controller.js";

export const authRoutes: FastifyPluginAsync = async (app) => {
  await app.register(registerRoute);
  await app.register(verifyEmailRoute);
  await app.register(loginRoute);
};
