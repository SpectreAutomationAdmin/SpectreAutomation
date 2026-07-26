// Send the member-facing receipt email after a successful POS
// settlement. Uses the existing email adapter (dev / SMTP / SES) — no
// PDF attachment because the adapter contract doesn't carry one;
// instead the email links to /app/member/dining/[saleId] where the
// member can view + print the same itemized chit Spectre snapshotted
// at settlement (POSSaleChit).
//
// Statuses persisted onto POSCheck.receiptEmailStatus:
//   SENT             — real provider accepted the message
//   DEV_LOGGED       — console-mode adapter logged but did NOT deliver
//   FAILED           — adapter returned an error
//   SUPPRESSED       — recipient is on the EmailSuppression list
//   SKIPPED_NO_EMAIL — the member has no email on file
//   PENDING          — pre-send state (transient)
//
// Every attempt — successful, failed, suppressed, or dev-logged —
// writes an EmailDeliveryEvent row so admins can audit attempts even
// when the dev adapter is in play.

import { prisma } from "../prisma";
import { selectEmailAdapter, getEmailMode } from "../integrations/email";
import { formatCurrency } from "../finance";
import { ensureSurveyInvitationForCheck, FOOD_BEVERAGE_DEPT_KEY } from "../hospitality/surveys";

export type ReceiptEmailStatus =
  | "SENT"
  | "DEV_LOGGED"
  | "FAILED"
  | "SUPPRESSED"
  | "SKIPPED_NO_EMAIL";

export type ReceiptEmailResult = {
  status: ReceiptEmailStatus;
  toAddress: string | null;
  failureReason?: string | null;
  providerMessageId?: string | null;
};

type SurveyContext = {
  links: Array<{ rating: number; url: string }>;
  overviewUrl: string | null;
};

// Email the receipt for a settled POSSale to the linked member.
// `origin` lets us include a working absolute link back to the
// member-facing dining receipt page. `survey` (optional) appends the
// hospitality feedback rating links to the message body.
export async function sendReceiptEmailForSale(
  saleId: string,
  origin: string,
  survey?: SurveyContext,
): Promise<ReceiptEmailResult> {
  const sale = await prisma.pOSSale.findUnique({
    where: { id: saleId },
    include: {
      member: { select: { id: true, firstName: true, lastName: true, email: true } },
      location: { select: { name: true } },
      club: { select: { name: true } },
      lines: {
        orderBy: { id: "asc" },
        include: {
          modifiers: { orderBy: { sortOrder: "asc" } },
        },
      },
      taxLines: true,
      // Either of these reverse-relations resolves the POSCheck that
      // produced this sale: `fromCheck` for the legacy lounge / merge-
      // all settle (one sale per check), `settlementGroup` for split-
      // bill (one sale per group). At most one is populated.
      fromCheck: { select: { tableNumber: true, checkNumber: true } },
      settlementGroup: {
        select: {
          label: true,
          posCheck: { select: { tableNumber: true, checkNumber: true } },
        },
      },
    },
  });
  if (!sale) {
    return { status: "FAILED", toAddress: null, failureReason: "Sale not found" };
  }
  // Pull the freshest member email — the admin may have just corrected
  // it on the profile page seconds before settling. Reading the relation
  // baked into the sale would carry whatever email existed at sale
  // creation, which can be stale.
  let memberEmail: string | null = sale.member?.email ?? null;
  let memberFirstName = sale.member?.firstName ?? "there";
  if (sale.memberId) {
    const fresh = await prisma.member.findUnique({
      where: { id: sale.memberId },
      select: { email: true, firstName: true },
    });
    if (fresh) {
      memberEmail = fresh.email || null;
      memberFirstName = fresh.firstName || memberFirstName;
    }
  }
  if (!memberEmail || !memberEmail.includes("@")) {
    return { status: "SKIPPED_NO_EMAIL", toAddress: null };
  }

  const adapter = await selectEmailAdapter(sale.clubId);
  const mode = await getEmailMode(sale.clubId);
  const clubName = sale.club?.name ?? "Your club";
  const subject = `Your ${clubName} receipt — ${sale.saleNumber}`;

  // Resolve table number + group label (when applicable) for the body
  // header. Either reverse-relation supplies the table; only the split-
  // bill path supplies the group label.
  const tableNumber =
    sale.settlementGroup?.posCheck?.tableNumber ??
    sale.fromCheck?.tableNumber ??
    null;
  const groupLabel = sale.settlementGroup?.label ?? null;

  const body = buildReceiptText({
    clubName,
    memberFirstName,
    locationName: sale.location?.name ?? "lounge",
    saleNumber: sale.saleNumber,
    saleDate: sale.saleDate,
    chargeMode: sale.chargeMode,
    tableNumber,
    groupLabel,
    lines: sale.lines.map((l) => ({
      qty: Number(l.quantity.toString()),
      description: l.description,
      lineTotal: Number(l.lineTotal.toString()),
      modifiers: l.modifiers.map((m) => ({
        label: m.label,
        priceDelta: Number(m.priceDelta.toString()),
      })),
    })),
    subtotal: Number(sale.subtotal.toString()),
    taxLines: sale.taxLines.map((t) => ({
      label: t.label,
      amount: Number(t.amount.toString()),
    })),
    grandTotal: Number(sale.grandTotal.toString()),
    receiptLink: `${origin.replace(/\/$/, "")}/app/member/dining/${sale.id}`,
    survey,
    locationLabelLong: sale.location?.name ?? "the Clubhouse Lounge",
  });

  const adapterResult = await adapter.send({
    clubId: sale.clubId,
    channel: "EMAIL",
    to: { email: memberEmail, memberId: sale.member?.id ?? null },
    subject,
    body,
  });

  // Always record the attempt for audit, even when the adapter only
  // logged to console. `kind` distinguishes outcomes for filtering.
  const eventKind =
    adapterResult.status === "SENT" && mode === "console" ? "POS_RECEIPT_DEV_LOGGED" :
    adapterResult.status === "SENT" ? "POS_RECEIPT_SENT" :
    adapterResult.failureReason?.startsWith("suppressed:") ? "POS_RECEIPT_SUPPRESSED" :
    "POS_RECEIPT_FAILED";
  try {
    await prisma.emailDeliveryEvent.create({
      data: {
        clubId: sale.clubId,
        email: memberEmail,
        kind: eventKind,
        provider: mode,
        messageId: adapterResult.providerMessageId ?? null,
        reason: adapterResult.failureReason ?? null,
      },
    });
  } catch {
    // Audit-only — never let an audit-write failure mask the send result.
  }

  if (adapterResult.status === "SENT") {
    // Console mode "SENT" is actually DEV_LOGGED — be honest about it.
    if (mode === "console") {
      return {
        status: "DEV_LOGGED",
        toAddress: memberEmail,
        providerMessageId: adapterResult.providerMessageId ?? null,
      };
    }
    return {
      status: "SENT",
      toAddress: memberEmail,
      providerMessageId: adapterResult.providerMessageId ?? null,
    };
  }
  // Adapter marks suppression as FAILED with "suppressed:" prefix.
  if (adapterResult.failureReason?.startsWith("suppressed:")) {
    return {
      status: "SUPPRESSED",
      toAddress: memberEmail,
      failureReason: adapterResult.failureReason,
    };
  }
  return {
    status: "FAILED",
    toAddress: memberEmail,
    failureReason: adapterResult.failureReason ?? "Unknown error",
  };
}

// Email helper that also persists the outcome onto POSCheck so the
// success screen + history page can surface it. Pure additive — does
// NOT block / roll back settlement on failure. Also creates (or reuses)
// the hospitality-survey invitation so the receipt body carries rating
// links and the admin dashboard has an audit trail.
export async function sendAndRecordReceiptEmail(opts: {
  checkId: string;
  saleId: string;
  origin: string;
}): Promise<ReceiptEmailResult> {
  // Look up clubId + memberId for survey wiring. Done with a single
  // narrow read so a missing check (defensive) does not block the
  // receipt send.
  const check = await prisma.pOSCheck.findUnique({
    where: { id: opts.checkId },
    select: { clubId: true, memberId: true },
  });

  let survey: SurveyContext | undefined;
  if (check) {
    const inv = await ensureSurveyInvitationForCheck({
      clubId: check.clubId,
      posCheckId: opts.checkId,
      posSaleId: opts.saleId,
      memberId: check.memberId,
      origin: opts.origin,
      departmentKey: FOOD_BEVERAGE_DEPT_KEY,
    });
    if (inv.token && inv.surveyLinks.length > 0) {
      survey = { links: inv.surveyLinks, overviewUrl: inv.surveyOverviewUrl };
    }
    // If we couldn't recover the raw token (resend case), the receipt
    // omits the rating block — the original email is the source of
    // truth for survey submission.
  }

  const result = await sendReceiptEmailForSale(opts.saleId, opts.origin, survey);
  await prisma.pOSCheck.update({
    where: { id: opts.checkId },
    data: {
      receiptEmailStatus: result.status,
      receiptEmailAddress: result.toAddress,
      // "Emailed at" only tracks real provider acceptance. DEV_LOGGED
      // sales never produced a real email, so the timestamp stays
      // null to avoid lying about delivery.
      receiptEmailedAt: result.status === "SENT" ? new Date() : null,
      receiptEmailFailure:
        result.status === "FAILED" || result.status === "SUPPRESSED"
          ? (result.failureReason ?? null)
          : null,
    },
  });
  return result;
}

// Per-group variant of sendAndRecordReceiptEmail. Used by the split-
// bill seat-settle path. Sends the receipt for ONE settlement group's
// POSSale and writes the outcome onto POSSettlementGroup.receiptEmail*
// (the POSCheck-level row is reserved for the single-group / legacy
// merge-all path, so we don't overwrite it from a split-bill settle).
//
// Same status semantics as sendAndRecordReceiptEmail:
//   SENT             — real provider accepted the message
//   DEV_LOGGED       — console-mode adapter logged but did NOT deliver
//   FAILED           — adapter returned an error
//   SUPPRESSED       — recipient is on the EmailSuppression list
//   SKIPPED_NO_EMAIL — the paying member has no email on file
//
// Receipt-email failure NEVER rolls back settlement — the group is
// already SETTLED and the POSSale is COMPLETED. Outcomes are recorded
// for the UI to surface (closed-check history + settle success panel).
export async function sendAndRecordGroupReceiptEmail(opts: {
  groupId: string;
  saleId: string;
  origin: string;
}): Promise<ReceiptEmailResult> {
  // Per-group survey wiring (step 8). Look up the settlement group for
  // its clubId + posCheckId + memberId, then ensure an invitation
  // scoped to THIS group. The invitation model's app-level idempotency
  // means resending the same group reuses the existing row + token (no
  // duplicate invitations, see ensureSurveyInvitationForCheck).
  const group = await prisma.pOSSettlementGroup.findUnique({
    where: { id: opts.groupId },
    select: { clubId: true, posCheckId: true, memberId: true },
  });
  let survey: SurveyContext | undefined;
  if (group) {
    const inv = await ensureSurveyInvitationForCheck({
      clubId: group.clubId,
      posCheckId: group.posCheckId,
      posSaleId: opts.saleId,
      posSettlementGroupId: opts.groupId,
      memberId: group.memberId,
      origin: opts.origin,
      departmentKey: FOOD_BEVERAGE_DEPT_KEY,
    });
    if (inv.token && inv.surveyLinks.length > 0) {
      survey = { links: inv.surveyLinks, overviewUrl: inv.surveyOverviewUrl };
    }
    // No raw token on resend (only the hash is persisted, so the helper
    // cannot reconstruct the URL). The original email still carries the
    // working link; resend body keeps the receipt itself.
  }
  const result = await sendReceiptEmailForSale(opts.saleId, opts.origin, survey);

  await prisma.pOSSettlementGroup.update({
    where: { id: opts.groupId },
    data: {
      receiptEmailStatus: result.status,
      receiptEmailAddress: result.toAddress,
      // "Emailed at" only tracks real provider acceptance. DEV_LOGGED
      // and SKIPPED/SUPPRESSED never produced a real email — stay null
      // so the UI doesn't lie.
      receiptEmailedAt: result.status === "SENT" ? new Date() : null,
      receiptEmailFailure:
        result.status === "FAILED" || result.status === "SUPPRESSED"
          ? (result.failureReason ?? null)
          : null,
    },
  });
  return result;
}

// Mask an email like `j***@example.com` for display on the success screen.
export function maskEmail(email: string | null | undefined): string {
  if (!email) return "—";
  const [name, host] = email.split("@");
  if (!host) return email;
  const visible = name.slice(0, 1);
  return `${visible}${"*".repeat(Math.max(2, name.length - 1))}@${host}`;
}

// -----------------------------------------------------------------------
// Plain-text receipt body. Kept in this module so the email content and
// the on-screen receipt evolve together.
// -----------------------------------------------------------------------
function buildReceiptText(input: {
  clubName: string;
  memberFirstName: string;
  locationName: string;
  locationLabelLong?: string;
  saleNumber: string;
  saleDate: Date;
  chargeMode: string;
  // Optional context — populated for table-driven sales (seat flow)
  // and the split-bill receipt. Omitted on legacy lounge ringup.
  tableNumber?: string | null;
  groupLabel?: string | null;
  lines: Array<{
    qty: number;
    description: string;
    lineTotal: number;
    modifiers: Array<{ label: string; priceDelta: number }>;
  }>;
  subtotal: number;
  taxLines: Array<{ label: string; amount: number }>;
  grandTotal: number;
  receiptLink: string;
  survey?: { links: Array<{ rating: number; url: string }>; overviewUrl: string | null };
}): string {
  const paymentLabel =
    input.chargeMode === "QR_PAY" ? "Paid by phone (QR)" : "Charged to member account";
  const itemBlocks = input.lines.map((l) => {
    const head = `  ${l.qty} × ${l.description}  ${formatCurrency(l.lineTotal)}`;
    const mods = l.modifiers.length
      ? l.modifiers
          .map((m) => {
            const delta = m.priceDelta;
            const suffix = delta !== 0 ? `  (${delta > 0 ? "+" : ""}${formatCurrency(delta)})` : "";
            return `      • ${m.label}${suffix}`;
          })
          .join("\n")
      : null;
    return mods ? `${head}\n${mods}` : head;
  });

  const taxRows = input.taxLines.map(
    (t) => `  ${t.label.padEnd(12)} ${formatCurrency(t.amount)}`,
  );

  // Hospitality survey block. The ⭐ glyphs render in any modern email
  // client; both HTML wrappers (SMTP-via-nodemailer + Microsoft Graph)
  // escape this body inside a <pre> so it survives unchanged.
  const surveyBlock: string[] = input.survey
    ? [
        ``,
        `Tell us how we did today`,
        `------------------------`,
        `Your feedback helps the ${input.locationLabelLong ?? "Clubhouse"} team continue to improve the member experience.`,
        ``,
        ...input.survey.links.map(
          (l) => `  ${"⭐".repeat(l.rating)} ${l.rating} — ${l.url}`,
        ),
        ``,
        `5 = excellent`,
        input.survey.overviewUrl
          ? `Prefer to leave a comment instead? Open the survey: ${input.survey.overviewUrl}`
          : ``,
      ].filter((s) => s !== "")
    : [];

  // Optional context lines — only render when populated so the legacy
  // tableless lounge POS doesn't grow blank rows.
  const contextRows: string[] = [];
  if (input.tableNumber) contextRows.push(`  Table:        ${input.tableNumber}`);
  if (input.groupLabel) contextRows.push(`  Group:        ${input.groupLabel}`);

  return [
    `Hi ${input.memberFirstName},`,
    ``,
    `Thanks for visiting the ${input.locationName}. Here's your itemized receipt from ${input.clubName}:`,
    ``,
    `  Check / sale: ${input.saleNumber}`,
    `  Date:         ${input.saleDate.toISOString().slice(0, 16).replace("T", " ")}`,
    `  Payment:      ${paymentLabel}`,
    ...contextRows,
    ``,
    `Items`,
    `-----`,
    ...itemBlocks,
    ``,
    `  Subtotal     ${formatCurrency(input.subtotal)}`,
    ...taxRows,
    `  Total        ${formatCurrency(input.grandTotal)}`,
    ``,
    `View or print this receipt online: ${input.receiptLink}`,
    ...surveyBlock,
    ``,
    input.clubName,
  ].join("\n");
}
