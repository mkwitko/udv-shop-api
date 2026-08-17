import type { FastifyPluginAsync } from "fastify";
import { loginRoute } from "./login/login.controller.js";
import { logoutRoute } from "./logout/logout.controller.js";
import { refreshRoute } from "./refresh/refresh.controller.js";
import { registerRoute } from "./register/register.controller.js";
import { verifyEmailRoute } from "./verify-email/verify-email.controller.js";

export const authRoutes: FastifyPluginAsync = async (app) => {
  await app.register(registerRoute);
  await app.register(verifyEmailRoute);
  await app.register(loginRoute);
  await app.register(refreshRoute);
  await app.register(logoutRoute);
};
