// Typed error hierarchy. Every service-layer function throws one of these
// instead of a bare Error, so route handlers can produce safe, consistent
// responses without leaking internal detail.

export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly safeMessage: string;

  constructor(code: string, message: string, httpStatus = 400, safeMessage?: string) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.safeMessage = safeMessage ?? message;
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "Authentication required") {
    super("UNAUTHENTICATED", message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action") {
    super("FORBIDDEN", message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    super("NOT_FOUND", `${entity}${id ? ` (${id})` : ""} not found`, 404);
  }
}

export class ValidationError extends AppError {
  readonly issues: Array<{ path: string; message: string }>;
  constructor(issues: Array<{ path: string; message: string }>, message = "Validation failed") {
    super("VALIDATION", message, 422);
    this.issues = issues;
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super("CONFLICT", message, 409);
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many requests. Please try again shortly.") {
    super("RATE_LIMITED", message, 429);
  }
}

/**
 * Thrown by `commitBatch` when a COA import is about to REPLACE an
 * existing active Chart of Accounts. The caller (typically the
 * /app/admin/imports/[id] server action) catches this code,
 * surfaces a confirmation modal to the user, and re-invokes
 * `commitBatch` with `confirmReplaceCoa: true`.
 *
 * The `details` payload powers the modal copy: how many accounts
 * exist today, how many will be replaced (matched-by-number), and
 * how many will be deactivated (left over).
 */
export class RequiresCoaReplacementConfirmationError extends AppError {
  readonly details: {
    existingActiveCount: number;
    matchingImportCount: number;
    deactivateCount: number;
    importedRowCount: number;
  };
  constructor(details: RequiresCoaReplacementConfirmationError["details"]) {
    super(
      "COA_REPLACEMENT_REQUIRES_CONFIRMATION",
      "This club already has an active Chart of Accounts. Commit again with confirmReplaceCoa=true to replace it.",
      409,
      "This club already has an active Chart of Accounts. Confirm replacement to proceed.",
    );
    this.details = details;
  }
}

export class TenantViolationError extends AppError {
  // This is an internal-only error. The safe message never reveals tenant detail.
  constructor(detail: string) {
    super("TENANT_VIOLATION", `Tenant isolation violation: ${detail}`, 403, "Not found");
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
