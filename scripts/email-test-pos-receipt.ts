// Live end-to-end verification of POS receipt email delivery.
//
//   npm run email:test-pos-receipt
//
// What it does:
//   1. Confirms EMAIL_DELIVERY_MODE=smtp and the SMTP_* vars are set.
//   2. Opens a TCP probe against SMTP_HOST:SMTP_PORT.
//   3. Looks up the target test member (Owen Beauchamp by default).
//   4. Runs three real settlements:
//        a. MEMBER_ACCOUNT settlement → expects a receipt email
//        b. QR_PAY then confirmQRPayment → expects a receipt email
//        c. QR_PAY then declineQRPayment → expects NO receipt email
//   5. Polls the local Maildev inbox at MAILDEV_WEB to confirm each
//      email actually landed (and that the decline scenario did not).
//   6. Prints a summary with inbox URL, masked recipient, and per-step
//      outcomes. Exits 0 on full pass, 1 on any failure.
//
// Safe to re-run: each run opens fresh checks and settles them
// independently. It does NOT email production providers because the
// only delivery path it uses is the configured EMAIL_DELIVERY_MODE.

// Side-effect import — loads .env.local + .env BEFORE env.ts is
// evaluated. ES module import order matters: this must precede any
// import that touches src/lib/env.ts (directly or transitively).
import "./lib/preload-env";

import net from "node:net";
import { env } from "../src/lib/env";
import { prisma } from "../src/lib/prisma";
import { loadPrincipal } from "../src/lib/rbac";
import {
  openCheck,
  addCheckLines,
  sendUnsentItems,
  settleCheck,
  confirmQRPayment,
  declineQRPayment,
} from "../src/lib/pos/checks";
import { LOUNGE_LOCATION_CODE } from "../src/lib/pos/lounge";

// -----------------------------------------------------------------
// Config
// -----------------------------------------------------------------
const TARGET_FIRST = process.env.TEST_MEMBER_FIRST ?? "Owen";
const TARGET_LAST = process.env.TEST_MEMBER_LAST ?? "Beauchamp";
const MAILDEV_WEB = process.env.MAILDEV_WEB ?? "http://localhost:8025";
const APP_ORIGIN = process.env.APP_ORIGIN ?? "http://localhost:3000";

type Step = { name: string; ok: boolean; detail: string };
const steps: Step[] = [];
function record(name: string, ok: boolean, detail: string) {
  steps.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name} — ${detail}`);
}

function mask(email: string | null | undefined): string {
  if (!email) return "(no email)";
  const [n, h] = email.split("@");
  if (!h) return email;
  return `${n.slice(0, 1)}${"*".repeat(Math.max(2, n.length - 1))}@${h}`;
}

// -----------------------------------------------------------------
// 1. Env validation
// -----------------------------------------------------------------
function checkEnv(): boolean {
  if (env.EMAIL_DELIVERY_MODE !== "smtp") {
    record("env mode", false, `EMAIL_DELIVERY_MODE=${env.EMAIL_DELIVERY_MODE ?? "(unset)"} — set to 'smtp' in .env.local`);
    return false;
  }
  if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_FROM) {
    record("env smtp config", false, `SMTP_HOST=${env.SMTP_HOST}, SMTP_PORT=${env.SMTP_PORT}, SMTP_FROM=${env.SMTP_FROM}`);
    return false;
  }
  record("env mode", true, `EMAIL_DELIVERY_MODE=smtp, host=${env.SMTP_HOST}:${env.SMTP_PORT}, from=${env.SMTP_FROM}`);
  return true;
}

// -----------------------------------------------------------------
// 2. SMTP TCP reachability
// -----------------------------------------------------------------
async function checkSmtpReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const host = env.SMTP_HOST!;
    const port = env.SMTP_PORT!;
    const sock = net.createConnection({ host, port, timeout: 3000 });
    sock.once("connect", () => {
      sock.end();
      record("smtp reachable", true, `${host}:${port}`);
      resolve(true);
    });
    sock.once("error", (err) => {
      record("smtp reachable", false, `${host}:${port} — ${err.message} (is Maildev running? try: npm run mail:dev)`);
      resolve(false);
    });
    sock.once("timeout", () => {
      sock.destroy();
      record("smtp reachable", false, `${host}:${port} — connect timeout`);
      resolve(false);
    });
  });
}

// -----------------------------------------------------------------
// 3. Member + admin lookup
// -----------------------------------------------------------------
async function loadFixtures() {
  const member = await prisma.member.findFirst({
    where: { firstName: TARGET_FIRST, lastName: TARGET_LAST },
    select: { id: true, clubId: true, email: true, firstName: true, lastName: true, memberNumber: true },
  });
  if (!member) throw new Error(`Test member not found: ${TARGET_FIRST} ${TARGET_LAST}`);
  if (!member.email || !member.email.includes("@")) {
    throw new Error(`Test member ${member.firstName} has no email on file — update the profile first.`);
  }
  const adminRole = await prisma.userClubRole.findFirst({
    where: { clubId: member.clubId, roleKey: "CLUB_ADMIN" },
    include: { user: { select: { id: true } } },
  });
  if (!adminRole?.user) throw new Error(`No CLUB_ADMIN user for clubId=${member.clubId}`);
  const principal = await loadPrincipal(adminRole.user.id, member.clubId);
  if (!principal) throw new Error(`Failed to load principal for admin ${adminRole.user.id}`);

  // Pick the lounge location + an active taxable menu item.
  const loc = await prisma.pOSLocation.findFirst({
    where: { clubId: member.clubId, code: LOUNGE_LOCATION_CODE },
  });
  if (!loc) throw new Error(`Lounge location ${LOUNGE_LOCATION_CODE} not provisioned for ${member.clubId}`);
  const item = await prisma.pOSMenuItem.findFirst({
    where: {
      isActive: true,
      taxable: true,
      category: { locationId: loc.id, isActive: true },
    },
    select: { id: true, name: true },
  });
  if (!item) throw new Error(`No active taxable menu item available in ${loc.name}`);

  return { member, principal, item };
}

// -----------------------------------------------------------------
// 4. Maildev inbox poller — returns inbox items whose `to` includes
//    the target email, ordered newest first.
// -----------------------------------------------------------------
type MailEntry = { id: string; subject: string; to: Array<{ address: string }>; time: string };
async function fetchMaildevInbox(): Promise<MailEntry[]> {
  const res = await fetch(`${MAILDEV_WEB}/email`);
  if (!res.ok) throw new Error(`Maildev API ${res.status} at ${MAILDEV_WEB}/email`);
  const data = (await res.json()) as MailEntry[];
  return data;
}

async function waitForInboxMessage(opts: {
  recipient: string;
  subjectContains: string;
  timeoutMs?: number;
}): Promise<MailEntry | null> {
  // Match by sale-number (globally unique) + recipient. We deliberately
  // don't filter by Maildev's `time` field — it's second-precision and a
  // sub-second poll race led to false negatives.
  const deadline = Date.now() + (opts.timeoutMs ?? 8000);
  while (Date.now() < deadline) {
    let mails: MailEntry[] = [];
    try { mails = await fetchMaildevInbox(); } catch { /* maildev still booting */ }
    const hit = mails.find(
      (m) =>
        m.subject.includes(opts.subjectContains) &&
        m.to.some((t) => t.address.toLowerCase() === opts.recipient.toLowerCase()),
    );
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

// -----------------------------------------------------------------
// 5. End-to-end settlement helpers
// -----------------------------------------------------------------
type Fixtures = Awaited<ReturnType<typeof loadFixtures>>;

async function settleMemberAccount(f: Fixtures) {
  const check = await openCheck(f.principal, f.member.clubId, { memberId: f.member.id });
  await addCheckLines(f.principal, check.id, {
    items: [{ menuItemId: f.item.id, quantity: 1 }],
  });
  await sendUnsentItems(f.principal, check.id);
  const { sale } = await settleCheck(f.principal, check.id, {
    paymentMethod: "MEMBER_ACCOUNT",
    allowUnsentLines: true,
    origin: APP_ORIGIN,
  });
  const after = await prisma.pOSCheck.findUnique({ where: { id: check.id } });
  const status = after?.receiptEmailStatus ?? null;
  const inboxHit = await waitForInboxMessage({
    recipient: f.member.email,
    subjectContains: sale.saleNumber,
  });
  return {
    checkId: check.id,
    saleNumber: sale.saleNumber,
    receiptEmailStatus: status,
    inboxFound: !!inboxHit,
    inboxId: inboxHit?.id ?? null,
  };
}

async function settleQRConfirm(f: Fixtures) {
  const check = await openCheck(f.principal, f.member.clubId, { memberId: f.member.id });
  await addCheckLines(f.principal, check.id, {
    items: [{ menuItemId: f.item.id, quantity: 1 }],
  });
  await sendUnsentItems(f.principal, check.id);
  const { sale } = await settleCheck(f.principal, check.id, {
    paymentMethod: "QR_PAY",
    allowUnsentLines: true,
    origin: APP_ORIGIN,
  });
  // Assert: pending state, no email yet.
  const pending = await prisma.pOSCheck.findUnique({ where: { id: check.id } });
  if (pending?.receiptEmailStatus) {
    return {
      checkId: check.id,
      saleNumber: sale.saleNumber,
      stage: "pending",
      receiptEmailStatus: pending.receiptEmailStatus,
      inboxFound: false,
      inboxId: null,
      error: "Email status set BEFORE QR confirm",
    };
  }
  await confirmQRPayment(f.principal, sale.id, { origin: APP_ORIGIN });
  const after = await prisma.pOSCheck.findUnique({ where: { id: check.id } });
  const inboxHit = await waitForInboxMessage({
    recipient: f.member.email,
    subjectContains: sale.saleNumber,
  });
  return {
    checkId: check.id,
    saleNumber: sale.saleNumber,
    stage: "confirmed",
    receiptEmailStatus: after?.receiptEmailStatus ?? null,
    inboxFound: !!inboxHit,
    inboxId: inboxHit?.id ?? null,
  };
}

async function settleQRDeclined(f: Fixtures) {
  const check = await openCheck(f.principal, f.member.clubId, { memberId: f.member.id });
  await addCheckLines(f.principal, check.id, {
    items: [{ menuItemId: f.item.id, quantity: 1 }],
  });
  await sendUnsentItems(f.principal, check.id);
  const { sale } = await settleCheck(f.principal, check.id, {
    paymentMethod: "QR_PAY",
    allowUnsentLines: true,
    origin: APP_ORIGIN,
  });
  await declineQRPayment(f.principal, sale.id, "verification: simulated decline");
  const after = await prisma.pOSCheck.findUnique({ where: { id: check.id } });
  // Wait briefly to ensure no email shows up.
  const inboxHit = await waitForInboxMessage({
    recipient: f.member.email,
    subjectContains: sale.saleNumber,
    timeoutMs: 2000,
  });
  return {
    checkId: check.id,
    saleNumber: sale.saleNumber,
    finalStatus: after?.status,
    receiptEmailStatus: after?.receiptEmailStatus ?? null,
    inboxFound: !!inboxHit,
  };
}

// -----------------------------------------------------------------
// Main
// -----------------------------------------------------------------
async function main() {
  // eslint-disable-next-line no-console
  console.log("\nPOS receipt email — live verification");
  // eslint-disable-next-line no-console
  console.log("=====================================\n");

  if (!checkEnv()) process.exit(1);
  const smtpUp = await checkSmtpReachable();
  if (!smtpUp) process.exit(1);

  const f = await loadFixtures();
  record(
    "fixtures",
    true,
    `member=${f.member.firstName} ${f.member.lastName} (${f.member.memberNumber}) → ${mask(f.member.email)}; menuItem="${f.item.name}"`,
  );

  // -- MEMBER_ACCOUNT path
  const ma = await settleMemberAccount(f);
  const maOk = ma.receiptEmailStatus === "SENT" && ma.inboxFound;
  record(
    "MEMBER_ACCOUNT settlement",
    maOk,
    `sale=${ma.saleNumber} · receiptEmailStatus=${ma.receiptEmailStatus} · inbox=${ma.inboxFound ? "DELIVERED" : "missing"}`,
  );

  // -- QR confirmed path
  const qc = await settleQRConfirm(f);
  const qcOk = qc.receiptEmailStatus === "SENT" && qc.inboxFound && !("error" in qc && qc.error);
  record(
    "QR confirmed settlement",
    qcOk,
    `sale=${qc.saleNumber} · status=${qc.receiptEmailStatus} · inbox=${qc.inboxFound ? "DELIVERED" : "missing"}${"error" in qc && qc.error ? ` · ERR=${qc.error}` : ""}`,
  );

  // -- QR declined path
  const qd = await settleQRDeclined(f);
  const qdOk = qd.receiptEmailStatus === null && !qd.inboxFound && qd.finalStatus === "PAYMENT_FAILED";
  record(
    "QR declined (no email)",
    qdOk,
    `sale=${qd.saleNumber} · final=${qd.finalStatus} · receiptEmailStatus=${qd.receiptEmailStatus} · inbox=${qd.inboxFound ? "WRONGLY DELIVERED" : "correctly absent"}`,
  );

  // -- Audit row counts
  const deliveryRows = await prisma.emailDeliveryEvent.findMany({
    where: { email: f.member.email },
    orderBy: { occurredAt: "desc" },
    take: 5,
  });
  record(
    "EmailDeliveryEvent rows",
    deliveryRows.length >= 2,
    `recent kinds=[${deliveryRows.map((r) => r.kind).join(", ")}], provider=${deliveryRows[0]?.provider ?? "n/a"}`,
  );

  // -- Summary
  // eslint-disable-next-line no-console
  console.log("\nSummary");
  // eslint-disable-next-line no-console
  console.log("-------");
  const allOk = steps.every((s) => s.ok);
  // eslint-disable-next-line no-console
  console.log(`Result:      ${allOk ? "ALL PASS" : "FAILURES"}`);
  // eslint-disable-next-line no-console
  console.log(`Tested as:   ${f.member.firstName} ${f.member.lastName} (${f.member.memberNumber})`);
  // eslint-disable-next-line no-console
  console.log(`Recipient:   ${mask(f.member.email)}`);
  // eslint-disable-next-line no-console
  console.log(`App URL:     ${APP_ORIGIN}`);
  // eslint-disable-next-line no-console
  console.log(`Inbox URL:   ${MAILDEV_WEB}`);
  // eslint-disable-next-line no-console
  console.log(`Repeat:      npm run email:test-pos-receipt`);
  // eslint-disable-next-line no-console
  console.log("");

  process.exit(allOk ? 0 : 1);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Verification script crashed:", err);
    process.exit(2);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
