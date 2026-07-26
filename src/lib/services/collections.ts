// Collections service.
//
// Productionized:
//   - Editable templates per club.
//   - Stage ladder (STAGE_30 / STAGE_60 / STAGE_90 / STAGE_120 / STAGE_FINAL).
//   - Notice generation that renders a template with variables.
//   - Suspension toggles (charge-account, tee-sheet, full) are CollectionActions
//     and are mirrored onto Member.accessStatus.
//   - Restore flow.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "./tenant";
import { ConflictError, ValidationError } from "../errors";
import { formatCurrency } from "../finance";

// ---------- default templates (used to seed and to reset) ------------------
export const DEFAULT_NOTICE_TEMPLATES: ReadonlyArray<{
  key: string;
  name: string;
  subject: string;
  body: string;
}> = [
  {
    key: "FRIENDLY_REMINDER",
    name: "Friendly reminder",
    subject: "A gentle reminder regarding your member account",
    body: "Dear {{firstName}},\n\nWe hope this note finds you well. A balance of {{currentBalance}} remains on your account. We would be most grateful if you could attend to it at your convenience.\n\nWith warm regards,\nMember Services",
  },
  {
    key: "OVER_30",
    name: "Over 30 days",
    subject: "Your member account · 30-day reminder",
    body: "Dear {{firstName}},\n\nA balance on your member account has aged past thirty days. The current balance is {{currentBalance}}. Please remit payment at your earliest convenience.\n\nWith warm regards,\nMember Services",
  },
  {
    key: "OVER_60",
    name: "Over 60 days",
    subject: "Your member account · 60-day notice",
    body: "Dear {{firstName}},\n\nWe note a portion of your member account has now aged past sixty days. We would be most grateful if you could attend to this so we may keep your account in good standing.\n\nWith warm regards,\nMember Services",
  },
  {
    key: "OVER_90",
    name: "Over 90 days",
    subject: "Your member account · 90-day notice",
    body: "Dear {{firstName}},\n\nA portion of your member account remains outstanding beyond ninety days. We very much appreciate your attention to this matter, and our finance team is available to discuss payment arrangements.\n\nWith warm regards,\nMember Services",
  },
  {
    key: "OVER_120",
    name: "Over 120 days",
    subject: "Your member account · 120-day notice",
    body: "Dear {{firstName}},\n\nWe note that a portion of your member account remains outstanding beyond one hundred and twenty days. We respectfully ask that you make contact with our finance office without further delay.\n\nWith warm regards,\nMember Services",
  },
  {
    key: "SUSPENSION_WARNING",
    name: "Suspension warning",
    subject: "Your member account · privileges may be affected",
    body: "Dear {{firstName}},\n\nThis note is to advise that, if your outstanding balance of {{currentBalance}} is not resolved within seven days, certain privileges on your account will be temporarily suspended in accordance with club policy. We would very much prefer to avoid this and remain available to discuss arrangements.\n\nWith warm regards,\nMember Services",
  },
  {
    key: "FINAL_NOTICE",
    name: "Final notice",
    subject: "Your member account · final notice",
    body: "Dear {{firstName}},\n\nThis is a final notice regarding the outstanding balance on your member account. We respectfully ask that you contact our finance office immediately to discuss resolution and avoid any further action affecting your privileges.\n\nWith warm regards,\nMember Services",
  },
  {
    key: "CARD_DECLINED",
    name: "Card declined",
    subject: "We were unable to process a recent payment",
    body: "Dear {{firstName}},\n\nWe attempted to process a recent payment on the credit card on file and the transaction was declined. To avoid any interruption to your account privileges, please update your payment information at your earliest convenience.\n\nWith warm regards,\nMember Services",
  },
  {
    key: "PAP_FAILED",
    name: "PAP / EFT returned",
    subject: "A pre-authorized payment was returned",
    body: "Dear {{firstName}},\n\nA recent pre-authorized payment was returned by your bank. Kindly review the banking details we have on file and confirm at your convenience so we may keep your account current.\n\nWith warm regards,\nMember Services",
  },
];

export const DEFAULT_STAGES: ReadonlyArray<{
  key: string;
  name: string;
  description: string;
  triggerAgeDays: number;
  defaultTemplateKey: string;
  autoSuspendChargeAccount: boolean;
  autoSuspendTeeSheet: boolean;
  sortOrder: number;
}> = [
  { key: "STAGE_30",    name: "30-day stage",    description: "Friendly reminder once the oldest unpaid balance crosses 30 days.", triggerAgeDays: 30,  defaultTemplateKey: "OVER_30",   autoSuspendChargeAccount: false, autoSuspendTeeSheet: false, sortOrder: 1 },
  { key: "STAGE_60",    name: "60-day stage",    description: "Formal reminder.",                                                 triggerAgeDays: 60,  defaultTemplateKey: "OVER_60",   autoSuspendChargeAccount: false, autoSuspendTeeSheet: false, sortOrder: 2 },
  { key: "STAGE_90",    name: "90-day stage",    description: "Member is referred to finance; suspension warning sent.",          triggerAgeDays: 90,  defaultTemplateKey: "OVER_90",   autoSuspendChargeAccount: false, autoSuspendTeeSheet: false, sortOrder: 3 },
  { key: "STAGE_120",   name: "120-day stage",   description: "Charge-account privileges paused automatically.",                  triggerAgeDays: 120, defaultTemplateKey: "OVER_120",  autoSuspendChargeAccount: true,  autoSuspendTeeSheet: false, sortOrder: 4 },
  { key: "STAGE_FINAL", name: "Final stage",     description: "Final notice; full suspension pending board review.",              triggerAgeDays: 150, defaultTemplateKey: "FINAL_NOTICE", autoSuspendChargeAccount: true, autoSuspendTeeSheet: true,  sortOrder: 5 },
];

// ---------- template seeding ----------------------------------------------
export async function ensureClubCollectionsSeed(clubId: string): Promise<void> {
  const existing = await prisma.collectionNoticeTemplate.count({ where: { clubId } });
  if (!existing) {
    await prisma.collectionNoticeTemplate.createMany({
      data: DEFAULT_NOTICE_TEMPLATES.map((t) => ({ clubId, ...t, isSystem: true })),
    });
  }
  const existingStages = await prisma.collectionStage.count({ where: { clubId } });
  if (!existingStages) {
    await prisma.collectionStage.createMany({
      data: DEFAULT_STAGES.map((s) => ({ clubId, ...s, isActive: true })),
    });
  }
}

// ---------- template rendering -------------------------------------------
export function renderTemplate(
  body: string,
  vars: Record<string, string | number | null | undefined>
): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    if (v == null) return "";
    return String(v);
  });
}

// ---------- template CRUD --------------------------------------------------
export const templatePatchSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10_000),
  name: z.string().trim().min(1).max(120).optional(),
});

export async function updateTemplate(principal: Principal, templateId: string, raw: unknown) {
  const tpl = await prisma.collectionNoticeTemplate.findUnique({ where: { id: templateId } });
  assertTenantOwned(tpl, principal);
  requirePermission(principal, tpl.clubId, "collections:templates:write");
  const parsed = templatePatchSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const updated = await prisma.collectionNoticeTemplate.update({
    where: { id: templateId },
    data: { ...parsed.data, updatedById: principal.id },
  });
  await audit(principal, {
    action: "collections.template.update",
    entityType: "CollectionNoticeTemplate",
    entityId: templateId,
    clubId: tpl.clubId,
    before: tpl,
    after: updated,
  });
  return updated;
}

// ---------- notice generation ---------------------------------------------
export async function generateNoticeFromTemplate(
  principal: Principal,
  memberId: string,
  templateKey: string,
  stageKey?: string
) {
  const member = await prisma.member.findUnique({ where: { id: memberId }, include: { account: true } });
  assertTenantOwned(member, principal);
  requirePermission(principal, member.clubId, "collections:work");
  const tpl = await prisma.collectionNoticeTemplate.findUnique({
    where: { clubId_key: { clubId: member.clubId, key: templateKey } },
  });
  if (!tpl) throw new ConflictError(`No template ${templateKey} for this club`);

  const rendered = renderTemplate(tpl.body, {
    firstName: member.firstName,
    lastName: member.lastName,
    currentBalance: formatCurrency(member.account?.currentBalance ?? 0),
    clubName: "",
  });
  const notice = await prisma.collectionNotice.create({
    data: {
      clubId: member.clubId,
      memberId,
      noticeType: templateKey,
      message: rendered,
      status: "DRAFT",
      templateId: tpl.id,
      stageKey: stageKey ?? null,
    },
  });
  await audit(principal, {
    action: "collections.notice.generate",
    entityType: "CollectionNotice",
    entityId: notice.id,
    clubId: member.clubId,
    meta: { templateKey, stageKey },
  });
  return notice;
}

export async function markNoticeSent(principal: Principal, noticeId: string) {
  const n = await prisma.collectionNotice.findUnique({ where: { id: noticeId } });
  assertTenantOwned(n, principal);
  requirePermission(principal, n.clubId, "collections:work");
  if (n.status !== "DRAFT") throw new ConflictError("Notice is not in DRAFT");
  const updated = await prisma.collectionNotice.update({
    where: { id: noticeId },
    data: { status: "SENT", sentAt: new Date() },
  });
  await prisma.collectionAction.create({
    data: { clubId: n.clubId, memberId: n.memberId, action: "NOTICE_SENT", meta: JSON.stringify({ noticeId, type: n.noticeType }) },
  });
  await audit(principal, {
    action: "collections.notice.sent",
    entityType: "CollectionNotice",
    entityId: noticeId,
    clubId: n.clubId,
    before: n,
    after: updated,
  });
  return updated;
}

export async function markNoticeResolved(principal: Principal, noticeId: string) {
  const n = await prisma.collectionNotice.findUnique({ where: { id: noticeId } });
  assertTenantOwned(n, principal);
  requirePermission(principal, n.clubId, "collections:work");
  const updated = await prisma.collectionNotice.update({
    where: { id: noticeId },
    data: { status: "RESOLVED" },
  });
  await audit(principal, {
    action: "collections.notice.resolved",
    entityType: "CollectionNotice",
    entityId: noticeId,
    clubId: n.clubId,
    before: n,
    after: updated,
  });
  return updated;
}

// ---------- access restriction ---------------------------------------------
export async function applyAccessAction(
  principal: Principal,
  memberId: string,
  action: "SUSPEND_CHARGE" | "SUSPEND_TEE" | "FULL_SUSPEND" | "RESTORE"
) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  assertTenantOwned(member, principal);
  requirePermission(principal, member.clubId, "collections:work");

  let next: string;
  let actionKey: string;
  switch (action) {
    case "SUSPEND_CHARGE": next = "CHARGE_ACCOUNT_SUSPENDED"; actionKey = "SUSPENDED_CHARGE"; break;
    case "SUSPEND_TEE":    next = "TEE_SHEET_SUSPENDED";      actionKey = "SUSPENDED_TEE"; break;
    case "FULL_SUSPEND":   next = "FULL_SUSPENSION";          actionKey = "FULL_SUSPENDED"; break;
    case "RESTORE":        next = "FULL_ACCESS";              actionKey = "RESTORED"; break;
  }

  const updated = await prisma.member.update({ where: { id: memberId }, data: { accessStatus: next } });
  await prisma.collectionAction.create({
    data: { clubId: member.clubId, memberId, action: actionKey, meta: JSON.stringify({ before: member.accessStatus, after: next }) },
  });
  await audit(principal, {
    action: `collections.${actionKey.toLowerCase()}`,
    entityType: "Member",
    entityId: memberId,
    clubId: member.clubId,
    before: { accessStatus: member.accessStatus },
    after: { accessStatus: next },
  });
  return updated;
}
