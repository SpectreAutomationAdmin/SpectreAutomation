// Lounge POS — closed-check history.
//
// Lists checks that have moved out of the active service workflow
// (CLOSED or VOIDED). Filters by date range, settlement method, and
// search (check number / member name). Each row links to the
// frozen signature-chit PDF if one was snapshotted at settlement.

import { Fragment } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { listClosedChecks } from "@/lib/pos/checks";
import { formatCurrency, formatDateTime } from "@/lib/finance";
import { maskEmail } from "@/lib/pos/receipts";
import { getEmailDeliveryDescriptor } from "@/lib/integrations/email";
import { ResendReceiptButton } from "./ResendReceiptButton";
import { GroupResendReceiptButton } from "./GroupResendReceiptButton";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function LoungeHistoryPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; method?: string; q?: string };
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "inventory:read")) redirect("/app/admin");

  const from = searchParams.from ? new Date(searchParams.from) : defaultFrom();
  const to = searchParams.to ? new Date(searchParams.to) : new Date();
  // Cap "to" at end-of-day so today's settled checks aren't excluded.
  const toEnd = new Date(to);
  toEnd.setHours(23, 59, 59, 999);
  const method = (searchParams.method === "MEMBER_ACCOUNT" || searchParams.method === "QR_PAY")
    ? searchParams.method as "MEMBER_ACCOUNT" | "QR_PAY"
    : undefined;
  const search = searchParams.q?.trim() || undefined;

  const checks = await listClosedChecks(principal, clubId, {
    from,
    to: toEnd,
    settlementMethod: method,
    search,
    limit: 200,
  });
  const emailDelivery = await getEmailDeliveryDescriptor(clubId);
  const canResend = hasPermission(principal, clubId, "inventory:write");

  return (
    <div>
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="page-title">Closed checks</h1>
          <p className="mt-1 text-sm text-stone-500">
            Settled or voided lounge checks. Filter by date, payment method, or member.
          </p>
        </div>
        <Link href="/app/admin/ops/pos/lounge" className="btn btn-secondary btn-sm">
          ← Lounge POS
        </Link>
      </div>

      {/* Filter strip */}
      <form className="mt-4 card card-body flex flex-wrap gap-3 items-end" method="get">
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">From</label>
          <input
            type="date"
            name="from"
            defaultValue={dateInput(from)}
            className="input text-sm"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">To</label>
          <input
            type="date"
            name="to"
            defaultValue={dateInput(to)}
            className="input text-sm"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Method</label>
          <select name="method" defaultValue={method ?? ""} className="input text-sm">
            <option value="">All</option>
            <option value="MEMBER_ACCOUNT">Member account</option>
            <option value="QR_PAY">Pay by Phone (QR)</option>
          </select>
        </div>
        <div className="flex-1 min-w-[16rem]">
          <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Search</label>
          <input
            type="text"
            name="q"
            defaultValue={search ?? ""}
            placeholder="Check number or member name"
            className="input text-sm"
          />
        </div>
        <button type="submit" className="btn btn-primary btn-sm">Apply</button>
      </form>

      {/* Email delivery mode banner — admins need to know whether the
          system is actually sending mail and to where. Distinguishes
          a local Maildev sink from a real external SMTP relay. */}
      <div className={`mt-4 rounded-md border px-3 py-2 text-xs ${
        emailDelivery.mode === "console" || emailDelivery.smtpTarget === "local"
          ? "border-amber-300 bg-amber-50 text-amber-900"
          : "border-club-green-300 bg-club-green-50 text-club-green-800"
      }`}>
        <span className="font-medium">Email delivery mode:</span>{" "}
        {emailDelivery.mode === "smtp" && emailDelivery.smtpTarget === "local" && (
          <>SMTP (local Maildev) — delivered to the local inbox at <a href="http://localhost:8025" target="_blank" rel="noopener noreferrer" className="underline">http://localhost:8025</a> only.{" "}
          Members do NOT receive these emails. Edit <code>.env.local</code> and restart to switch to a real relay.</>
        )}
        {emailDelivery.mode === "smtp" && emailDelivery.smtpTarget === "external" && (
          <>SMTP (external relay) — receipts deliver to real inboxes via <code>{emailDelivery.smtpHost}:{emailDelivery.smtpPort}</code>.</>
        )}
        {emailDelivery.mode === "smtp" && !emailDelivery.smtpTarget && (
          <>SMTP — receipts deliver via the configured SMTP server.</>
        )}
        {emailDelivery.mode === "microsoft365" && (
          <>Microsoft 365 — receipts sent from <code>{emailDelivery.microsoftFromMailbox ?? "(mailbox not set)"}</code> via Microsoft Graph.</>
        )}
        {emailDelivery.mode === "ses" && "SES — receipts deliver via Amazon SES."}
        {emailDelivery.mode === "console" && "Console (dev) — receipts are logged to the server console only; no mail leaves this machine. Set EMAIL_DELIVERY_MODE=smtp with SMTP_HOST/SMTP_PORT/SMTP_FROM to enable real delivery."}
      </div>

      <div className="mt-4 card overflow-hidden">
        <div className="px-5 py-3 border-b border-stone-200 font-medium">
          Checks ({checks.length})
        </div>
        <table className="table-base">
          <thead>
            <tr>
              <th>Check #</th>
              <th>Member</th>
              <th>Closed</th>
              <th>Method</th>
              <th className="text-right">Total</th>
              <th>Status</th>
              <th>Receipt email</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {checks.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-sm text-stone-500">
                  No closed checks match those filters.
                </td>
              </tr>
            )}
            {checks.map((c) => {
              const total = c.posSale
                ? Number(c.posSale.grandTotal.toString())
                : c.settlementGroups.reduce((s, g) => s + Number(g.grandTotal.toString()), 0);
              const isSplit = c.settlementGroups.length > 1;
              const methodLabel = isSplit
                ? `Split (${c.settlementGroups.length} groups)`
                : c.settlementMethod === "QR_PAY" ? "Pay by Phone" :
                  c.settlementMethod === "MEMBER_ACCOUNT" ? "Member account" : "—";
              const statusBadge = derivedStatus(c.status, c.settlementMethod);
              return (
                <Fragment key={c.id}>
                  <tr>
                    <td className="text-xs font-mono">{c.checkNumber}</td>
                    <td className="text-sm">
                      {c.member ? `${c.member.firstName} ${c.member.lastName}` : "—"}
                      {c.member?.memberNumber && (
                        <span className="ml-1 text-[10px] text-stone-400">{c.member.memberNumber}</span>
                      )}
                    </td>
                    <td className="text-xs">{c.closedAt ? formatDateTime(c.closedAt) : "—"}</td>
                    <td className="text-xs text-stone-600">{methodLabel}</td>
                    <td className="text-right tabular-nums">{formatCurrency(total)}</td>
                    <td>
                      <span className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wide ${statusBadge.tone}`}>
                        {statusBadge.label}
                      </span>
                    </td>
                    <td className="text-xs text-stone-600 max-w-[14rem]">
                      {isSplit ? (
                        <div className="text-[11px] text-stone-500">
                          {c.settlementGroups.length} group receipts — see below
                        </div>
                      ) : (
                        <>
                          <div className={emailTone(c.receiptEmailStatus)}>
                            {emailLabel(c.receiptEmailStatus)}
                          </div>
                          {c.receiptEmailAddress && (
                            <div className="text-[10px] text-stone-500">{maskEmail(c.receiptEmailAddress)}</div>
                          )}
                          {c.receiptEmailFailure && (
                            <div className="text-[10px] text-red-600 truncate" title={c.receiptEmailFailure}>
                              {c.receiptEmailFailure}
                            </div>
                          )}
                        </>
                      )}
                    </td>
                    <td className="text-right text-xs whitespace-nowrap">
                      {!isSplit && c.posSaleId && (
                        <div className="inline-flex flex-col items-end gap-1">
                          <a
                            href={`/api/admin/pos/lounge/sales/${c.posSaleId}/chit/SIGNATURE`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-club-green-700 hover:underline"
                          >
                            Open receipt
                          </a>
                          {canResend && c.status === "CLOSED" && (
                            <ResendReceiptButton checkId={c.id} />
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                  {/* Per-group breakdown for split-bill settles. Each
                      group is its own paying member with its own receipt
                      email status. Open receipt links to the group's
                      POSSale (the same row the paying member sees in
                      /app/member/dining). */}
                {isSplit && c.settlementGroups.map((g) => (
                    <tr key={`${c.id}-${g.id}`} className="bg-stone-50/60">
                      <td className="text-[10px] font-mono text-stone-500 pl-6">↳ {g.label}</td>
                      <td className="text-xs">
                        {g.member ? `${g.member.firstName} ${g.member.lastName}` : "—"}
                        {g.member?.memberNumber && (
                          <span className="ml-1 text-[10px] text-stone-400">{g.member.memberNumber}</span>
                        )}
                      </td>
                      <td className="text-[10px] text-stone-500">{g.settlementMethod ?? "—"}</td>
                      <td className="text-xs text-stone-600">
                        {g.status === "SETTLED" ? "Member account" : g.status}
                      </td>
                      <td className="text-right tabular-nums text-xs">
                        {formatCurrency(Number(g.grandTotal.toString()))}
                      </td>
                      <td>
                        <span className="inline-flex rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wide bg-club-green-50 text-club-green-800 border-club-green-300">
                          {g.status}
                        </span>
                      </td>
                      <td className="text-xs max-w-[14rem]">
                        <div className={emailTone(g.receiptEmailStatus)}>
                          {emailLabel(g.receiptEmailStatus)}
                        </div>
                        {g.receiptEmailAddress && (
                          <div className="text-[10px] text-stone-500">{maskEmail(g.receiptEmailAddress)}</div>
                        )}
                        {g.receiptEmailFailure && (
                          <div className="text-[10px] text-red-600 truncate" title={g.receiptEmailFailure}>
                            {g.receiptEmailFailure}
                          </div>
                        )}
                      </td>
                      <td className="text-right text-xs whitespace-nowrap">
                        {g.posSaleId && (
                          <div className="inline-flex flex-col items-end gap-1">
                            <a
                              href={`/api/admin/pos/lounge/sales/${g.posSaleId}/chit/SIGNATURE`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-club-green-700 hover:underline"
                            >
                              Open receipt
                            </a>
                            {canResend && c.status === "CLOSED" && (
                              <GroupResendReceiptButton
                                groupId={g.id}
                                disabledReason={groupResendDisabledReason(g, c.status)}
                              />
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function defaultFrom(): Date {
  // Last 7 days by default — server/shift framing in practice.
  const d = new Date();
  d.setDate(d.getDate() - 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dateInput(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function emailLabel(s: string | null | undefined): string {
  if (!s) return "—";
  if (s === "SENT") return "Sent";
  if (s === "DEV_LOGGED") return "Dev-logged";
  if (s === "FAILED") return "Failed";
  if (s === "SUPPRESSED") return "Suppressed";
  if (s === "SKIPPED_NO_EMAIL") return "No email on file";
  return s;
}

// Compute the human-readable reason a per-group Resend button should
// stay disabled. NULL = button is active. We pre-compute these on the
// server so the button doesn't have to round-trip the action to learn
// the answer for static reasons (no email, voided check, QR pay).
// Suppression is NOT pre-computed here — it requires a query into the
// EmailSuppression table; clicking the button surfaces SUPPRESSED inline.
type GroupResendShape = {
  settlementMethod: string | null;
  posSaleId: string | null;
  member: { email: string | null } | null;
};
function groupResendDisabledReason(
  g: GroupResendShape,
  checkStatus: string,
): string | null {
  if (checkStatus === "VOIDED") return "Cannot resend: check is voided.";
  if (!g.posSaleId) return "Cannot resend: no settled sale.";
  if (g.settlementMethod !== "MEMBER_ACCOUNT") {
    return "Resend only available for member-account groups.";
  }
  if (!g.member) return "Cannot resend: no paying member.";
  const email = g.member.email?.trim() ?? "";
  if (!email || !email.includes("@")) return "Cannot resend: member has no email on file.";
  return null;
}

function emailTone(s: string | null | undefined): string {
  if (s === "SENT") return "text-club-green-700 font-medium";
  if (s === "DEV_LOGGED") return "text-amber-700 font-medium";
  if (s === "FAILED" || s === "SUPPRESSED") return "text-red-700 font-medium";
  return "text-stone-600";
}

function derivedStatus(
  status: string,
  method: string | null,
): { label: string; tone: string } {
  if (status === "VOIDED") return { label: "Voided", tone: "bg-stone-100 text-stone-600 border-stone-200" };
  if (status === "CLOSED") {
    if (method === "QR_PAY") return { label: "Paid (QR)", tone: "bg-club-green-50 text-club-green-800 border-club-green-300" };
    if (method === "MEMBER_ACCOUNT") return { label: "Member charged", tone: "bg-club-green-50 text-club-green-800 border-club-green-300" };
    return { label: "Closed", tone: "bg-club-green-50 text-club-green-800 border-club-green-300" };
  }
  return { label: status, tone: "bg-stone-100 text-stone-700 border-stone-300" };
}
