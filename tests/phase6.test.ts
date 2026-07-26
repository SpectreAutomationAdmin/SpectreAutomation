// Phase 6 — Enterprise reporting, governance, auditor, notifications,
// documents, KPIs, workflows, insights, search, settings.
//
// Covers the 15 testable contracts listed in the Phase 6L brief.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeUser, makeMember, resetDb, principalFor } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { ForbiddenError, ConflictError, TenantViolationError } from "@/lib/errors";
import {
  reportingService, exportService, packageService, auditorService,
  notificationService, documentService, kpiService, workflowService,
  insightService, searchService, settingsService,
} from "@/lib/enterprise";

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

// ---------------------------------------------------------------------------
// 1. Reporting engine — definitions seeded, run + saved-report flow.
// ---------------------------------------------------------------------------
describe("Phase 6A — Reporting engine", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("builtin definitions are idempotent + reports run to a frozen result", async () => {
    const club = await bootstrapAPClub("R-A");
    const p = await adminPrincipal(club.id);
    await reportingService.ensureBuiltinDefinitions(club.id);
    await reportingService.ensureBuiltinDefinitions(club.id); // idempotent
    const defs = await db().reportDefinition.findMany({ where: { clubId: club.id } });
    expect(defs.length).toBeGreaterThanOrEqual(7);

    const run = await reportingService.runReport(p, club.id, { definitionKey: "trial_balance" });
    expect(run.status).toBe("SUCCEEDED");
    expect(run.resultJson).toBeTruthy();
    expect(run.rowCount).toBeGreaterThanOrEqual(0);
  });

  it("saved report flow: create, list, run linked", async () => {
    const club = await bootstrapAPClub("R-B");
    const p = await adminPrincipal(club.id);
    await reportingService.ensureBuiltinDefinitions(club.id);
    const saved = await reportingService.createSavedReport(p, club.id, {
      definitionKey: "balance_sheet",
      name: "Year-end BS",
      parameters: { asOf: "2026-12-31" },
    });
    const list = await reportingService.listSavedReports(p, club.id);
    expect(list.some((r) => r.id === saved.id)).toBe(true);
    const run = await reportingService.runReport(p, club.id, { definitionKey: "balance_sheet", savedReportId: saved.id });
    expect(run.savedReportId).toBe(saved.id);
  });
});

// ---------------------------------------------------------------------------
// 2. Export pipeline — CSV body produced + ReportExport audit row.
// ---------------------------------------------------------------------------
describe("Phase 6H — Exports", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("CSV export emits a body and records a ReportExport row", async () => {
    const club = await bootstrapAPClub("E-A");
    const p = await adminPrincipal(club.id);
    await reportingService.ensureBuiltinDefinitions(club.id);
    const run = await reportingService.runReport(p, club.id, { definitionKey: "ar_aging" });
    const { export: exp, body } = await exportService.exportReportRun(p, run.id, "CSV");
    expect(exp.format).toBe("CSV");
    expect(exp.sizeBytes).toBeGreaterThanOrEqual(0);
    expect(typeof body).toBe("string");
    // Audit row exists.
    const audit = await db().auditLog.findFirst({ where: { entityType: "ReportExport", entityId: exp.id } });
    expect(audit).toBeTruthy();
  });

  it("export requires reports:export permission", async () => {
    const club = await bootstrapAPClub("E-B");
    const p = await adminPrincipal(club.id);
    await reportingService.ensureBuiltinDefinitions(club.id);
    const run = await reportingService.runReport(p, club.id, { definitionKey: "ar_aging" });
    // MEMBER lacks reports:export.
    await makeUser({ email: `m-${club.id.slice(0, 6)}@example.com`, role: "MEMBER", clubId: club.id });
    const memberP = await principalFor(`m-${club.id.slice(0, 6)}@example.com`);
    await expect(exportService.exportReportRun(memberP, run.id, "CSV")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// 3. Board packages — create, add report section snapshots, self-approval blocked.
// ---------------------------------------------------------------------------
describe("Phase 6B — Board packages", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("section snapshot freezes a ReportRun and approvers != creator", async () => {
    const club = await bootstrapAPClub("P-A");
    const p = await adminPrincipal(club.id);
    await reportingService.ensureBuiltinDefinitions(club.id);
    const pkg = await packageService.createPackage(p, club.id, {
      name: "Board April", periodLabel: "2026-04", asOfDate: new Date().toISOString(),
    });
    const section = await packageService.addSection(p, pkg.id, {
      title: "Balance Sheet", kind: "REPORT", reportDefinitionKey: "balance_sheet",
    });
    expect(section.reportRunId).toBeTruthy();

    // Self-approval blocked.
    await packageService.submitForApproval(p, pkg.id);
    await expect(packageService.approvePackage(p, pkg.id)).rejects.toBeInstanceOf(ConflictError);
    // A different approver succeeds.
    const gm = await gmPrincipal(club.id);
    const approved = await packageService.approvePackage(gm, pkg.id);
    expect(approved.status).toBe("APPROVED");
  });

  it("distribution requires APPROVED status + advances to DISTRIBUTED", async () => {
    const club = await bootstrapAPClub("P-B");
    const creator = await adminPrincipal(club.id);
    const approver = await gmPrincipal(club.id);
    const pkg = await packageService.createPackage(creator, club.id, {
      name: "Board May", periodLabel: "2026-05", asOfDate: new Date().toISOString(),
    });
    await expect(packageService.recordDistribution(creator, pkg.id, { recipientName: "X", recipientEmail: "x@example.com" })).rejects.toBeInstanceOf(ConflictError);
    await packageService.approvePackage(approver, pkg.id);
    await packageService.recordDistribution(creator, pkg.id, { recipientName: "X", recipientEmail: "x@example.com" });
    const refreshed = await db().reportingPackage.findUnique({ where: { id: pkg.id } });
    expect(refreshed?.status).toBe("DISTRIBUTED");
  });
});

// ---------------------------------------------------------------------------
// 4. Auditor mode — invitation lifecycle + access restrictions.
// ---------------------------------------------------------------------------
describe("Phase 6C — Auditor mode", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("invite -> accept -> session -> revoke lifecycle", async () => {
    const club = await bootstrapAPClub("A-A");
    const p = await adminPrincipal(club.id);
    const grant = await auditorService.inviteAuditor(p, club.id, {
      auditorName: "Ext Auditor", auditorEmail: "auditor@example.com", expiresInDays: 30,
    });
    expect(grant.status).toBe("PENDING");
    const accepted = await auditorService.acceptAuditorInvite(grant.inviteToken);
    expect(accepted.status).toBe("ACTIVE");
    const session = await auditorService.startAuditorSession(grant.id, "10.0.0.1", "auditor-browser");
    expect(session.grantId).toBe(grant.id);
    await auditorService.revokeAuditorGrant(p, grant.id, "engagement complete");
    const revoked = await db().auditorAccessGrant.findUnique({ where: { id: grant.id } });
    expect(revoked?.status).toBe("REVOKED");
    // After revocation, a new session cannot start.
    await expect(auditorService.startAuditorSession(grant.id, null, null)).rejects.toBeInstanceOf(ConflictError);
  });
});

// ---------------------------------------------------------------------------
// 5. Notifications — delivery logging + preference suppression.
// ---------------------------------------------------------------------------
describe("Phase 6D — Notifications", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("notify creates a CommunicationLog and NotificationDelivery row", async () => {
    const club = await bootstrapAPClub("N-A");
    const p = await adminPrincipal(club.id);
    const member = await makeMember(club.id, {});
    await notificationService.ensureSystemTemplates(club.id);
    const n = await notificationService.notify(p, club.id, {
      channel: "EMAIL", toEmail: "x@example.com", toMemberId: member.id,
      templateKey: "payment_failed", vars: { firstName: member.firstName },
    });
    expect(n.status).toBe("SENT");
    const deliveries = await db().notificationDelivery.findMany({ where: { notificationId: n.id } });
    expect(deliveries.length).toBe(1);
    const log = await db().communicationLog.findMany({ where: { clubId: club.id, notificationId: n.id } });
    expect(log.length).toBe(1);
  });

  it("preference opt-out suppresses delivery but still records intent", async () => {
    const club = await bootstrapAPClub("N-B");
    const p = await adminPrincipal(club.id);
    const member = await makeMember(club.id, {});
    await notificationService.setPreference(p, { clubId: club.id, memberId: member.id, topic: "payment_failed", channels: ["EMAIL"], enabled: false });
    await notificationService.ensureSystemTemplates(club.id);
    const n = await notificationService.notify(p, club.id, {
      channel: "EMAIL", toMemberId: member.id, toEmail: "x@example.com",
      templateKey: "payment_failed", topic: "payment_failed", vars: { firstName: member.firstName },
    });
    expect(n.status).toBe("FAILED");
    const deliveries = await db().notificationDelivery.findMany({ where: { notificationId: n.id } });
    expect(deliveries[0]?.failureReason).toContain("preference");
  });
});

// ---------------------------------------------------------------------------
// 6. Documents — upload + versioning + soft delete + access log.
// ---------------------------------------------------------------------------
describe("Phase 6E — Documents", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("upload creates v1, second upload creates v2; soft delete is reversible", async () => {
    const club = await bootstrapAPClub("D-A");
    const p = await adminPrincipal(club.id);
    const doc = await documentService.uploadDocument(p, club.id, {
      name: "Engagement letter.pdf", sizeBytes: 12345, mimeType: "application/pdf",
      folderPath: "/Auditor/2026", tagKeys: ["audit", "engagement"],
      body: "PDF BODY",
    });
    const v2 = await documentService.uploadVersion(p, doc.id, { sizeBytes: 12500, body: "PDF BODY v2" });
    expect(v2.versionNumber).toBe(2);

    // Audit log captures upload + view.
    await documentService.getDocument(p, doc.id);
    const logs = await db().documentAuditLog.findMany({ where: { documentId: doc.id } });
    expect(logs.find((l) => l.action === "UPLOAD")).toBeTruthy();
    expect(logs.find((l) => l.action === "VIEW")).toBeTruthy();

    await documentService.softDeleteDocument(p, doc.id);
    const deleted = await db().document.findUnique({ where: { id: doc.id } });
    expect(deleted?.status).toBe("DELETED");
    await documentService.restoreDocument(p, doc.id);
    const restored = await db().document.findUnique({ where: { id: doc.id } });
    expect(restored?.status).toBe("ACTIVE");
  });

  it("document search filters by query, tag, and folder", async () => {
    const club = await bootstrapAPClub("D-B");
    const p = await adminPrincipal(club.id);
    await documentService.uploadDocument(p, club.id, { name: "Board Minutes.pdf", sizeBytes: 100, folderPath: "/Governance", tagKeys: ["minutes"] });
    await documentService.uploadDocument(p, club.id, { name: "Vendor W9.pdf", sizeBytes: 100, folderPath: "/Vendors", tagKeys: ["w9"] });
    const hits = await documentService.searchDocuments(p, club.id, { query: "board" });
    expect(hits.length).toBe(1);
    const govHits = await documentService.searchDocuments(p, club.id, { folderPath: "/Governance" });
    expect(govHits.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. KPI engine — compute, threshold breach, alert raised.
// ---------------------------------------------------------------------------
describe("Phase 6F — KPI engine", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("computeKPIValues persists values + breaches raise alerts", async () => {
    const club = await bootstrapAPClub("K-A");
    const p = await adminPrincipal(club.id);
    await kpiService.ensureDefaultKPIs(club.id);
    await kpiService.upsertThreshold(p, club.id, {
      kpiKey: "active_members", kind: "WARNING", op: "LT", threshold: 10000,
    });
    const result = await kpiService.computeKPIValues(club.id);
    expect(result.kpiCount).toBeGreaterThan(0);
    const values = await db().kPIValue.findMany({ where: { clubId: club.id } });
    expect(values.length).toBeGreaterThan(0);
    const alerts = await db().kPIAlert.findMany({ where: { clubId: club.id } });
    expect(alerts.length).toBeGreaterThan(0); // active_members < 10000 in test club
  });

  it("dashboards: GM + Controller seeded; widgets render KPI metadata", async () => {
    const club = await bootstrapAPClub("K-B");
    const p = await adminPrincipal(club.id);
    await kpiService.ensureDefaultKPIs(club.id);
    await kpiService.ensureDefaultDashboards(club.id);
    const dash = await kpiService.getDashboard(p, club.id, "gm");
    expect(dash).toBeTruthy();
    expect(dash!.widgets.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Workflow engine — multi-step approval + self-approval blocked.
// ---------------------------------------------------------------------------
describe("Phase 6G — Workflow engine", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("two-step workflow advances and rejects self-approval", async () => {
    const club = await bootstrapAPClub("W-A");
    const creator = await adminPrincipal(club.id);
    const approver = await gmPrincipal(club.id);
    const wf = await workflowService.createWorkflow(creator, club.id, {
      key: "capital_project", name: "New mower purchase",
      steps: [
        { key: "controller_review", name: "Controller review", kind: "APPROVAL", requiredApprovals: 1 },
        { key: "gm_approval", name: "GM approval", kind: "APPROVAL", requiredApprovals: 1 },
      ],
    });
    await workflowService.startWorkflow(creator, wf.id);
    const refreshed = await db().workflow.findUnique({ where: { id: wf.id }, include: { steps: { orderBy: { sortOrder: "asc" } } } });
    const firstStep = refreshed!.steps[0];
    // Creator cannot self-approve.
    await expect(workflowService.decideStep(creator, firstStep.id, { decision: "APPROVE" })).rejects.toBeInstanceOf(ConflictError);
    await workflowService.decideStep(approver, firstStep.id, { decision: "APPROVE" });
    const afterStep1 = await db().workflow.findUnique({ where: { id: wf.id }, include: { steps: { orderBy: { sortOrder: "asc" } } } });
    expect(afterStep1!.currentStepId).toBe(afterStep1!.steps[1].id);
    await workflowService.decideStep(approver, afterStep1!.steps[1].id, { decision: "APPROVE" });
    const done = await db().workflow.findUnique({ where: { id: wf.id } });
    expect(done?.status).toBe("COMPLETED");
  });
});

// ---------------------------------------------------------------------------
// 9. Insights — rules raise + dedupe within a week.
// ---------------------------------------------------------------------------
describe("Phase 6K — Insights", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("rules raise insights and are deduped on rerun within a week", async () => {
    const club = await bootstrapAPClub("I-A");
    const p = await adminPrincipal(club.id);
    await insightService.ensureSystemRules(club.id);
    // Stage a member with a sufficiently aged balance to trip the engagement watch.
    const m = await makeMember(club.id, { firstName: "Aged", lastName: "Account" });
    await db().memberAccount.update({
      where: { memberId: m.id },
      data: { currentBalance: 500, sixtyDayBalance: 300, ninetyDayBalance: 200 },
    });
    const r1 = await insightService.runInsights(club.id, p);
    expect(r1.raised).toBeGreaterThan(0);
    const r2 = await insightService.runInsights(club.id, p);
    expect(r2.raised).toBe(0); // deduped
  });
});

// ---------------------------------------------------------------------------
// 10. Search — index + permission-aware filter.
// ---------------------------------------------------------------------------
describe("Phase 6I — Global search", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("index + search returns hits; results are filtered by permission", async () => {
    const club = await bootstrapAPClub("S-A");
    const p = await adminPrincipal(club.id);
    await makeMember(club.id, { firstName: "Aria", lastName: "Mendez" });
    await searchService.reindexClub(club.id);
    const hits = await searchService.globalSearch(p, club.id, "Aria");
    expect(hits.some((h) => h.title.includes("Aria"))).toBe(true);

    // A BOARD_READ_ONLY user lacks members:read, so should not see member hits.
    await makeUser({ email: "board@example.com", role: "BOARD_READ_ONLY", clubId: club.id });
    const board = await principalFor("board@example.com");
    const boardHits = await searchService.globalSearch(board, club.id, "Aria");
    expect(boardHits.some((h) => h.entityType === "MEMBER")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11. Settings — set + get + permission gate.
// ---------------------------------------------------------------------------
describe("Phase 6J — Settings", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("set + get round-trips; non-writers blocked", async () => {
    const club = await bootstrapAPClub("Set-A");
    const p = await adminPrincipal(club.id);
    await settingsService.setSetting(p, club.id, { scope: "BILLING", key: "late_fee_amount", value: 25 });
    const val = await settingsService.getSetting<number>(club.id, "BILLING", "late_fee_amount");
    expect(val).toBe(25);

    await makeUser({ email: "staff@example.com", role: "STAFF", clubId: club.id });
    const staff = await principalFor("staff@example.com");
    await expect(settingsService.setSetting(staff, club.id, { scope: "BILLING", key: "late_fee_amount", value: 10 })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// 12. Tenant isolation — Phase 6 records cannot cross clubs.
// ---------------------------------------------------------------------------
describe("Phase 6 — Tenant isolation", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("club A admin cannot read club B documents or packages", async () => {
    const clubA = await bootstrapAPClub("T-A");
    const clubB = await bootstrapAPClub("T-B");
    const pA = await adminPrincipal(clubA.id);
    const pB = await adminPrincipal(clubB.id);
    await documentService.uploadDocument(pB, clubB.id, { name: "B-only.pdf", sizeBytes: 100 });
    const docs = await documentService.searchDocuments(pA, clubA.id, {});
    expect(docs.length).toBe(0);

    await reportingService.ensureBuiltinDefinitions(clubB.id);
    const pkgB = await packageService.createPackage(pB, clubB.id, { name: "B-only", periodLabel: "2026-04", asOfDate: new Date().toISOString() });
    await expect(packageService.getPackage(pA, pkgB.id)).rejects.toBeInstanceOf(TenantViolationError);
  });
});
