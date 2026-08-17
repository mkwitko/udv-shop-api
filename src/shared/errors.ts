export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
export class NotFoundError extends AppError {
  constructor(message = "not_found") {
    super("NOT_FOUND", 404, message);
  }
}
export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION", 400, message, details);
  }
}
export class ConflictError extends AppError {
  constructor(message: string) {
    super("CONFLICT", 409, message);
  }
}
export class UnauthorizedError extends AppError {
  constructor(message = "unauthorized") {
    super("UNAUTHORIZED", 401, message);
  }
}
export class ForbiddenError extends AppError {
  constructor(message = "forbidden") {
    super("FORBIDDEN", 403, message);
  }
}
export class BadGatewayError extends AppError {
  constructor(message = "bad_gateway", details?: unknown) {
    super("BAD_GATEWAY", 502, message, details);
  }
}
export class ServiceUnavailableError extends AppError {
  constructor(message = "service_unavailable", details?: unknown) {
    super("SERVICE_UNAVAILABLE", 503, message, details);
  }
}
export function badGateway(message: string, cause: unknown): BadGatewayError {
  const err = new BadGatewayError(message);
  err.cause = cause;
  return err;
}
