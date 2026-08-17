import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../../../../infra/db/client.js";
import { NotFoundError } from "../../../../shared/errors.js";
import { requireStoreRole, requireWritableStore } from "../../../hooks/store-role.js";
import { createStoresRepository } from "../../stores/stores.repository.js";
import {
  IMAGE_CONTENT_TYPES,
  PresignUploadBody,
  PresignUploadResponse,
} from "./presign-upload.schema.js";

export const presignUploadRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/uploads/presign",
    {
      config: { permissions: { any: ["store_owner", "store_admin", "store_staff"] } },
      schema: {
        operationId: "presignUpload",
        tags: ["uploads"],
        body: PresignUploadBody,
        response: { 201: PresignUploadResponse },
      },
    },
    async (req, reply) => {
      const { storeSlug, contentType } = req.body as PresignUploadBody;
      const store = await createStoresRepository(db).findBySlug(storeSlug);
      if (!store) throw new NotFoundError(`store ${storeSlug} not found`);
      requireStoreRole(req, store.id, "staff");
      requireWritableStore(req, store);
      const ext = IMAGE_CONTENT_TYPES[contentType as keyof typeof IMAGE_CONTENT_TYPES];
      const key = `stores/${store.id}/products/${randomUUID()}.${ext}`;
      const uploadUrl = await app.gateways.r2.presignPut({ key, contentType });
      void reply.code(201).send({ key, uploadUrl, publicUrl: app.gateways.r2.publicUrl(key) });
    },
  );
};
