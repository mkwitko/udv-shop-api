import type { FastifyPluginAsync } from "fastify";
import { forgotPasswordRoute } from "./forgot-password/forgot-password.controller.js";
import { googleCallbackRoute } from "./google/google-callback.controller.js";
import { googleStartRoute } from "./google/google-start.controller.js";
import { loginRoute } from "./login/login.controller.js";
import { logoutRoute } from "./logout/logout.controller.js";
import { refreshRoute } from "./refresh/refresh.controller.js";
import { registerRoute } from "./register/register.controller.js";
import { resetPasswordRoute } from "./reset-password/reset-password.controller.js";
import { verifyEmailRoute } from "./verify-email/verify-email.controller.js";

export const authRoutes: FastifyPluginAsync = async (app) => {
  await app.register(registerRoute);
  await app.register(verifyEmailRoute);
  await app.register(loginRoute);
  await app.register(refreshRoute);
  await app.register(logoutRoute);
  await app.register(forgotPasswordRoute);
  await app.register(resetPasswordRoute);
  await app.register(googleStartRoute);
  await app.register(googleCallbackRoute);
};
