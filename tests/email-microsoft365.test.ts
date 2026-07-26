// Microsoft 365 / Graph email delivery — unit + integration tests.
//
// No real Microsoft tenant is contacted. All HTTP I/O routes through a
// stubbed `GraphTransport` injected via setGraphTransportForTest.
//
// Coverage:
//   - microsoft365 mode selects the Graph adapter (env-driven AND
//     per-club IntegrationSetting)
//   - Missing config fails clearly (not a generic stack trace)
//   - Token acquisition success caches the token
//   - Token acquisition failure surfaces a useful reason
//   - sendMail success returns SENT + provider request-id
//   - sendMail failure returns FAILED + reason
//   - POS member-account settlement triggers send with the member's
//     current profile email and writes an EmailDeliveryEvent row
//   - POS QR Pay defers send until confirmQRPayment
//   - QR decline/expire never sends
//   - Per-club IntegrationSetting overrides env-driven config
//   - One club's IntegrationSetting cannot be used to send another
//     club's receipt
//   - Client secret never appears in failure reasons or
//     EmailDeliveryEvent records

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, makeMember, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  setGraphTransportForTest,
  type GraphTransport,
} from "@/lib/integrations/microsoft-graph";
import { selectEmailAdapter, getEmailMode } from "@/lib/integrations/email";
import {
  openCheck,
  addCheckLines,
  sendUnsentItems,
  settleCheck,
  confirmQRPayment,
  declineQRPayment,
  expireQRPayment,
} from "@/lib/pos/checks";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";

// -----------------------------------------------------------------
// Test scaffolding
// -----------------------------------------------------------------

type Captured = {
  tokenCalls: Array<{ tenantId: string; clientId: string; clientSecret: string }>;
  sendCalls: Array<{ accessToken: string; fromMailbox: string; toEmail: string; subject: string; body: string }>;
};

function makeCapturingTransport(opts?: {
  tokenError?: string;
  sendError?: string;
  requestId?: string;
}): { transport: GraphTransport; captured: Captured } {
  const captured: Captured = { tokenCalls: [], sendCalls: [] };
  const transport: GraphTransport = {
    async fetchToken(args) {
      captured.tokenCalls.push({ ...args });
      if (opts?.tokenError) throw new Error(opts.tokenError);
      return { accessToken: `tok-for-${args.tenantId}-${captured.tokenCalls.length}`, expiresInSec: 3600 };
    },
    async sendMail({ accessToken, fromMailbox, request }) {
      captured.sendCalls.push({
        accessToken,
        fromMailbox,
        toEmail: request.message.toRecipients[0]?.emailAddress.address ?? "",
        subject: request.message.subject,
        body: request.message.body.content,
      });
      if (opts?.sendError) throw new Error(opts.sendError);
      return { requestId: opts?.requestId ?? `req-${captured.sendCalls.length}` };
    },
  };
  return { transport, captured };
}

async function bootstrapLounge(name: string) {
  const club = await bootstrapAPClub(name);
  const fbDept = await db().department.findFirst({ where: { clubId: club.id, code: "FB" } });
  const location = await db().pOSLocation.create({
    data: { clubId: club.id, code: LOUNGE_LOCATION_CODE, name: "Lounge", departmentId: fbDept?.id ?? null },
  });
  const terminal = await db().pOSTerminal.create({
    data: { clubId: club.id, code: LOUNGE_TERMINAL_CODE, name: "Lounge Terminal", locationId: location.id },
  });
  await db().pOSSession.create({
    data: { clubId: club.id, locationId: location.id, terminalId: terminal.id, status: "OPEN", openingFloat: 0 },
  });
  const cat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: location.id, name: "Mains", sortOrder: 1, isActive: true, chitDestination: "KITCHEN" },
  });
  const burger = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: cat.id, name: "Burger", price: 20, taxable: true, isActive: true },
  });
  return { club, burger };
}

async function clubAdminPrincipal(clubId: string, suffix = "") {
  const email = `ms365-admin-${suffix}-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function setEmailIntegration(clubId: string, opts: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  fromMailbox: string;
}) {
  await db().integrationSetting.create({
    data: {
      clubId,
      scope: "EMAIL",
      provider: "microsoft365",
      isActive: true,
      configJson: JSON.stringify({
        tenantId: opts.tenantId,
        clientId: opts.clientId,
        fromMailbox: opts.fromMailbox,
      }),
      secretsJson: JSON.stringify({ clientSecret: opts.clientSecret }),
    },
  });
}

async function memberWithEmail(clubId: string, email: string) {
  const m = await makeMember(clubId);
  return db().member.update({ where: { id: m.id }, data: { email } });
}

beforeAll(async () => {
  await resetDb();
  await seedRbac();
});

beforeEach(async () => {
  await resetDb();
  await seedRbac();
});

afterEach(() => {
  setGraphTransportForTest(null);
});

// -----------------------------------------------------------------
// 1. Adapter selection
// -----------------------------------------------------------------

describe("microsoft365 — adapter selection", () => {
  it("selectEmailAdapter resolves the Graph adapter when the per-club setting is microsoft365", async () => {
    const club = await bootstrapAPClub("MS Select Club");
    await setEmailIntegration(club.id, {
      tenantId: "tenant-a", clientId: "client-a",
      clientSecret: "shhh-a", fromMailbox: "receipts@a.test",
    });
    const { transport, captured } = makeCapturingTransport();
    setGraphTransportForTest(transport);

    const adapter = await selectEmailAdapter(club.id);
    const r = await adapter.send({
      clubId: club.id, channel: "EMAIL",
      to: { email: "x@example.com" },
      subject: "S", body: "B",
    });

    expect(r.status).toBe("SENT");
    expect(captured.tokenCalls).toHaveLength(1);
    expect(captured.tokenCalls[0].tenantId).toBe("tenant-a");
    expect(captured.sendCalls[0].fromMailbox).toBe("receipts@a.test");
    expect(await getEmailMode(club.id)).toBe("microsoft365");
  });

  it("missing config fields short-circuit to a clear FAILED reason", async () => {
    const club = await bootstrapAPClub("MS Missing Club");
    await setEmailIntegration(club.id, {
      tenantId: "", clientId: "client-a",
      clientSecret: "shhh-a", fromMailbox: "",
    });
    const { transport, captured } = makeCapturingTransport();
    setGraphTransportForTest(transport);

    const adapter = await selectEmailAdapter(club.id);
    const r = await adapter.send({
      clubId: club.id, channel: "EMAIL",
      to: { email: "x@example.com" },
      subject: "S", body: "B",
    });

    expect(r.status).toBe("FAILED");
    expect(r.failureReason).toMatch(/tenantId/);
    expect(r.failureReason).toMatch(/fromMailbox/);
    // Must NOT touch the network if config is incomplete.
    expect(captured.tokenCalls).toHaveLength(0);
    expect(captured.sendCalls).toHaveLength(0);
  });
});

// -----------------------------------------------------------------
// 2. Token + send semantics
// -----------------------------------------------------------------

describe("microsoft365 — token + send semantics", () => {
  it("caches the access token across sends for the same tenant/client", async () => {
    const club = await bootstrapAPClub("MS Cache Club");
    await setEmailIntegration(club.id, {
      tenantId: "tenant-b", clientId: "client-b",
      clientSecret: "shhh-b", fromMailbox: "receipts@b.test",
    });
    const { transport, captured } = makeCapturingTransport();
    setGraphTransportForTest(transport);

    const adapter = await selectEmailAdapter(club.id);
    await adapter.send({ clubId: club.id, channel: "EMAIL", to: { email: "a@x.test" }, subject: "S1", body: "B1" });
    await adapter.send({ clubId: club.id, channel: "EMAIL", to: { email: "b@x.test" }, subject: "S2", body: "B2" });

    expect(captured.sendCalls).toHaveLength(2);
    // Two sends, ONE token fetch.
    expect(captured.tokenCalls).toHaveLength(1);
  });

  it("token acquisition failure surfaces a FAILED status with the reason and never hits sendMail", async () => {
    const club = await bootstrapAPClub("MS TokenFail Club");
    await setEmailIntegration(club.id, {
      tenantId: "tenant-c", clientId: "client-c",
      clientSecret: "shhh-c", fromMailbox: "receipts@c.test",
    });
    const { transport, captured } = makeCapturingTransport({
      tokenError: "Token request failed (400): AADSTS7000215: Invalid client secret provided",
    });
    setGraphTransportForTest(transport);

    const adapter = await selectEmailAdapter(club.id);
    const r = await adapter.send({
      clubId: club.id, channel: "EMAIL",
      to: { email: "x@example.com" },
      subject: "S", body: "B",
    });
    expect(r.status).toBe("FAILED");
    expect(r.failureReason).toContain("AADSTS7000215");
    expect(captured.sendCalls).toHaveLength(0);
  });

  it("sendMail failure surfaces a FAILED status and returns the provider error", async () => {
    const club = await bootstrapAPClub("MS SendFail Club");
    await setEmailIntegration(club.id, {
      tenantId: "tenant-d", clientId: "client-d",
      clientSecret: "shhh-d", fromMailbox: "receipts@d.test",
    });
    const { transport } = makeCapturingTransport({
      sendError: "Graph sendMail failed (403): ErrorAccessDenied",
    });
    setGraphTransportForTest(transport);

    const adapter = await selectEmailAdapter(club.id);
    const r = await adapter.send({
      clubId: club.id, channel: "EMAIL",
      to: { email: "x@example.com" },
      subject: "S", body: "B",
    });
    expect(r.status).toBe("FAILED");
    expect(r.failureReason).toContain("ErrorAccessDenied");
  });

  it("sendMail success records the provider request-id as providerMessageId", async () => {
    const club = await bootstrapAPClub("MS ReqId Club");
    await setEmailIntegration(club.id, {
      tenantId: "tenant-e", clientId: "client-e",
      clientSecret: "shhh-e", fromMailbox: "receipts@e.test",
    });
    const { transport } = makeCapturingTransport({ requestId: "graph-req-xyz" });
    setGraphTransportForTest(transport);

    const adapter = await selectEmailAdapter(club.id);
    const r = await adapter.send({
      clubId: club.id, channel: "EMAIL",
      to: { email: "x@example.com" },
      subject: "S", body: "B",
    });
    expect(r.status).toBe("SENT");
    expect(r.providerMessageId).toBe("graph-req-xyz");
  });
});

// -----------------------------------------------------------------
// 3. POS receipts via Microsoft 365
// -----------------------------------------------------------------

async function settleAndReturnCheck(opts: {
  clubId: string;
  principal: Awaited<ReturnType<typeof clubAdminPrincipal>>;
  memberId: string;
  burgerId: string;
  paymentMethod: "MEMBER_ACCOUNT" | "QR_PAY";
}) {
  const check = await openCheck(opts.principal, opts.clubId, { memberId: opts.memberId });
  await addCheckLines(opts.principal, check.id, {
    items: [{ menuItemId: opts.burgerId, quantity: 1 }],
  });
  await sendUnsentItems(opts.principal, check.id);
  return settleCheck(opts.principal, check.id, {
    paymentMethod: opts.paymentMethod,
    allowUnsentLines: true,
    origin: "http://localhost:3000",
  });
}

describe("microsoft365 — POS receipt integration", () => {
  it("MEMBER_ACCOUNT settlement sends the receipt via Graph using the current profile email", async () => {
    const { club, burger } = await bootstrapLounge("MS POS MA Club");
    await setEmailIntegration(club.id, {
      tenantId: "tenant-f", clientId: "client-f",
      clientSecret: "shhh-f", fromMailbox: "receipts@silver.club",
    });
    const principal = await clubAdminPrincipal(club.id, "ma");
    const member = await memberWithEmail(club.id, "owen@example.com");

    const { transport, captured } = makeCapturingTransport({ requestId: "req-ma" });
    setGraphTransportForTest(transport);

    const { check } = await settleAndReturnCheck({
      clubId: club.id, principal, memberId: member.id, burgerId: burger.id,
      paymentMethod: "MEMBER_ACCOUNT",
    });

    expect(captured.sendCalls).toHaveLength(1);
    expect(captured.sendCalls[0].toEmail).toBe("owen@example.com");
    expect(captured.sendCalls[0].fromMailbox).toBe("receipts@silver.club");

    const after = await db().pOSCheck.findUnique({ where: { id: check!.id } });
    expect(after?.receiptEmailStatus).toBe("SENT");
    expect(after?.receiptEmailAddress).toBe("owen@example.com");

    const events = await db().emailDeliveryEvent.findMany({ where: { clubId: club.id } });
    expect(events.map((e) => e.kind)).toContain("POS_RECEIPT_SENT");
    expect(events[0].provider).toBe("microsoft365");
  });

  it("QR Pay does not send until confirmQRPayment; declined never sends", async () => {
    const { club, burger } = await bootstrapLounge("MS POS QR Club");
    await setEmailIntegration(club.id, {
      tenantId: "tenant-g", clientId: "client-g",
      clientSecret: "shhh-g", fromMailbox: "receipts@g.test",
    });
    const principal = await clubAdminPrincipal(club.id, "qr");
    const member = await memberWithEmail(club.id, "qr-member@example.com");

    const { transport, captured } = makeCapturingTransport();
    setGraphTransportForTest(transport);

    // Path 1: pending → confirmed.
    const confirmed = await settleAndReturnCheck({
      clubId: club.id, principal, memberId: member.id, burgerId: burger.id,
      paymentMethod: "QR_PAY",
    });
    expect(captured.sendCalls).toHaveLength(0);
    await confirmQRPayment(principal, confirmed.sale.id, { origin: "http://localhost:3000" });
    expect(captured.sendCalls).toHaveLength(1);
    expect(captured.sendCalls[0].toEmail).toBe("qr-member@example.com");

    // Path 2: pending → declined.
    const declined = await settleAndReturnCheck({
      clubId: club.id, principal, memberId: member.id, burgerId: burger.id,
      paymentMethod: "QR_PAY",
    });
    await declineQRPayment(principal, declined.sale.id, "test decline");
    expect(captured.sendCalls).toHaveLength(1); // unchanged

    // Path 3: pending → expired.
    const expired = await settleAndReturnCheck({
      clubId: club.id, principal, memberId: member.id, burgerId: burger.id,
      paymentMethod: "QR_PAY",
    });
    await expireQRPayment(principal, expired.sale.id);
    expect(captured.sendCalls).toHaveLength(1); // still unchanged
  });

  it("Graph failure records FAILED + reason but does NOT roll back the settlement", async () => {
    const { club, burger } = await bootstrapLounge("MS POS Fail Club");
    await setEmailIntegration(club.id, {
      tenantId: "tenant-h", clientId: "client-h",
      clientSecret: "shhh-h", fromMailbox: "receipts@h.test",
    });
    const principal = await clubAdminPrincipal(club.id, "fail");
    const member = await memberWithEmail(club.id, "fail@example.com");

    const { transport } = makeCapturingTransport({
      sendError: "Graph sendMail failed (404): ErrorMailRecipientNotFound",
    });
    setGraphTransportForTest(transport);

    const { check, sale } = await settleAndReturnCheck({
      clubId: club.id, principal, memberId: member.id, burgerId: burger.id,
      paymentMethod: "MEMBER_ACCOUNT",
    });

    const after = await db().pOSCheck.findUnique({ where: { id: check!.id } });
    expect(after?.status).toBe("CLOSED");
    expect(after?.receiptEmailStatus).toBe("FAILED");
    expect(after?.receiptEmailFailure).toContain("ErrorMailRecipientNotFound");

    // Sale must still be COMPLETED — email failure must not undo AR/GL.
    const completed = await db().pOSSale.findUnique({ where: { id: sale.id } });
    expect(completed?.status).toBe("COMPLETED");
  });
});

// -----------------------------------------------------------------
// 4. Multi-tenant safety + secret-hygiene
// -----------------------------------------------------------------

describe("microsoft365 — multi-tenant + secret hygiene", () => {
  it("a receipt for club A only ever uses club A's IntegrationSetting (cross-tenant isolation)", async () => {
    const { club: clubA, burger: burgerA } = await bootstrapLounge("MS Tenant A");
    const { club: clubB } = await bootstrapLounge("MS Tenant B");
    await setEmailIntegration(clubA.id, {
      tenantId: "tenant-A", clientId: "client-A",
      clientSecret: "secret-A", fromMailbox: "receipts@a.test",
    });
    await setEmailIntegration(clubB.id, {
      tenantId: "tenant-B", clientId: "client-B",
      clientSecret: "secret-B", fromMailbox: "receipts@b.test",
    });
    const principalA = await clubAdminPrincipal(clubA.id, "iso");
    const memberA = await memberWithEmail(clubA.id, "memberA@example.com");

    const { transport, captured } = makeCapturingTransport();
    setGraphTransportForTest(transport);

    await settleAndReturnCheck({
      clubId: clubA.id, principal: principalA, memberId: memberA.id, burgerId: burgerA.id,
      paymentMethod: "MEMBER_ACCOUNT",
    });

    // Token + send must have used tenant-A / client-A / receipts@a.test —
    // never any of B's values.
    expect(captured.tokenCalls).toHaveLength(1);
    expect(captured.tokenCalls[0].tenantId).toBe("tenant-A");
    expect(captured.tokenCalls[0].clientId).toBe("client-A");
    expect(captured.tokenCalls[0].clientSecret).toBe("secret-A");
    expect(captured.sendCalls[0].fromMailbox).toBe("receipts@a.test");
  });

  it("the client secret is never written to receiptEmailFailure or EmailDeliveryEvent.reason", async () => {
    const { club, burger } = await bootstrapLounge("MS Secret Club");
    const SECRET = "shh-do-not-leak-me-1234567890";
    await setEmailIntegration(club.id, {
      tenantId: "tenant-x", clientId: "client-x",
      clientSecret: SECRET, fromMailbox: "receipts@x.test",
    });
    const principal = await clubAdminPrincipal(club.id, "secret");
    const member = await memberWithEmail(club.id, "leak@example.com");

    // Force the transport's error message to *include* the secret as a
    // worst-case: the adapter MUST scrub it before persisting.
    const transport: GraphTransport = {
      async fetchToken() {
        throw new Error(`Mock blew up; secret=${SECRET} embedded in trace`);
      },
      async sendMail() {
        return { requestId: null };
      },
    };
    setGraphTransportForTest(transport);

    const { check } = await settleAndReturnCheck({
      clubId: club.id, principal, memberId: member.id, burgerId: burger.id,
      paymentMethod: "MEMBER_ACCOUNT",
    });

    const after = await db().pOSCheck.findUnique({ where: { id: check!.id } });
    expect(after?.receiptEmailStatus).toBe("FAILED");
    expect(after?.receiptEmailFailure ?? "").not.toContain(SECRET);
    expect(after?.receiptEmailFailure ?? "").toMatch(/\*\*\*/);

    const events = await db().emailDeliveryEvent.findMany({ where: { clubId: club.id } });
    for (const e of events) {
      expect(e.reason ?? "").not.toContain(SECRET);
    }
  });
});
