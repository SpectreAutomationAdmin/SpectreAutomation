// Phase 11F — SaaS billing (Spectre billing customer clubs).
//
// NOT to be confused with member payment processing. This module deals with
// the relationship between Spectre (the SaaS vendor) and a club (the SaaS
// customer). The provider model is adapter-based:
//   - mockBillingProvider (default; safe in dev / tests)
//   - stripeBillingProvider (dynamic-import @stripe/stripe-node)
//
// Webhook events update ClubSubscription status, which flows through the
// Phase 10 entitlement engine to gate features.

import { z } from "zod";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { logger } from "../observability/logger";
import { requirePermission, type Principal } from "../rbac";
import { ConflictError, ValidationError } from "../errors";
import { optionalImport } from "../integrations/optional-import";
import { getSecret } from "../secrets";

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------
export interface BillingProvider {
  name: string;
  createCustomer(args: { clubId: string; name: string; email: string }): Promise<{ externalId: string }>;
  createCheckoutSession(args: { customerExternalId: string; priceExternalId: string; successUrl: string; cancelUrl: string }): Promise<{ url: string; sessionId: string }>;
  verifyWebhook(args: { rawBody: string; signature: string; secret: string }): Promise<{ ok: boolean; reason?: string; eventId?: string; eventType?: string; payload?: unknown }>;
}

// ---------------------------------------------------------------------------
// Mock provider — always available; deterministic for tests.
// ---------------------------------------------------------------------------
export const mockBillingProvider: BillingProvider = {
  name: "mock",
  async createCustomer({ clubId, name, email }) {
    return { externalId: `mock_cust_${clubId.slice(0, 8)}_${name.length}_${email.length}` };
  },
  async createCheckoutSession({ customerExternalId, priceExternalId }) {
    return { url: `https://mock.billing/checkout/${customerExternalId}/${priceExternalId}`, sessionId: `mock_sess_${Date.now()}` };
  },
  async verifyWebhook({ rawBody, signature, secret }) {
    // Mock uses simple HMAC-SHA256 over rawBody.
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(signature, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return { ok: false, reason: "length" };
    if (!timingSafeEqual(a, b)) return { ok: false, reason: "mismatch" };
    try {
      const parsed = JSON.parse(rawBody) as { id?: string; type?: string; data?: unknown };
      return { ok: true, eventId: parsed.id, eventType: parsed.type, payload: parsed.data };
    } catch { return { ok: false, reason: "invalid json" }; }
  },
};

// ---------------------------------------------------------------------------
// Stripe provider — dynamic-import.
// ---------------------------------------------------------------------------
export async function stripeBillingProvider(args: { apiKey: string; webhookSecret: string }): Promise<BillingProvider> {
  const mod = await optionalImport("stripe");
  if (!mod) {
    logger.warn("billing.stripe.missing", { hint: "`stripe` npm package not installed; falling back to mock" });
    return mockBillingProvider;
  }
  const Stripe = (mod.default ?? mod) as new (key: string, opts?: { apiVersion?: string }) => {
    customers: { create: (args: { name: string; email: string; metadata: Record<string, string> }) => Promise<{ id: string }> };
    checkout: { sessions: { create: (args: { customer: string; line_items: Array<{ price: string; quantity: number }>; mode: string; success_url: string; cancel_url: string }) => Promise<{ id: string; url: string | null }> } };
    webhooks: { constructEvent: (rawBody: string, signature: string, secret: string) => { id: string; type: string; data: { object: unknown } } };
  };
  const stripe = new Stripe(args.apiKey);
  return {
    name: "stripe",
    async createCustomer({ clubId, name, email }) {
      const result = await stripe.customers.create({ name, email, metadata: { clubId } });
      return { externalId: result.id };
    },
    async createCheckoutSession({ customerExternalId, priceExternalId, successUrl, cancelUrl }) {
      const session = await stripe.checkout.sessions.create({
        customer: customerExternalId,
        line_items: [{ price: priceExternalId, quantity: 1 }],
        mode: "subscription",
        success_url: successUrl, cancel_url: cancelUrl,
      });
      return { sessionId: session.id, url: session.url ?? "" };
    },
    async verifyWebhook({ rawBody, signature, secret }) {
      try {
        const event = stripe.webhooks.constructEvent(rawBody, signature, secret);
        return { ok: true, eventId: event.id, eventType: event.type, payload: event.data.object };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Provider selection — env or per-club setting drives the choice.
// ---------------------------------------------------------------------------
let activeProvider: BillingProvider = mockBillingProvider;
export function setBillingProvider(p: BillingProvider) { activeProvider = p; }

export async function selectProvider(clubId?: string): Promise<BillingProvider> {
  if (process.env.SPECTRE_BILLING_PROVIDER !== "stripe") return activeProvider;
  const apiKey = clubId ? await getSecret({ clubId, scope: "BILLING" as never, provider: "stripe", keyName: "API_KEY" }) : process.env.STRIPE_API_KEY ?? null;
  const webhookSecret = clubId ? await getSecret({ clubId, scope: "BILLING" as never, provider: "stripe", keyName: "WEBHOOK_SECRET" }) : process.env.STRIPE_WEBHOOK_SECRET ?? null;
  if (!apiKey || !webhookSecret) return mockBillingProvider;
  return stripeBillingProvider({ apiKey, webhookSecret });
}

// ---------------------------------------------------------------------------
// Customer + checkout
// ---------------------------------------------------------------------------
export const createCustomerSchema = z.object({
  email: z.string().email(),
});

export async function ensureBillingCustomer(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "settings:write");
  const parsed = createCustomerSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club) throw new ConflictError("Club not found");
  const existing = await prisma.billingCustomer.findUnique({ where: { clubId } });
  if (existing) return existing;
  const provider = await selectProvider(clubId);
  const result = await provider.createCustomer({ clubId, name: club.name, email: parsed.data.email });
  const customer = await prisma.billingCustomer.create({
    data: { clubId, provider: provider.name, externalId: result.externalId, email: parsed.data.email },
  });
  await audit(principal, { action: "billing.customer.create", entityType: "BillingCustomer", entityId: customer.id, clubId, after: { provider: provider.name, externalId: result.externalId } });
  return customer;
}

// ---------------------------------------------------------------------------
// Webhook handling — receives provider webhook + dispatches state updates.
// ---------------------------------------------------------------------------
export async function handleWebhook(args: { rawBody: string; signature: string; provider?: string; webhookSecret?: string; clubId?: string }) {
  const provider = await selectProvider(args.clubId);
  // Webhook secret precedence: explicit arg → secrets manager (if clubId).
  let secret = args.webhookSecret;
  if (!secret && args.clubId) {
    secret = (await getSecret({ clubId: args.clubId, scope: "BILLING" as never, provider: provider.name, keyName: "WEBHOOK_SECRET" })) ?? undefined;
  }
  if (!secret) {
    secret = process.env.STRIPE_WEBHOOK_SECRET ?? process.env.SPECTRE_BILLING_WEBHOOK_SECRET ?? "";
  }
  if (!secret) {
    logger.warn("billing.webhook.no_secret");
    throw new ConflictError("Billing webhook secret not configured");
  }
  const verify = await provider.verifyWebhook({ rawBody: args.rawBody, signature: args.signature, secret });
  if (!verify.ok) {
    return { status: "FAILED" as const, reason: verify.reason };
  }
  if (!verify.eventId || !verify.eventType) {
    return { status: "FAILED" as const, reason: "missing event fields" };
  }
  // Idempotent persist.
  try {
    await prisma.billingWebhookEvent.create({
      data: {
        clubId: args.clubId ?? null, provider: provider.name,
        externalEventId: verify.eventId, eventType: verify.eventType,
        signature: args.signature, signatureVerified: true,
        status: "VERIFIED", rawPayload: args.rawBody,
      },
    });
  } catch {
    // Unique violation = duplicate delivery; treat as success.
    logger.info("billing.webhook.duplicate", { eventId: verify.eventId });
    return { status: "DUPLICATE" as const, eventId: verify.eventId };
  }
  // Apply state transitions.
  await applyWebhook(verify.eventType, verify.payload as Record<string, unknown>, provider.name);
  await prisma.billingWebhookEvent.updateMany({
    where: { provider: provider.name, externalEventId: verify.eventId },
    data: { status: "COMPLETED", processedAt: new Date() },
  });
  return { status: "COMPLETED" as const, eventId: verify.eventId, eventType: verify.eventType };
}

async function applyWebhook(eventType: string, payload: Record<string, unknown>, providerName: string) {
  switch (eventType) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = payload as { id: string; customer: string; status: string; current_period_start?: number; current_period_end?: number; cancel_at?: number };
      const customer = await prisma.billingCustomer.findFirst({ where: { provider: providerName, externalId: sub.customer } });
      if (!customer) return;
      const status = normalizeSubStatus(sub.status);
      await prisma.billingSubscription.upsert({
        where: { provider_externalId: { provider: providerName, externalId: sub.id } },
        update: {
          status,
          currentPeriodStart: sub.current_period_start ? new Date(sub.current_period_start * 1000) : null,
          currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
          cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
        },
        create: {
          clubId: customer.clubId, customerId: customer.id, provider: providerName, externalId: sub.id, status,
          currentPeriodStart: sub.current_period_start ? new Date(sub.current_period_start * 1000) : null,
          currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
        },
      });
      // Propagate to ClubSubscription entitlement.
      const entitlementStatus = status === "ACTIVE" ? "ACTIVE" : status === "PAST_DUE" ? "PAUSED" : status === "CANCELLED" ? "CANCELLED" : "ACTIVE";
      await prisma.clubSubscription.update({
        where: { clubId: customer.clubId },
        data: { status: entitlementStatus },
      }).catch(() => { /* may not exist yet */ });
      return;
    }
    case "customer.subscription.deleted": {
      const sub = payload as { id: string };
      await prisma.billingSubscription.updateMany({
        where: { provider: providerName, externalId: sub.id },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });
      return;
    }
    case "invoice.created":
    case "invoice.paid":
    case "invoice.payment_failed": {
      const inv = payload as { id: string; customer: string; number?: string; amount_due?: number; amount_paid?: number; currency?: string; status?: string; hosted_invoice_url?: string; invoice_pdf?: string; period_start?: number; period_end?: number };
      const customer = await prisma.billingCustomer.findFirst({ where: { provider: providerName, externalId: inv.customer } });
      if (!customer) return;
      const status = normalizeInvoiceStatus(inv.status, eventType);
      await prisma.billingInvoice.upsert({
        where: { provider_externalId: { provider: providerName, externalId: inv.id } },
        update: {
          status, number: inv.number ?? null,
          amountDue: (inv.amount_due ?? 0) / 100,
          amountPaid: (inv.amount_paid ?? 0) / 100,
          currency: inv.currency ?? "usd",
          hostedUrl: inv.hosted_invoice_url ?? null,
          pdfUrl: inv.invoice_pdf ?? null,
          paidAt: status === "PAID" ? new Date() : null,
        },
        create: {
          clubId: customer.clubId, customerId: customer.id, provider: providerName, externalId: inv.id, status,
          number: inv.number ?? null,
          amountDue: (inv.amount_due ?? 0) / 100, amountPaid: (inv.amount_paid ?? 0) / 100,
          currency: inv.currency ?? "usd",
          hostedUrl: inv.hosted_invoice_url ?? null, pdfUrl: inv.invoice_pdf ?? null,
          periodStart: inv.period_start ? new Date(inv.period_start * 1000) : null,
          periodEnd: inv.period_end ? new Date(inv.period_end * 1000) : null,
        },
      });
      if (eventType === "invoice.payment_failed") {
        await prisma.clubSubscription.update({
          where: { clubId: customer.clubId }, data: { status: "PAUSED" },
        }).catch(() => {});
      }
      return;
    }
  }
}

function normalizeSubStatus(status: string): string {
  switch (status) {
    case "active": return "ACTIVE";
    case "trialing": return "TRIALING";
    case "past_due": return "PAST_DUE";
    case "canceled":
    case "cancelled": return "CANCELLED";
    case "paused": return "PAUSED";
    default: return status.toUpperCase();
  }
}

function normalizeInvoiceStatus(status: string | undefined, eventType: string): string {
  if (eventType === "invoice.paid") return "PAID";
  if (eventType === "invoice.payment_failed") return "OPEN";
  switch (status) {
    case "paid": return "PAID";
    case "open": return "OPEN";
    case "uncollectible": return "UNCOLLECTIBLE";
    case "void": return "VOID";
    default: return "DRAFT";
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function getBillingSnapshot(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "settings:read");
  const [customer, subscriptions, invoices, recentWebhooks] = await Promise.all([
    prisma.billingCustomer.findUnique({ where: { clubId } }),
    prisma.billingSubscription.findMany({ where: { clubId }, orderBy: { createdAt: "desc" } }),
    prisma.billingInvoice.findMany({ where: { clubId }, orderBy: { createdAt: "desc" }, take: 25 }),
    prisma.billingWebhookEvent.findMany({ where: { clubId }, orderBy: { receivedAt: "desc" }, take: 10 }),
  ]);
  return { customer, subscriptions, invoices, recentWebhooks };
}
