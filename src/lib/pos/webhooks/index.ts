// Phase 8B — POS webhook receiver.
//
// Webhook flow:
//   1. Provider POSTs JSON to /api/integrations/pos/[provider]/webhook
//   2. The route handler calls verifyAndRecordWebhook(raw, headers).
//   3. Signature is verified using the provider's adapter (Square HMAC,
//      Lightspeed signature, ...).
//   4. Replay prevention: (scope, nonce) is upserted into WebhookReplay;
//      the unique constraint rejects duplicates.
//   5. POSWebhookEvent is persisted RECEIVED + VERIFIED.
//   6. A BackgroundJob (kind=POS_WEBHOOK) is enqueued to dispatch the
//      event to the provider's importer (idempotent on externalEventId).
//   7. The job updates the POSWebhookEvent status COMPLETED / FAILED.

import { z } from "zod";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "../../prisma";
import { logger } from "../../observability/logger";
import { audit } from "../../audit";
import { enqueue } from "../../queue";
import { ConflictError, ValidationError } from "../../errors";
import { getSecret } from "../../secrets";
import { consumeRate } from "../../security/rate-limit";

void z;

// ---------------------------------------------------------------------------
// Provider adapter interface
// ---------------------------------------------------------------------------
export interface POSProviderAdapter {
  key: string;
  verifySignature(args: { rawBody: string; headers: Record<string, string>; webhookSecret: string }): Promise<{ ok: boolean; reason?: string; nonce?: string }>;
  parse(rawBody: string): Promise<{ externalEventId: string; eventType: string; payload: unknown }>;
  importSale?(args: { clubId: string; event: { externalEventId: string; eventType: string; payload: unknown } }): Promise<{ saleId?: string; skipped?: boolean; reason?: string }>;
}

// ---------------------------------------------------------------------------
// Square adapter
// ---------------------------------------------------------------------------
export const squareAdapter: POSProviderAdapter = {
  key: "square",
  async verifySignature({ rawBody, headers, webhookSecret }) {
    const signature = headers["x-square-hmacsha256-signature"] ?? headers["x-square-signature"];
    if (!signature) return { ok: false, reason: "missing signature header" };
    const url = headers["x-spectre-webhook-url"] ?? ""; // route should pass full URL
    const message = `${url}${rawBody}`;
    const expected = createHmac("sha256", webhookSecret).update(message).digest("base64");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return { ok: false, reason: "signature length mismatch" };
    if (!timingSafeEqual(a, b)) return { ok: false, reason: "signature mismatch" };
    return { ok: true, nonce: signature };
  },
  async parse(rawBody) {
    const parsed = JSON.parse(rawBody) as { event_id?: string; type?: string; data?: unknown };
    if (!parsed.event_id || !parsed.type) throw new ValidationError([{ path: "event_id|type", message: "Missing event_id or type" }]);
    return { externalEventId: parsed.event_id, eventType: parsed.type, payload: parsed.data ?? parsed };
  },
  async importSale({ clubId, event }) {
    if (!event.eventType.startsWith("payment") && !event.eventType.startsWith("order")) {
      return { skipped: true, reason: `event ${event.eventType} not a sale` };
    }
    // Minimal Square shape — production code would map order line items
    // through POSMapping to InventoryItem.id.
    const payload = event.payload as { object?: { payment?: { amount_money?: { amount: number; currency: string }; id: string }; order?: { id: string } } };
    const payment = payload.object?.payment;
    if (!payment) return { skipped: true, reason: "no payment in payload" };
    const amount = Number(payment.amount_money?.amount ?? 0) / 100;
    const location = await prisma.pOSLocation.findFirst({ where: { clubId, isActive: true } });
    if (!location) return { skipped: true, reason: "no POS location configured" };
    const { createSale, completeSale } = await import("../index");
    const sale = await createSale({ id: "system", name: "POS webhook", email: "system@spectre", status: "ACTIVE", memberships: [{ clubId: null, roleKey: "SUPER_ADMIN" }], activeClubId: null, memberId: null }, clubId, {
      locationCode: location.code,
      chargeMode: "CASH",
      lines: [{ kind: "OTHER", description: `Square order ${payload.object?.order?.id ?? event.externalEventId}`, quantity: 1, unitPrice: amount, taxAmount: 0, discountAmount: 0 }],
      payments: [{ method: "CASH", amount, tipAmount: 0, externalReference: payment.id }],
      providerKey: "square",
      externalReference: event.externalEventId,
    });
    if (sale.status === "DRAFT") await completeSale({ id: "system", name: "POS webhook", email: "system@spectre", status: "ACTIVE", memberships: [{ clubId: null, roleKey: "SUPER_ADMIN" }], activeClubId: null, memberId: null }, sale.id);
    return { saleId: sale.id };
  },
};

// ---------------------------------------------------------------------------
// Lightspeed adapter
// ---------------------------------------------------------------------------
export const lightspeedAdapter: POSProviderAdapter = {
  key: "lightspeed",
  async verifySignature({ rawBody, headers, webhookSecret }) {
    const signature = headers["x-lightspeed-signature"];
    if (!signature) return { ok: false, reason: "missing signature header" };
    const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
    const a = Buffer.from(signature, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return { ok: false, reason: "signature length mismatch" };
    if (!timingSafeEqual(a, b)) return { ok: false, reason: "signature mismatch" };
    return { ok: true, nonce: signature };
  },
  async parse(rawBody) {
    const parsed = JSON.parse(rawBody) as { eventID?: string; eventType?: string; payload?: unknown };
    if (!parsed.eventID || !parsed.eventType) throw new ValidationError([{ path: "eventID|eventType", message: "Missing eventID or eventType" }]);
    return { externalEventId: parsed.eventID, eventType: parsed.eventType, payload: parsed.payload ?? parsed };
  },
  async importSale({ clubId, event }) {
    // Lightspeed sale shape (simplified):
    //   { saleID, locationID, total, tax, lines: [{ itemID, qty, price }], payments: [{ type, amount }] }
    if (!event.eventType.toLowerCase().includes("sale")) {
      return { skipped: true, reason: `event ${event.eventType} not a sale` };
    }
    const payload = event.payload as {
      saleID?: string; locationID?: string;
      total?: number; tax?: number; tip?: number;
      lines?: Array<{ itemID?: string; description?: string; qty?: number; price?: number }>;
      payments?: Array<{ type?: string; amount?: number }>;
      member?: { externalID?: string };
    };
    // Resolve location via POSMapping.
    let location;
    if (payload.locationID) {
      const mapping = await prisma.pOSMapping.findFirst({
        where: { clubId, providerKey: "lightspeed", kind: "LOCATION", externalId: payload.locationID },
      });
      if (mapping) location = await prisma.pOSLocation.findUnique({ where: { id: mapping.spectreId } });
    }
    if (!location) location = await prisma.pOSLocation.findFirst({ where: { clubId, isActive: true } });
    if (!location) return { skipped: true, reason: "no POS location" };

    // Resolve member if provided.
    let memberId: string | undefined;
    if (payload.member?.externalID) {
      const m = await prisma.pOSMapping.findFirst({
        where: { clubId, providerKey: "lightspeed", kind: "MEMBER", externalId: payload.member.externalID },
      });
      if (m) memberId = m.spectreId;
    }

    // Build lines — try inventory mapping first; unmapped items become OTHER.
    const lines = await Promise.all((payload.lines ?? []).map(async (l) => {
      let itemSku: string | null = null;
      if (l.itemID) {
        const mapping = await prisma.pOSMapping.findFirst({
          where: { clubId, providerKey: "lightspeed", kind: "ITEM", externalId: l.itemID },
        });
        if (mapping) {
          const item = await prisma.inventoryItem.findUnique({ where: { id: mapping.spectreId } });
          if (item) itemSku = item.sku;
        }
      }
      return {
        kind: itemSku ? "INVENTORY" : "OTHER" as "INVENTORY" | "OTHER",
        itemSku,
        description: l.description ?? `Lightspeed item ${l.itemID ?? "—"}`,
        quantity: l.qty ?? 1,
        unitPrice: l.price ?? 0,
        taxAmount: 0,
        discountAmount: 0,
      };
    }));
    const chargeMode = memberId ? "MEMBER_ACCOUNT" : "CASH";
    const grandTotal = payload.total ?? lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    const { createSale, completeSale } = await import("../index");
    const systemPrincipal = { id: "system", name: "Lightspeed webhook", email: "system@spectre", status: "ACTIVE", memberships: [{ clubId: null, roleKey: "SUPER_ADMIN" as const }], activeClubId: null, memberId: null };
    const sale = await createSale(systemPrincipal, clubId, {
      locationCode: location.code,
      memberId,
      chargeMode,
      lines,
      taxLines: payload.tax ? [{ label: "Tax", rate: 0, amount: payload.tax }] : [],
      payments: [{ method: chargeMode === "MEMBER_ACCOUNT" ? "MEMBER_ACCOUNT" : "CASH", amount: grandTotal, tipAmount: payload.tip ?? 0 }],
      providerKey: "lightspeed",
      externalReference: event.externalEventId,
    });
    if (sale.status === "DRAFT") await completeSale(systemPrincipal, sale.id);
    return { saleId: sale.id };
  },
};

// ---------------------------------------------------------------------------
// Clover adapter
// ---------------------------------------------------------------------------
export const cloverAdapter: POSProviderAdapter = {
  key: "clover",
  async verifySignature({ rawBody, headers, webhookSecret }) {
    // Clover sends X-Clover-Auth (HMAC-SHA256 base64 of body).
    const signature = headers["x-clover-auth"] ?? headers["x-clover-signature"];
    if (!signature) return { ok: false, reason: "missing signature header" };
    const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("base64");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return { ok: false, reason: "signature length mismatch" };
    if (!timingSafeEqual(a, b)) return { ok: false, reason: "signature mismatch" };
    return { ok: true, nonce: signature };
  },
  async parse(rawBody) {
    // Clover webhook envelope:
    //   { merchants: { <merchantId>: [{ objectId, type, ts, ... }] } }
    const parsed = JSON.parse(rawBody) as { merchants?: Record<string, Array<{ objectId: string; type: string; ts?: number }>> };
    const entries = parsed.merchants ? Object.values(parsed.merchants).flat() : [];
    const first = entries[0];
    if (!first) throw new ValidationError([{ path: "merchants", message: "Empty Clover webhook" }]);
    return { externalEventId: `${first.objectId}:${first.ts ?? ""}`, eventType: first.type, payload: first };
  },
  async importSale({ clubId, event }) {
    // Clover sale shape (simplified — production code would call back to the
    // Clover REST API with the objectId to fetch the full order):
    if (event.eventType !== "CREATE" && event.eventType !== "UPDATE") {
      return { skipped: true, reason: `event ${event.eventType} not a sale create/update` };
    }
    const payload = event.payload as { objectId: string; type: string };
    // Without a live REST callback we can only record a placeholder sale.
    const location = await prisma.pOSLocation.findFirst({ where: { clubId, isActive: true } });
    if (!location) return { skipped: true, reason: "no POS location" };
    const { createSale, completeSale } = await import("../index");
    const systemPrincipal = { id: "system", name: "Clover webhook", email: "system@spectre", status: "ACTIVE", memberships: [{ clubId: null, roleKey: "SUPER_ADMIN" as const }], activeClubId: null, memberId: null };
    const sale = await createSale(systemPrincipal, clubId, {
      locationCode: location.code,
      chargeMode: "CASH",
      lines: [{ kind: "OTHER", description: `Clover order ${payload.objectId}`, quantity: 1, unitPrice: 0, taxAmount: 0, discountAmount: 0 }],
      payments: [{ method: "CASH", amount: 0, tipAmount: 0 }],
      providerKey: "clover",
      externalReference: event.externalEventId,
    });
    if (sale.status === "DRAFT") await completeSale(systemPrincipal, sale.id);
    return { saleId: sale.id };
  },
};

// Phase 8 had a placeholder named cloverPlaceholderAdapter; keep the export
// alias so existing imports don't break.
export const cloverPlaceholderAdapter = cloverAdapter;

export const POS_ADAPTERS: Record<string, POSProviderAdapter> = {
  square: squareAdapter,
  lightspeed: lightspeedAdapter,
  clover: cloverAdapter,
};

// ---------------------------------------------------------------------------
// Receive + verify + queue
// ---------------------------------------------------------------------------
export const receiveSchema = z.object({
  clubId: z.string(),
  providerKey: z.string(),
  rawBody: z.string(),
  headers: z.record(z.string(), z.string()),
  url: z.string().optional(),
  remoteAddress: z.string().optional(),
});

export async function receiveWebhook(raw: unknown) {
  const parsed = receiveSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const { clubId, providerKey, rawBody, headers, url, remoteAddress } = parsed.data;

  // Rate limit per (provider + IP) to absorb stampedes / bad actors.
  const limit = await consumeRate("webhook_pos", `${providerKey}:${remoteAddress ?? "unknown"}`);
  if (!limit.allowed) {
    logger.warn("pos.webhook.rate_limited", { providerKey, remoteAddress, retryAfterMs: limit.retryAfterMs });
    throw new ConflictError("Rate limit exceeded");
  }

  const adapter = POS_ADAPTERS[providerKey];
  if (!adapter) throw new ConflictError(`Unknown POS provider: ${providerKey}`);

  // Resolve provider config — the webhook secret comes from a POSIntegrationProvider row.
  const provider = await prisma.pOSIntegrationProvider.findUnique({ where: { clubId_key: { clubId, key: providerKey } } });
  if (!provider || !provider.webhookSecret) {
    logger.warn("pos.webhook.no_secret", { clubId, providerKey });
    throw new ConflictError("Webhook secret not configured");
  }
  // (In production the secret should come from getSecret() — kept on the row
  // here for the dev demo; real deployments override webhookSecret with the
  // resolved value at startup.)
  let webhookSecret = provider.webhookSecret;
  const fromSecrets = await getSecret({ clubId, scope: "POS", provider: providerKey, keyName: "webhookSecret" });
  if (fromSecrets) webhookSecret = fromSecrets;

  // Forward URL via header so signature verification matches the canonical
  // URL used for HMAC computation.
  const headersWithUrl = { ...headers, "x-spectre-webhook-url": url ?? "" };
  const verify = await adapter.verifySignature({ rawBody, headers: headersWithUrl, webhookSecret });
  let parsedEvent;
  try {
    parsedEvent = await adapter.parse(rawBody);
  } catch (err) {
    logger.warn("pos.webhook.parse_failed", { clubId, providerKey, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }

  // Replay prevention.
  if (verify.nonce) {
    try {
      await prisma.webhookReplay.create({
        data: { clubId, scope: `POS:${providerKey}`, nonce: verify.nonce },
      });
    } catch {
      // Unique-key violation = duplicate delivery; safe to ignore.
      logger.info("pos.webhook.replay_duplicate", { clubId, providerKey, externalEventId: parsedEvent.externalEventId });
      // Mark prior event as duplicate.
      await prisma.pOSWebhookEvent.updateMany({
        where: { clubId, providerKey, externalEventId: parsedEvent.externalEventId },
        data: { status: "DUPLICATE" },
      });
      return { status: "DUPLICATE", verified: verify.ok };
    }
  }

  // Persist the event row.
  const existing = await prisma.pOSWebhookEvent.findUnique({
    where: { clubId_providerKey_externalEventId: { clubId, providerKey, externalEventId: parsedEvent.externalEventId } },
  });
  if (existing) {
    logger.info("pos.webhook.duplicate_event", { clubId, providerKey, externalEventId: parsedEvent.externalEventId });
    return { status: "DUPLICATE", verified: verify.ok, event: existing };
  }

  const event = await prisma.pOSWebhookEvent.create({
    data: {
      clubId, providerKey,
      externalEventId: parsedEvent.externalEventId, eventType: parsedEvent.eventType,
      signature: verify.nonce ?? null, signatureVerified: verify.ok,
      rawPayload: rawBody, status: verify.ok ? "VERIFIED" : "FAILED",
      failureReason: verify.ok ? null : verify.reason,
    },
  });

  if (!verify.ok) {
    await prisma.pOSImportError.create({
      data: { clubId, webhookEventId: event.id, providerKey, errorMessage: verify.reason ?? "signature_failed", payloadSnippet: rawBody.slice(0, 1000) },
    });
    return { status: "FAILED", verified: false, event };
  }

  // Queue dispatch job (idempotent on externalEventId).
  const job = await enqueue({
    kind: "POS_WEBHOOK",
    queue: "pos-webhooks",
    clubId,
    payload: { eventId: event.id },
    idempotencyKey: `pos:${providerKey}:${parsedEvent.externalEventId}`,
    correlationId: event.id,
  });
  await prisma.pOSWebhookEvent.update({ where: { id: event.id }, data: { jobId: job.id, status: "PROCESSING" } });
  return { status: "QUEUED", verified: true, event, jobId: job.id };
}

// ---------------------------------------------------------------------------
// Handler — invoked by the queue worker for kind=POS_WEBHOOK
// ---------------------------------------------------------------------------
export async function dispatchWebhook(eventId: string) {
  const event = await prisma.pOSWebhookEvent.findUnique({ where: { id: eventId } });
  if (!event) throw new Error("event not found");
  if (event.status !== "PROCESSING" && event.status !== "VERIFIED") {
    return { skipped: true, reason: `event status ${event.status}` };
  }
  const adapter = POS_ADAPTERS[event.providerKey];
  if (!adapter || !adapter.importSale) {
    await prisma.pOSWebhookEvent.update({ where: { id: eventId }, data: { status: "FAILED", failureReason: "no importer" } });
    return { skipped: true, reason: "no importer" };
  }
  try {
    const parsed = await adapter.parse(event.rawPayload);
    const result = await adapter.importSale({ clubId: event.clubId, event: parsed });
    await prisma.pOSWebhookEvent.update({
      where: { id: eventId },
      data: { status: "COMPLETED", processedAt: new Date(), resultingSaleId: result.saleId ?? null, failureReason: result.skipped ? result.reason : null },
    });
    return result;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await prisma.pOSWebhookEvent.update({
      where: { id: eventId },
      data: { status: "FAILED", failureReason: errorMessage, attempts: { increment: 1 } },
    });
    await prisma.pOSImportError.create({
      data: { clubId: event.clubId, webhookEventId: event.id, providerKey: event.providerKey, errorMessage, payloadSnippet: event.rawPayload.slice(0, 1000) },
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Register the handler with the queue once at module load.
// ---------------------------------------------------------------------------
import { registerHandler } from "../../queue";
registerHandler<{ eventId: string }>("POS_WEBHOOK", async ({ payload }) => {
  return dispatchWebhook(payload.eventId);
});

// Re-export for tests.
export { audit };
