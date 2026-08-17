import type { FastifyPluginAsync } from "fastify";
import { presignUploadRoute } from "./presign-upload/presign-upload.controller.js";

export const uploadsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(presignUploadRoute);
};
