import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { AppError } from "../../shared/errors.js";

// fastify@5's setErrorHandler types `error` as `unknown` by default (no built-in FastifyError
// generic covers the ad-hoc `.validation`/`.statusCode` fields it attaches at runtime), so we
// narrow explicitly here to keep the handler logic identical to the spec.
type MaybeFastifyError = Error & { validation?: unknown; statusCode?: number };

const _plugin: FastifyPluginAsync = async (app) => {
  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send({
      code: "NOT_FOUND",
      message: `route ${req.method} ${req.url} not found`,
      trace_id: req.id,
    });
  });

  app.setErrorHandler((rawErr, req, reply) => {
    const err = rawErr as MaybeFastifyError;
    if (err instanceof AppError) {
      if (err.statusCode >= 500) req.log.error({ err }, "unhandled app error");
      void reply
        .code(err.statusCode)
        .send({ code: err.code, message: err.message, details: err.details, trace_id: req.id });
      return;
    }
    // erro de validação do fastify (zod compiler seta err.validation)
    if ("validation" in err && err.validation) {
      void reply.code(400).send({
        code: "VALIDATION",
        message: "validation_error",
        details: err.validation,
        trace_id: req.id,
      });
      return;
    }
    const statusCode =
      "statusCode" in err && typeof err.statusCode === "number" ? err.statusCode : 500;
    if (statusCode >= 500) {
      req.log.error({ err }, "unhandled error");
      void reply
        .code(500)
        .send({ code: "INTERNAL", message: "internal_server_error", trace_id: req.id });
      return;
    }
    void reply
      .code(statusCode)
      .send({ code: "HTTP_ERROR", message: err.message, trace_id: req.id });
  });
};

export const errorHandlerPlugin = fp(_plugin, { name: "error-handler" });
