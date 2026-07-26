// Append-only audit service. Every sensitive write must call audit() — the
// service-layer functions in src/lib/services/* are responsible for this.
//
// We never throw from audit() into the caller. A failure to write an audit
// row should never prevent legitimate work from completing — but it should
// be logged loudly so ops can investigate.

import { prisma } from "./prisma";
import type { Principal } from "./rbac";
import { getRequestContext } from "./request-context";

export type AuditInput = {
  action: string;            // e.g. "application.approve"
  entityType: string;        // e.g. "Applicant"
  entityId?: string | null;
  clubId?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
};

export async function audit(actor: Principal | { id: string } | null, input: AuditInput) {
  try {
    const { ip, userAgent } = getRequestContext();
    await prisma.auditLog.create({
      data: {
        clubId: input.clubId ?? null,
        userId: actor?.id ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        beforeJson: input.before == null ? null : safeStringify(input.before),
        afterJson: input.after == null ? null : safeStringify(input.after),
        metaJson: input.meta == null ? null : safeStringify(input.meta),
        ip,
        userAgent,
      },
    });
  } catch (err) {
    // Never let audit failures bubble up. Surface for ops monitoring.
    // eslint-disable-next-line no-console
    console.error("[audit] failed to write log", { action: input.action, error: err });
  }
}

// Stable, size-bounded JSON serializer. Strips functions, large blobs, and
// known-sensitive keys.
const SENSITIVE_KEYS = new Set(["passwordHash", "password", "mfaSecret", "cardNumber", "cvv", "accountNumber", "ssn", "sin"]);
const MAX_LENGTH = 16_000;

function safeStringify(value: unknown): string {
  const seen = new WeakSet();
  const json = JSON.stringify(value, (key, val) => {
    if (SENSITIVE_KEYS.has(key)) return "[redacted]";
    if (typeof val === "function") return undefined;
    if (val && typeof val === "object") {
      if (seen.has(val as object)) return "[circular]";
      seen.add(val as object);
    }
    return val;
  });
  if (json && json.length > MAX_LENGTH) return json.slice(0, MAX_LENGTH) + "…[truncated]";
  return json;
}
