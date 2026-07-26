// Sprint 2 B2 (2026-07-19) — Categorised error taxonomy for the
// delegated mailbox flow.
//
// Per §7 of the B2 directive: "Use structured sanitized error
// categories" and NEVER log full Microsoft error payloads. The
// codes below are the ONLY strings that appear in audit records,
// user-facing responses, or logs when something goes wrong.

export const MAILBOX_ERROR_CODE = {
  // OAuth flow — before token exchange
  OAUTH_STATE_MISSING: "oauth_state_missing",
  OAUTH_STATE_UNKNOWN: "oauth_state_unknown",
  OAUTH_STATE_EXPIRED: "oauth_state_expired",
  OAUTH_STATE_REPLAY: "oauth_state_replay",
  OAUTH_USER_MISMATCH: "oauth_user_mismatch",
  OAUTH_CLUB_MISMATCH: "oauth_club_mismatch",
  OAUTH_DENIED_BY_USER: "oauth_denied_by_user",
  OAUTH_ADMIN_CONSENT_REQUIRED: "oauth_admin_consent_required",
  OAUTH_UNSAFE_RETURN_URL: "oauth_unsafe_return_url",
  // OAuth flow — code exchange and identity
  OAUTH_CODE_EXCHANGE_FAILED: "oauth_code_exchange_failed",
  OAUTH_NONCE_MISMATCH: "oauth_nonce_mismatch",
  OAUTH_ISSUER_INVALID: "oauth_issuer_invalid",
  OAUTH_PERSONAL_ACCOUNT_REJECTED: "oauth_personal_account_rejected",
  OAUTH_TENANT_MISSING: "oauth_tenant_missing",
  OAUTH_ME_FAILED: "oauth_me_failed",
  OAUTH_MAILBOX_ADDRESS_MISSING: "oauth_mailbox_address_missing",
  // Uniqueness / policy
  DUPLICATE_MAILBOX_DIFFERENT_USER: "duplicate_mailbox_different_user",
  ACTIVE_PERSONAL_MAILBOX_REPLACEMENT_REQUIRED: "active_personal_mailbox_replacement_required",
  CROSS_CLUB_MAILBOX_DENIED: "cross_club_mailbox_denied",
  // Refresh lifecycle
  REFRESH_RETRYABLE: "refresh_retryable",
  REFRESH_TERMINAL: "refresh_terminal",
  // Feature-flag / permission
  FEATURE_DISABLED: "feature_disabled",
  PERMISSION_DENIED: "permission_denied",
  UNAUTHENTICATED: "unauthenticated",
  // Housekeeping
  CONNECTION_NOT_FOUND: "connection_not_found",
  CONNECTION_ALREADY_DISCONNECTED: "connection_already_disconnected",
  INTERNAL_ERROR: "internal_error",
} as const;

export type MailboxErrorCode = (typeof MAILBOX_ERROR_CODE)[keyof typeof MAILBOX_ERROR_CODE];

export class MailboxFlowError extends Error {
  readonly code: MailboxErrorCode;
  readonly context: Record<string, string | number | boolean>;
  constructor(code: MailboxErrorCode, context: Record<string, string | number | boolean> = {}) {
    super(`Mailbox flow error: ${code}`);
    this.name = "MailboxFlowError";
    this.code = code;
    this.context = context;
  }
}

// Distinguish retryable errors (transient — Microsoft throttling,
// 5xx, network timeouts) from terminal ones (invalid_grant,
// consent_required, invalid_client). Used by the refresh lifecycle
// to decide whether to transition REAUTH_REQUIRED.
//
// The specific MSAL error codes below are documented at
// https://learn.microsoft.com/en-us/azure/active-directory/develop/reference-error-codes
// and cross-checked against @azure/msal-common's ServerError class.
export function classifyMsalError(err: unknown): "retryable" | "terminal" {
  const asObj = err as { errorCode?: string; errorNo?: string; subError?: string; response?: { status?: number } } | undefined;
  const code = asObj?.errorCode ?? "";
  const sub = asObj?.subError ?? "";
  const httpStatus = asObj?.response?.status ?? 0;

  // Terminal — user must reconnect.
  const TERMINAL_CODES = new Set([
    "invalid_grant",
    "interaction_required",
    "consent_required",
    "invalid_client",
    "unauthorized_client",
  ]);
  const TERMINAL_SUB_ERRORS = new Set([
    "bad_token",
    "token_expired",
    "consent_required",
    "user_password_expired",
  ]);
  if (TERMINAL_CODES.has(code) || TERMINAL_SUB_ERRORS.has(sub)) return "terminal";
  // 400 with an unknown code is treated as terminal so we don't
  // hammer Microsoft on bad requests. 429 and 5xx are retryable.
  if (httpStatus >= 500) return "retryable";
  if (httpStatus === 429) return "retryable";
  if (httpStatus === 400) return "terminal";
  // Default: retryable. The refresh lifecycle will back off and try
  // again; if it keeps failing, the reconciliation heartbeat will
  // flip DELAYED and eventually manual review.
  return "retryable";
}
