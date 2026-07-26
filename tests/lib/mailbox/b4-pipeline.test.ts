// Sprint 2 B4 (2026-07-19) — End-to-end pipeline tests.
//
// Coverage:
//   sanitizer         → HTML fixtures (safe, script injection, tracking
//                        pixel, malformed, oversized)
//   normalizer        → missing sender / subject / body
//   classifier        → rule precedence + suppression
//   materializer      → idempotency + orchestration preservation
//   sync              → mocked round trip through the MailboxConnection
//                        + EmailMessage + WorkIntakeItem + activity
//   Mission Control   → merge policy + personal-mailbox visibility

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { sanitizeEmailHtml, htmlToText } from "@/lib/mailbox/sanitize";
import { normalizeGraphMessage, stableIdentityForEmail } from "@/lib/mailbox/normalize";
import { classifyEmail, CLASSIFIER_RULES } from "@/lib/mailbox/classifier";
import { upsertEmailIntake } from "@/lib/mailbox/email-materializer";
import { runInitialSyncForConnection } from "@/lib/mailbox/sync";
import { mergeWorkItems, loadEmailIntakeItems } from "@/lib/mission-control/email-intake";
import {
  MockMicrosoftDelegatedProvider,
} from "@/lib/integrations/microsoft-graph-delegated-mock";
import {
  setMicrosoftDelegatedProvider,
} from "@/lib/integrations/microsoft-graph-delegated";
import { startConnect, finaliseConnection } from "@/lib/mailbox/connect";
import type { RawGraphMessage } from "@/lib/integrations/microsoft-graph-delegated";
import type { Principal } from "@/lib/rbac";
import {
  resolveIntake,
  assignToSelf,
  markInformational,
} from "@/lib/work-intake/actions";

// ---------------------------------------------------------------------------
// Sanitizer fixtures
// ---------------------------------------------------------------------------
describe("sanitizeEmailHtml (§5 sanitization contract)", () => {
  it("strips <script> and event handlers", () => {
    const out = sanitizeEmailHtml('<p>hi <script>alert(1)</script></p><p onclick="steal()">x</p>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onclick");
    expect(out).toContain("hi");
  });

  it("neutralises remote image src (blocks tracking pixels)", () => {
    const out = sanitizeEmailHtml('<img src="https://tracker.example/pixel.gif" width="1" height="1" alt="p">');
    expect(out).toContain('src="about:blank"');
    expect(out).not.toContain("tracker.example");
    // Alt + geometry preserved.
    expect(out).toContain('alt="p"');
  });

  it("forces safe attributes on <a>", () => {
    const out = sanitizeEmailHtml('<a href="https://example.com" target="_top" onclick="x()">go</a>');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('target="_blank"');
    expect(out).not.toContain("onclick");
    expect(out).not.toContain('target="_top"');
  });

  it("rejects javascript: URLs", () => {
    const out = sanitizeEmailHtml('<a href="javascript:alert(1)">click</a>');
    // sanitize-html drops the href entirely when the scheme is not allowed.
    expect(out).not.toContain("javascript:");
  });

  it("survives malformed HTML without throwing", () => {
    expect(() => sanitizeEmailHtml("<p>a<div><b>no close")).not.toThrow();
  });

  it("truncates oversized bodies", () => {
    const huge = "<p>" + "a".repeat(500_000) + "</p>";
    const out = sanitizeEmailHtml(huge, { maxBytes: 10_000 });
    expect(out.length).toBeLessThan(20_000);
    expect(out).toContain("truncated by Spectre");
  });

  it("htmlToText yields readable plaintext without markup", () => {
    const t = htmlToText("<p>Hello <b>world</b><script>bad()</script></p><p>Second para</p>");
    expect(t).not.toContain("<");
    expect(t).toContain("Hello world");
    expect(t).toContain("Second para");
    expect(t).not.toContain("bad()");
  });
});

// ---------------------------------------------------------------------------
// Normalizer fixtures
// ---------------------------------------------------------------------------
describe("normalizeGraphMessage (§5)", () => {
  const base: RawGraphMessage = {
    id: "AAMkAD-fake",
    internetMessageId: "<internet-abc@corp.test>",
    conversationId: "conv-1",
    from: { emailAddress: { address: "Sender@Example.COM", name: "Sender Person" } },
    toRecipients: [{ emailAddress: { address: "you@corp.test" } }],
    subject: "Hello  world",
    receivedDateTime: "2026-07-19T12:00:00Z",
    bodyPreview: "hello preview",
    body: { contentType: "html", content: "<p>hi</p>" },
    importance: "normal",
    hasAttachments: false,
  };

  it("lowercases and single-line-truncates the sender address", () => {
    const n = normalizeGraphMessage(base);
    expect(n.senderAddress).toBe("sender@example.com");
    expect(n.subject).toBe("Hello world");
  });

  it("falls back to 'Unknown sender' when name and address are both absent", () => {
    const n = normalizeGraphMessage({ ...base, from: null, sender: null });
    expect(n.senderName).toBe("Unknown sender");
    expect(n.senderAddress).toBe("");
  });

  it("substitutes '(no subject)' for empty subjects", () => {
    const n = normalizeGraphMessage({ ...base, subject: "" });
    expect(n.subject).toBe("(no subject)");
  });

  it("produces sanitized bodyHtml when body is html", () => {
    const n = normalizeGraphMessage({
      ...base,
      body: { contentType: "html", content: "<p>ok<script>bad</script></p>" },
    });
    expect(n.bodyHtmlSanitized).not.toContain("<script");
  });

  it("stableIdentityForEmail prefers immutableId, then internetMessageId", () => {
    const nWithImmutable = normalizeGraphMessage({ ...base, immutableId: "IMM_1" });
    expect(stableIdentityForEmail(nWithImmutable)).toBe("IMM_1");
    const nWithoutImmutable = normalizeGraphMessage({ ...base });
    expect(stableIdentityForEmail(nWithoutImmutable)).toBe("<internet-abc@corp.test>");
  });
});

// ---------------------------------------------------------------------------
// Classifier fixtures
// ---------------------------------------------------------------------------
describe("classifyEmail (§9)", () => {
  function make(overrides: Partial<Parameters<typeof classifyEmail>[0]>) {
    return classifyEmail({
      graphMessageId: "id",
      immutableId: null,
      internetMessageId: null,
      conversationId: null,
      senderAddress: overrides.senderAddress ?? "someone@corp.test",
      senderName: overrides.senderName ?? "Some One",
      recipients: { to: ["you@corp.test"], cc: [], bcc: [] },
      subject: overrides.subject ?? "hi",
      receivedAt: new Date(),
      sentAt: null,
      preview: overrides.preview ?? "",
      bodyHtmlSanitized: null,
      bodyTextExtract: null,
      importance: overrides.importance ?? "normal",
      isRead: false,
      hasAttachments: overrides.hasAttachments ?? false,
      webLink: null,
      isRemoved: false,
      headers: overrides.headers ?? {},
    });
  }

  it("classifies a PDF invoice as INVOICE_LIKELY with high confidence", () => {
    const c = make({
      senderAddress: "billing@pepsi.com",
      subject: "Invoice #12345",
      hasAttachments: true,
    });
    expect(c.label).toBe("INVOICE_LIKELY");
    expect(c.confidence).toBeGreaterThan(0.7);
    expect(c.intakeAction).toBe("CREATE_ACTIONABLE");
    expect(c.ruleKey).toBe("vendor_invoice_via_pdf_and_keywords");
  });

  it("classifies a keyword-only invoice at lower confidence", () => {
    const c = make({ subject: "Please pay: invoice for services" });
    expect(c.label).toBe("INVOICE_LIKELY");
    expect(c.confidence).toBeLessThan(0.7);
    expect(c.confidence).not.toBe(1.0); // never auto-1.0 for rule execution
  });

  it("suppresses list mail via List-Unsubscribe", () => {
    const c = make({ headers: { "list-unsubscribe": "<mailto:x@list.com>" } });
    expect(c.label).toBe("LIKELY_NOISE");
    expect(c.intakeAction).toBe("SUPPRESS");
  });

  it("suppresses no-reply automation", () => {
    const c = make({ senderAddress: "noreply@service.example" });
    expect(c.label).toBe("LIKELY_NOISE");
    expect(c.intakeAction).toBe("SUPPRESS");
  });

  it("falls through to INFORMATIONAL when nothing else matches", () => {
    const c = make({});
    expect(c.label).toBe("INFORMATIONAL");
    expect(c.intakeAction).toBe("CREATE_INFORMATIONAL");
  });

  it("rules registry has stable keys + versions (auditability)", () => {
    for (const rule of CLASSIFIER_RULES) {
      expect(rule.key).toMatch(/^[a-z_]+$/);
      expect(rule.version).toBeGreaterThan(0);
      expect(rule.confidence).toBeLessThanOrEqual(1.0);
      expect(rule.confidence).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Materializer / orchestration preservation
// ---------------------------------------------------------------------------
describe("email materializer — idempotency + orchestration preservation (§7)", () => {
  let userId: string;
  let clubId: string;
  let mailboxConnectionId: string;
  let emailRow: { id: string; graphMessageId: string };

  beforeEach(async () => {
    const club = await prisma.club.create({ data: { name: "MatClub", slug: `matclub-${Date.now()}` } });
    const user = await prisma.user.create({
      data: {
        name: "Mat User",
        email: `mat-${Date.now()}@x.test`,
        role: "CLUB_ADMIN",
        passwordHash: "x",
        clubId: club.id,
      },
    });
    clubId = club.id;
    userId = user.id;

    // Seed a mailbox connection + email row without going through OAuth.
    const conn = await prisma.mailboxConnection.create({
      data: {
        userId,
        clubId,
        provider: "MICROSOFT_365",
        mailboxType: "PERSONAL",
        externalUserId: "ext_mat_" + Date.now(),
        microsoftTenantId: "00000000-0000-0000-0000-tenantmat00",
        connectedEmail: "mat@example.test",
        accessTokenSecretRef: "enc:fake",
        refreshTokenSecretRef: "enc:fake",
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        grantedScopes: "openid Mail.Read",
        status: "CONNECTED_PENDING_SYNC",
      },
    });
    mailboxConnectionId = conn.id;
    emailRow = await prisma.emailMessage.create({
      data: {
        clubId,
        mailboxConnectionId,
        graphMessageId: "graph_m_1_" + Date.now(),
        senderName: "Vendor Person",
        senderAddress: "billing@pepsi.com",
        recipientsJson: JSON.stringify({ to: ["you@corp.test"], cc: [], bcc: [] }),
        subject: "Invoice #A-42",
        receivedAt: new Date("2026-07-18T09:00:00Z"),
        preview: "please pay by end of month",
        importance: "normal",
        hasAttachments: true,
        lastSyncedAt: new Date(),
      },
    });
  });

  it("creates an intake and PRIMARY link on first run; second run reuses it (idempotent)", async () => {
    const email = (await prisma.emailMessage.findUnique({ where: { id: emailRow.id } }))!;
    const first = await upsertEmailIntake({
      clubId,
      email,
      classification: {
        label: "INVOICE_LIKELY",
        method: "RULE",
        ruleKey: "vendor_invoice_via_pdf_and_keywords",
        ruleVersion: 1,
        reason: "test",
        confidence: 0.85,
        intakeAction: "CREATE_ACTIONABLE",
      },
    });
    expect(first).not.toBeNull();
    const second = await upsertEmailIntake({
      clubId,
      email,
      classification: {
        label: "INVOICE_LIKELY",
        method: "RULE",
        ruleKey: "vendor_invoice_via_pdf_and_keywords",
        ruleVersion: 1,
        reason: "test",
        confidence: 0.85,
        intakeAction: "CREATE_ACTIONABLE",
      },
    });
    expect(second?.id).toBe(first!.id);
    // Only one PRIMARY link + one intake per email.
    const links = await prisma.emailWorkIntakeOrigin.findMany({
      where: { emailMessageId: email.id, role: "PRIMARY" },
    });
    expect(links).toHaveLength(1);
  });

  it("resync does NOT reset owner / status / deferredUntil / resolvedAt (I2)", async () => {
    const email = (await prisma.emailMessage.findUnique({ where: { id: emailRow.id } }))!;
    const intake = await upsertEmailIntake({
      clubId,
      email,
      classification: {
        label: "INVOICE_LIKELY",
        method: "RULE",
        ruleKey: "vendor_invoice_via_pdf_and_keywords",
        ruleVersion: 1,
        reason: "test",
        confidence: 0.85,
        intakeAction: "CREATE_ACTIONABLE",
      },
    });
    // Simulate user actions.
    const deferUntil = new Date(Date.now() + 24 * 3600_000);
    await prisma.workIntakeItem.update({
      where: { id: intake!.id },
      data: {
        status: "DEFERRED",
        ownerUserId: userId,
        judgmentRequired: true,
        deferredUntil: deferUntil,
      },
    });
    // Resync.
    await upsertEmailIntake({
      clubId,
      email,
      classification: {
        label: "INVOICE_LIKELY",
        method: "RULE",
        ruleKey: "vendor_invoice_via_pdf_and_keywords",
        ruleVersion: 2, // even a new version doesn't stomp orchestration
        reason: "test v2",
        confidence: 0.9,
        intakeAction: "CREATE_ACTIONABLE",
      },
    });
    const after = await prisma.workIntakeItem.findUnique({ where: { id: intake!.id } });
    expect(after?.status).toBe("DEFERRED");
    expect(after?.ownerUserId).toBe(userId);
    expect(after?.deferredUntil?.toISOString()).toBe(deferUntil.toISOString());
    // Classification updated because no override was set.
    expect(after?.classificationRuleVersion).toBe(2);
  });

  it("user classification override survives resync (I3)", async () => {
    const email = (await prisma.emailMessage.findUnique({ where: { id: emailRow.id } }))!;
    const intake = await upsertEmailIntake({
      clubId,
      email,
      classification: {
        label: "INVOICE_LIKELY",
        method: "RULE",
        ruleKey: "vendor_invoice_via_pdf_and_keywords",
        ruleVersion: 1,
        reason: "test",
        confidence: 0.85,
        intakeAction: "CREATE_ACTIONABLE",
      },
    });
    await prisma.workIntakeItem.update({
      where: { id: intake!.id },
      data: {
        classification: "MEMBER_INQUIRY_LIKELY",
        classificationMethod: "USER",
        classificationOverriddenByUserId: userId,
        classificationOverriddenAt: new Date(),
      },
    });
    await upsertEmailIntake({
      clubId,
      email,
      classification: {
        label: "INVOICE_LIKELY",
        method: "RULE",
        ruleKey: "vendor_invoice_via_pdf_and_keywords",
        ruleVersion: 1,
        reason: "test",
        confidence: 0.85,
        intakeAction: "CREATE_ACTIONABLE",
      },
    });
    const after = await prisma.workIntakeItem.findUnique({ where: { id: intake!.id } });
    expect(after?.classification).toBe("MEMBER_INQUIRY_LIKELY");
    expect(after?.classificationMethod).toBe("USER");
  });

  it("SUPPRESS action creates no intake row on first materialise", async () => {
    const email = (await prisma.emailMessage.findUnique({ where: { id: emailRow.id } }))!;
    const result = await upsertEmailIntake({
      clubId,
      email,
      classification: {
        label: "LIKELY_NOISE",
        method: "RULE",
        ruleKey: "list_mail_or_marketing",
        ruleVersion: 1,
        reason: "list mail",
        confidence: 0.9,
        intakeAction: "SUPPRESS",
      },
    });
    expect(result).toBeNull();
    const items = await prisma.workIntakeItem.findMany({ where: { clubId } });
    expect(items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end sync mocked pipeline
// ---------------------------------------------------------------------------
describe("initial sync — mocked round trip", () => {
  let userId: string;
  let clubId: string;
  let mailboxConnectionId: string;
  let provider: MockMicrosoftDelegatedProvider;

  beforeEach(async () => {
    const club = await prisma.club.create({ data: { name: "SyncClub", slug: `sync-${Date.now()}` } });
    const user = await prisma.user.create({
      data: {
        name: "Sync User",
        email: `sync-${Date.now()}@x.test`,
        role: "CLUB_ADMIN",
        passwordHash: "x",
        clubId: club.id,
      },
    });
    clubId = club.id;
    userId = user.id;
    provider = new MockMicrosoftDelegatedProvider({
      tenantId: "00000000-0000-0000-0000-tenantsync0",
      externalUserId: "ext_sync_" + Date.now(),
      connectedEmail: "sync@corp.test",
      displayName: "Sync User",
    });
    setMicrosoftDelegatedProvider(provider);
    // OAuth round trip → conn in CONNECTED_PENDING_SYNC.
    const started = await startConnect({ userId, clubId, returnPath: "/app/user/settings/connected-accounts" });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const tx = await prisma.mailboxOAuthTransaction.findUnique({ where: { state } });
    provider.updateConfig({ echoNonce: tx!.nonce });
    const res = await finaliseConnection({
      state,
      code: "code",
      callerUserId: userId,
      callerClubId: clubId,
    });
    mailboxConnectionId = res.mailboxConnectionId;
  });
  afterEach(() => setMicrosoftDelegatedProvider(null));

  function makeMsg(overrides: Partial<RawGraphMessage>): RawGraphMessage {
    return {
      id: overrides.id ?? `graph_${Math.random().toString(36).slice(2, 8)}`,
      internetMessageId: overrides.internetMessageId ?? `<${Math.random().toString(36).slice(2)}@corp.test>`,
      from: overrides.from ?? { emailAddress: { address: "vendor@example.com", name: "Vendor" } },
      subject: overrides.subject ?? "Regular update",
      receivedDateTime: overrides.receivedDateTime ?? new Date().toISOString(),
      bodyPreview: overrides.bodyPreview ?? "hi",
      body: overrides.body ?? { contentType: "text", content: "hi there" },
      importance: overrides.importance ?? "normal",
      hasAttachments: overrides.hasAttachments ?? false,
      ...overrides,
    };
  }

  it("imports messages, materializes intake, and lands the connection in CONNECTED", async () => {
    provider.setFixtureMessages([
      makeMsg({ subject: "Invoice #999 attached", hasAttachments: true, from: { emailAddress: { address: "billing@pepsi.com", name: "Pepsi" } } }),
      makeMsg({ subject: "Newsletter — Weekly", internetMessageHeaders: [{ name: "List-Unsubscribe", value: "<mailto:u@lists.example>" }] }),
      makeMsg({ subject: "Question about my reservation", from: { emailAddress: { address: "member@family.test", name: "Member" } } }),
    ]);
    const result = await runInitialSyncForConnection({ mailboxConnectionId });
    expect(result.outcome).toBe("COMPLETED");
    expect(result.messagesExamined).toBe(3);

    // EmailMessage rows persisted for all 3.
    const emails = await prisma.emailMessage.findMany({ where: { mailboxConnectionId } });
    expect(emails).toHaveLength(3);

    // Intake items: invoice + reservation created; newsletter suppressed.
    const intake = await prisma.workIntakeItem.findMany({ where: { clubId } });
    expect(intake).toHaveLength(2);
    const labels = intake.map((i) => i.classification).sort();
    expect(labels).toEqual(["INVOICE_LIKELY", "MEMBER_INQUIRY_LIKELY"]);

    // Connection transitioned CONNECTED_PENDING_SYNC → CONNECTED.
    const conn = await prisma.mailboxConnection.findUnique({ where: { id: mailboxConnectionId } });
    expect(conn?.status).toBe("CONNECTED");
    expect(conn?.lastSuccessfulSyncAt).not.toBeNull();
  });

  it("second sync run does not duplicate messages or intake", async () => {
    // Two back-to-back syncs against the SAME fixture. The
    // idempotency contract is enforced by the `(mailboxConnectionId,
    // graphMessageId)` unique constraint on EmailMessage and the
    // `(workIntakeItemId, emailMessageId)` unique constraint on
    // EmailWorkIntakeOrigin; a second run should observe an existing
    // row and take the update / upsert branch.
    const seed = {
      id: "stable-1",
      internetMessageId: "<stable-1@corp.test>",
      subject: "Invoice #1",
      hasAttachments: true,
      from: { emailAddress: { address: "billing@pepsi.com", name: "Pepsi" } },
    } as const;
    provider.setFixtureMessages([makeMsg(seed)]);
    await runInitialSyncForConnection({ mailboxConnectionId });
    provider.setFixtureMessages([makeMsg(seed)]);
    await runInitialSyncForConnection({ mailboxConnectionId });
    // Two facts we care about:
    //   1. There is EXACTLY ONE EmailMessage per (connection, graphId).
    //      Multi-row here would mean the unique constraint is not
    //      firing, which is the actual bug we're testing for.
    const perGraphId = await prisma.emailMessage.groupBy({
      by: ["mailboxConnectionId", "graphMessageId"],
      where: { mailboxConnectionId },
      _count: { _all: true },
    });
    for (const row of perGraphId) {
      expect(row._count._all).toBe(1);
    }
    //   2. There is EXACTLY ONE PRIMARY link per email.
    const links = await prisma.emailWorkIntakeOrigin.findMany({
      where: { emailMessage: { mailboxConnectionId }, role: "PRIMARY" },
    });
    const grouped = new Map<string, number>();
    for (const l of links) grouped.set(l.emailMessageId, (grouped.get(l.emailMessageId) ?? 0) + 1);
    for (const [, n] of grouped) expect(n).toBe(1);
  });

  it("sync on a disconnected connection is a safe no-op", async () => {
    // Disconnect first.
    await prisma.mailboxConnection.update({
      where: { id: mailboxConnectionId },
      data: {
        status: "DISCONNECTED",
        accessTokenSecretRef: null,
        refreshTokenSecretRef: null,
      },
    });
    const result = await runInitialSyncForConnection({ mailboxConnectionId });
    expect(result.outcome).toBe("SKIPPED");
    const emails = await prisma.emailMessage.findMany({ where: { mailboxConnectionId } });
    expect(emails).toHaveLength(0);
  });

  it("terminal Graph error flips the connection to REAUTH_REQUIRED", async () => {
    provider.setListInboxOutcome("TERMINAL_INVALID_GRANT");
    const result = await runInitialSyncForConnection({ mailboxConnectionId });
    expect(result.outcome).toBe("TERMINAL");
    const conn = await prisma.mailboxConnection.findUnique({ where: { id: mailboxConnectionId } });
    expect(conn?.status).toBe("REAUTH_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// Mission Control merge policy + personal-mailbox visibility
// ---------------------------------------------------------------------------
describe("Mission Control merge (§13)", () => {
  it("mergeWorkItems orders judgment > approval > comm > info within each priority", () => {
    const now = new Date();
    const mk = (idTag: string, state: "judgment" | "approval" | "comm" | "info", when: Date) => ({
      id: idTag,
      state,
      idTag,
      title: idTag,
      sender: { from: "x" },
      timestamp: when.toISOString(),
      timestampLabel: "x",
      actions: [],
    });
    const merged = mergeWorkItems({
      ap: [mk("AP-1", "approval", new Date(now.getTime() - 100))],
      ar: [mk("AR-1", "judgment", new Date(now.getTime() - 200))],
      email: [
        mk("MAIL-1", "comm", new Date(now.getTime() - 50)),
        mk("MAIL-2", "info", now),
      ],
    });
    expect(merged.map((m) => m.idTag)).toEqual(["AR-1", "AP-1", "MAIL-1", "MAIL-2"]);
  });

  it("does not surface another user's PERSONAL mailbox email", async () => {
    const club = await prisma.club.create({ data: { name: "PrivClub", slug: `priv-${Date.now()}` } });
    const alice = await prisma.user.create({
      data: {
        name: "Alice",
        email: `alice-${Date.now()}@x.test`,
        role: "CLUB_ADMIN",
        passwordHash: "x",
        clubId: club.id,
      },
    });
    const bob = await prisma.user.create({
      data: {
        name: "Bob",
        email: `bob-${Date.now()}@x.test`,
        role: "CLUB_ADMIN",
        passwordHash: "x",
        clubId: club.id,
      },
    });
    // Alice's mailbox + email + intake.
    const conn = await prisma.mailboxConnection.create({
      data: {
        userId: alice.id,
        clubId: club.id,
        provider: "MICROSOFT_365",
        mailboxType: "PERSONAL",
        externalUserId: "ext_alice_" + Date.now(),
        microsoftTenantId: "00000000-0000-0000-0000-tenantalice",
        connectedEmail: "alice@corp.test",
        accessTokenSecretRef: "enc:x",
        refreshTokenSecretRef: "enc:x",
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        grantedScopes: "Mail.Read",
        status: "CONNECTED",
      },
    });
    const email = await prisma.emailMessage.create({
      data: {
        clubId: club.id,
        mailboxConnectionId: conn.id,
        graphMessageId: "priv_" + Date.now(),
        senderName: "Vendor",
        senderAddress: "billing@example.test",
        recipientsJson: "{}",
        subject: "Alice private invoice",
        receivedAt: new Date(),
        preview: "…",
        importance: "normal",
        hasAttachments: false,
        lastSyncedAt: new Date(),
      },
    });
    const intake = await prisma.workIntakeItem.create({
      data: {
        clubId: club.id,
        status: "OPEN",
        judgmentRequired: true,
        displaySourceLabel: "Outlook",
        displaySender: "Vendor",
        displaySubject: email.subject,
        displayPreview: "…",
        displayReceivedAt: email.receivedAt,
      },
    });
    await prisma.emailWorkIntakeOrigin.create({
      data: {
        clubId: club.id,
        workIntakeItemId: intake.id,
        emailMessageId: email.id,
        role: "PRIMARY",
      },
    });
    const bobPrincipal: Principal = {
      id: bob.id,
      name: "Bob",
      email: bob.email,
      status: "ACTIVE",
      activeClubId: club.id,
      memberships: [{ clubId: club.id, roleKey: "CLUB_ADMIN" }],
      memberId: null,
    };
    const items = await loadEmailIntakeItems({ principal: bobPrincipal, clubId: club.id, now: new Date() });
    expect(items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Work Intake actions
// ---------------------------------------------------------------------------
describe("Work Intake actions (§15)", () => {
  let userId: string;
  let clubId: string;
  let intakeId: string;

  beforeEach(async () => {
    const club = await prisma.club.create({ data: { name: "ActClub", slug: `act-${Date.now()}` } });
    const user = await prisma.user.create({
      data: {
        name: "Act User",
        email: `act-${Date.now()}@x.test`,
        role: "CLUB_ADMIN",
        passwordHash: "x",
        clubId: club.id,
      },
    });
    clubId = club.id;
    userId = user.id;
    // Seed a mailbox + email + intake with the user as owner.
    const conn = await prisma.mailboxConnection.create({
      data: {
        userId,
        clubId,
        provider: "MICROSOFT_365",
        mailboxType: "PERSONAL",
        externalUserId: "ext_act_" + Date.now(),
        microsoftTenantId: "00000000-0000-0000-0000-tenantact00",
        connectedEmail: "act@corp.test",
        accessTokenSecretRef: "enc:x",
        refreshTokenSecretRef: "enc:x",
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        grantedScopes: "Mail.Read",
        status: "CONNECTED",
      },
    });
    const email = await prisma.emailMessage.create({
      data: {
        clubId,
        mailboxConnectionId: conn.id,
        graphMessageId: "act_" + Date.now(),
        senderName: "Vendor",
        senderAddress: "vendor@example.test",
        recipientsJson: "{}",
        subject: "Please review",
        receivedAt: new Date(),
        preview: "please",
        importance: "normal",
        hasAttachments: false,
        lastSyncedAt: new Date(),
      },
    });
    const intake = await prisma.workIntakeItem.create({
      data: {
        clubId,
        status: "OPEN",
        judgmentRequired: true,
        displaySourceLabel: "Outlook",
        displaySender: "Vendor",
        displaySubject: email.subject,
        displayPreview: "please",
        displayReceivedAt: email.receivedAt,
      },
    });
    await prisma.emailWorkIntakeOrigin.create({
      data: {
        clubId,
        workIntakeItemId: intake.id,
        emailMessageId: email.id,
        role: "PRIMARY",
      },
    });
    intakeId = intake.id;
  });

  const principal = (userId: string, clubId: string): Principal => ({
    id: userId,
    name: "Act User",
    email: "x@x.test",
    status: "ACTIVE",
    activeClubId: clubId,
    memberships: [{ clubId, roleKey: "CLUB_ADMIN" }],
    memberId: null,
  });

  it("resolveIntake sets RESOLVED + appends activity", async () => {
    await resolveIntake({ principal: principal(userId, clubId), clubId, workIntakeItemId: intakeId });
    const after = await prisma.workIntakeItem.findUnique({ where: { id: intakeId } });
    expect(after?.status).toBe("RESOLVED");
    expect(after?.resolvedByUserId).toBe(userId);
    const activity = await prisma.workIntakeActivity.findMany({ where: { workIntakeItemId: intakeId } });
    expect(activity.some((a) => a.action === "RESOLVED")).toBe(true);
  });

  it("assignToSelf transitions OPEN → IN_PROGRESS + records activity", async () => {
    await assignToSelf({ principal: principal(userId, clubId), clubId, workIntakeItemId: intakeId });
    const after = await prisma.workIntakeItem.findUnique({ where: { id: intakeId } });
    expect(after?.ownerUserId).toBe(userId);
    expect(after?.status).toBe("IN_PROGRESS");
  });

  it("markInformational sets INFORMATIONAL + drops judgmentRequired", async () => {
    await markInformational({ principal: principal(userId, clubId), clubId, workIntakeItemId: intakeId });
    const after = await prisma.workIntakeItem.findUnique({ where: { id: intakeId } });
    expect(after?.status).toBe("INFORMATIONAL");
    expect(after?.judgmentRequired).toBe(false);
  });
});

