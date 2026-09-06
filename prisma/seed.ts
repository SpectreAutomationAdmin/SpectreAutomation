import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { calculateAmortization } from "../src/lib/finance";
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, type RoleKey, type PermissionKey } from "../src/lib/permissions";
import { DEFAULT_NOTICE_TEMPLATES, DEFAULT_STAGES } from "../src/lib/services/collections";
import { DEFAULT_CHECKLIST } from "../src/lib/services/onboarding";
import {
  DEFAULT_CATEGORIES, DEFAULT_FS_GROUPS, DEFAULT_DEPARTMENTS, DEFAULT_ACCOUNTS,
} from "../src/lib/accounting/coa-template";
import { upsertCategory, upsertFsGroup, upsertAccountInternal } from "../src/lib/accounting/coa";
import { ensureFiscalYear } from "../src/lib/accounting/periods";
import { backfillArToGl } from "../src/lib/accounting/events";
import { seedDefaultTaxCodes } from "../src/lib/ap/tax-codes";
import { ensureDefaultPolicies } from "../src/lib/ap/approvals";
import { createVendor, activateVendor, addBankingProfile, submitBankingForApproval, verifyBanking } from "../src/lib/ap/vendors";
import { invoiceService } from "../src/lib/ap";
import { uploadCapture } from "../src/lib/ap/capture";
import { budgetService, lessonService, payrollService } from "../src/lib/ops";
import type { Principal } from "../src/lib/rbac";
// Phase 6
import { ensureBuiltinDefinitions } from "../src/lib/enterprise/reports";
import { ensureSystemTemplates } from "../src/lib/enterprise/notifications";
import { ensureDefaultKPIs, ensureDefaultDashboards, computeKPIValues } from "../src/lib/enterprise/kpi";
import { ensureSystemRules, runInsights } from "../src/lib/enterprise/insights";
import { ensureDefaultSettings } from "../src/lib/enterprise/settings";
import { reindexClub } from "../src/lib/enterprise/search";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding Spectre Automation demo data…");

  // ---------------------------------------------------------------
  // Wipe (idempotent reseed)
  // ---------------------------------------------------------------
  // Phase 11 — first.
  await prisma.ssoLoginAttempt.deleteMany();
  await prisma.ssoProvider.deleteMany();
  await prisma.trustedDevice.deleteMany();
  await prisma.recoveryCode.deleteMany();
  await prisma.mfaFactor.deleteMany();
  await prisma.billingPaymentAttempt.deleteMany();
  await prisma.billingInvoice.deleteMany();
  await prisma.billingSubscription.deleteMany();
  await prisma.billingWebhookEvent.deleteMany();
  await prisma.billingCustomer.deleteMany();
  await prisma.tournamentScoreCorrection.deleteMany();
  await prisma.tournamentScoreDraft.deleteMany();
  await prisma.pOSMappingHistory.deleteMany();
  await prisma.webhookSecretRotation.deleteMany();
  await prisma.webhookSecretVersion.deleteMany();
  // Phase 10 — push attempts, pairings, subscription, usage next.
  await prisma.billingCycle.deleteMany();
  await prisma.usageMetric.deleteMany();
  await prisma.clubSubscription.deleteMany();
  await prisma.subscriptionPlan.deleteMany();
  await prisma.tournamentPairing.deleteMany();
  await prisma.pushDeliveryAttempt.deleteMany();
  await prisma.pushCampaign.deleteMany();
  // Phase 9 — pilot / API / tournament / push / auth / observability next.
  await prisma.pilotReadinessItem.deleteMany();
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhookSubscription.deleteMany();
  await prisma.apiRequestLog.deleteMany();
  await prisma.apiKeyPermission.deleteMany();
  await prisma.apiKey.deleteMany();
  await prisma.tournamentCommunication.deleteMany();
  await prisma.tournamentPayoutPrize.deleteMany();
  await prisma.tournamentLeaderboard.deleteMany();
  await prisma.tournamentScore.deleteMany();
  await prisma.tournamentMatch.deleteMany();
  await prisma.tournamentRound.deleteMany();
  await prisma.tournamentRegistration.deleteMany();
  await prisma.tournamentTeam.deleteMany();
  await prisma.tournamentDivision.deleteMany();
  await prisma.tournament.deleteMany();
  await prisma.webPushSubscription.deleteMany();
  await prisma.suspiciousActivityEvent.deleteMany();
  await prisma.accountLock.deleteMany();
  await prisma.authAttempt.deleteMany();
  await prisma.metricCounter.deleteMany();
  await prisma.observabilityEvent.deleteMany();
  // Phase 8 — jobs / POS webhooks / tee-sheet / hardware / flags next.
  await prisma.rateLimitBucket.deleteMany();
  await prisma.featureFlag.deleteMany();
  await prisma.deviceAssignment.deleteMany();
  await prisma.deviceStatus.deleteMany();
  await prisma.deviceEvent.deleteMany();
  await prisma.hardwareDevice.deleteMany();
  await prisma.cartAssignment.deleteMany();
  await prisma.paceOfPlayRecord.deleteMany();
  await prisma.teeLotteryEntry.deleteMany();
  await prisma.teeLottery.deleteMany();
  await prisma.teeTimeGuest.deleteMany();
  await prisma.teeTimePlayer.deleteMany();
  await prisma.teeTimeBooking.deleteMany();
  await prisma.teeTime.deleteMany();
  await prisma.teeSheet.deleteMany();
  await prisma.courseHole.deleteMany();
  await prisma.course.deleteMany();
  await prisma.webhookReplay.deleteMany();
  await prisma.pOSMapping.deleteMany();
  await prisma.pOSImportError.deleteMany();
  await prisma.pOSSyncRun.deleteMany();
  await prisma.pOSWebhookEvent.deleteMany();
  await prisma.queueHealth.deleteMany();
  await prisma.jobFailure.deleteMany();
  await prisma.jobRun.deleteMany();
  await prisma.backgroundJob.deleteMany();
  // Phase 18C — dining reservations: drop before POS so the
  // reservationId FK on POSCheck and the check-link bridge unwind cleanly.
  await prisma.diningReservationCheckLink.deleteMany();
  await prisma.diningReservation.deleteMany();
  await prisma.diningTable.deleteMany();
  await prisma.diningArea.deleteMany();
  await prisma.reservationSettings.deleteMany();
  // Phase 18B — hospitality survey tables (FK to POSCheck/Member/Club).
  await prisma.hospitalitySurveyResponse.deleteMany();
  await prisma.hospitalitySurveyInvitation.deleteMany();
  await prisma.departmentNotificationRule.deleteMany();
  // Phase 7 — integrations + POS + LLM tables next.
  await prisma.lLMCommentaryDraft.deleteMany();
  // Open-check workflow tables (children → parents).
  await prisma.pOSChitLine.deleteMany();
  await prisma.pOSChit.deleteMany();
  await prisma.pOSCheckEvent.deleteMany();
  await prisma.pOSCheckLineModifier.deleteMany();
  // Phase 18E / 18F — split groups + per-seat assignments before lines/checks.
  await prisma.pOSSettlementGroup.deleteMany();
  await prisma.pOSCheckSeat.deleteMany();
  await prisma.pOSCheckLine.deleteMany();
  await prisma.pOSCheck.deleteMany();
  await prisma.pOSPayment.deleteMany();
  await prisma.pOSDiscount.deleteMany();
  await prisma.pOSTaxLine.deleteMany();
  await prisma.pOSSaleLineModifier.deleteMany();
  await prisma.pOSSaleLine.deleteMany();
  await prisma.pOSSale.deleteMany();
  await prisma.pOSSaleChit.deleteMany();
  await prisma.pOSSession.deleteMany();
  await prisma.pOSTerminal.deleteMany();
  // Printer registry — independent of menu / sale data.
  await prisma.pOSPrinter.deleteMany();
  // Modifier catalog comes off menu items, so wipe it before items.
  await prisma.pOSModifierOption.deleteMany();
  await prisma.pOSModifierGroup.deleteMany();
  // Menu items first (FK → POSMenuCategory), then categories (FK → POSLocation),
  // then locations.
  await prisma.pOSMenuItem.deleteMany();
  await prisma.pOSMenuCategory.deleteMany();
  await prisma.pOSLocation.deleteMany();
  await prisma.pOSIntegrationProvider.deleteMany();
  await prisma.documentBackfillBatch.deleteMany();
  await prisma.integrationCheck.deleteMany();
  await prisma.integrationSetting.deleteMany();
  // Phase 6 enterprise tables first — they FK across all earlier modules.
  await prisma.searchIndexEntry.deleteMany();
  await prisma.insightAlert.deleteMany();
  await prisma.insight.deleteMany();
  await prisma.insightRule.deleteMany();
  await prisma.clubSetting.deleteMany();
  await prisma.workflowHistory.deleteMany();
  await prisma.workflowComment.deleteMany();
  await prisma.workflowApproval.deleteMany();
  await prisma.workflowAssignment.deleteMany();
  await prisma.workflowStep.deleteMany();
  await prisma.workflow.deleteMany();
  await prisma.kPIAlert.deleteMany();
  await prisma.kPIThreshold.deleteMany();
  await prisma.kPIWidget.deleteMany();
  await prisma.kPIDashboard.deleteMany();
  await prisma.kPIValue.deleteMany();
  await prisma.kPI.deleteMany();
  await prisma.documentAuditLog.deleteMany();
  await prisma.documentAccess.deleteMany();
  await prisma.documentVersion.deleteMany();
  await prisma.documentTagJoin.deleteMany();
  await prisma.documentTag.deleteMany();
  await prisma.document.deleteMany();
  await prisma.documentRetentionPolicy.deleteMany();
  await prisma.documentFolder.deleteMany();
  await prisma.communicationCampaign.deleteMany();
  await prisma.communicationLog.deleteMany();
  await prisma.notificationDelivery.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.notificationPreference.deleteMany();
  await prisma.notificationTemplate.deleteMany();
  await prisma.auditExport.deleteMany();
  await prisma.auditRequestItem.deleteMany();
  await prisma.auditRequest.deleteMany();
  await prisma.auditorSession.deleteMany();
  await prisma.auditorAccessGrant.deleteMany();
  await prisma.packageApproval.deleteMany();
  await prisma.packageDistribution.deleteMany();
  await prisma.reportingPackageCommentary.deleteMany();
  await prisma.reportingPackageSection.deleteMany();
  await prisma.reportingPackage.deleteMany();
  await prisma.reportExport.deleteMany();
  await prisma.reportRun.deleteMany();
  await prisma.savedReport.deleteMany();
  await prisma.reportDefinition.deleteMany();
  // Phase 5 operational tables first — they FK accounting / AP / member.
  await prisma.forecastLine.deleteMany();
  await prisma.forecast.deleteMany();
  await prisma.budgetAssumption.deleteMany();
  await prisma.budgetLine.deleteMany();
  await prisma.budget.deleteMany();
  await prisma.assetDisposal.deleteMany();
  await prisma.assetMaintenanceRecord.deleteMany();
  await prisma.assetDepreciationEntry.deleteMany();
  await prisma.capitalAsset.deleteMany();
  await prisma.assetLocation.deleteMany();
  await prisma.assetCategory.deleteMany();
  await prisma.payrollRemittance.deleteMany();
  await prisma.payrollLine.deleteMany();
  await prisma.payrollRun.deleteMany();
  await prisma.timesheetEntry.deleteMany();
  await prisma.timesheet.deleteMany();
  await prisma.timeClockEvent.deleteMany();
  await prisma.payrollPeriod.deleteMany();
  await prisma.labourBudget.deleteMany();
  // HR-1 (2026-08-16) — child tables of Employee (+ session children
  // of session). FK-correct deletion order: grandchildren → children
  // → parents. Everything below must delete BEFORE `employee` so the
  // ON DELETE CASCADE / RESTRICT chain has nothing to trip on.
  await prisma.employeeOnboardingResponse.deleteMany();      // FK → session + question
  await prisma.employeeOnboardingStateTransition.deleteMany(); // FK → employee (+ optional session)
  await prisma.employeeOnboardingSession.deleteMany();       // FK → employee
  await prisma.employeeOnboardingInvitation.deleteMany();    // FK → employee
  await prisma.employeeOnboardingQuestion.deleteMany();      // FK → club (nullable)
  await prisma.employeeEmergencyContact.deleteMany();
  await prisma.employeeCredential.deleteMany();
  // EmployeeDocument BEFORE Employee — Employee has FKs
  // profilePhotoDocumentId / resumeDocumentId pointing INTO it.
  await prisma.employeeDocument.deleteMany();
  await prisma.employeeTaxProfile.deleteMany();
  await prisma.employeeBankAccount.deleteMany();
  await prisma.employeeSensitiveIdentity.deleteMany();
  await prisma.payrollDeduction.deleteMany();
  await prisma.payrollBenefit.deleteMany();
  await prisma.payrollProfile.deleteMany();
  await prisma.employeeCompensation.deleteMany();
  await prisma.employmentPeriod.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.employeePosition.deleteMany();
  await prisma.lessonPayable.deleteMany();
  await prisma.lessonBooking.deleteMany();
  await prisma.lessonType.deleteMany();
  await prisma.golfProfessional.deleteMany();
  await prisma.privateEventAddOn.deleteMany();
  await prisma.privateEventBarSelection.deleteMany();
  await prisma.privateEventMenuSelection.deleteMany();
  await prisma.privateEventDeposit.deleteMany();
  await prisma.privateEventBooking.deleteMany();
  await prisma.privateEventInquiry.deleteMany();
  await prisma.eventCategory.deleteMany();
  await prisma.inventoryTransferLine.deleteMany();
  await prisma.inventoryTransfer.deleteMany();
  await prisma.inventoryReceivingLine.deleteMany();
  await prisma.inventoryReceiving.deleteMany();
  await prisma.inventoryCountLine.deleteMany();
  await prisma.inventoryCount.deleteMany();
  await prisma.inventoryAdjustment.deleteMany();
  await prisma.inventoryTransaction.deleteMany();
  await prisma.inventoryItem.deleteMany();
  await prisma.inventoryLocation.deleteMany();
  await prisma.inventoryCategory.deleteMany();
  // AP tables (Phase 4) next — they FK accounting + club tables.
  await prisma.aPException.deleteMany();
  await prisma.paymentBatchItem.deleteMany();
  await prisma.vendorPayment.deleteMany();
  await prisma.paymentBatch.deleteMany();
  await prisma.aPInvoiceAttachment.deleteMany();
  await prisma.aPInvoiceLine.deleteMany();
  await prisma.aPInvoice.deleteMany();
  await prisma.receiptCapture.deleteMany();
  await prisma.approvalDecision.deleteMany();
  await prisma.approvalRequest.deleteMany();
  await prisma.approvalPolicy.deleteMany();
  await prisma.pennyTest.deleteMany();
  await prisma.vendorBankingProfile.deleteMany();
  await prisma.vendorDocument.deleteMany();
  await prisma.vendorContact.deleteMany();
  await prisma.vendorRiskFlag.deleteMany();
  await prisma.vendor.deleteMany();
  await prisma.taxCode.deleteMany();
  // Accounting tables next — they FK to club + user.
  await prisma.journalEntryLine.deleteMany();
  await prisma.journalAttachment.deleteMany();
  await prisma.journalEntry.deleteMany();
  await prisma.journalBatch.deleteMany();
  await prisma.recurringJournal.deleteMany();
  await prisma.account.deleteMany();
  await prisma.accountCategory.deleteMany();
  await prisma.financialStatementGroup.deleteMany();
  await prisma.fiscalPeriod.deleteMany();
  await prisma.fiscalYear.deleteMany();
  await prisma.costCenter.deleteMany();
  await prisma.department.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.eventRegistration.deleteMany();
  await prisma.clubEvent.deleteMany();
  await prisma.dashboardWidget.deleteMany();
  await prisma.memberPreference.deleteMany();
  await prisma.clubMilestone.deleteMany();
  await prisma.collectionAction.deleteMany();
  await prisma.collectionNotice.deleteMany();
  await prisma.collectionStage.deleteMany();
  await prisma.collectionNoticeTemplate.deleteMany();
  await prisma.financingPayment.deleteMany();
  await prisma.financingDocument.deleteMany();
  await prisma.financingPaymentSchedule.deleteMany();
  await prisma.financingAgreement.deleteMany();
  await prisma.statement.deleteMany();
  await prisma.dispute.deleteMany();
  await prisma.paymentPromise.deleteMany();
  await prisma.accountNote.deleteMany();
  await prisma.accountAdjustment.deleteMany();
  await prisma.paymentMethod.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.charge.deleteMany();
  await prisma.memberAccount.deleteMany();
  await prisma.memberDocument.deleteMany();
  await prisma.memberHouseholdMember.deleteMany();
  await prisma.onboardingChecklistItem.deleteMany();
  await prisma.incentiveCredit.deleteMany();
  await prisma.applicationDocument.deleteMany();
  await prisma.applicationHouseholdMember.deleteMany();
  await prisma.applicationDraftToken.deleteMany();
  await prisma.clubWidgetConfig.deleteMany();
  await prisma.clubAnnouncement.deleteMany();
  await prisma.userClubRole.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.permission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.user.deleteMany();
  await prisma.member.deleteMany();
  await prisma.applicant.deleteMany();
  await prisma.club.deleteMany();

  // ---------------------------------------------------------------
  // RBAC tables
  // ---------------------------------------------------------------
  for (const [key, def] of Object.entries(PERMISSIONS)) {
    await prisma.permission.create({ data: { key, name: def.name, category: def.category } });
  }
  for (const [key, def] of Object.entries(ROLES)) {
    await prisma.role.create({ data: { key, name: def.name, description: def.description, isSystem: true } });
  }
  for (const [roleKey, grants] of Object.entries(ROLE_PERMISSIONS) as Array<[RoleKey, PermissionKey[]]>) {
    for (const permissionKey of grants) {
      await prisma.rolePermission.create({ data: { roleKey, permissionKey } });
    }
  }

  // ---------------------------------------------------------------
  // TA-1B — Responsibility catalogue (canonical operational keys).
  // Only TENANT_ADMINISTRATION is seeded in TA-1B. Additional keys
  // are added in later slices when their consumers exist.
  // ---------------------------------------------------------------
  await prisma.responsibility.deleteMany();
  await prisma.responsibility.create({
    data: {
      key: "TENANT_ADMINISTRATION",
      displayLabel: "Tenant Administrator",
      scopeKind: "CLUB",
      cardinality: "PRIMARY_AND_BACKUPS",
      description:
        "Holds Tenant Administration authority for this Club. Primary invites and manages administrative users; may assign further responsibilities. Every Club must have at least one active Primary at all times.",
      isSpectreDefined: true,
    },
  });
  // Payroll-3D-3 — department-scoped Timesheet Approver.
  await prisma.responsibility.create({
    data: {
      key: "DEPARTMENT_TIME_APPROVAL",
      displayLabel: "Timesheet Approver",
      scopeKind: "DEPARTMENT",
      cardinality: "SINGLE_PRIMARY",
      description:
        "Reviews and approves recorded time for a specific department each pay period. Resolved through DepartmentResponsibility until TA-1F ships the generic resolver.",
      isSpectreDefined: true,
    },
  });

  // ---------------------------------------------------------------
  // Club
  // ---------------------------------------------------------------
  const club = await prisma.club.create({
    data: {
      name: "Silver Springs Golf & Country Club",
      slug: "silver-springs",
      wordmark: "Silver Springs",
      logoUrl: null,
      primaryColor: "#2f5832",
      whitelabelEnabled: true,
      address: "1 Fairway Lane, Calgary, AB",
      region: "Alberta",
      salesTaxRegion: "GST",
      foundedYear: 1958,
    },
  });

  // ClubProfile (Admin → Club Settings) — seeded so the Monthly
  // Reporting Package cover renders the identity line
  // ("CALGARY, ALBERTA · EST. 1958") and the period number out of
  // the box. Tenants without a profile gracefully omit the line.
  await prisma.clubProfile.create({
    data: {
      clubId: club.id,
      legalName: "Silver Springs Golf & Country Club Inc.",
      operatingName: "Silver Springs",
      yearFounded: 1958,
      city: "Calgary",
      provinceState: "Alberta",
      fiscalYearEndMonth: 6,
      fiscalYearEndDay: 30,
      defaultCurrency: "CAD",
      // Equity stewardship benchmark assumptions used by the Equity
      // Value Over Time chart (Chair's Dashboard). Basis points so the
      // value is integer-safe.
      //   - bestInClass : 5.50 % CAGR (peer top-quartile growth)
      //   - minRequired : 3.50 % CAGR (inflation parity floor)
      // Aligned with Saguaro p03's published benchmark levels. The
      // reporting service projects both benchmarks from the first
      // historical FY's actual closing equity base, then renders them
      // alongside the GL-derived actual line.
      equityBenchmarkBestCagrBps: 550,
      equityBenchmarkMinCagrBps: 350,
    },
  });

  // Local-dev white-label hostnames. `silver-springs.localtest.me` always
  // resolves to 127.0.0.1 in every OS, so a developer can hit
  // `http://silver-springs.localtest.me:3000/login` and exercise the
  // host-based tenant resolver without DNS plumbing. Status is ACTIVE so
  // `resolveClubByHost` matches it.
  await prisma.clubDomain.createMany({
    data: [
      { clubId: club.id, hostname: "silver-springs.localtest.me", kind: "PRIMARY", status: "ACTIVE", verificationToken: "dev-local", verifiedAt: new Date(), activatedAt: new Date(), isPrimary: true },
      { clubId: club.id, hostname: "members.silver-springs.localtest.me", kind: "MEMBER", status: "ACTIVE", verificationToken: "dev-local", verifiedAt: new Date(), activatedAt: new Date() },
      { clubId: club.id, hostname: "admin.silver-springs.localtest.me", kind: "ADMIN", status: "ACTIVE", verificationToken: "dev-local", verifiedAt: new Date(), activatedAt: new Date() },
    ],
  });

  // Milestones
  const milestones = [
    { year: 1958, title: "Silver Springs Founded", description: "A handful of visionary families broke ground on the original nine holes overlooking the Bow River valley.", sortOrder: 1 },
    { year: 1967, title: "Back Nine Opens", description: "The club expands to a championship 18 with the celebrated Cottonwood Stretch.", sortOrder: 2 },
    { year: 1981, title: "Clubhouse Reborn", description: "The timber-and-stone clubhouse is completed, anchoring decades of memorable evenings.", sortOrder: 3 },
    { year: 1994, title: "Hosts the Provincial Amateur", description: "Silver Springs welcomes the province's top players for an unforgettable week of competition.", sortOrder: 4 },
    { year: 2008, title: "50th Anniversary", description: "Members and alumni gather to celebrate fifty years of friendships, founders, and tradition.", sortOrder: 5 },
    { year: 2019, title: "Practice Facility Modernized", description: "A new short-game complex and indoor performance studio open for member use year-round.", sortOrder: 6 },
    { year: 2024, title: "Junior Program Renewed", description: "A reinvigorated junior pathway nurtures the next generation of Silver Springs members.", sortOrder: 7 },
  ];
  await prisma.clubMilestone.createMany({ data: milestones.map((m) => ({ ...m, clubId: club.id })) });

  // Collection templates + stages
  await prisma.collectionNoticeTemplate.createMany({
    data: DEFAULT_NOTICE_TEMPLATES.map((t) => ({ clubId: club.id, ...t, isSystem: true })),
  });
  await prisma.collectionStage.createMany({
    data: DEFAULT_STAGES.map((s) => ({ clubId: club.id, ...s, isActive: true })),
  });

  // A welcome announcement
  await prisma.clubAnnouncement.create({
    data: {
      clubId: club.id,
      title: "Welcome to your refreshed Member Hub",
      body: "We've updated your hub with new account widgets, statements, and a richer profile. Take a moment to explore.",
      audience: "ALL_MEMBERS",
      publishedAt: new Date(),
    },
  });

  // -------------------------------------------------------------
  // Phase 3 — Accounting bootstrap
  // -------------------------------------------------------------
  // 1. Departments (referenced by account defaults)
  for (let i = 0; i < DEFAULT_DEPARTMENTS.length; i++) {
    const d = DEFAULT_DEPARTMENTS[i];
    await prisma.department.create({
      data: { clubId: club.id, code: d.code, name: d.name, sortOrder: i, isActive: true },
    });
  }
  // 2. FS groups (parents first via DEFAULT_FS_GROUPS ordering)
  for (const g of DEFAULT_FS_GROUPS) {
    await upsertFsGroup(club.id, g);
  }
  // 3. Account categories
  for (const c of DEFAULT_CATEGORIES) {
    await upsertCategory(club.id, c);
  }
  // 4. Accounts — header accounts first via DEFAULT_ACCOUNTS ordering (parents precede children)
  for (const a of DEFAULT_ACCOUNTS) {
    await upsertAccountInternal(club.id, a, null);
  }
  // 5. Fiscal year + 12 monthly periods covering this calendar year and
  //    last + the year before that (the prior-year overlay window for
  //    the Operating Results card needs the year-before-last to be
  //    present so the 12-month YoY comparison line renders).
  const thisYear = new Date().getFullYear();
  await ensureFiscalYear(club.id, { startYear: thisYear - 2, startMonth: 1 });
  await ensureFiscalYear(club.id, { startYear: thisYear - 1, startMonth: 1 });
  await ensureFiscalYear(club.id, { startYear: thisYear, startMonth: 1 });

  // 5b. Historical fiscal-year equity snapshots — FY2019 through
  // FY{thisYear} — used by the Equity Value Over Time stewardship chart
  // (Chair's Dashboard, Section II). Each closed year carries the
  // closing equity as a Decimal on FiscalYear.closingEquity; the chart
  // pulls these via `getEquityHistory()` instead of from a static array
  // in the React component. These ARE accounting records (closed-year
  // equity snapshots), not chart fixtures.
  //
  // The dollar values mirror Silver Springs' historical closing
  // balances and are intentionally identical to the previous demo
  // series so the visual remains continuous through the data-source
  // migration. Real clubs will see these set by the period-close
  // engine when an FY transitions to CLOSED; demo tenants get them
  // seeded here.
  // Series target: $18.83M (FY2018) → $31.00M (FY2025), 7 YoY periods.
  // Compound CAGR = (31.00/18.83)^(1/7) − 1 = 7.38 % → renders "7.4 %".
  // YoY growth ranges 5.95–8.27 % — plausibly irregular real-club
  // progression, not a forced final-year jump. Aligned with Saguaro
  // p03's published actual line. These are the eight COMPLETED fiscal
  // years a May 2026 reporting package draws on; FY2026 itself
  // remains the in-progress current open year (no closingEquity).
  const EQUITY_HISTORY: Array<{ year: number; closingEquity: number }> = [
    { year: 2018, closingEquity: 18_830_000 },
    { year: 2019, closingEquity: 19_950_000 },
    { year: 2020, closingEquity: 21_500_000 },
    { year: 2021, closingEquity: 23_050_000 },
    { year: 2022, closingEquity: 24_800_000 },
    { year: 2023, closingEquity: 26_850_000 },
    { year: 2024, closingEquity: 28_900_000 },
    { year: 2025, closingEquity: 31_000_000 },
  ];

  for (const { year, closingEquity } of EQUITY_HISTORY) {
    // Every year in EQUITY_HISTORY is a completed past year — set
    // status CLOSED. Upsert so FY{thisYear-1} (created earlier by
    // ensureFiscalYear with status OPEN) is also flipped to CLOSED
    // and given its closing equity.
    const startDate = new Date(Date.UTC(year, 0, 1));
    const endDate = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
    await prisma.fiscalYear.upsert({
      where: { clubId_label: { clubId: club.id, label: `FY${year}` } },
      update: { closingEquity, status: "CLOSED" },
      create: {
        clubId: club.id,
        label: `FY${year}`,
        startDate,
        endDate,
        status: "CLOSED",
        closingEquity,
      },
    });
  }

  // 5c. Historical monthly NOI / revenue / budget snapshots — used by
  // the Operating Results — 12-Month Rolling Trend stewardship chart
  // (Chair's Dashboard, Section II). Parallel to the closingEquity
  // story above: each closed monthly period carries its NOI,
  // revenue, and board-approved budget NOI as Decimals on
  // FiscalPeriod (closingNoi / closingRevenue / budgetNoi). The chart
  // pulls these via `getOperatingResults()` instead of from a static
  // array in the React component.
  //
  // Twelve months ending April 2026 form the trailing window the May
  // 31 2026 reporting period draws on (FiscalPeriod.endDate < asOf,
  // so the May 2026 period — which closes after May 31 23:59:59.999
  // > May 31 00:00 — is excluded). Twelve months ending April 2025
  // form the prior-year overlay so the chart's YoY recovery line has
  // real data.
  //
  // Values are in DOLLARS (not cents); seeded to produce
  // board-readable totals at the chart level — see the comment block
  // at the end for the rolled-up KPI math.
  type MonthlyResult = { year: number; month: number; noi: number; revenue: number; budget: number };
  const MONTHLY_RESULTS: MonthlyResult[] = [
    // ---- Prior-year overlay window (May 2024 – Apr 2025) ----
    { year: 2024, month: 1,  noi: -80_000,  revenue: 600_000,   budget: -60_000 },
    { year: 2024, month: 2,  noi: -60_000,  revenue: 580_000,   budget: -40_000 },
    { year: 2024, month: 3,  noi: -25_000,  revenue: 750_000,   budget: -10_000 },
    { year: 2024, month: 4,  noi:   5_000,  revenue: 1_350_000, budget:  20_000 },
    { year: 2024, month: 5,  noi:  50_000,  revenue: 1_600_000, budget:  60_000 },
    { year: 2024, month: 6,  noi:  70_000,  revenue: 1_700_000, budget:  85_000 },
    { year: 2024, month: 7,  noi: -85_000,  revenue: 1_550_000, budget: -20_000 },
    { year: 2024, month: 8,  noi: -68_000,  revenue: 1_450_000, budget: -10_000 },
    { year: 2024, month: 9,  noi: -25_000,  revenue: 1_350_000, budget:  15_000 },
    { year: 2024, month: 10, noi:  20_000,  revenue: 1_400_000, budget:  40_000 },
    { year: 2024, month: 11, noi:  35_000,  revenue: 1_200_000, budget:  55_000 },
    { year: 2024, month: 12, noi:  10_000,  revenue:   850_000, budget:  30_000 },
    { year: 2025, month: 1,  noi: -98_000,  revenue:   650_000, budget: -55_000 },
    { year: 2025, month: 2,  noi: -75_000,  revenue:   620_000, budget: -30_000 },
    { year: 2025, month: 3,  noi: -32_000,  revenue:   780_000, budget:  -5_000 },
    { year: 2025, month: 4,  noi:   5_000,  revenue: 1_400_000, budget:  20_000 },
    // ---- Current trailing-12 window (May 2025 – Apr 2026) ----
    // Re-seeded 2026-06-13 to the Saguaro reference pattern (sums
    // verified in comment block below) so the reporting service
    // produces:
    //   YTD NOI       = $45K
    //   YTD Revenue   = $15.0M  →  NOI % of Revenue = 0.3 %
    //   Budget Goal   = $0
    // Monthly pattern, mapped onto the rolling May-Apr window:
    //   May/Jun     — strong season open      (+60, +70)
    //   Jul/Aug     — summer dip              (−55, −40)
    //   Sep-Dec     — modest fall recovery    (+25, +30, +20, +15)
    //   Jan/Feb     — small winter negative   (−50, −40)
    //   Mar/Apr     — spring recovery start   (+5, +5)
    { year: 2025, month: 5,  noi:  60_000,  revenue: 1_700_000, budget:  50_000 },
    { year: 2025, month: 6,  noi:  70_000,  revenue: 1_750_000, budget:  55_000 },
    { year: 2025, month: 7,  noi: -55_000,  revenue: 1_550_000, budget: -45_000 },
    { year: 2025, month: 8,  noi: -40_000,  revenue: 1_450_000, budget: -35_000 },
    { year: 2025, month: 9,  noi:  25_000,  revenue: 1_380_000, budget:  20_000 },
    { year: 2025, month: 10, noi:  30_000,  revenue: 1_450_000, budget:  25_000 },
    { year: 2025, month: 11, noi:  20_000,  revenue: 1_280_000, budget:  15_000 },
    { year: 2025, month: 12, noi:  15_000,  revenue:   880_000, budget:  10_000 },
    { year: 2026, month: 1,  noi: -50_000,  revenue:   690_000, budget: -45_000 },
    { year: 2026, month: 2,  noi: -40_000,  revenue:   620_000, budget: -35_000 },
    { year: 2026, month: 3,  noi:   5_000,  revenue:   800_000, budget:       0 },
    { year: 2026, month: 4,  noi:   5_000,  revenue: 1_450_000, budget: -15_000 },
  ];
  // Trailing 12 ending Apr 2026 (May 2025 – Apr 2026):
  //   NOI sum     = 60 + 70 − 55 − 40 + 25 + 30 + 20 + 15 − 50 − 40 + 5 + 5  = 45    → $45K YTD
  //   Revenue sum = 1700+1750+1550+1450+1380+1450+1280+880+690+620+800+1450  = 15,000  → $15.0M
  //   NOI %       = 45 / 15,000 * 100 = 0.30 %                                        → 0.3 %
  //   Budget sum  = 50 + 55 − 45 − 35 + 20 + 25 + 15 + 10 − 45 − 35 + 0 − 15  = 0      → $0
  // Prior-year window (May 2024 – Apr 2025), UNCHANGED:
  //   NOI sum     = 50 + 70 − 85 − 68 − 25 + 20 + 35 + 10 − 98 − 75 − 32 + 5  = −193  → ($193K)
  for (const r of MONTHLY_RESULTS) {
    const label = `FY${r.year}-M${String(r.month).padStart(2, "0")}`;
    await prisma.fiscalPeriod.updateMany({
      where: { clubId: club.id, label },
      data: { closingNoi: r.noi, closingRevenue: r.revenue, budgetNoi: r.budget },
    });
  }
  // 6. Phase 4 AP bootstrap: tax codes + approval policies.
  await seedDefaultTaxCodes(club.id);
  await ensureDefaultPolicies(club.id);

  // ---------------------------------------------------------------
  // Users (with new RBAC: User.role kept for back-compat AND UserClubRole rows)
  // ---------------------------------------------------------------
  const passwordHash = await bcrypt.hash("password", 10);

  await createUser({
    email: "super@spectre.app",
    name: "Spectre Super Admin",
    role: "SUPER_ADMIN",
    passwordHash,
    clubId: null,
    memberships: [{ clubId: null, roleKey: "SUPER_ADMIN" }],
  });
  await createUser({
    email: "admin@silversprings.club",
    name: "Patricia Bell",
    role: "CLUB_ADMIN",
    passwordHash,
    clubId: club.id,
    memberships: [{ clubId: club.id, roleKey: "CLUB_ADMIN" }],
  });
  await createUser({
    email: "finance@silversprings.club",
    name: "Daniel Cho",
    role: "FINANCE_ADMIN",
    passwordHash,
    clubId: club.id,
    memberships: [{ clubId: club.id, roleKey: "FINANCE_ADMIN" }],
  });
  // A second club admin role to demonstrate multi-role users in the future
  // (also good for tests). Not surfaced in the quick-login list.
  await createUser({
    email: "gm@silversprings.club",
    name: "Heather Rouleau",
    role: "GENERAL_MANAGER",
    passwordHash,
    clubId: club.id,
    memberships: [{ clubId: club.id, roleKey: "GENERAL_MANAGER" }],
  });

  // ---------------------------------------------------------------
  // Demo members
  // ---------------------------------------------------------------
  const today = new Date();

  // (a) Active in good standing — also seeded as a User with MEMBER role
  const memberA = await createMember(club.id, {
    memberNumber: "1042",
    firstName: "James",
    lastName: "Whitfield",
    email: "member@silversprings.club",
    status: "ACTIVE",
    joinDate: new Date("2014-05-12"),
    paymentMethodStatus: "PRIMARY_AND_BACKUP",
    membershipCategory: "Full Golf",
    accountBalances: { currentBalance: 240.5, thirtyDayBalance: 240.5, sixtyDayBalance: 0, ninetyDayBalance: 0 },
    lastPaymentDate: addDays(today, -7),
    paymentMethods: [
      { type: "CREDIT_CARD", nickname: "Personal Visa", lastFour: "4242", isPrimary: true, status: "ACTIVE" },
      { type: "EFT", nickname: "RBC Chequing", lastFour: "0091", isBackup: true, status: "ACTIVE" },
    ],
    createLogin: { email: "member@silversprings.club" },
    preferences: { interestedGolf: true, interestedDining: true, interestedEvents: true, wantsTeeTimeAlerts: true },
  });

  // (b) Onboarding
  const memberB = await createMember(club.id, {
    memberNumber: "1198",
    firstName: "Aisha",
    lastName: "Khan",
    email: "aisha.khan@example.com",
    status: "ONBOARDING",
    joinDate: addDays(today, -2),
    paymentMethodStatus: "NONE",
    membershipCategory: "Intermediate",
    accountBalances: { currentBalance: 0, thirtyDayBalance: 0, sixtyDayBalance: 0, ninetyDayBalance: 0 },
  });

  // (c) Over 60 days
  const memberC = await createMember(club.id, {
    memberNumber: "0876",
    firstName: "Robert",
    lastName: "Tanner",
    email: "robert.tanner@example.com",
    status: "ACTIVE",
    joinDate: new Date("2009-04-01"),
    paymentMethodStatus: "PRIMARY_ON_FILE",
    membershipCategory: "Full Golf",
    accountBalances: { currentBalance: 1840.0, thirtyDayBalance: 460, sixtyDayBalance: 1380, ninetyDayBalance: 0 },
    lastPaymentDate: addDays(today, -68),
    paymentMethods: [{ type: "CREDIT_CARD", nickname: "Personal Visa", lastFour: "1117", isPrimary: true, status: "ACTIVE" }],
  });

  // (d) Over 90 days
  const memberD = await createMember(club.id, {
    memberNumber: "0613",
    firstName: "Margaret",
    lastName: "Holloway",
    email: "margaret.holloway@example.com",
    status: "ACTIVE",
    accessStatus: "CHARGE_ACCOUNT_SUSPENDED",
    joinDate: new Date("2001-06-14"),
    paymentMethodStatus: "PRIMARY_ON_FILE",
    membershipCategory: "Senior Golf",
    accountBalances: { currentBalance: 3210.0, thirtyDayBalance: 410, sixtyDayBalance: 600, ninetyDayBalance: 900, oneTwentyDayBalance: 1300 },
    lastPaymentDate: addDays(today, -112),
    paymentMethods: [{ type: "CREDIT_CARD", nickname: "Visa", lastFour: "9091", isPrimary: true, status: "ACTIVE" }],
  });

  // (e) Failed payment
  const memberE = await createMember(club.id, {
    memberNumber: "1310",
    firstName: "Owen",
    lastName: "Beauchamp",
    email: "owen.b@example.com",
    status: "ACTIVE",
    joinDate: new Date("2020-08-22"),
    paymentMethodStatus: "PRIMARY_ON_FILE",
    membershipCategory: "Full Golf",
    accountBalances: { currentBalance: 612.0, thirtyDayBalance: 612, sixtyDayBalance: 0, ninetyDayBalance: 0 },
    lastPaymentDate: addDays(today, -34),
    paymentMethods: [{ type: "CREDIT_CARD", nickname: "Visa", lastFour: "0003", isPrimary: true, status: "FAILED" }],
    failedPayment: { amount: 612.0, method: "CREDIT_CARD", failureReason: "Card declined: insufficient funds", daysAgo: 2 },
  });

  // (f) Financing
  const memberF = await createMember(club.id, {
    memberNumber: "1402",
    firstName: "Elena",
    lastName: "Vasquez",
    email: "elena.vasquez@example.com",
    status: "ACTIVE",
    joinDate: new Date("2024-09-15"),
    paymentMethodStatus: "PRIMARY_ON_FILE",
    membershipCategory: "Full Golf",
    accountBalances: { currentBalance: 0, thirtyDayBalance: 0, sixtyDayBalance: 0, ninetyDayBalance: 0 },
    paymentMethods: [{ type: "EFT", nickname: "TD Chequing", lastFour: "5519", isPrimary: true, status: "ACTIVE" }],
  });

  const principal = 19600;
  const interestRate = 0.065;
  const term = 60;
  const startDate = new Date("2024-09-15");
  const amort = calculateAmortization(principal, interestRate, term, startDate);
  const agreement = await prisma.financingAgreement.create({
    data: {
      clubId: club.id,
      memberId: memberF.id,
      principalAmount: principal,
      interestRate,
      termMonths: term,
      paymentFrequency: "MONTHLY",
      monthlyPayment: amort.monthlyPayment,
      totalInterest: amort.totalInterest,
      startDate,
      status: "ACTIVE",
      signedAt: startDate,
      signatureName: "Elena Vasquez",
    },
  });
  await prisma.financingPaymentSchedule.createMany({
    data: amort.schedule.map((r) => ({
      clubId: club.id,
      financingAgreementId: agreement.id,
      paymentNumber: r.paymentNumber,
      dueDate: r.dueDate,
      paymentAmount: r.paymentAmount,
      principalAmount: r.principalAmount,
      interestAmount: r.interestAmount,
      remainingBalance: r.remainingBalance,
      status: r.dueDate < today ? "PAID" : "SCHEDULED",
    })),
  });

  await seedActivity(memberA);
  await seedActivity(memberC);
  await seedActivity(memberD);
  await seedActivity(memberE);

  // -------------------------------------------------------------------
  // Phase 20 (Member Database, 2026-08-15) — enrich the primary demo
  // memberships with the shapes the founder-facing admin Member Profile
  // needs: extended demographics, a portrait, associated household
  // people, group assignments, and custom-field values. Fully
  // fictional data — no PII from the reference screenshot is used.
  // -------------------------------------------------------------------

  // Groups (per-club vocabulary). Six representative segments.
  const groupSeeds = [
    { name: "Sailing Approved", sortOrder: 10 },
    { name: "Tennis",           sortOrder: 20 },
    { name: "Young Members",    sortOrder: 30 },
    { name: "Movie Club",       sortOrder: 40 },
    { name: "Golf",             sortOrder: 50 },
    { name: "Wednesday Night Racing", sortOrder: 60 },
  ];
  const groups = await Promise.all(groupSeeds.map((g) =>
    prisma.memberGroup.upsert({
      where: { clubId_name: { clubId: club.id, name: g.name } },
      create: { clubId: club.id, name: g.name, sortOrder: g.sortOrder },
      update: { sortOrder: g.sortOrder },
    })
  ));
  const groupByName = new Map(groups.map((g) => [g.name, g] as const));

  // Custom fields (per-club catalog). Two representative fields the
  // Member Profile "Additional Information" section renders.
  const customFieldSeeds = [
    { key: "resignation", label: "Resignation", kind: "TEXT" as const, sortOrder: 10 },
    { key: "interested_rc", label: "Are you interested in RC?", kind: "TEXT" as const, sortOrder: 20 },
  ];
  const customFields = await Promise.all(customFieldSeeds.map((c) =>
    prisma.memberCustomFieldDefinition.upsert({
      where: { clubId_key: { clubId: club.id, key: c.key } },
      create: { clubId: club.id, key: c.key, label: c.label, kind: c.kind, sortOrder: c.sortOrder },
      update: { label: c.label, kind: c.kind, sortOrder: c.sortOrder },
    })
  ));
  void customFields;

  // Portrait URLs — deterministic public-domain SVG avatars. Fictional
  // names below; the URLs come from the well-known Dicebear
  // "avataaars" generator and never reference real people.
  const portrait = (seed: string) =>
    `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(seed)}&backgroundColor=b6e3f4`;

  // (A) Family membership — James Whitfield + spouse + two dependants.
  await prisma.member.update({
    where: { id: memberA.id },
    data: {
      middleName: "Andrew",
      nickname: "Jim",
      salutation: "Mr.",
      gender: "male",
      homePhone: "403-555-0101",
      phone: "403-555-0114",
      dateOfBirth: new Date("1968-04-12"),
      profileImageUrl: portrait("james-whitfield"),
      addressLine1: "1204 Ridgeview Terrace",
      city: "Calgary", state: "AB", postalCode: "T3B 2W9", country: "Canada",
    },
  });
  await prisma.memberHouseholdMember.createMany({
    data: [
      { clubId: club.id, memberId: memberA.id, firstName: "Grace", lastName: "Whitfield",
        relationship: "SPOUSE", email: "grace.whitfield@example.com", phone: "403-555-0119",
        dateOfBirth: new Date("1971-11-30"), salutation: "Mrs.", gender: "female",
        profileImageUrl: portrait("grace-whitfield") },
      { clubId: club.id, memberId: memberA.id, firstName: "Ethan", lastName: "Whitfield",
        relationship: "CHILD", email: null, phone: null,
        dateOfBirth: new Date("2005-06-18"), gender: "male",
        profileImageUrl: portrait("ethan-whitfield") },
      { clubId: club.id, memberId: memberA.id, firstName: "Ava", lastName: "Whitfield",
        relationship: "CHILD", email: null, phone: null,
        dateOfBirth: new Date("2009-02-04"), gender: "female",
        profileImageUrl: portrait("ava-whitfield") },
    ],
  });
  await prisma.memberGroupAssignment.createMany({
    data: [
      { clubId: club.id, memberId: memberA.id, groupId: groupByName.get("Sailing Approved")!.id },
      { clubId: club.id, memberId: memberA.id, groupId: groupByName.get("Tennis")!.id },
      { clubId: club.id, memberId: memberA.id, groupId: groupByName.get("Golf")!.id },
      { clubId: club.id, memberId: memberA.id, groupId: groupByName.get("Movie Club")!.id },
      { clubId: club.id, memberId: memberA.id, groupId: groupByName.get("Wednesday Night Racing")!.id },
    ],
  });
  const [defResign, defRc] = customFields;
  await prisma.memberCustomFieldValue.create({
    data: { clubId: club.id, memberId: memberA.id, definitionId: defResign.id, valueText: "Not planning to resign." },
  });
  await prisma.memberCustomFieldValue.create({
    data: { clubId: club.id, memberId: memberA.id, definitionId: defRc.id, valueText: "Yes — please contact re: race committee." },
  });

  // (B) Single-member membership — Aisha Khan, minimal demographics
  // so "Not provided" fallbacks are exercised.
  await prisma.member.update({
    where: { id: memberB.id },
    data: {
      salutation: "Ms.",
      gender: "female",
      dateOfBirth: new Date("1994-09-14"),
      profileImageUrl: portrait("aisha-khan"),
      phone: "403-555-0173",
    },
  });
  await prisma.memberGroupAssignment.create({
    data: { clubId: club.id, memberId: memberB.id, groupId: groupByName.get("Young Members")!.id },
  });

  // (C) Couple membership — Robert Tanner + partner. No dependants.
  await prisma.member.update({
    where: { id: memberC.id },
    data: {
      middleName: "Isaac",
      salutation: "Mr.",
      gender: "male",
      homePhone: "403-555-0202",
      phone: "403-555-0207",
      dateOfBirth: new Date("1955-01-23"),
      profileImageUrl: portrait("robert-tanner"),
      addressLine1: "77 Riverside Lane", city: "Calgary", state: "AB",
      postalCode: "T2P 0X8", country: "Canada",
    },
  });
  await prisma.memberHouseholdMember.create({
    data: { clubId: club.id, memberId: memberC.id,
      firstName: "Priya", lastName: "Tanner", relationship: "PARTNER",
      email: "priya.tanner@example.com", phone: "403-555-0209",
      dateOfBirth: new Date("1958-05-17"), salutation: "Mrs.", gender: "female",
      profileImageUrl: portrait("priya-tanner") },
  });
  await prisma.memberGroupAssignment.createMany({
    data: [
      { clubId: club.id, memberId: memberC.id, groupId: groupByName.get("Golf")!.id },
      { clubId: club.id, memberId: memberC.id, groupId: groupByName.get("Movie Club")!.id },
    ],
  });

  // Notices
  await prisma.collectionNotice.create({ data: { clubId: club.id, memberId: memberC.id, noticeType: "OVER_60", message: defaultNotice("OVER_60", "Robert Tanner"), status: "SENT", sentAt: addDays(today, -3) } });
  await prisma.collectionNotice.create({ data: { clubId: club.id, memberId: memberD.id, noticeType: "OVER_90", message: defaultNotice("OVER_90", "Margaret Holloway"), status: "SENT", sentAt: addDays(today, -6) } });
  await prisma.collectionNotice.create({ data: { clubId: club.id, memberId: memberE.id, noticeType: "CARD_DECLINED", message: defaultNotice("CARD_DECLINED", "Owen Beauchamp"), status: "DRAFT" } });

  // Pending applicants
  await prisma.applicant.createMany({
    data: [
      { clubId: club.id, firstName: "Hugh", lastName: "Tremblay", email: "hugh.tremblay@example.com", phone: "403-555-0142", sponsorName: "James Whitfield", membershipCategory: "Full Golf", employmentInfo: "Partner, Tremblay Construction", consentCreditCheck: true, consentBackgroundCheck: true, applicationStatus: "SUBMITTED", creditScoreBand: "Excellent (760+)" },
      { clubId: club.id, firstName: "Sara", lastName: "Lindgren", email: "sara.lindgren@example.com", phone: "403-555-0188", sponsorName: "Margaret Holloway", membershipCategory: "Intermediate", employmentInfo: "Software Architect", consentCreditCheck: true, consentBackgroundCheck: false, applicationStatus: "UNDER_REVIEW", creditScoreBand: "Very Good (720–759)" },
      { clubId: club.id, firstName: "Marco", lastName: "DiCarlo", email: "marco.dicarlo@example.com", phone: "403-555-0107", sponsorName: "Elena Vasquez", membershipCategory: "Full Golf", employmentInfo: "Restaurateur", consentCreditCheck: true, consentBackgroundCheck: true, applicationStatus: "WAITLISTED", creditScoreBand: "Good (680–719)" },
    ],
  });

  // Events
  const events = await Promise.all([
    prisma.clubEvent.create({ data: { clubId: club.id, title: "Member-Guest Invitational", description: "A weekend of two-day team play, hospitality, and our signature champion's dinner.", eventDate: addDays(today, 21), capacity: 120, price: 380, status: "PUBLISHED" } }),
    prisma.clubEvent.create({ data: { clubId: club.id, title: "Wine & Tasting Evening", description: "An evening with a featured Okanagan vineyard hosted in the founders' lounge.", eventDate: addDays(today, 34), capacity: 60, price: 95, status: "PUBLISHED" } }),
    prisma.clubEvent.create({ data: { clubId: club.id, title: "Junior Club Championship", description: "Two-day stroke play event for our junior members 8–17.", eventDate: addDays(today, 48), capacity: 40, price: 0, status: "PUBLISHED" } }),
  ]);
  await prisma.eventRegistration.create({ data: { clubId: club.id, eventId: events[0].id, memberId: memberA.id, status: "REGISTERED", numberOfGuests: 1, amountCharged: 380 } });

  // Onboarding checklists for any ONBOARDING-status members.
  const onboardingMembers = await prisma.member.findMany({ where: { clubId: club.id, status: "ONBOARDING" } });
  for (const m of onboardingMembers) {
    await prisma.onboardingChecklistItem.createMany({
      data: DEFAULT_CHECKLIST.map((it, idx) => ({
        clubId: club.id,
        memberId: m.id,
        itemKey: it.itemKey,
        title: it.title,
        description: it.description,
        required: it.required,
        sortOrder: idx,
      })),
    });
  }

  // ---------------------------------------------------------------
  // Audit log seed — a few realistic entries so the audit view is non-empty.
  // ---------------------------------------------------------------
  await prisma.auditLog.createMany({
    data: [
      { clubId: club.id, action: "club.created", entityType: "Club", entityId: club.id, ip: "127.0.0.1", userAgent: "seed-script" },
      { clubId: club.id, action: "member.status_change", entityType: "Member", entityId: memberA.id, beforeJson: JSON.stringify({ status: "ONBOARDING" }), afterJson: JSON.stringify({ status: "ACTIVE" }), ip: "127.0.0.1", userAgent: "seed-script" },
    ],
  });

  // -------------------------------------------------------------
  // Backfill AR -> GL using the SUPER_ADMIN principal so adapter
  // calls have a real actor for audit purposes.
  // -------------------------------------------------------------
  const superUser = await prisma.user.findUnique({ where: { email: "super@spectre.app" }, include: { clubRoles: true } });
  if (superUser) {
    const principal = {
      id: superUser.id,
      name: superUser.name,
      email: superUser.email,
      status: superUser.status,
      memberships: superUser.clubRoles.map((r) => ({ clubId: r.clubId, roleKey: r.roleKey as RoleKey })),
      activeClubId: club.id,
      memberId: superUser.memberId,
    };
    const r = await backfillArToGl(principal, club.id);
    console.log(`GL backfill: ${r.chargesPosted} charges, ${r.paymentsPosted} payments, ${r.adjustmentsPosted} adjustments (${r.skipped} skipped).`);

    // ---------------------------------------------------------
    // Phase 4 demo AP data: vendors, invoices, capture items
    // ---------------------------------------------------------
    // Three demo vendors. Two get activated; one stays PENDING_APPROVAL.
    const vendorSeeds = [
      {
        legalName: "Northside Course Maintenance",
        operatingName: "Northside Course",
        taxRegistrationNumber: "123456789RT0001",
        taxRegion: "AB",
        paymentMethod: "EFT" as const,
        paymentTermsDays: 30,
        email: "ap@northside-cm.example",
        phone: "403-555-0204",
        address1: "55 Industrial Way",
        city: "Calgary", provinceState: "AB", postalCode: "T2A 1B2", country: "Canada",
        defaultExpenseAccountNumber: "6020", // Course Equipment R&M
        defaultDepartmentCode: "COURSE",
        defaultTaxCodeKey: "GST_5",
        activate: true,
      },
      {
        legalName: "Premium Foods Co.",
        operatingName: "Premium Foods",
        taxRegistrationNumber: "987654321RT0001",
        taxRegion: "AB",
        paymentMethod: "EFT" as const,
        paymentTermsDays: 14,
        email: "billing@premiumfoods.example",
        defaultExpenseAccountNumber: "5000", // COGS - F&B
        defaultDepartmentCode: "FB",
        defaultTaxCodeKey: "GST_5",
        activate: true,
      },
      {
        legalName: "Tetra Insurance Brokers",
        operatingName: "Tetra Insurance",
        taxRegion: "AB",
        paymentMethod: "CHEQUE" as const,
        paymentTermsDays: 30,
        email: "policies@tetra.example",
        defaultExpenseAccountNumber: "6430", // Insurance
        defaultDepartmentCode: "ADMIN",
        defaultTaxCodeKey: "EXEMPT",
        activate: false,
      },
    ];

    const createdVendors: Array<{ id: string; legalName: string; defaultExpenseAccountNumber?: string; defaultDepartmentCode?: string; defaultTaxCodeKey?: string }> = [];
    for (const v of vendorSeeds) {
      const created = await createVendor(principal, club.id, {
        legalName: v.legalName,
        operatingName: v.operatingName,
        taxRegistrationNumber: v.taxRegistrationNumber,
        taxRegion: v.taxRegion,
        paymentMethod: v.paymentMethod,
        paymentTermsDays: v.paymentTermsDays,
        email: v.email ?? "",
        phone: v.phone ?? "",
        address1: v.address1 ?? "",
        city: v.city ?? "",
        provinceState: v.provinceState ?? "",
        postalCode: v.postalCode ?? "",
        country: v.country ?? "",
        defaultExpenseAccountNumber: v.defaultExpenseAccountNumber ?? null,
        defaultDepartmentCode: v.defaultDepartmentCode ?? null,
        defaultTaxCodeKey: v.defaultTaxCodeKey ?? null,
      });
      if (v.activate) {
        await prisma.vendor.update({ where: { id: created.id }, data: { status: "ACTIVE", approvedAt: new Date(), approvedByUserId: principal.id } });
      }
      createdVendors.push({ id: created.id, legalName: created.legalName, defaultExpenseAccountNumber: v.defaultExpenseAccountNumber, defaultDepartmentCode: v.defaultDepartmentCode, defaultTaxCodeKey: v.defaultTaxCodeKey });
    }

    // Active EFT banking for the first vendor (so the EFT payment path works).
    const northside = createdVendors[0];
    const bp = await addBankingProfile(principal, northside.id, {
      type: "EFT", bankName: "Royal Canadian Bank",
      institutionNumber: "001", transitNumber: "00123",
      accountLastFour: "8821",
      processorToken: "vault_tok_demo_8821",
    });
    await submitBankingForApproval(principal, bp.id);
    // Confirm a penny test then verify (skip the penny-test gate via override
    // since SUPER_ADMIN holds ap:exception:override).
    await verifyBanking(principal, bp.id, { skipPennyTest: true });

    // Two demo AP invoices: one DRAFT, one POSTED.
    const draftInv = await invoiceService.createDraft(principal, club.id, {
      vendorId: northside.id,
      vendorReference: "NS-2025-0142",
      invoiceDate: new Date().toISOString().slice(0, 10),
      description: "Greens mower service & parts",
      currency: "CAD",
      lines: [
        { expenseAccountNumber: "6020", departmentCode: "COURSE", description: "Mower service", amount: 850, taxCodeKey: "GST_5", taxAmount: 42.5 },
        { expenseAccountNumber: "6010", departmentCode: "COURSE", description: "Replacement parts", amount: 320, taxCodeKey: "GST_5", taxAmount: 16 },
      ],
    });
    void draftInv;

    const postedInv = await invoiceService.createDraft(principal, club.id, {
      vendorId: createdVendors[1].id, // Premium Foods
      vendorReference: "PF-INV-9874",
      invoiceDate: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
      description: "Weekly produce delivery",
      currency: "CAD",
      lines: [
        { expenseAccountNumber: "5000", departmentCode: "FB", description: "Produce", amount: 1240, taxCodeKey: "GST_5", taxAmount: 62 },
      ],
    });
    // Take it straight to POSTED via the SUPER_ADMIN override path.
    await invoiceService.submitInvoiceForApproval(principal, postedInv.id);
    await invoiceService.postInvoice(principal, postedInv.id);

    // A couple of capture-inbox items.
    for (const fileName of ["Northside-INV-0143.pdf", "Highland-Power-Bill-March.pdf", "Heritage-Office-Receipt.jpg"]) {
      await uploadCapture(principal, club.id, { name: fileName, mimeType: "application/pdf", sizeBytes: 145000 });
    }

    console.log(`AP demo: ${createdVendors.length} vendors, 2 invoices, 3 captures.`);

    // ---------------------------------------------------------
    // Phase 5 — Operational core demo data
    // ---------------------------------------------------------
    await seedPhase5(club.id, principal, { northsideVendorId: northside.id, premiumFoodsVendorId: createdVendors[1].id });

    // ---------------------------------------------------------
    // Phase 6 — Enterprise reporting, KPIs, governance, settings
    // ---------------------------------------------------------
    await ensureBuiltinDefinitions(club.id);
    await ensureSystemTemplates(club.id);
    await ensureDefaultKPIs(club.id);
    await ensureDefaultDashboards(club.id);
    await ensureSystemRules(club.id);
    await ensureDefaultSettings(club.id);
    // Compute initial KPI values + scan for insights so the demo isn't empty.
    const kpiResult = await computeKPIValues(club.id);
    const insightResult = await runInsights(club.id, principal);
    await reindexClub(club.id);
    console.log(`Phase 6 demo: ${kpiResult.kpiCount} KPIs computed, ${insightResult.raised} insights raised.`);

    // ---------------------------------------------------------
    // Phase 7 — POS location + an integration row hinting at dev defaults.
    // ---------------------------------------------------------
    const proShopDept = await prisma.department.findFirst({ where: { clubId: club.id, code: "PROSHOP" } });
    const fbDept = await prisma.department.findFirst({ where: { clubId: club.id, code: "FB" } });
    await prisma.pOSLocation.upsert({
      where: { clubId_code: { clubId: club.id, code: "PROSHOP-FLOOR" } },
      update: {},
      create: { clubId: club.id, code: "PROSHOP-FLOOR", name: "Pro Shop Floor", departmentId: proShopDept?.id ?? null },
    });
    await prisma.pOSLocation.upsert({
      where: { clubId_code: { clubId: club.id, code: "FB-DINING" } },
      update: {},
      create: { clubId: club.id, code: "FB-DINING", name: "F&B Dining Room", departmentId: fbDept?.id ?? null },
    });
    // Clubhouse lounge — the workflow this build targets. Dedicated
    // location so a lounge sale lands on its own ledger line and the
    // member's dining surfaces can filter to it cleanly.
    const lounge = await prisma.pOSLocation.upsert({
      where: { clubId_code: { clubId: club.id, code: "FB-LOUNGE" } },
      update: {},
      create: { clubId: club.id, code: "FB-LOUNGE", name: "Clubhouse Lounge", departmentId: fbDept?.id ?? null },
    });
    const loungeTerminal = await prisma.pOSTerminal.upsert({
      where: { clubId_code: { clubId: club.id, code: "LOUNGE-T1" } },
      update: {},
      create: { clubId: club.id, code: "LOUNGE-T1", name: "Lounge Terminal 1", locationId: lounge.id },
    });
    // An open session so staff can ring up a sale immediately on first run.
    const openLoungeSession = await prisma.pOSSession.findFirst({
      where: { clubId: club.id, locationId: lounge.id, status: "OPEN" },
    });
    if (!openLoungeSession) {
      await prisma.pOSSession.create({
        data: {
          clubId: club.id,
          locationId: lounge.id,
          terminalId: loungeTerminal.id,
          status: "OPEN",
          openingFloat: 0,
        },
      });
    }
    // Full Silver Springs Clubhouse Lounge menu. Shared with the
    // live-DB refresh script — see prisma/lounge-menu.ts.
    const { LOUNGE_MENU } = await import("./lounge-menu");
    for (const group of LOUNGE_MENU) {
      const cat = await prisma.pOSMenuCategory.upsert({
        where: { clubId_locationId_name: { clubId: club.id, locationId: lounge.id, name: group.category } },
        update: { sortOrder: group.sortOrder, isActive: true, chitDestination: group.destination },
        create: { clubId: club.id, locationId: lounge.id, name: group.category, sortOrder: group.sortOrder, isActive: true, chitDestination: group.destination },
      });
      for (let i = 0; i < group.items.length; i++) {
        const it = group.items[i];
        await prisma.pOSMenuItem.upsert({
          where: { clubId_categoryId_name: { clubId: club.id, categoryId: cat.id, name: it.name } },
          update: { price: it.price, description: it.description ?? null, sortOrder: i, isActive: true },
          create: {
            clubId: club.id, categoryId: cat.id,
            name: it.name, description: it.description ?? null,
            price: it.price, sortOrder: i, isActive: true,
          },
        });
      }
    }
    // A dev integration row per scope so the integrations page shows real
    // data on first run.
    for (const scope of ["EMAIL", "SMS", "STORAGE", "LLM"] as const) {
      await prisma.integrationSetting.upsert({
        where: { clubId_scope_provider: { clubId: club.id, scope, provider: "dev" } },
        update: { isActive: true, configJson: "{}" },
        create: { clubId: club.id, scope, provider: "dev", isActive: true, configJson: "{}" },
      });
    }
    console.log(`Phase 7 demo: 3 POS locations (incl. Clubhouse Lounge with menu), dev adapters configured for EMAIL/SMS/STORAGE/LLM.`);

    // Modifier catalog for the lounge menu (no onions / add bacon /
    // fries → salad). Idempotent — wipes per-item groups before
    // re-seeding. Shared with `scripts/refresh-lounge-modifiers.ts`.
    {
      const { seedLoungeModifiers } = await import("../scripts/refresh-lounge-modifiers");
      const r = await seedLoungeModifiers({ clubId: club.id });
      console.log(`Phase 7D demo: lounge modifiers — ${r.groups} groups · ${r.options} options · ${r.items} items.`);
    }

    // Phase 18C demo: dining areas, tables, reservation settings, and a
    // mix of historical + upcoming reservations so the host dashboard
    // and analytics page have data on first boot. All scoped to
    // Silver Springs only; idempotent via upsert / @@unique keys.
    {
      // Lounge: long bar runs across the top of the canvas, two rows of
      // tables in front, a window booth + round-8 anchor the wall.
      const loungeBar = [
        { kind: "BAR", x: 500, y: 70,  width: 760, height: 70, label: "BAR" },
      ];
      const lounge = await prisma.diningArea.upsert({
        where: { clubId_name: { clubId: club.id, name: "Clubhouse Lounge" } },
        update: {
          active: true, sortOrder: 0,
          floorElementsJson: JSON.stringify(loungeBar),
          canvasWidth: 1000, canvasHeight: 620,
          description: "Indoor dining with the bar along the back wall and seating fanning out toward the windows.",
        },
        create: {
          clubId: club.id, name: "Clubhouse Lounge",
          description: "Indoor dining with the bar along the back wall and seating fanning out toward the windows.",
          sortOrder: 0, canvasWidth: 1000, canvasHeight: 620,
          floorElementsJson: JSON.stringify(loungeBar),
        },
      });
      // Patio: open-air; no bar, single label up top.
      const patioElements = [
        { kind: "LABEL", x: 500, y: 50, width: 200, height: 20, label: "PATIO · OVERLOOKING 18TH" },
        { kind: "DIVIDER", x: 500, y: 80, width: 760, height: 4 },
      ];
      const patio = await prisma.diningArea.upsert({
        where: { clubId_name: { clubId: club.id, name: "Patio" } },
        update: {
          active: true, sortOrder: 1,
          floorElementsJson: JSON.stringify(patioElements),
          canvasWidth: 1000, canvasHeight: 480,
        },
        create: {
          clubId: club.id, name: "Patio",
          description: "Seasonal outdoor dining overlooking the 18th.",
          sortOrder: 1, canvasWidth: 1000, canvasHeight: 480,
          floorElementsJson: JSON.stringify(patioElements),
        },
      });

      // Realistic Silver Springs layout. Coordinates in the 1000×620
      // virtual canvas; shapes match the real dining room style.
      const tableDefs: Array<{
        areaId: string; num: string; cap: number;
        display?: string;
        shape: "ROUND" | "SQUARE" | "RECTANGLE";
        x: number; y: number; width: number; height: number; rotation?: number;
      }> = [
        // Front of the bar — two-top high-tops.
        { areaId: lounge.id, num: "L1", cap: 2, shape: "ROUND",  x: 170, y: 220, width: 80,  height: 80 },
        { areaId: lounge.id, num: "L2", cap: 2, shape: "ROUND",  x: 290, y: 220, width: 80,  height: 80 },
        // Middle row — four-tops.
        { areaId: lounge.id, num: "L3", cap: 4, shape: "SQUARE", x: 460, y: 250, width: 110, height: 110 },
        { areaId: lounge.id, num: "L4", cap: 4, shape: "SQUARE", x: 610, y: 250, width: 110, height: 110 },
        { areaId: lounge.id, num: "L5", cap: 4, shape: "SQUARE", x: 760, y: 250, width: 110, height: 110 },
        // Window wall — long booth rectangle.
        { areaId: lounge.id, num: "L6", cap: 6, display: "Window booth", shape: "RECTANGLE", x: 260, y: 440, width: 280, height: 90 },
        // Anchor round 8-top.
        { areaId: lounge.id, num: "L7", cap: 8, display: "Round 8",       shape: "ROUND",     x: 700, y: 450, width: 160, height: 160 },

        // Patio: open-air; mix of round 2/4-tops, two 6-top group tables.
        { areaId: patio.id, num: "P1", cap: 2, shape: "ROUND",     x: 160, y: 220, width: 80,  height: 80 },
        { areaId: patio.id, num: "P2", cap: 4, shape: "ROUND",     x: 320, y: 220, width: 110, height: 110 },
        { areaId: patio.id, num: "P3", cap: 4, shape: "ROUND",     x: 500, y: 220, width: 110, height: 110 },
        { areaId: patio.id, num: "P4", cap: 6, shape: "RECTANGLE", x: 700, y: 220, width: 220, height: 90 },
        { areaId: patio.id, num: "P5", cap: 6, shape: "RECTANGLE", x: 500, y: 380, width: 260, height: 90 },
      ];
      const tableMap: Record<string, string> = {};
      for (const t of tableDefs) {
        const row = await prisma.diningTable.upsert({
          where: { clubId_tableNumber: { clubId: club.id, tableNumber: t.num } },
          update: {
            capacity: t.cap, diningAreaId: t.areaId, displayName: t.display ?? null, active: true,
            shape: t.shape, xPos: t.x, yPos: t.y, width: t.width, height: t.height,
            rotation: t.rotation ?? 0,
          },
          create: {
            clubId: club.id, diningAreaId: t.areaId, tableNumber: t.num,
            displayName: t.display ?? null, capacity: t.cap,
            minPartySize: 1, maxPartySize: Math.max(t.cap, 8),
            shape: t.shape, xPos: t.x, yPos: t.y, width: t.width, height: t.height,
            rotation: t.rotation ?? 0,
          },
        });
        tableMap[t.num] = row.id;
      }
      // Make one lounge table DIRTY on first seed so the legend has a
      // visible example. Only when the table is currently AVAILABLE
      // (avoid overwriting a live SEATED state on subsequent reseeds).
      await prisma.diningTable.updateMany({
        where: { id: tableMap["L3"], status: "AVAILABLE" },
        data: { status: "DIRTY" },
      });
      // And take one patio table OUT_OF_SERVICE for the demo.
      await prisma.diningTable.updateMany({
        where: { id: tableMap["P1"], status: "AVAILABLE" },
        data: { status: "OUT_OF_SERVICE" },
      });

      await prisma.reservationSettings.upsert({
        where: { clubId: club.id },
        update: {
          dressCodeText: "Smart-casual attire is required in all Silver Springs dining areas. Denim, athletic wear, and head coverings are not permitted. Collared shirts are required for gentlemen after 4pm.",
          noShowPolicyText: "Please cancel at least two hours in advance. Missed reservations may be subject to a no-show fee charged to the member account.",
          contactEmail: "clubhouse@silverspringsgolfclub.com",
          contactPhone: "+1 (902) 555-0140",
          noShowFeeAmount: new (await import("@prisma/client/runtime/library")).Decimal(25),
          maxPartySizeOnline: 8,
          advanceBookingDays: 60,
          cancellationCutoffHours: 2,
        },
        create: {
          clubId: club.id,
          dressCodeText: "Smart-casual attire is required in all Silver Springs dining areas. Denim, athletic wear, and head coverings are not permitted. Collared shirts are required for gentlemen after 4pm.",
          noShowPolicyText: "Please cancel at least two hours in advance. Missed reservations may be subject to a no-show fee charged to the member account.",
          contactEmail: "clubhouse@silverspringsgolfclub.com",
          contactPhone: "+1 (902) 555-0140",
          maxPartySizeOnline: 8,
          advanceBookingDays: 60,
          cancellationCutoffHours: 2,
        },
      });

      // Demo reservations only if the table is otherwise empty for this
      // club — keeps reseeds non-cumulative.
      const existing = await prisma.diningReservation.count({ where: { clubId: club.id } });
      if (existing === 0) {
        const someMembers = await prisma.member.findMany({
          where: { clubId: club.id }, select: { id: true }, take: 8, orderBy: { lastName: "asc" },
        });
        const now = new Date();
        const future = (h: number) => new Date(now.getTime() + h * 60 * 60 * 1000);
        const past = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

        // Today / upcoming: a CONFIRMED reservation tonight, a SEATED party right now.
        if (someMembers.length > 0) {
          await prisma.diningReservation.create({
            data: {
              clubId: club.id, memberId: someMembers[0].id,
              reservationType: "MEMBER", status: "CONFIRMED",
              reservationDate: new Date(Date.UTC(future(6).getUTCFullYear(), future(6).getUTCMonth(), future(6).getUTCDate())),
              startTime: future(6),
              expectedEndTime: future(6 + 1.5),
              partySize: 4, diningAreaId: lounge.id, tableId: tableMap["L4"],
              dressCodeAcknowledged: true, noShowFeeAcknowledged: true, createdById: null,
              occasion: "Anniversary",
            },
          });
        }
        if (someMembers.length > 1) {
          const seatedAt = new Date(now.getTime() - 35 * 60_000);
          await prisma.diningReservation.create({
            data: {
              clubId: club.id, memberId: someMembers[1].id,
              reservationType: "MEMBER", status: "SEATED",
              reservationDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
              startTime: seatedAt, expectedEndTime: future(1),
              actualSeatedAt: seatedAt,
              partySize: 2, diningAreaId: lounge.id, tableId: tableMap["L1"],
              dressCodeAcknowledged: true, noShowFeeAcknowledged: true,
            },
          });
          await prisma.diningTable.update({
            where: { id: tableMap["L1"] }, data: { status: "SEATED" },
          });
        }

        // Historical completed visits across the last 30 days.
        for (let i = 0; i < 12 && i < someMembers.length * 3; i++) {
          const m = someMembers[i % someMembers.length];
          const startedAt = past(i + 1);
          const seatedAt = new Date(startedAt.getTime() + 10 * 60_000);
          const departedAt = new Date(seatedAt.getTime() + (60 + (i % 5) * 10) * 60_000);
          await prisma.diningReservation.create({
            data: {
              clubId: club.id, memberId: m.id,
              reservationType: i % 4 === 0 ? "WALK_IN" : "MEMBER",
              status: "COMPLETED",
              reservationDate: new Date(Date.UTC(startedAt.getUTCFullYear(), startedAt.getUTCMonth(), startedAt.getUTCDate())),
              startTime: startedAt, expectedEndTime: new Date(seatedAt.getTime() + 90 * 60_000),
              actualSeatedAt: seatedAt, actualDepartedAt: departedAt,
              partySize: 2 + (i % 4),
              diningAreaId: i % 3 === 0 ? patio.id : lounge.id,
              tableId: tableMap[i % 3 === 0 ? "P3" : "L3"],
              dressCodeAcknowledged: true, noShowFeeAcknowledged: true,
            },
          });
        }
        // A couple of no-shows.
        if (someMembers.length > 2) {
          await prisma.diningReservation.create({
            data: {
              clubId: club.id, memberId: someMembers[2].id,
              reservationType: "MEMBER", status: "NO_SHOW",
              reservationDate: past(4),
              startTime: past(4), expectedEndTime: new Date(past(4).getTime() + 90 * 60_000),
              partySize: 4, diningAreaId: lounge.id, tableId: tableMap["L4"],
              dressCodeAcknowledged: true, noShowFeeAcknowledged: true,
              noShowMarkedAt: past(4), noShowReason: "Did not arrive within the courtesy window.",
            },
          });
        }
        console.log(`Phase 18C demo: 2 dining areas + 12 tables + reservation settings + demo reservations (clubhouse@silverspringsgolfclub.com).`);
      } else {
        console.log(`Phase 18C demo: dining areas + tables + settings up-to-date.`);
      }
    }

    // 60 days of demo prep-time history so the hospitality analytics
    // dashboard is populated on first boot. Idempotent — keyed off the
    // marker string in POSCheck.notes.
    {
      const { seedHospitalityHistory } = await import("../scripts/seed-hospitality-history");
      const r = await seedHospitalityHistory({ clubId: club.id });
      console.log(`Phase 7C demo: hospitality history — ${r.checks} checks · ${r.chits} chits over 60 days.`);
    }

    // ---------------------------------------------------------
    // Phase 7B — Seed two historical lounge sales for the demo member so
    // the dining widget on /app/member shows real data on first sign-in.
    // We write the records directly (not through `completeSale()`) because
    // seed data doesn't need posting-guard, audit, or GL side effects —
    // tests exercise the real service path, the seed just needs realistic
    // rows.
    // ---------------------------------------------------------
    {
      const demoMember = await prisma.member.findFirst({ where: { clubId: club.id, memberNumber: "1042" } });
      const memberAccount = demoMember ? await prisma.memberAccount.findUnique({ where: { memberId: demoMember.id } }) : null;
      // Attribute the seeded historical sales to the club admin so the
      // POS history page shows a staff name on row 1 from first run.
      // (A future seed could rotate through staff users for variety.)
      const seedingStaff = await prisma.user.findFirst({ where: { email: "admin@silversprings.club" } });
      if (demoMember && memberAccount) {
        // Plausible recent orders using items from the actual menu so
        // the demo member's dining widget reflects realistic purchases.
        // The seeder doesn't go through priceLoungeCart — it stamps the
        // numbers directly — so prices must match the menu prices in
        // `prisma/lounge-menu.ts`.
        const orders = [
          {
            daysAgo: 6,
            saleNumber: "LNG-1001",
            lines: [
              { name: "Steak Frites", price: 28, qty: 1 },
              { name: "Caesar Salad (Starter)", price: 9, qty: 1 },
              { name: "50th Anniversary Ale (Pint)", price: 6.75, qty: 1 },
              { name: "House Made Tiramisu", price: 9, qty: 1 },
            ],
          },
          {
            daysAgo: 2,
            saleNumber: "LNG-1002",
            lines: [
              { name: "Chicken Wings", price: 18, qty: 1 },
              { name: "Heineken", price: 8, qty: 1 },
            ],
          },
        ];
        const GST_RATE = 0.05;
        for (const order of orders) {
          const subtotal = order.lines.reduce((s, l) => s + l.price * l.qty, 0);
          const taxTotal = Math.round(subtotal * GST_RATE * 100) / 100;
          const grandTotal = Math.round((subtotal + taxTotal) * 100) / 100;
          const saleDate = addDays(today, -order.daysAgo);

          // Skip if this sale was already seeded.
          const existing = await prisma.pOSSale.findFirst({ where: { clubId: club.id, saleNumber: order.saleNumber } });
          if (existing) continue;

          // Create the AR Charge first so we can link it on the sale.
          const arCharge = await prisma.charge.create({
            data: {
              clubId: club.id,
              memberId: demoMember.id,
              accountId: memberAccount.id,
              description: `Clubhouse Lounge — ${order.saleNumber}`,
              category: "FOOD_BEVERAGE",
              amount: grandTotal,
              transactionDate: saleDate,
              status: "POSTED",
            },
          });
          const sale = await prisma.pOSSale.create({
            data: {
              clubId: club.id,
              saleNumber: order.saleNumber,
              locationId: lounge.id,
              terminalId: loungeTerminal.id,
              memberId: demoMember.id,
              chargeMode: "MEMBER_ACCOUNT",
              subtotal, taxTotal, grandTotal,
              status: "COMPLETED",
              saleDate,
              arChargeId: arCharge.id,
              createdByUserId: seedingStaff?.id ?? null,
            },
          });
          for (let i = 0; i < order.lines.length; i++) {
            const l = order.lines[i];
            const lineSubtotal = l.price * l.qty;
            const lineTax = Math.round(lineSubtotal * GST_RATE * 100) / 100;
            await prisma.pOSSaleLine.create({
              data: {
                clubId: club.id,
                saleId: sale.id,
                kind: "SERVICE",
                description: l.name,
                quantity: l.qty,
                unitPrice: l.price,
                lineSubtotal,
                taxAmount: lineTax,
                lineTotal: lineSubtotal + lineTax,
              },
            });
          }
          await prisma.pOSTaxLine.create({
            data: {
              clubId: club.id, saleId: sale.id, kind: "TAX",
              label: "GST 5%", rate: GST_RATE, amount: taxTotal, taxCodeKey: "GST_5",
            },
          });
          await prisma.pOSPayment.create({
            data: {
              clubId: club.id, saleId: sale.id,
              method: "MEMBER_ACCOUNT", amount: grandTotal, status: "CAPTURED",
              capturedAt: saleDate,
            },
          });
        }
        console.log(`Phase 7B demo: 2 historical lounge sales seeded for ${demoMember.firstName} ${demoMember.lastName}.`);
      }
    }

    // ---------------------------------------------------------
    // Phase 8 — Tee sheet course, feature flags, demo device.
    // ---------------------------------------------------------
    const course = await prisma.course.upsert({
      where: { clubId_code: { clubId: club.id, code: "MAIN-18" } },
      update: {},
      create: { clubId: club.id, code: "MAIN-18", name: "Main 18 Championship Course", holes: 18, parTotal: 72 },
    });
    // Generate two CourseHoles for tests; the full 18 is admin-driven.
    for (let i = 1; i <= 18; i++) {
      await prisma.courseHole.upsert({
        where: { courseId_holeNumber: { courseId: course.id, holeNumber: i } },
        update: {},
        create: { clubId: club.id, courseId: course.id, holeNumber: i, par: i % 5 === 0 ? 5 : (i % 3 === 0 ? 3 : 4), yardage: 360 + (i * 7) },
      });
    }
    // Global feature flags: tee sheet on by default; LLM commentary at 20%.
    await prisma.featureFlag.create({ data: { clubId: club.id, key: "tee_sheet", name: "Tee Sheet", isEnabled: true, rolloutPercent: 100, scope: "MODULE" } });
    await prisma.featureFlag.create({ data: { clubId: club.id, key: "llm_commentary", name: "AI Commentary", isEnabled: true, rolloutPercent: 100, scope: "EXPERIMENT" } });
    await prisma.featureFlag.create({ data: { clubId: club.id, key: "pos_webhooks", name: "POS Webhooks", isEnabled: true, rolloutPercent: 100, scope: "MODULE" } });
    await prisma.featureFlag.create({ data: { clubId: club.id, key: "hardware_devices", name: "Hardware devices", isEnabled: false, rolloutPercent: 0, scope: "EXPERIMENT" } });
    // A demo door-access device.
    await prisma.hardwareDevice.create({
      data: {
        clubId: club.id, serial: "DOOR-PROSHOP-001", kind: "DOOR_ACCESS",
        label: "Pro Shop front door", vendor: "Acme Access", status: "ACTIVE",
        authTokenHash: "demo-token-hash-placeholder",
      },
    });
    // Capture an initial queue-health snapshot row so the queues page isn't empty.
    const { captureQueueHealth } = await import("../src/lib/queue");
    await captureQueueHealth();
    console.log(`Phase 8 demo: 1 course (18 holes), 4 feature flags, 1 device, queue-health snapshot.`);

    // ---------------------------------------------------------
    // Phase 9 — pilot readiness, demo tournament, demo API key.
    // ---------------------------------------------------------
    const { ensureManualItems, runProbes } = await import("../src/lib/pilot");
    await ensureManualItems(club.id);
    await runProbes(club.id);
    // Demo tournament (DRAFT) anchored to the Main 18 course.
    const mainCourse = await prisma.course.findFirst({ where: { clubId: club.id, code: "MAIN-18" } });
    if (mainCourse) {
      const lessonRevenue = await prisma.account.findFirst({ where: { clubId: club.id, accountNumber: "4400" } });
      await prisma.tournament.upsert({
        where: { clubId_name: { clubId: club.id, name: "Member-Guest Invitational" } },
        update: {},
        create: {
          clubId: club.id, name: "Member-Guest Invitational",
          description: "Weekend two-day team play with hospitality and a champion's dinner.",
          format: "STROKE", status: "DRAFT",
          startDate: new Date(Date.now() + 30 * 86400000),
          endDate: new Date(Date.now() + 31 * 86400000),
          registrationOpensAt: new Date(Date.now() - 7 * 86400000),
          registrationClosesAt: new Date(Date.now() + 14 * 86400000),
          entryFee: 380, guestFee: 380,
          maxParticipants: 64,
          courseId: mainCourse.id, revenueAccountId: lessonRevenue?.id ?? null,
        },
      });
    }
    console.log(`Phase 9 demo: readiness probes run, 1 tournament scaffolded.`);

    // ---------------------------------------------------------
    // Phase 10 — default plans, pilot subscription, demo webhook subscription.
    // ---------------------------------------------------------
    const { ensureDefaultPlans } = await import("../src/lib/entitlements");
    await ensureDefaultPlans();
    // Pilot subscription for the demo club.
    const pilotPlan = await prisma.subscriptionPlan.findUnique({ where: { key: "pilot" } });
    if (pilotPlan) {
      await prisma.clubSubscription.upsert({
        where: { clubId: club.id },
        update: {},
        create: { clubId: club.id, planId: pilotPlan.id, status: "PILOT", seatCount: 5 },
      });
    }
    console.log(`Phase 10 demo: default plan catalog seeded, club enrolled in PILOT.`);
  }

  console.log("\nDemo seed complete.\n");
  console.log("Sign in at /login with any of:");
  console.log("  super@spectre.app           / password   (SUPER_ADMIN)");
  console.log("  admin@silversprings.club    / password   (CLUB_ADMIN)");
  console.log("  finance@silversprings.club  / password   (FINANCE_ADMIN)");
  console.log("  gm@silversprings.club       / password   (GENERAL_MANAGER)");
  console.log("  member@silversprings.club   / password   (MEMBER — James Whitfield)\n");
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
type UserSeed = {
  email: string;
  name: string;
  role: RoleKey;
  passwordHash: string;
  clubId: string | null;
  memberId?: string | null;
  memberships: Array<{ clubId: string | null; roleKey: RoleKey }>;
};

async function createUser(u: UserSeed) {
  const user = await prisma.user.create({
    data: {
      name: u.name,
      email: u.email,
      role: u.role,
      passwordHash: u.passwordHash,
      clubId: u.clubId,
      memberId: u.memberId ?? null,
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    },
  });
  for (const m of u.memberships) {
    await prisma.userClubRole.create({
      data: { userId: user.id, clubId: m.clubId, roleKey: m.roleKey },
    });
  }
  return user;
}

type MemberSeed = {
  memberNumber: string;
  firstName: string;
  lastName: string;
  email: string;
  status: string;
  accessStatus?: string;
  joinDate?: Date;
  membershipCategory: string;
  paymentMethodStatus: string;
  accountBalances: { currentBalance: number; thirtyDayBalance: number; sixtyDayBalance: number; ninetyDayBalance: number; oneTwentyDayBalance?: number };
  lastPaymentDate?: Date;
  paymentMethods?: Array<{ type: string; nickname: string; lastFour: string; isPrimary?: boolean; isBackup?: boolean; status: string }>;
  createLogin?: { email: string };
  preferences?: Partial<{ interestedGolf: boolean; interestedDining: boolean; interestedEvents: boolean; interestedLeagues: boolean; interestedPracticeFacilities: boolean; wantsProShopOffers: boolean; wantsTeeTimeAlerts: boolean }>;
  failedPayment?: { amount: number; method: string; failureReason: string; daysAgo: number };
};

async function createMember(clubId: string, m: MemberSeed) {
  const member = await prisma.member.create({
    data: {
      clubId,
      memberNumber: m.memberNumber,
      firstName: m.firstName,
      lastName: m.lastName,
      email: m.email,
      status: m.status,
      accessStatus: m.accessStatus ?? "FULL_ACCESS",
      joinDate: m.joinDate,
      membershipCategory: m.membershipCategory,
      paymentMethodStatus: m.paymentMethodStatus,
    },
  });
  const account = await prisma.memberAccount.create({
    data: { clubId, memberId: member.id, ...m.accountBalances, lastPaymentDate: m.lastPaymentDate },
  });
  if (m.paymentMethods) {
    await prisma.paymentMethod.createMany({
      data: m.paymentMethods.map((pm) => ({
        clubId,
        memberId: member.id,
        type: pm.type,
        nickname: pm.nickname,
        lastFour: pm.lastFour,
        isPrimary: !!pm.isPrimary,
        isBackup: !!pm.isBackup,
        status: pm.status,
      })),
    });
  }
  if (m.createLogin) {
    const passwordHash = await bcrypt.hash("password", 10);
    await createUser({
      email: m.createLogin.email,
      name: `${m.firstName} ${m.lastName}`,
      role: "MEMBER",
      passwordHash,
      clubId,
      memberId: member.id,
      memberships: [{ clubId, roleKey: "MEMBER" }],
    });
  }
  if (m.preferences) {
    await prisma.memberPreference.create({ data: { clubId, memberId: member.id, ...m.preferences } });
  }
  if (m.failedPayment) {
    await prisma.payment.create({
      data: {
        clubId,
        memberId: member.id,
        accountId: account.id,
        amount: m.failedPayment.amount,
        method: m.failedPayment.method,
        status: "FAILED",
        failureReason: m.failedPayment.failureReason,
        paymentDate: addDays(new Date(), -m.failedPayment.daysAgo),
      },
    });
  }
  return member;
}

async function seedActivity(member: { id: string; clubId: string }) {
  const account = await prisma.memberAccount.findUnique({ where: { memberId: member.id } });
  if (!account) return;

  const today = new Date();
  // Dining charges aren't in this list anymore — they come from real
  // POS sales seeded in Phase 7B (Clubhouse Lounge). Keeping a stray
  // FOOD_BEVERAGE row here would split the member's dining history
  // across two sources and confuse the dining widget / receipt detail.
  const sample = [
    { description: "Monthly Dues", category: "DUES", amount: 410, daysAgo: 28 },
    { description: "Pro Shop — golf shoes", category: "PRO_SHOP", amount: 240, daysAgo: 18 },
    { description: "Locker Rental Q3", category: "OTHER", amount: 75, daysAgo: 3 },
  ];

  await prisma.charge.createMany({
    data: sample.map((c) => ({
      clubId: member.clubId,
      memberId: member.id,
      accountId: account.id,
      description: c.description,
      category: c.category,
      amount: c.amount,
      transactionDate: addDays(today, -c.daysAgo),
      status: "POSTED",
    })),
  });

  await prisma.payment.create({
    data: {
      clubId: member.clubId,
      memberId: member.id,
      accountId: account.id,
      amount: 410,
      paymentDate: addDays(today, -30),
      method: "CREDIT_CARD",
      status: "SUCCESS",
    },
  });
}

function defaultNotice(noticeType: string, memberName: string): string {
  switch (noticeType) {
    case "CARD_DECLINED": return `Dear ${memberName},\n\nWe attempted to process a recent payment on the credit card on file and the transaction was declined. To avoid any interruption to your account privileges, please log in to your member account at your earliest convenience and update your payment information.\n\nWith warm regards,\nMember Services`;
    case "PAP_FAILED": return `Dear ${memberName},\n\nA recent pre-authorized payment was returned by your bank. Kindly review the banking details we have on file and confirm at your convenience so we may keep your account current.\n\nWith warm regards,\nMember Services`;
    case "OVER_30": return `Dear ${memberName},\n\nA balance on your member account has aged past thirty days. We have included a copy of your statement for your reference. Please remit payment at your earliest convenience.\n\nWith warm regards,\nMember Services`;
    case "OVER_60": return `Dear ${memberName},\n\nWe note a portion of your member account has now aged past sixty days. We would be most grateful if you could attend to this at your earliest convenience so we may keep your account in good standing.\n\nWith warm regards,\nMember Services`;
    case "OVER_90": return `Dear ${memberName},\n\nA portion of your member account remains outstanding beyond ninety days. We would very much appreciate the courtesy of your attention to this matter, and a member of our finance team will be in touch should it remain unresolved.\n\nWith warm regards,\nMember Services`;
    case "FINAL_NOTICE": return `Dear ${memberName},\n\nThis is a final notice regarding the outstanding balance on your member account. We respectfully ask that you contact our finance office immediately to discuss resolution and avoid any further action affecting your privileges.\n\nWith warm regards,\nMember Services`;
    default: return `Dear ${memberName},\n\nA member services representative will be in touch shortly regarding your account.`;
  }
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// ---------------------------------------------------------------
// Phase 5 demo seed — operational core (inventory, events,
// lessons, payroll, capital assets, budgets).
// ---------------------------------------------------------------
async function seedPhase5(
  clubId: string,
  principal: Principal,
  vendors: { northsideVendorId: string; premiumFoodsVendorId: string }
) {
  // Account / department resolution helpers
  const accountByNumber = new Map<string, { id: string; accountNumber: string }>();
  const accounts = await prisma.account.findMany({ where: { clubId } });
  for (const a of accounts) accountByNumber.set(a.accountNumber, { id: a.id, accountNumber: a.accountNumber });
  const departmentByCode = new Map<string, { id: string; code: string }>();
  const departments = await prisma.department.findMany({ where: { clubId } });
  for (const d of departments) departmentByCode.set(d.code, { id: d.id, code: d.code });
  const proShopDept = departmentByCode.get("PROSHOP") ?? departmentByCode.get("PRO_SHOP") ?? null;
  const fbDept = departmentByCode.get("FB") ?? null;
  const courseDept = departmentByCode.get("COURSE") ?? null;
  const adminDept = departmentByCode.get("ADMIN") ?? null;

  // --- Inventory categories
  const proShopCat = await prisma.inventoryCategory.create({
    data: {
      clubId, key: "PRO_SHOP_APPAREL", name: "Pro Shop — Apparel",
      inventoryAccountId: accountByNumber.get("1210")?.id ?? null,
      cogsAccountId: accountByNumber.get("5100")?.id ?? null,
      revenueAccountId: accountByNumber.get("4300")?.id ?? null,
    },
  });
  const fbCat = await prisma.inventoryCategory.create({
    data: {
      clubId, key: "FB_PRODUCE", name: "F&B — Produce",
      inventoryAccountId: accountByNumber.get("1220")?.id ?? null,
      cogsAccountId: accountByNumber.get("5000")?.id ?? null,
      revenueAccountId: accountByNumber.get("4200")?.id ?? null,
    },
  });

  // --- Inventory locations
  const proShopLoc = await prisma.inventoryLocation.create({
    data: { clubId, code: "PROSHOP", name: "Pro Shop Floor", departmentId: proShopDept?.id ?? null },
  });
  const kitchenLoc = await prisma.inventoryLocation.create({
    data: { clubId, code: "KITCHEN", name: "Main Kitchen", departmentId: fbDept?.id ?? null },
  });

  // --- Inventory items
  await prisma.inventoryItem.createMany({
    data: [
      { clubId, sku: "PS-POLO-001", name: "Club logo polo (M)", categoryId: proShopCat.id, defaultLocationId: proShopLoc.id, defaultCost: 28, retailPrice: 75, reorderPoint: 10, reorderQty: 24, preferredVendorId: vendors.premiumFoodsVendorId },
      { clubId, sku: "PS-CAP-001", name: "Club logo cap", categoryId: proShopCat.id, defaultLocationId: proShopLoc.id, defaultCost: 12, retailPrice: 35, reorderPoint: 20, reorderQty: 50 },
      { clubId, sku: "PS-GLOVE-L", name: "Premium glove (L)", categoryId: proShopCat.id, defaultLocationId: proShopLoc.id, defaultCost: 14, retailPrice: 38, reorderPoint: 15, reorderQty: 30 },
      { clubId, sku: "FB-WINE-CAB-2022", name: "House Cabernet 2022", categoryId: fbCat.id, defaultLocationId: kitchenLoc.id, defaultCost: 18, retailPrice: 48, reorderPoint: 12, reorderQty: 24, preferredVendorId: vendors.premiumFoodsVendorId },
      { clubId, sku: "FB-LESSON-SVC", name: "Range balls (bucket)", kind: "SERVICE", categoryId: fbCat.id, retailPrice: 12 },
    ],
  });

  // --- Event category
  await prisma.eventCategory.create({
    data: { clubId, key: "WEDDING", name: "Wedding", defaultRevenueAccountId: accountByNumber.get("4500")?.id ?? null },
  });

  // --- Private event inquiry + booking
  const inquiry = await prisma.privateEventInquiry.create({
    data: {
      clubId,
      inquirerName: "Caroline & James Booth",
      inquirerEmail: "caroline.booth@example.com",
      inquirerPhone: "403-555-0312",
      preferredDate: addDays(new Date(), 75),
      headCount: 120,
      message: "Rehearsal dinner the night before — looking for the founders' lounge and patio.",
      status: "REVIEWED",
    },
  });
  await prisma.privateEventBooking.create({
    data: {
      clubId,
      bookingNumber: "PE-0001",
      inquiryId: inquiry.id,
      customerName: "Caroline Booth",
      customerEmail: "caroline.booth@example.com",
      eventName: "Booth–Tanaka Wedding Reception",
      eventStart: addDays(new Date(), 90),
      eventEnd: addDays(new Date(), 90),
      headCount: 120,
      status: "CONFIRMED",
      depositAmount: 5000,
      totalAmount: 22500,
      revenueAccountId: accountByNumber.get("4500")?.id ?? null,
      deferredRevenueAccountId: accountByNumber.get("2230")?.id ?? null,
    },
  });

  // --- Golf professionals + lesson types
  const headPro = await prisma.golfProfessional.create({
    data: { clubId, firstName: "Daniel", lastName: "Park", email: "dpark@silversprings.club", isHeadPro: true, hourlyRate: 85 },
  });
  const proB = await prisma.golfProfessional.create({
    data: { clubId, firstName: "Mei", lastName: "Tanaka", email: "mtanaka@silversprings.club", isHeadPro: false, hourlyRate: 55 },
  });

  await lessonService.createLessonType(principal, clubId, {
    key: "PRIVATE_60",
    name: "Private lesson — 60 min",
    durationMinutes: 60,
    memberPrice: 95,
    instructorPayPerLesson: 55,
    revenueAccountNumber: "4400",
    instructorExpenseAccountNumber: "6100",
  });
  await lessonService.createLessonType(principal, clubId, {
    key: "GROUP_CLINIC",
    name: "Group clinic (4 players)",
    durationMinutes: 90,
    memberPrice: 60,
    instructorPayPerLesson: 80,
    isGroup: true,
    revenueAccountNumber: "4400",
    instructorExpenseAccountNumber: "6100",
  });
  void headPro; void proB;

  // --- Employee positions + employees
  const posCourse = await prisma.employeePosition.create({ data: { clubId, code: "GREENSKEEPER", name: "Greenskeeper", defaultPayRate: 24 } });
  const posServer = await prisma.employeePosition.create({ data: { clubId, code: "SERVER", name: "Server", defaultPayRate: 18 } });
  const posAdmin = await prisma.employeePosition.create({ data: { clubId, code: "ADMIN_ASST", name: "Administrative Assistant", defaultPayRate: 28, isExempt: false } });

  await payrollService.createEmployee(principal, clubId, {
    firstName: "Marc", lastName: "Boudreau", email: "marc.b@silversprings.club",
    departmentCode: "COURSE", positionCode: posCourse.code,
    compensationType: "HOURLY", payRate: 24,
    hireDate: "2022-04-01",
  });
  await payrollService.createEmployee(principal, clubId, {
    firstName: "Priya", lastName: "Singh", email: "priya.s@silversprings.club",
    departmentCode: "FB", positionCode: posServer.code,
    compensationType: "HOURLY", payRate: 19,
    hireDate: "2023-08-12",
  });
  await payrollService.createEmployee(principal, clubId, {
    firstName: "Karen", lastName: "Wallace", email: "karen.w@silversprings.club",
    departmentCode: "ADMIN", positionCode: posAdmin.code,
    compensationType: "SALARY", payRate: 62000,
    hireDate: "2018-01-15",
  });

  // HR-1 (2026-08-16) — sensitive-slice fixtures. Employee B has a
  // complete HR record (SIN + banking + tax); Employee D is
  // mid-onboarding (invitation issued, no sensitive data captured
  // yet). Every ciphertext blob is written through the KMS scope="HR"
  // path so scope-key rotation reaches these rows too. The
  // sinLastThree / accountLastFour columns carry only the safe
  // suffix — matching what the masked-read helpers surface.
  const {
    upsertSin: seedUpsertSin,
  } = await import("../src/lib/hr/sensitive-identity");
  const {
    upsertBankAccount: seedUpsertBank,
    activateBankAccount: seedActivateBank,
  } = await import("../src/lib/hr/bank-account");
  const {
    upsertTaxProfile: seedUpsertTax,
  } = await import("../src/lib/hr/tax-profile");
  const {
    issueInvitation: seedIssueInvitation,
  } = await import("../src/lib/hr/invitations");

  const employeeB = await payrollService.createEmployee(principal, clubId, {
    firstName: "Bethany", lastName: "Nakamura", email: "bethany.n@silversprings.club",
    departmentCode: "FB", positionCode: posServer.code,
    compensationType: "HOURLY", payRate: 22,
    hireDate: "2024-05-20",
  });
  await seedUpsertSin(principal, employeeB.id, "123456789");
  await seedUpsertBank(principal, employeeB.id, {
    institutionNumber: "003",
    transitNumber: "12345",
    accountNumber: "9876543210",
    holderName: "Bethany Nakamura",
  });
  await seedActivateBank(principal, employeeB.id);
  await seedUpsertTax(principal, employeeB.id, {
    province: "ON",
    td1FormVersion: "2026-01",
    effectiveFrom: new Date("2026-01-01"),
    federalClaim: "15705.00",
    provincialClaim: "12399.00",
    additionalDeductions: "50.00",
  });

  const employeeD = await payrollService.createEmployee(principal, clubId, {
    firstName: "Devon", lastName: "Okafor", email: "devon.o@silversprings.club",
    departmentCode: "COURSE", positionCode: posCourse.code,
    compensationType: "HOURLY", payRate: 21,
    hireDate: "2026-08-01",
  });
  await seedIssueInvitation(principal, employeeD.id, { ttlHours: 24 * 7 });

  // HR-1 admin-workflows slice (2026-08-16) — Employee A + Employee C
  // fixtures. These exercise the canonical employee CRUD, EmployeeDocument
  // profile-photo + resume back-pointers, EmploymentPeriod effective
  // dating, and onboarding-session APPROVED state without touching
  // SIN / bank / tax (Employee A) or the Member link (Employee C — a
  // family relationship exists out-of-band with a Member row, but the
  // Employee row's memberId MUST stay NULL).
  const {
    createEmployee: seedCreateEmployee,
  } = await import("../src/lib/hr/employees");
  const {
    openEmploymentPeriod: seedOpenPeriod,
  } = await import("../src/lib/hr/employment-periods");
  const {
    uploadEmployeeDocument: seedUploadDoc,
  } = await import("../src/lib/hr/documents");
  const {
    createSession: seedCreateSession,
    transitionSession: seedTransitionSession,
  } = await import("../src/lib/hr/onboarding-sessions");

  // --- Employee A — Alexandra Reyes. Not a Member. Full onboarding
  //     completed (APPROVED); profile photo + resume as
  //     EmployeeDocument rows; open employment period from hire date.
  const employeeA = await seedCreateEmployee(principal, clubId, {
    firstName: "Alexandra", lastName: "Reyes",
    email: "alexandra.r@silversprings.club",
    departmentId: adminDept?.id ?? null,
    positionId: posAdmin.id,
    compensationType: "SALARY", payRate: 65000,
    hireDate: "2024-03-15",
    employmentType: "FULL_TIME",
    employeeLifecycle: "ACTIVE",
  });
  const alexandraPhoto = await seedUploadDoc(principal, employeeA.id, {
    category: "profile_photo",
    storageKey: "s3://spectre-hr/seed/alexandra-photo.jpg",
    contentSha256: "a".repeat(64),
    sizeBytes: 87_400,
    mimeType: "image/jpeg",
    displayName: "Alexandra Reyes — profile photo",
  });
  const alexandraResume = await seedUploadDoc(principal, employeeA.id, {
    category: "resume",
    storageKey: "s3://spectre-hr/seed/alexandra-resume.pdf",
    contentSha256: "b".repeat(64),
    sizeBytes: 152_300,
    mimeType: "application/pdf",
    displayName: "Alexandra Reyes — resume",
  });
  await prisma.employee.update({
    where: { id: employeeA.id },
    data: {
      profilePhotoDocumentId: alexandraPhoto.id,
      resumeDocumentId: alexandraResume.id,
    },
  });
  await seedOpenPeriod(principal, employeeA.id, {
    effectiveFrom: new Date("2024-03-15"),
    employmentType: "FULL_TIME",
    reason: "HIRE",
    departmentId: adminDept?.id ?? null,
    positionId: posAdmin.id,
  });
  // Onboarding — DRAFT -> INVITED -> IN_PROGRESS -> SUBMITTED -> APPROVED.
  const sessionA = await seedCreateSession(principal, employeeA.id);
  await seedTransitionSession(principal, sessionA.id, "INVITED");
  await seedTransitionSession(principal, sessionA.id, "IN_PROGRESS", {
    actorSource: "EMPLOYEE", actorEmployeeId: employeeA.id,
  });
  await seedTransitionSession(principal, sessionA.id, "SUBMITTED", {
    actorSource: "EMPLOYEE", actorEmployeeId: employeeA.id,
  });
  await seedTransitionSession(principal, sessionA.id, "APPROVED");

  // --- Employee C — Carmen Sato. Child-of-Member (family relationship
  //     is out-of-band with an existing Member; the Employee row's
  //     memberId MUST stay NULL — do NOT link. F&B server, open
  //     employment period, onboarding APPROVED.
  const employeeC = await seedCreateEmployee(principal, clubId, {
    firstName: "Carmen", lastName: "Sato",
    email: "carmen.s@silversprings.club",
    departmentId: fbDept?.id ?? null,
    positionId: posServer.id,
    compensationType: "HOURLY", payRate: 18,
    hireDate: "2025-06-01",
    employmentType: "PART_TIME",
    employeeLifecycle: "ACTIVE",
  });
  // Explicitly assert the invariant: Employee C is NOT linked to a
  // Member, even though a Sato family Member exists in the club.
  if (employeeC.memberId !== null) {
    throw new Error("Employee C fixture must have memberId=null (child-of-Member is out-of-band)");
  }
  await seedOpenPeriod(principal, employeeC.id, {
    effectiveFrom: new Date("2025-06-01"),
    employmentType: "PART_TIME",
    reason: "HIRE",
    departmentId: fbDept?.id ?? null,
    positionId: posServer.id,
  });
  const sessionC = await seedCreateSession(principal, employeeC.id);
  await seedTransitionSession(principal, sessionC.id, "INVITED");
  await seedTransitionSession(principal, sessionC.id, "IN_PROGRESS", {
    actorSource: "EMPLOYEE", actorEmployeeId: employeeC.id,
  });
  await seedTransitionSession(principal, sessionC.id, "SUBMITTED", {
    actorSource: "EMPLOYEE", actorEmployeeId: employeeC.id,
  });
  await seedTransitionSession(principal, sessionC.id, "APPROVED");

  // HR-1 financial-systems slice (2026-08-16) — canonical
  // EmployeeCompensation rows + PayrollProfile foundation.
  //
  // Every seeded Employee gets ONE current EmployeeCompensation row
  // via the compensation service so the shadow-write invariant on
  // `Employee.payRate` is exercised end-to-end (both columns hold
  // the fixture rate). Employees A, B, C also get ACTIVE
  // PayrollProfiles — this exercises the full activation-precondition
  // path (current compensation + SIN + VERIFIED bank). Employee A and
  // C had no SIN / bank on file from the admin-workflows fixtures;
  // we seed the trio here so activation succeeds. Employee D stays
  // DRAFT because it is intentionally mid-onboarding (no SIN / bank
  // captured yet).
  //
  // These calls go through the service — never a raw
  // `prisma.employeeCompensation.create` and never a raw
  // `prisma.payrollProfile.update({ activatedAt })`. Doing so would
  // bypass the exclusive-writer invariant on `Employee.payRate` and
  // the activation-precondition guard.
  const {
    changeCompensation: seedChangeCompensation,
  } = await import("../src/lib/hr/compensation");
  const {
    upsertPayrollProfile: seedUpsertPayrollProfile,
    activatePayrollProfile: seedActivatePayrollProfile,
  } = await import("../src/lib/hr/payroll-profile");

  // Employee B — already has SIN + VERIFIED bank + tax from the
  // security-compliance block above. Seed compensation matching the
  // fixture rate on Employee.payRate, then activate PayrollProfile.
  await seedChangeCompensation(principal, employeeB.id, {
    effectiveFrom: new Date("2024-05-20"),
    amount: 22,
    cadence: "HOURLY",
    currency: "CAD",
  });
  await seedUpsertPayrollProfile(principal, employeeB.id, {
    jurisdiction: "CA-ON",
    payGroup: "BIWEEKLY_HOURLY",
    payFrequency: "BIWEEKLY",
    directDepositActive: true,
  });
  await seedActivatePayrollProfile(principal, employeeB.id);

  // Employee D — invited but not yet onboarded. Seed compensation so
  // Employee.payRate stays in step with the canonical column, but
  // leave PayrollProfile DRAFT (no activation) — SIN / bank are
  // intentionally not on file.
  await seedChangeCompensation(principal, employeeD.id, {
    effectiveFrom: new Date("2026-08-01"),
    amount: 21,
    cadence: "HOURLY",
    currency: "CAD",
  });
  await seedUpsertPayrollProfile(principal, employeeD.id, {
    jurisdiction: "CA-ON",
    payGroup: "BIWEEKLY_HOURLY",
    payFrequency: "BIWEEKLY",
  });

  // Employee A — ACTIVE full-time salary. Seed the activation trio
  // (compensation + SIN + VERIFIED bank) then activate PayrollProfile.
  await seedChangeCompensation(principal, employeeA.id, {
    effectiveFrom: new Date("2024-03-15"),
    amount: 65000,
    cadence: "SALARY",
    currency: "CAD",
  });
  await seedUpsertSin(principal, employeeA.id, "234567891");
  await seedUpsertBank(principal, employeeA.id, {
    institutionNumber: "004",
    transitNumber: "23456",
    accountNumber: "1122334455",
    holderName: "Alexandra Reyes",
  });
  await seedActivateBank(principal, employeeA.id);
  await seedUpsertPayrollProfile(principal, employeeA.id, {
    jurisdiction: "CA-ON",
    payGroup: "MONTHLY_SALARY",
    payFrequency: "MONTHLY",
    directDepositActive: true,
  });
  await seedActivatePayrollProfile(principal, employeeA.id);

  // Employee C — ACTIVE part-time hourly. Same activation trio, then
  // activate. Employee C.memberId stays NULL (the admin-workflows
  // fixture asserts the child-of-Member invariant).
  await seedChangeCompensation(principal, employeeC.id, {
    effectiveFrom: new Date("2025-06-01"),
    amount: 18,
    cadence: "HOURLY",
    currency: "CAD",
  });
  await seedUpsertSin(principal, employeeC.id, "345678912");
  await seedUpsertBank(principal, employeeC.id, {
    institutionNumber: "010",
    transitNumber: "34567",
    accountNumber: "2233445566",
    holderName: "Carmen Sato",
  });
  await seedActivateBank(principal, employeeC.id);
  await seedUpsertPayrollProfile(principal, employeeC.id, {
    jurisdiction: "CA-ON",
    payGroup: "BIWEEKLY_HOURLY",
    payFrequency: "BIWEEKLY",
    directDepositActive: true,
  });
  await seedActivatePayrollProfile(principal, employeeC.id);

  // --- Asset categories, locations, demo asset
  const buildingsCat = await prisma.assetCategory.create({
    data: {
      clubId, key: "BUILDINGS", name: "Buildings & Structures",
      assetAccountId: accountByNumber.get("1520")?.id ?? null,
      accumulatedDepreciationAccountId: accountByNumber.get("1525")?.id ?? null,
      depreciationExpenseAccountId: accountByNumber.get("6900")?.id ?? null,
      defaultUsefulLifeMonths: 360, // 30 years
    },
  });
  const equipmentCat = await prisma.assetCategory.create({
    data: {
      clubId, key: "EQUIPMENT", name: "Course Equipment",
      assetAccountId: accountByNumber.get("1540")?.id ?? null,
      accumulatedDepreciationAccountId: accountByNumber.get("1545")?.id ?? null,
      depreciationExpenseAccountId: accountByNumber.get("6900")?.id ?? null,
      defaultUsefulLifeMonths: 60,
    },
  });
  const clubhouseLoc = await prisma.assetLocation.create({ data: { clubId, code: "CLUBHOUSE", name: "Clubhouse" } });
  const yardLoc = await prisma.assetLocation.create({ data: { clubId, code: "MAINT_YARD", name: "Maintenance Yard" } });

  await prisma.capitalAsset.create({
    data: {
      clubId, assetNumber: "FA-00001",
      name: "Toro Greens Mower 3250-D",
      categoryId: equipmentCat.id,
      locationId: yardLoc.id,
      departmentId: courseDept?.id ?? null,
      acquisitionDate: new Date("2024-04-01"),
      acquisitionCost: 48500,
      residualValue: 4000,
      usefulLifeMonths: 60,
      depreciationMethod: "STRAIGHT_LINE",
      netBookValue: 48500,
      status: "ACTIVE",
    },
  });
  await prisma.capitalAsset.create({
    data: {
      clubId, assetNumber: "FA-00002",
      name: "Founders' Lounge Renovation",
      categoryId: buildingsCat.id,
      locationId: clubhouseLoc.id,
      departmentId: adminDept?.id ?? null,
      acquisitionDate: new Date("2023-09-15"),
      acquisitionCost: 215000,
      residualValue: 0,
      usefulLifeMonths: 240,
      depreciationMethod: "STRAIGHT_LINE",
      netBookValue: 215000,
      status: "ACTIVE",
    },
  });

  // --- Sample budget for current fiscal year
  const thisYear = new Date().getFullYear();
  const fy = await prisma.fiscalYear.findFirst({
    where: { clubId, label: `FY${thisYear}` },
  });
  if (fy) {
    const budget = await budgetService.createBudget(principal, clubId, {
      fiscalYearId: fy.id,
      name: "Operating Budget",
      version: 1,
    });
    const months = (annual: number) => Array.from({ length: 12 }, () => Math.round((annual / 12) * 100) / 100);
    // Revenue lines
    if (accountByNumber.has("4000")) await budgetService.upsertBudgetLine(principal, budget.id, { accountNumber: "4000", monthlyAmounts: months(1_200_000) });
    if (accountByNumber.has("4100")) await budgetService.upsertBudgetLine(principal, budget.id, { accountNumber: "4100", departmentCode: "GOLF", monthlyAmounts: months(420_000) });
    if (accountByNumber.has("4200")) await budgetService.upsertBudgetLine(principal, budget.id, { accountNumber: "4200", departmentCode: fbDept?.code, monthlyAmounts: months(840_000) });
    if (accountByNumber.has("4300")) await budgetService.upsertBudgetLine(principal, budget.id, { accountNumber: "4300", departmentCode: proShopDept?.code, monthlyAmounts: months(320_000) });
    // Expense lines
    if (accountByNumber.has("5000")) await budgetService.upsertBudgetLine(principal, budget.id, { accountNumber: "5000", departmentCode: fbDept?.code, monthlyAmounts: months(380_000) });
    if (accountByNumber.has("6000")) await budgetService.upsertBudgetLine(principal, budget.id, { accountNumber: "6000", departmentCode: courseDept?.code, monthlyAmounts: months(620_000) });
    if (accountByNumber.has("6900")) await budgetService.upsertBudgetLine(principal, budget.id, { accountNumber: "6900", monthlyAmounts: months(180_000) });
    await budgetService.approveBudget(principal, budget.id);
    await budgetService.activateBudget(principal, budget.id);
  }

  console.log(`Phase 5 demo: 5 inventory items, 1 private event, 2 instructors, 7 employees (3 baseline + Employee B full HR + Employee D onboarding + Employee A onboarded + Employee C onboarded), 2 assets, ${fy ? "1 active budget" : "0 budgets"}.`);
}

// Founder rule 2026-07-01 v14.9 — tag every seeded JournalEntry as
// `source: "DEMO"` so the Finance report layer can filter them out
// once the club has committed a real Opening Trial Balance import.
// This is a bulk update at the end of seeding so we don't have to
// thread a `demoMode` flag through every AP/POS/inventory posting
// path. Any real import that runs AFTER seed (which uses
// `source: "IMPORT"` on the v14.3 TB commit path) is untouched.
async function tagSeededJournalEntriesAsDemo() {
  const result = await prisma.journalEntry.updateMany({
    where: { source: { not: "IMPORT" } },
    data: { source: "DEMO" },
  });
  console.log(`Tagged ${result.count} seeded JournalEntry row(s) as source="DEMO".`);
}

main()
  .then(tagSeededJournalEntriesAsDemo)
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
