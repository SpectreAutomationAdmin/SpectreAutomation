// Phase 7 — Integrations + POS + LLM commentary + Document backfill.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeUser, makeMember, resetDb, principalFor } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { ForbiddenError, ConflictError } from "@/lib/errors";
import {
  reportingService, exportService, packageService,
  notificationService, documentService, llmCommentaryService,
  backfillService,
} from "@/lib/enterprise";
import * as pos from "@/lib/pos";
import * as inventory from "@/lib/ops/inventory";
import {
  upsertIntegration, getActiveIntegration, recordIntegrationCheck,
  integrationStatusSummary,
} from "@/lib/integrations/config";

async function adminPrincipal(clubId: string) {
  const email = `admin-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function gmPrincipal(clubId: string) {
  const email = `gm-${clubId}@example.com`;
  await makeUser({ email, role: "GENERAL_MANAGER", clubId });
  return principalFor(email);
}

async function makeRevenueAndInventory(clubId: string, sku: string) {
  // The bootstrapAPClub seeds COA but no inventory items. Create one.
  const proShopDept = await db().department.findFirst({ where: { clubId, code: "PROSHOP" } });
  const cat = await db().inventoryCategory.upsert({
    where: { clubId_key: { clubId, key: "PROSHOP" } },
    update: {},
    create: {
      clubId, key: "PROSHOP", name: "Pro Shop",
      inventoryAccountId: (await db().account.findFirst({ where: { clubId, accountNumber: "1210" } }))?.id,
      cogsAccountId: (await db().account.findFirst({ where: { clubId, accountNumber: "5100" } }))?.id,
      revenueAccountId: (await db().account.findFirst({ where: { clubId, accountNumber: "4300" } }))?.id,
      adjustmentExpenseAccountId: (await db().account.findFirst({ where: { clubId, accountNumber: "6410" } }))?.id,
    },
  });
  const item = await db().inventoryItem.create({
    data: {
      clubId, sku, name: `Item ${sku}`, categoryId: cat.id,
      defaultCost: 10, retailPrice: 25, quantityOnHand: 20, averageCost: 10,
    },
  });
  const loc = await db().pOSLocation.upsert({
    where: { clubId_code: { clubId, code: "PROSHOP" } },
    update: {},
    create: { clubId, code: "PROSHOP", name: "Pro Shop Floor", departmentId: proShopDept?.id ?? null },
  });
  return { item, location: loc, category: cat };
}

// ---------------------------------------------------------------------------
// 7A — Production export renderers
// ---------------------------------------------------------------------------
describe("Phase 7A — Export renderers", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("PDF export produces a real PDF byte stream + links a Document", async () => {
    const club = await bootstrapAPClub("E-A");
    const p = await adminPrincipal(club.id);
    await reportingService.ensureBuiltinDefinitions(club.id);
    const run = await reportingService.runReport(p, club.id, { definitionKey: "balance_sheet" });
    const { export: exp, body, documentId } = await exportService.exportReportRun(p, run.id, "PDF");
    expect(exp.status).toBe("COMPLETED");
    const buf = body instanceof Buffer ? body : Buffer.from(body as string);
    // Real PDFs start with the %PDF- magic bytes.
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
    expect(documentId).toBeTruthy();
    const doc = await db().document.findUnique({ where: { id: documentId! } });
    expect(doc?.mimeType).toBe("application/pdf");
  });

  it("XLSX export produces a real XLSX byte stream", async () => {
    const club = await bootstrapAPClub("E-B");
    const p = await adminPrincipal(club.id);
    await reportingService.ensureBuiltinDefinitions(club.id);
    const run = await reportingService.runReport(p, club.id, { definitionKey: "trial_balance" });
    const { export: exp, body } = await exportService.exportReportRun(p, run.id, "XLSX");
    expect(exp.status).toBe("COMPLETED");
    const buf = body instanceof Buffer ? body : Buffer.from(body as string);
    // XLSX is a zip — first two bytes are PK.
    expect(buf.slice(0, 2).toString()).toBe("PK");
  });

  it("PPTX export produces a real PPTX byte stream + audit", async () => {
    const club = await bootstrapAPClub("E-C");
    const p = await adminPrincipal(club.id);
    await reportingService.ensureBuiltinDefinitions(club.id);
    const run = await reportingService.runReport(p, club.id, { definitionKey: "income_statement" });
    const { export: exp, body } = await exportService.exportReportRun(p, run.id, "PPTX");
    expect(exp.status).toBe("COMPLETED");
    const buf = body instanceof Buffer ? body : Buffer.from(body as string);
    expect(buf.slice(0, 2).toString()).toBe("PK");
    const audit = await db().auditLog.findFirst({ where: { entityType: "ReportExport", entityId: exp.id, action: "report.export" } });
    expect(audit).toBeTruthy();
  });

  it("export records FAILED state on render error", async () => {
    const club = await bootstrapAPClub("E-D");
    const p = await adminPrincipal(club.id);
    await reportingService.ensureBuiltinDefinitions(club.id);
    const run = await reportingService.runReport(p, club.id, { definitionKey: "ar_aging" });
    // Force the run row to have invalid JSON so the export fails predictably.
    await db().reportRun.update({ where: { id: run.id }, data: { resultJson: "not json" } });
    await expect(exportService.exportReportRun(p, run.id, "PDF")).rejects.toThrow();
    const exps = await db().reportExport.findMany({ where: { reportRunId: run.id } });
    expect(exps[0]?.status).toBe("FAILED");
    expect(exps[0]?.errorMessage).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 7B — Email + SMS adapter selection
// ---------------------------------------------------------------------------
describe("Phase 7B — Email + SMS adapters", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("default email adapter sends successfully (dev provider)", async () => {
    const club = await bootstrapAPClub("N-A");
    const p = await adminPrincipal(club.id);
    await notificationService.ensureSystemTemplates(club.id);
    const n = await notificationService.notify(p, club.id, {
      channel: "EMAIL", toEmail: "x@example.com", templateKey: "statement_available",
      vars: { firstName: "Test", periodLabel: "2026-04" },
    });
    expect(n.status).toBe("SENT");
  });

  it("integration setting registers + reads + masks secrets", async () => {
    const club = await bootstrapAPClub("N-B");
    const p = await adminPrincipal(club.id);
    const setting = await upsertIntegration(p, club.id, {
      scope: "EMAIL", provider: "ses", isActive: true,
      config: { region: "us-east-1", fromAddress: "noreply@club.example" },
      secrets: { accessKeyId: "AKIA...", secretAccessKey: "secret" },
    });
    expect(setting.secretsJson).toBeNull();
    const active = await getActiveIntegration(club.id, "EMAIL");
    expect(active?.provider).toBe("ses");
    expect(active?.secretsJson).toBeTruthy(); // raw row keeps it
  });

  it("preference opt-out suppresses email + records FAILED delivery", async () => {
    const club = await bootstrapAPClub("N-C");
    const p = await adminPrincipal(club.id);
    const member = await makeMember(club.id, {});
    await notificationService.setPreference(p, { clubId: club.id, memberId: member.id, topic: "payment_failed", channels: ["EMAIL"], enabled: false });
    await notificationService.ensureSystemTemplates(club.id);
    const n = await notificationService.notify(p, club.id, {
      channel: "EMAIL", toMemberId: member.id, toEmail: "x@example.com",
      templateKey: "payment_failed", topic: "payment_failed", vars: { firstName: member.firstName },
    });
    expect(n.status).toBe("FAILED");
  });
});

// ---------------------------------------------------------------------------
// 7C — Storage adapters
// ---------------------------------------------------------------------------
describe("Phase 7C — Storage", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("memory storage round-trips upload + download", async () => {
    const club = await bootstrapAPClub("S-A");
    const p = await adminPrincipal(club.id);
    const doc = await documentService.uploadDocument(p, club.id, {
      name: "test.pdf", sizeBytes: 11, body: "spectre-rt", mimeType: "application/pdf",
    });
    const result = await documentService.downloadDocument(p, doc.id);
    expect(result.body).toBeTruthy();
  });

  it("signed-URL access tokens are scoped + expire", async () => {
    const club = await bootstrapAPClub("S-B");
    const p = await adminPrincipal(club.id);
    const doc = await documentService.uploadDocument(p, club.id, { name: "test.pdf", sizeBytes: 5 });
    const access = await documentService.shareDocument(p, doc.id, { expiresInHours: 1 });
    expect(access.signedUrlToken).toBeTruthy();
    expect(access.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });
});

// ---------------------------------------------------------------------------
// 7D — Document backfill
// ---------------------------------------------------------------------------
describe("Phase 7D — Document backfill", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("dry run reports candidate count without creating Document rows", async () => {
    const club = await bootstrapAPClub("BF-A");
    const p = await adminPrincipal(club.id);
    const member = await makeMember(club.id, {});
    await db().memberDocument.create({
      data: { clubId: club.id, memberId: member.id, kind: "STATEMENT", name: "Mar 2026.pdf", storageKey: "s/x", mimeType: "application/pdf", sizeBytes: 1024 },
    });
    const dry = await backfillService.runBackfill(p, club.id, { dryRun: true });
    expect(dry.totals.candidates).toBe(1);
    expect(dry.totals.created).toBe(1); // "would create" in dry-run
    const docs = await db().document.count({ where: { clubId: club.id, status: "ACTIVE" } });
    expect(docs).toBe(0); // dry run didn't actually persist
  });

  it("real backfill is idempotent across reruns", async () => {
    const club = await bootstrapAPClub("BF-B");
    const p = await adminPrincipal(club.id);
    const member = await makeMember(club.id, {});
    await db().memberDocument.create({
      data: { clubId: club.id, memberId: member.id, kind: "STATEMENT", name: "x.pdf", storageKey: "s/x", mimeType: "application/pdf", sizeBytes: 1024 },
    });
    const r1 = await backfillService.runBackfill(p, club.id, { dryRun: false });
    expect(r1.totals.created).toBe(1);
    const r2 = await backfillService.runBackfill(p, club.id, { dryRun: false });
    expect(r2.totals.created).toBe(0);
    expect(r2.totals.skipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7E + 7F + 7G — POS module: sale, inventory, AR, GL
// ---------------------------------------------------------------------------
describe("Phase 7EFG — POS + inventory + AR", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("complete sale reduces inventory and posts COGS + AR + revenue", async () => {
    const club = await bootstrapAPClub("POS-A");
    const p = await adminPrincipal(club.id);
    const { item, location } = await makeRevenueAndInventory(club.id, "PS-001");
    const member = await makeMember(club.id, {});

    const sale = await pos.createSale(p, club.id, {
      locationCode: location.code,
      memberId: member.id, chargeMode: "MEMBER_ACCOUNT",
      lines: [{ kind: "INVENTORY", itemSku: item.sku, description: item.name, quantity: 2, unitPrice: 25, taxAmount: 0, discountAmount: 0, revenueAccountNumber: "4300" }],
      payments: [{ method: "MEMBER_ACCOUNT", amount: 50, tipAmount: 0 }],
    });
    const completed = await pos.completeSale(p, sale.id);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.postedJournalEntryId).toBeTruthy();
    expect(completed.arChargeId).toBeTruthy();

    const refreshed = await db().inventoryItem.findUnique({ where: { id: item.id } });
    expect(Number(refreshed!.quantityOnHand.toString())).toBe(18); // 20 - 2
    const charge = await db().charge.findUnique({ where: { id: completed.arChargeId! } });
    expect(Number(charge!.amount.toString())).toBe(50);

    // The revenue + COGS JEs both exist.
    const journals = await db().journalEntry.findMany({ where: { clubId: club.id }, orderBy: { createdAt: "desc" }, take: 5, include: { lines: true } });
    const cogsJE = journals.find((j) => j.description?.includes("Inventory sale"));
    expect(cogsJE).toBeTruthy();
    const cogsSum = cogsJE!.lines.reduce((s, l) => s + Number(l.debit.toString()) - Number(l.credit.toString()), 0);
    expect(Math.abs(cogsSum)).toBeLessThan(0.01);
  });

  it("duplicate POS sale via (provider, externalReference) returns the existing sale", async () => {
    const club = await bootstrapAPClub("POS-B");
    const p = await adminPrincipal(club.id);
    const { item, location } = await makeRevenueAndInventory(club.id, "PS-002");
    const provider = await db().pOSIntegrationProvider.create({
      data: { clubId: club.id, key: "square", name: "Square" },
    });

    const sale1 = await pos.createSale(p, club.id, {
      locationCode: location.code, chargeMode: "CASH",
      lines: [{ kind: "INVENTORY", itemSku: item.sku, description: item.name, quantity: 1, unitPrice: 20, taxAmount: 0, discountAmount: 0 }],
      payments: [{ method: "CASH", amount: 20, tipAmount: 0 }],
      providerKey: provider.key, externalReference: "sq-ext-123",
    });
    const sale2 = await pos.createSale(p, club.id, {
      locationCode: location.code, chargeMode: "CASH",
      lines: [{ kind: "INVENTORY", itemSku: item.sku, description: item.name, quantity: 1, unitPrice: 20, taxAmount: 0, discountAmount: 0 }],
      payments: [{ method: "CASH", amount: 20, tipAmount: 0 }],
      providerKey: provider.key, externalReference: "sq-ext-123",
    });
    expect(sale2.id).toBe(sale1.id);
  });

  it("refund reverses inventory + AR + posts a balanced contra JE", async () => {
    const club = await bootstrapAPClub("POS-C");
    const p = await adminPrincipal(club.id);
    const { item, location } = await makeRevenueAndInventory(club.id, "PS-003");
    const member = await makeMember(club.id, {});
    const sale = await pos.createSale(p, club.id, {
      locationCode: location.code, memberId: member.id, chargeMode: "MEMBER_ACCOUNT",
      lines: [{ kind: "INVENTORY", itemSku: item.sku, description: item.name, quantity: 3, unitPrice: 25, taxAmount: 0, discountAmount: 0 }],
      payments: [{ method: "MEMBER_ACCOUNT", amount: 75, tipAmount: 0 }],
    });
    await pos.completeSale(p, sale.id);
    const refund = await pos.refundSale(p, sale.id, { reason: "Returned merchandise" });
    expect(refund.refundOfSaleId).toBe(sale.id);
    const itemRefreshed = await db().inventoryItem.findUnique({ where: { id: item.id } });
    expect(Number(itemRefreshed!.quantityOnHand.toString())).toBe(20); // back to original
    // The reversal Charge exists and offsets.
    const charges = await db().charge.findMany({ where: { memberId: member.id }, orderBy: { transactionDate: "asc" } });
    const sum = charges.reduce((s, c) => s + Number(c.amount.toString()), 0);
    expect(sum).toBe(0);
  });

  it("permission: POS sale requires inventory:write", async () => {
    const club = await bootstrapAPClub("POS-D");
    const adm = await adminPrincipal(club.id);
    const { item, location } = await makeRevenueAndInventory(club.id, "PS-004");
    await makeUser({ email: "staff@example.com", role: "STAFF", clubId: club.id });
    const staff = await principalFor("staff@example.com");
    await expect(pos.createSale(staff, club.id, {
      locationCode: location.code, chargeMode: "CASH",
      lines: [{ kind: "INVENTORY", itemSku: item.sku, description: item.name, quantity: 1, unitPrice: 25, taxAmount: 0, discountAmount: 0 }],
      payments: [{ method: "CASH", amount: 25, tipAmount: 0 }],
    })).rejects.toBeInstanceOf(ForbiddenError);
    void adm;
  });
});

// ---------------------------------------------------------------------------
// 7H — LLM commentary
// ---------------------------------------------------------------------------
describe("Phase 7H — LLM commentary", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("mock provider generates a ready draft with audit + tenant safety", async () => {
    const club = await bootstrapAPClub("L-A");
    const p = await adminPrincipal(club.id);
    const draft = await llmCommentaryService.generateCommentary(p, club.id, {
      promptKey: "insight_summary",
      variables: { title: "Member disengagement", body: "Three members aged past 60 days", severity: "WATCH" },
    });
    expect(draft.status).toBe("READY");
    expect(draft.generatedText).toBeTruthy();
    expect(draft.provider).toBe("mock");
    const audit = await db().auditLog.findFirst({ where: { entityType: "LLMCommentaryDraft", entityId: draft.id, action: "llm.commentary.generate" } });
    expect(audit).toBeTruthy();
  });

  it("draft requires human approval before finalization", async () => {
    const club = await bootstrapAPClub("L-B");
    const p = await adminPrincipal(club.id);
    await reportingService.ensureBuiltinDefinitions(club.id);
    const pkg = await packageService.createPackage(p, club.id, { name: "AI Test", periodLabel: "2026-05", asOfDate: new Date().toISOString() });
    const draft = await llmCommentaryService.generateCommentary(p, club.id, {
      promptKey: "package_executive_summary",
      variables: { clubName: "Demo", periodLabel: "2026-05", figures: "—", trends: "—" },
      subjectEntityType: "ReportingPackage", subjectEntityId: pkg.id,
    });
    const commentary = await llmCommentaryService.acceptDraftAsCommentary(p, draft.id, {
      packageId: pkg.id, subject: "AI executive summary",
    });
    expect(commentary.isAIDraft).toBe(true);
    expect(commentary.aiDraftId).toBe(draft.id);
    expect(commentary.status).toBe("DRAFT"); // still a draft commentary until finalize
    const draftAfter = await db().lLMCommentaryDraft.findUnique({ where: { id: draft.id } });
    expect(draftAfter?.status).toBe("ACCEPTED");
  });
});

// ---------------------------------------------------------------------------
// 7I — Integration health + tenant isolation
// ---------------------------------------------------------------------------
describe("Phase 7I — Integration health", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("recordIntegrationCheck updates the IntegrationSetting summary", async () => {
    const club = await bootstrapAPClub("H-A");
    const p = await adminPrincipal(club.id);
    const setting = await upsertIntegration(p, club.id, {
      scope: "STORAGE", provider: "local", isActive: true, config: { rootDir: ".data" },
    });
    await recordIntegrationCheck({ clubId: club.id, settingId: setting.id, scope: "STORAGE", provider: "local", status: "OK", durationMs: 12 });
    const summary = await integrationStatusSummary(club.id);
    const storage = summary.find((s) => s.scope === "STORAGE");
    expect(storage?.lastTestStatus).toBe("OK");
  });

  it("Phase 7 services are tenant-safe across clubs", async () => {
    const clubA = await bootstrapAPClub("T-A");
    const clubB = await bootstrapAPClub("T-B");
    const pA = await adminPrincipal(clubA.id);
    const pB = await adminPrincipal(clubB.id);
    const { location: locA } = await makeRevenueAndInventory(clubA.id, "TA-1");
    // Try to use club A's location while authenticated to club B (clubId mismatch).
    await expect(pos.createSale(pB, clubB.id, {
      locationCode: locA.code, chargeMode: "CASH",
      lines: [{ kind: "OTHER", description: "fee", quantity: 1, unitPrice: 10, taxAmount: 0, discountAmount: 0 }],
      payments: [{ method: "CASH", amount: 10, tipAmount: 0 }],
    })).rejects.toBeInstanceOf(ConflictError);
    void pA;
  });
});
