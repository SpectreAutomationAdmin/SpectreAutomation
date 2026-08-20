// Per-test isolation helpers. Tests share one SQLite database (cheaper than
// rebuilding the schema every time); each test starts by wiping the tables it
// touches. This is fast in SQLite and keeps tests order-independent.

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, type RoleKey, type PermissionKey } from "@/lib/permissions";

// Tests share the same Prisma client as services so reads see writes
// regardless of which side performed them.
export function db() {
  return prisma;
}

export async function resetDb() {
  const c = db();
  // Reset the in-memory rate-limit buckets so tests start with a clean
  // token-bucket state. Tests that depend on rate-limit behavior set their
  // own limiter explicitly.
  try {
    const m = await import("@/lib/security/rate-limit");
    m._resetInMemoryBuckets();
  } catch { /* ignore — limiter module not loaded yet */ }
  // FK-safe deletion order, wrapped in a single $transaction so all
  // ~200 deleteMany calls submit as one batch instead of 200 serial
  // round-trips. On Windows SQLite/WAL this drops the per-call cost
  // from ~2.4s to a few hundred ms. The phase comments preserve the
  // FK ordering rationale; the order still matters because FK
  // constraints enforce per-statement inside the transaction.
  await c.$transaction([
    // Phase 15 — wipe first.
    c.clubDomain.deleteMany(),
    // Phase 18B — hospitality survey: responses → invitations → rules.
    c.hospitalitySurveyResponse.deleteMany(),
    c.hospitalitySurveyInvitation.deleteMany(),
    c.departmentNotificationRule.deleteMany(),
    // Phase 18C — dining reservations: check-link → reservation → table → area → settings.
    c.diningReservationCheckLink.deleteMany(),
    c.diningReservation.deleteMany(),
    // Step 32 — floor-plan tables reference DiningTable; wipe before DiningTable.
    c.diningFloorPlanTable.deleteMany(),
    c.diningFloorPlan.deleteMany(),
    c.diningTable.deleteMany(),
    c.diningArea.deleteMany(),
    c.reservationSettings.deleteMany(),
    // Phase 14 — wipe next.
    c.retrospectiveAction.deleteMany(),
    c.retrospectiveItem.deleteMany(),
    c.pilotRetrospective.deleteMany(),
    c.pilotMetricSnapshot.deleteMany(),
    c.emailDeliveryEvent.deleteMany(),
    c.emailSuppression.deleteMany(),
    c.importTemplate.deleteMany(),
    // Phase 13 — wipe next.
    c.supportActionLog.deleteMany(),
    c.supportSession.deleteMany(),
    c.supportAccessGrant.deleteMany(),
    c.incidentTimelineEvent.deleteMany(),
    c.incident.deleteMany(),
    c.supportTicket.deleteMany(),
    c.knownIssue.deleteMany(),
    c.trainingScenario.deleteMany(),
    c.clubTrainingMode.deleteMany(),
    c.memberPortalInvite.deleteMany(),
    c.openingBalanceSet.deleteMany(),
    c.importError.deleteMany(),
    c.importRow.deleteMany(),
    c.importBatch.deleteMany(),
    c.pilotGoLiveSignoff.deleteMany(),
    c.pilotOnboardingNote.deleteMany(),
    c.pilotOnboardingBlocker.deleteMany(),
    c.pilotOnboardingTask.deleteMany(),
    c.pilotOnboardingStep.deleteMany(),
    c.pilotOnboardingProject.deleteMany(),
    // Phase 12 — wipe next.
    c.appWebhookSubscription.deleteMany(),
    c.oAuthGrant.deleteMany(),
    c.appPermission.deleteMany(),
    c.installedApp.deleteMany(),
    c.marketplaceApp.deleteMany(),
    c.accessReviewItem.deleteMany(),
    c.accessReview.deleteMany(),
    c.complianceEvidence.deleteMany(),
    c.policyAcknowledgement.deleteMany(),
    c.circuitBreakerState.deleteMany(),
    c.tournamentScoreConflict.deleteMany(),
    c.secretAccessLog.deleteMany(),
    c.keyRotationEvent.deleteMany(),
    c.encryptedSecretMetadata.deleteMany(),
    // Phase 11 — wipe next.
    c.ssoLoginAttempt.deleteMany(),
    c.ssoProvider.deleteMany(),
    c.trustedDevice.deleteMany(),
    c.recoveryCode.deleteMany(),
    c.mfaFactor.deleteMany(),
    c.billingPaymentAttempt.deleteMany(),
    c.billingInvoice.deleteMany(),
    c.billingSubscription.deleteMany(),
    c.billingWebhookEvent.deleteMany(),
    c.billingCustomer.deleteMany(),
    c.tournamentScoreCorrection.deleteMany(),
    c.tournamentScoreDraft.deleteMany(),
    c.pOSMappingHistory.deleteMany(),
    c.webhookSecretRotation.deleteMany(),
    c.webhookSecretVersion.deleteMany(),
    // Phase 10 — wipe next.
    c.billingCycle.deleteMany(),
    c.usageMetric.deleteMany(),
    c.clubSubscription.deleteMany(),
    c.subscriptionPlan.deleteMany(),
    c.tournamentPairing.deleteMany(),
    c.pushDeliveryAttempt.deleteMany(),
    c.pushCampaign.deleteMany(),
    // Phase 9 — wipe next.
    c.pilotReadinessItem.deleteMany(),
    c.webhookDelivery.deleteMany(),
    c.webhookSubscription.deleteMany(),
    c.apiRequestLog.deleteMany(),
    c.apiKeyPermission.deleteMany(),
    c.apiKey.deleteMany(),
    c.tournamentCommunication.deleteMany(),
    c.tournamentPayoutPrize.deleteMany(),
    c.tournamentLeaderboard.deleteMany(),
    c.tournamentScore.deleteMany(),
    c.tournamentMatch.deleteMany(),
    c.tournamentRound.deleteMany(),
    c.tournamentRegistration.deleteMany(),
    c.tournamentTeam.deleteMany(),
    c.tournamentDivision.deleteMany(),
    c.tournament.deleteMany(),
    c.webPushSubscription.deleteMany(),
    c.suspiciousActivityEvent.deleteMany(),
    c.accountLock.deleteMany(),
    c.authAttempt.deleteMany(),
    c.metricCounter.deleteMany(),
    c.observabilityEvent.deleteMany(),
    // Phase 8 — wipe next (jobs / POS webhooks / tee-sheet / hardware / flags).
    c.rateLimitBucket.deleteMany(),
    c.featureFlag.deleteMany(),
    c.deviceAssignment.deleteMany(),
    c.deviceStatus.deleteMany(),
    c.deviceEvent.deleteMany(),
    c.hardwareDevice.deleteMany(),
    c.cartAssignment.deleteMany(),
    c.paceOfPlayRecord.deleteMany(),
    c.teeLotteryEntry.deleteMany(),
    c.teeLottery.deleteMany(),
    c.teeTimeGuest.deleteMany(),
    c.teeTimePlayer.deleteMany(),
    c.teeTimeBooking.deleteMany(),
    c.teeTime.deleteMany(),
    c.teeSheet.deleteMany(),
    c.courseHole.deleteMany(),
    c.course.deleteMany(),
    c.webhookReplay.deleteMany(),
    c.pOSMapping.deleteMany(),
    c.pOSImportError.deleteMany(),
    c.pOSSyncRun.deleteMany(),
    c.pOSWebhookEvent.deleteMany(),
    c.queueHealth.deleteMany(),
    c.jobFailure.deleteMany(),
    c.jobRun.deleteMany(),
    c.backgroundJob.deleteMany(),
    // Phase 7 — integrations + POS + LLM tables next (they FK earlier modules).
    c.lLMCommentaryDraft.deleteMany(),
    // Open-check workflow tables (children → parents).
    c.pOSChitLine.deleteMany(),
    c.pOSChit.deleteMany(),
    c.pOSCheckEvent.deleteMany(),
    c.pOSCheckLineModifier.deleteMany(),
    // Phase 18E — seat-group settlements (children of POSCheck).
    c.pOSSettlementGroup.deleteMany(),
    // Phase 18F — per-seat member/guest assignments (children of POSCheck).
    c.pOSCheckSeat.deleteMany(),
    // Step 19 — QR-code payment lifecycle (children of POSCheck).
    c.pOSQRPayment.deleteMany(),
    c.pOSCheckLine.deleteMany(),
    c.pOSCheck.deleteMany(),
    c.pOSPayment.deleteMany(),
    c.pOSDiscount.deleteMany(),
    c.pOSTaxLine.deleteMany(),
    c.pOSSaleLineModifier.deleteMany(),
    c.pOSSaleLine.deleteMany(),
    c.pOSSale.deleteMany(),
    c.pOSSaleChit.deleteMany(),
    c.pOSSession.deleteMany(),
    c.pOSTerminal.deleteMany(),
    // Printer registry — independent of menu / sale data.
    c.pOSPrinter.deleteMany(),
    // Modifier catalog comes off menu items, so wipe it before items.
    c.pOSModifierOption.deleteMany(),
    c.pOSModifierGroup.deleteMany(),
    // Menu items first (FK → POSMenuCategory), then categories (FK → POSLocation),
    // then locations themselves.
    c.pOSMenuItem.deleteMany(),
    c.pOSMenuCategory.deleteMany(),
    c.pOSLocation.deleteMany(),
    c.pOSIntegrationProvider.deleteMany(),
    c.documentBackfillBatch.deleteMany(),
    c.integrationCheck.deleteMany(),
    c.integrationSetting.deleteMany(),
    // Order matters because of FK constraints. Phase 6 governance/comms/docs first
    // (they reference accounting / member / vendor tables).
    c.searchIndexEntry.deleteMany(),
    c.insightAlert.deleteMany(),
    c.insight.deleteMany(),
    c.insightRule.deleteMany(),
    c.clubSetting.deleteMany(),
    c.workflowHistory.deleteMany(),
    c.workflowComment.deleteMany(),
    c.workflowApproval.deleteMany(),
    c.workflowAssignment.deleteMany(),
    c.workflowStep.deleteMany(),
    c.workflow.deleteMany(),
    c.kPIAlert.deleteMany(),
    c.kPIThreshold.deleteMany(),
    c.kPIWidget.deleteMany(),
    c.kPIDashboard.deleteMany(),
    c.kPIValue.deleteMany(),
    c.kPI.deleteMany(),
    c.documentAuditLog.deleteMany(),
    c.documentAccess.deleteMany(),
    c.documentVersion.deleteMany(),
    c.documentTagJoin.deleteMany(),
    c.documentTag.deleteMany(),
    c.document.deleteMany(),
    c.documentRetentionPolicy.deleteMany(),
    c.documentFolder.deleteMany(),
    c.communicationCampaign.deleteMany(),
    c.communicationLog.deleteMany(),
    c.notificationDelivery.deleteMany(),
    c.notification.deleteMany(),
    c.notificationPreference.deleteMany(),
    c.notificationTemplate.deleteMany(),
    c.auditExport.deleteMany(),
    c.auditRequestItem.deleteMany(),
    c.auditRequest.deleteMany(),
    c.auditorSession.deleteMany(),
    c.auditorAccessGrant.deleteMany(),
    c.packageApproval.deleteMany(),
    c.packageDistribution.deleteMany(),
    c.reportingPackageCommentary.deleteMany(),
    c.reportingPackageSection.deleteMany(),
    c.reportingPackage.deleteMany(),
    // Monthly Reporting Package archive — recipients cascade from
    // package, but order matters because both FK back to Club / User.
    c.monthlyPackageRecipient.deleteMany(),
    c.monthlyPackage.deleteMany(),
    // Governance — Board & Committees roster. FKs to Club + Member;
    // cascades from Member. Delete before Member.
    c.boardRole.deleteMany(),
    c.reportExport.deleteMany(),
    c.reportRun.deleteMany(),
    c.savedReport.deleteMany(),
    c.reportDefinition.deleteMany(),
    // Phase 5 operational tables next (they FK into AP / accounting / member tables).
    c.forecastLine.deleteMany(),
    c.forecast.deleteMany(),
    c.budgetAssumption.deleteMany(),
    c.budgetLine.deleteMany(),
    c.budget.deleteMany(),
    c.assetDisposal.deleteMany(),
    c.assetMaintenanceRecord.deleteMany(),
    c.assetDepreciationEntry.deleteMany(),
    c.capitalAsset.deleteMany(),
    c.assetLocation.deleteMany(),
    c.assetCategory.deleteMany(),
    c.payrollRemittance.deleteMany(),
    c.payrollLine.deleteMany(),
    c.payrollRun.deleteMany(),
    c.timesheetEntry.deleteMany(),
    c.timesheet.deleteMany(),
    c.timeClockEvent.deleteMany(),
    c.payrollPeriod.deleteMany(),
    c.labourBudget.deleteMany(),
    // HR-1 (2026-08-16) — child tables of Employee (+ session
    // grandchildren). FK-correct deletion order — everything below
    // must delete BEFORE `employee`.
    c.employeeOnboardingResponse.deleteMany(),
    c.employeeOnboardingStateTransition.deleteMany(),
    c.employeeOnboardingSession.deleteMany(),
    c.employeeOnboardingInvitation.deleteMany(),
    c.employeeOnboardingQuestion.deleteMany(),
    c.employeeEmergencyContact.deleteMany(),
    c.employeeCredential.deleteMany(),
    // EmployeeDocument BEFORE Employee — Employee references it via
    // profilePhotoDocumentId / resumeDocumentId.
    c.employeeDocument.deleteMany(),
    c.employeeTaxProfile.deleteMany(),
    c.employeeBankAccount.deleteMany(),
    c.employeeSensitiveIdentity.deleteMany(),
    c.payrollDeduction.deleteMany(),
    c.payrollBenefit.deleteMany(),
    c.payrollProfile.deleteMany(),
    c.employeeCompensation.deleteMany(),
    c.employmentPeriod.deleteMany(),
    c.employee.deleteMany(),
    c.employeePosition.deleteMany(),
    c.lessonPayable.deleteMany(),
    c.lessonBooking.deleteMany(),
    c.lessonType.deleteMany(),
    c.golfProfessional.deleteMany(),
    c.privateEventAddOn.deleteMany(),
    c.privateEventBarSelection.deleteMany(),
    c.privateEventMenuSelection.deleteMany(),
    c.privateEventDeposit.deleteMany(),
    c.privateEventBooking.deleteMany(),
    c.privateEventInquiry.deleteMany(),
    c.eventCategory.deleteMany(),
    c.inventoryTransferLine.deleteMany(),
    c.inventoryTransfer.deleteMany(),
    c.inventoryReceivingLine.deleteMany(),
    c.inventoryReceiving.deleteMany(),
    c.inventoryCountLine.deleteMany(),
    c.inventoryCount.deleteMany(),
    c.inventoryAdjustment.deleteMany(),
    c.inventoryTransaction.deleteMany(),
    c.inventoryItem.deleteMany(),
    c.inventoryLocation.deleteMany(),
    c.inventoryCategory.deleteMany(),
    // Phase 4 AP tables next.
    c.aPException.deleteMany(),
    c.paymentBatchItem.deleteMany(),
    c.vendorPayment.deleteMany(),
    c.paymentBatch.deleteMany(),
    c.aPInvoiceAttachment.deleteMany(),
    c.aPInvoiceLine.deleteMany(),
    c.aPInvoice.deleteMany(),
    c.receiptCapture.deleteMany(),
    c.approvalDecision.deleteMany(),
    c.approvalRequest.deleteMany(),
    c.approvalPolicy.deleteMany(),
    c.pennyTest.deleteMany(),
    c.vendorBankingProfile.deleteMany(),
    c.vendorDocument.deleteMany(),
    c.vendorContact.deleteMany(),
    c.vendorRiskFlag.deleteMany(),
    c.vendor.deleteMany(),
    c.taxCode.deleteMany(),
    // Phase 3 accounting tables.
    c.journalEntryLine.deleteMany(),
    c.journalAttachment.deleteMany(),
    c.journalEntry.deleteMany(),
    c.journalBatch.deleteMany(),
    c.recurringJournal.deleteMany(),
    c.account.deleteMany(),
    c.accountCategory.deleteMany(),
    c.financialStatementGroup.deleteMany(),
    c.fiscalPeriod.deleteMany(),
    c.fiscalYear.deleteMany(),
    c.costCenter.deleteMany(),
    c.department.deleteMany(),
    c.auditLog.deleteMany(),
    c.eventRegistration.deleteMany(),
    c.clubEvent.deleteMany(),
    c.dashboardWidget.deleteMany(),
    c.memberPreference.deleteMany(),
    c.clubMilestone.deleteMany(),
    c.collectionAction.deleteMany(),
    c.collectionNotice.deleteMany(),
    c.collectionStage.deleteMany(),
    c.collectionNoticeTemplate.deleteMany(),
    c.financingPayment.deleteMany(),
    c.financingDocument.deleteMany(),
    c.financingPaymentSchedule.deleteMany(),
    c.financingAgreement.deleteMany(),
    c.statement.deleteMany(),
    c.dispute.deleteMany(),
    c.paymentPromise.deleteMany(),
    c.accountNote.deleteMany(),
    c.accountAdjustment.deleteMany(),
    c.paymentMethod.deleteMany(),
    c.payment.deleteMany(),
    c.charge.deleteMany(),
    c.memberAccount.deleteMany(),
    c.memberDocument.deleteMany(),
    c.memberHouseholdMember.deleteMany(),
    c.onboardingChecklistItem.deleteMany(),
    c.incentiveCredit.deleteMany(),
    c.applicationDocument.deleteMany(),
    c.applicationHouseholdMember.deleteMany(),
    c.applicationDraftToken.deleteMany(),
    c.clubWidgetConfig.deleteMany(),
    c.clubAnnouncement.deleteMany(),
    c.userClubRole.deleteMany(),
    c.rolePermission.deleteMany(),
    c.permission.deleteMany(),
    c.role.deleteMany(),
    // Stabilization (2026-08-19) — Phase 4R rev-10+ mailbox tables
    // FK into User (MailboxAccess.userId, MailboxOAuthTransaction.userId,
    // and email/sync-run subordinates). They must be torn down before
    // `c.user.deleteMany()` runs, otherwise a batch execution of the
    // HR suite fails with a FK violation when a prior file leaves
    // mailbox rows behind. Individual HR files were already doing this
    // in their own beforeEach; centralising it here makes every HR
    // test-file's `resetDb()` call self-sufficient.
    c.workIntakeActivity.deleteMany(),
    c.workIntakeItemRead.deleteMany(),
    c.workIntakeFinding.deleteMany(),
    c.workIntakeOrigin.deleteMany(),
    c.emailWorkIntakeOrigin.deleteMany(),
    c.workIntakeItem.deleteMany(),
    c.apIntakeSource.deleteMany(),
    c.emailAttachment.deleteMany(),
    c.emailMessage.deleteMany(),
    c.mailboxSyncRun.deleteMany(),
    c.graphSubscription.deleteMany(),
    c.mailboxAccess.deleteMany(),
    c.mailboxOAuthTransaction.deleteMany(),
    c.mailboxConnection.deleteMany(),
    // HR-2B.4 (2026-08-19) — OnboardingRequirement FKs into Club;
    // must be wiped before club.deleteMany().
    c.onboardingRequirement.deleteMany(),
    // HR-2C (2026-08-20) — ClubMedia FKs into Club.
    c.clubMedia.deleteMany(),
    // HR-2C (2026-08-20) — Training tables. Order matters: leaf rows
    // (completion / attempt-response / progress) before their parents
    // (attempt / question), then course-version, then course. Every
    // table FKs into Club (RESTRICT) so all must clear before
    // c.club.deleteMany().
    c.trainingCompletion.deleteMany(),
    c.trainingQuestionResponse.deleteMany(),
    c.trainingAttempt.deleteMany(),
    c.trainingProgress.deleteMany(),
    c.trainingAssignment.deleteMany(),
    c.trainingAnswerOption.deleteMany(),
    c.trainingQuestion.deleteMany(),
    c.trainingCourseVersion.deleteMany(),
    c.trainingCourse.deleteMany(),
    c.user.deleteMany(),
    c.member.deleteMany(),
    c.applicant.deleteMany(),
    c.club.deleteMany(),
  ]);
}

export async function seedRbac() {
  const c = db();
  for (const [key, def] of Object.entries(PERMISSIONS)) {
    await c.permission.upsert({ where: { key }, update: {}, create: { key, name: def.name, category: def.category } });
  }
  for (const [key, def] of Object.entries(ROLES)) {
    await c.role.upsert({ where: { key }, update: {}, create: { key, name: def.name, description: def.description, isSystem: true } });
  }
  for (const [roleKey, grants] of Object.entries(ROLE_PERMISSIONS) as Array<[RoleKey, PermissionKey[]]>) {
    for (const permissionKey of grants) {
      await c.rolePermission.upsert({
        where: { roleKey_permissionKey: { roleKey, permissionKey } },
        update: {},
        create: { roleKey, permissionKey },
      });
    }
  }
}

export async function makeClub(name: string) {
  const c = db();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return c.club.create({
    data: { name, slug, region: "Test", salesTaxRegion: "GST", foundedYear: 2000 },
  });
}

export async function makeUser(opts: {
  email: string;
  name?: string;
  role: RoleKey;
  clubId: string | null;
  memberId?: string | null;
}) {
  const c = db();
  const passwordHash = await bcrypt.hash("password", 4);
  const user = await c.user.create({
    data: {
      email: opts.email,
      name: opts.name ?? opts.email,
      role: opts.role,
      passwordHash,
      clubId: opts.clubId,
      memberId: opts.memberId ?? null,
      status: "ACTIVE",
    },
  });
  await c.userClubRole.create({ data: { userId: user.id, clubId: opts.clubId, roleKey: opts.role } });
  return user;
}

export async function makeMember(clubId: string, opts?: { firstName?: string; lastName?: string }) {
  const c = db();
  const member = await c.member.create({
    data: {
      clubId,
      memberNumber: "TEST-" + Math.floor(Math.random() * 1_000_000),
      firstName: opts?.firstName ?? "Test",
      lastName: opts?.lastName ?? "Member",
      email: `t${Date.now()}_${Math.floor(Math.random() * 10000)}@example.com`,
      status: "ACTIVE",
      paymentMethodStatus: "NONE",
    },
  });
  await c.memberAccount.create({ data: { clubId, memberId: member.id } });
  return member;
}

// Build a Principal matching what loadPrincipal() returns, without going through
// the iron-session/cookies machinery (which would need a request context).
export async function principalFor(userEmail: string) {
  const c = db();
  const u = await c.user.findUnique({ where: { email: userEmail }, include: { clubRoles: true } });
  if (!u) throw new Error("User missing: " + userEmail);
  const memberships = u.clubRoles.map((r) => ({ clubId: r.clubId, roleKey: r.roleKey as RoleKey }));
  const firstScoped = memberships.find((m) => m.clubId)?.clubId ?? null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    status: u.status,
    memberships,
    activeClubId: firstScoped,
    memberId: u.memberId,
  };
}
