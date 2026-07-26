// Hospitality feedback admin dashboard.
//
// F&B-manager-friendly view of every receipt-driven survey response.
// Top: KPI strip + rating distribution. Above-the-fold "Needs attention"
// queue shows unresolved low-rating items (urgent first). Below: a
// filterable table covering the whole result set (date range, rating,
// recovery status, urgent-only, unrouted-only).
//
// Per-row actions: mark reviewed, mark in progress, mark resolved,
// assign follow-up owner, append timestamped internal note. Status
// changes route through the service layer (audited, tenant-safe).

import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { formatCurrency, formatDateTime } from "@/lib/finance";
import {
  listSurveyResponses,
  getFeedbackSummary,
  markResponseReviewed,
  setResponseRecoveryStatus,
  assignResponseFollowUp,
  addResponseInternalNote,
} from "@/lib/hospitality/surveys";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ----------- server actions -----------
// Action errors land in the `spectre_feedback_error` cookie (single-use,
// httpOnly, 30-second TTL). The page reads + clears it on the next
// render. Same pattern as /admin/compliance — no shared helper today,
// pattern is inlined per page until enough surfaces need it.
const ERROR_COOKIE = "spectre_feedback_error";

function setActionError(err: unknown): void {
  if (isAppError(err)) {
    cookies().set(ERROR_COOKIE, err.safeMessage, {
      httpOnly: true,
      sameSite: "strict",
      maxAge: 30,
    });
    return;
  }
  // Unknown / programmer-level errors bubble up so the runtime + sentry
  // see them. We don't want to write opaque "Action failed" to the UI
  // when something is actually broken.
  throw err;
}

async function reviewedAction(responseId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await markResponseReviewed(p, responseId); } catch (err) { setActionError(err); }
  revalidatePath("/app/admin/hospitality/feedback");
}
async function inProgressAction(responseId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await setResponseRecoveryStatus(p, responseId, "IN_PROGRESS"); } catch (err) { setActionError(err); }
  revalidatePath("/app/admin/hospitality/feedback");
}
async function resolvedAction(responseId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await setResponseRecoveryStatus(p, responseId, "RESOLVED"); } catch (err) { setActionError(err); }
  revalidatePath("/app/admin/hospitality/feedback");
}
async function assignAction(responseId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const userId = String(formData.get("userId") ?? "").trim();
  try { await assignResponseFollowUp(p, responseId, userId || null); } catch (err) { setActionError(err); }
  revalidatePath("/app/admin/hospitality/feedback");
}
async function noteAction(responseId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const note = String(formData.get("note") ?? "").trim();
  if (!note) return;
  try { await addResponseInternalNote(p, responseId, note); } catch (err) { setActionError(err); }
  revalidatePath("/app/admin/hospitality/feedback");
}

// ----------- page -----------
export default async function HospitalityFeedbackPage({
  searchParams,
}: {
  searchParams: {
    focus?: string;
    recovery?: string;
    urgent?: string;
    unrouted?: string;
    rating?: string;
    from?: string;
    to?: string;
  };
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "settings:read")) redirect("/app/admin");
  const canWrite = hasPermission(principal, clubId, "settings:write");

  // Single-use action-error cookie. We read it for this render and
  // immediately delete it so a back-button refresh doesn't replay the
  // banner. Same pattern as /admin/compliance.
  const cookieStore = cookies();
  const actionError = cookieStore.get(ERROR_COOKIE)?.value ?? null;
  if (actionError) cookieStore.delete(ERROR_COOKIE);

  const recoveryFilter = (
    searchParams.recovery === "NEEDS_REVIEW" ||
    searchParams.recovery === "IN_PROGRESS" ||
    searchParams.recovery === "RESOLVED" ||
    searchParams.recovery === "NONE"
  ) ? searchParams.recovery : undefined;

  // Parse rating / date range from query string. Anything invalid
  // silently falls back to "no filter" so a hand-typed URL never breaks
  // the page.
  const ratingFilter =
    searchParams.rating && /^[1-5]$/.test(searchParams.rating)
      ? Number(searchParams.rating) as 1 | 2 | 3 | 4 | 5
      : undefined;
  const fromDate = parseDate(searchParams.from);
  const toDate = parseDateEnd(searchParams.to);

  const [summary, rows, needsAttention, eligibleAssignees, dept] = await Promise.all([
    getFeedbackSummary(principal, clubId, 30),
    listSurveyResponses(principal, clubId, {
      recoveryStatus: recoveryFilter,
      rating: ratingFilter,
      from: fromDate,
      to: toDate,
      urgentOnly: searchParams.urgent === "1",
      unroutedOnly: searchParams.unrouted === "1",
      limit: 200,
    }),
    // Needs-attention queue is independent of the table filter so a
    // manager always sees what's open, regardless of how they've
    // narrowed the main table. Urgent (rating <= 2) come first via
    // sortNeedsAttention below.
    listSurveyResponses(principal, clubId, { limit: 50 })
      .then((all) => all.filter(needsAttentionFilter).sort(sortNeedsAttention).slice(0, 12)),
    prisma.user.findMany({
      where: { clubId, status: "ACTIVE", role: { in: ["CLUB_ADMIN", "GENERAL_MANAGER", "FB_MANAGER"] } },
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
      take: 50,
    }),
    prisma.departmentNotificationRule.findFirst({
      where: { clubId, departmentKey: "FOOD_BEVERAGE" },
    }),
  ]);

  const hasTableFilter = Boolean(
    recoveryFilter || ratingFilter || searchParams.urgent === "1" ||
    searchParams.unrouted === "1" || fromDate || toDate,
  );

  return (
    <div>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <Link href="/app/admin/hospitality" className="text-sm text-stone-500 hover:text-club-ink">← Hospitality</Link>
          <h1 className="mt-3 page-title">Guest feedback</h1>
          <p className="mt-1 text-stone-500 max-w-3xl">
            Member ratings submitted from POS receipt emails. Anything below 5/5 routes
            a service-recovery notification to the configured department head.
          </p>
        </div>
      </div>

      {actionError && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</div>
      )}

      {/* Department head config warning */}
      {!dept?.notifyUserId && !dept?.notifyEmail && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span className="font-medium">No Food &amp; Beverage department head configured.</span>{" "}
          Service-recovery alerts will appear here as &ldquo;Unrouted&rdquo; until a notification rule
          is set. Configure one with a notify email or user.
        </div>
      )}

      {/* Summary cards */}
      <div className="mt-6 grid grid-cols-2 md:grid-cols-5 gap-3">
        <SummaryCard label="Avg rating (30d)" value={summary.average ? summary.average.toFixed(2) : "—"} sub={`${summary.total} responses`} />
        <SummaryCard label="Below 5/5" value={String(summary.belowFive)} sub="last 30 days" />
        <SummaryCard label="Urgent open" value={String(summary.urgentOpen)} sub="rating ≤ 2" tone={summary.urgentOpen > 0 ? "red" : undefined} />
        <SummaryCard label="Unresolved" value={String(summary.unresolvedRecovery)} sub="needs follow-up" tone={summary.unresolvedRecovery > 0 ? "amber" : undefined} />
        <SummaryCard label="Unrouted" value={String(summary.unrouted)} sub="no dept head" tone={summary.unrouted > 0 ? "amber" : undefined} />
      </div>

      {/* Distribution — bars use discrete Tailwind width classes so the
          page has zero inline styles. 13-bucket granularity (steps of
          ~8%) — fine for a 5-bar histogram. See `widthBucketClass` for
          the lookup. */}
      <div className="mt-3 card card-body">
        <div className="text-xs uppercase tracking-wide text-stone-500">Rating distribution (30d)</div>
        <div className="mt-2 grid grid-cols-5 gap-3 text-center text-xs">
          {([5, 4, 3, 2, 1] as const).map((r) => {
            const n = summary.distribution[r];
            const pct = summary.total ? (n / summary.total) * 100 : 0;
            return (
              <div key={r}>
                <div className="font-medium">{"⭐".repeat(r)}</div>
                <div className="mt-1 h-2 rounded bg-stone-100 overflow-hidden">
                  <div className={`h-2 bg-stone-900 ${widthBucketClass(pct)}`} />
                </div>
                <div className="mt-1 text-stone-600">{n}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* -----------------------------------------------------------
          Needs attention — independent of the filter bar below.
          Urgent (rating <= 2) comes first; then NEEDS_REVIEW, then
          IN_PROGRESS. RESOLVED + 5/5 NONE never appear here.
          ----------------------------------------------------------- */}
      <section className="mt-6">
        <div className="flex items-baseline justify-between">
          <h2 className="font-serif text-xl text-club-ink">Needs attention</h2>
          <span className="text-xs text-stone-500">{needsAttention.length} open</span>
        </div>
        <div className="mt-2 card overflow-hidden">
          {needsAttention.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-stone-500">
              No feedback requiring attention.
            </div>
          ) : (
            <ul className="divide-y divide-stone-100">
              {needsAttention.map((r) => {
                const memberName = r.member ? `${r.member.firstName} ${r.member.lastName}` : "Guest";
                return (
                  <li key={r.id} className={`px-4 py-3 ${r.urgent ? "bg-red-50/40" : ""}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <RatingPill rating={r.rating} urgent={r.urgent} />
                          {recoveryBadge(r.serviceRecoveryStatus)}
                          {!r.notificationRouted && r.serviceRecoveryStatus !== "NONE" && (
                            <span className="inline-flex rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-800">Unrouted</span>
                          )}
                          {r.posSettlementGroup?.label && (
                            <span className="inline-flex rounded-md border border-stone-300 bg-white px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-stone-700">
                              {r.posSettlementGroup.label}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-sm font-medium text-club-ink">{memberName}</div>
                        {r.comment && (
                          <div className="mt-1 text-sm text-stone-700 line-clamp-2 whitespace-pre-wrap">
                            {r.comment}
                          </div>
                        )}
                        <div className="mt-1 text-[10px] text-stone-500">
                          {formatDateTime(r.submittedAt)}
                          {r.posCheck?.checkNumber && <> · Check {r.posCheck.checkNumber}</>}
                          {r.posSale?.grandTotal !== undefined && (
                            <> · {formatCurrency(Number(r.posSale.grandTotal.toString()))}</>
                          )}
                        </div>
                      </div>
                      <Link
                        href={`/app/admin/hospitality/feedback?focus=${r.id}#${r.id}`}
                        className="shrink-0 text-xs text-club-green-700 hover:underline"
                      >
                        Review →
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* -----------------------------------------------------------
          Filter bar — date range + rating + status. GET form so the
          URL carries the filter state (shareable + history-stable).
          ----------------------------------------------------------- */}
      <section className="mt-6">
        <div className="flex items-baseline justify-between">
          <h2 className="font-serif text-xl text-club-ink">All feedback</h2>
          <span className="text-xs text-stone-500">{rows.length} response{rows.length === 1 ? "" : "s"}</span>
        </div>

        <form method="get" className="mt-2 card card-body flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">From</label>
            <input type="date" name="from" defaultValue={searchParams.from ?? ""} className="input text-sm" />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">To</label>
            <input type="date" name="to" defaultValue={searchParams.to ?? ""} className="input text-sm" />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Rating</label>
            <select name="rating" defaultValue={searchParams.rating ?? ""} className="input text-sm">
              <option value="">All</option>
              <option value="1">1 star</option>
              <option value="2">2 stars</option>
              <option value="3">3 stars</option>
              <option value="4">4 stars</option>
              <option value="5">5 stars</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-stone-500 mb-1">Status</label>
            <select name="recovery" defaultValue={searchParams.recovery ?? ""} className="input text-sm">
              <option value="">Any</option>
              <option value="NEEDS_REVIEW">Needs review</option>
              <option value="IN_PROGRESS">In progress</option>
              <option value="RESOLVED">Resolved</option>
              <option value="NONE">5/5 (none)</option>
            </select>
          </div>
          <label className="inline-flex items-center gap-1 text-xs text-stone-700">
            <input type="checkbox" name="urgent" value="1" defaultChecked={searchParams.urgent === "1"} />
            Urgent only
          </label>
          <label className="inline-flex items-center gap-1 text-xs text-stone-700">
            <input type="checkbox" name="unrouted" value="1" defaultChecked={searchParams.unrouted === "1"} />
            Unrouted only
          </label>
          <button type="submit" className="btn btn-primary btn-sm">Apply</button>
          {hasTableFilter && (
            <Link href="/app/admin/hospitality/feedback" className="btn btn-secondary btn-sm">Reset</Link>
          )}
        </form>

        {/* Table */}
        <div className="mt-3 card overflow-hidden">
          <table className="table-base">
            <thead>
              <tr>
                <th>Submitted</th>
                <th>Member</th>
                <th>Rating</th>
                <th>Comment</th>
                <th>Check / group</th>
                <th>Status</th>
                <th>Owner</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-stone-500">
                    {hasTableFilter
                      ? "No survey responses match these filters."
                      : "No survey responses in this date range."}
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const focused = searchParams.focus === r.id;
                const owner = eligibleAssignees.find((u) => u.id === r.assignedToUserId);
                const memberName = r.member ? `${r.member.firstName} ${r.member.lastName}` : "—";
                return (
                  <tr key={r.id} id={r.id} className={focused ? "bg-amber-50/60" : undefined}>
                    <td className="text-xs whitespace-nowrap">{formatDateTime(r.submittedAt)}</td>
                    <td className="text-sm">
                      {memberName}
                      {r.member?.memberNumber && (
                        <div className="text-[10px] text-stone-400">{r.member.memberNumber}</div>
                      )}
                    </td>
                    <td>
                      <RatingPill rating={r.rating} urgent={r.urgent} />
                      {!r.notificationRouted && r.serviceRecoveryStatus !== "NONE" && (
                        <div className="mt-0.5 inline-flex rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-800">Unrouted</div>
                      )}
                    </td>
                    <td className="text-xs text-stone-700 max-w-[20rem]">
                      {r.comment
                        ? <div className="line-clamp-3 whitespace-pre-wrap">{r.comment}</div>
                        : <span className="text-stone-400">—</span>
                      }
                      {r.internalNotes && (
                        <details className="mt-1 text-[10px] text-stone-500">
                          <summary className="cursor-pointer">Internal notes</summary>
                          <pre className="mt-1 whitespace-pre-wrap font-sans">{r.internalNotes}</pre>
                        </details>
                      )}
                    </td>
                    <td className="text-xs">
                      {r.posCheck?.checkNumber && (
                        <Link href="/app/admin/ops/pos/lounge/history" className="text-club-green-700 hover:underline">
                          {r.posCheck.checkNumber}
                        </Link>
                      )}
                      {r.posSettlementGroup?.label && (
                        <div className="text-[10px] text-stone-500">{r.posSettlementGroup.label}</div>
                      )}
                      {r.posSale?.grandTotal !== undefined && (
                        <div className="text-[10px] text-stone-500">
                          {formatCurrency(Number(r.posSale.grandTotal.toString()))}
                        </div>
                      )}
                    </td>
                    <td className="text-xs">{recoveryBadge(r.serviceRecoveryStatus)}</td>
                    <td className="text-xs text-stone-600">{owner?.name ?? owner?.email ?? "—"}</td>
                    <td className="text-right text-xs">
                      {canWrite && (
                        <details className="inline">
                          <summary className="cursor-pointer text-club-green-700 hover:underline">Actions</summary>
                          <div className="absolute right-3 mt-1 rounded-md border border-stone-200 bg-white shadow-md p-3 w-72 text-left space-y-2 text-xs z-10">
                            {r.serviceRecoveryStatus !== "NONE" && r.serviceRecoveryStatus !== "RESOLVED" && (
                              <form action={reviewedAction.bind(null, r.id)}>
                                <button className="text-club-green-700 hover:underline">Mark reviewed</button>
                              </form>
                            )}
                            {r.serviceRecoveryStatus === "NEEDS_REVIEW" && (
                              <form action={inProgressAction.bind(null, r.id)}>
                                <button className="text-club-green-700 hover:underline">Mark in progress</button>
                              </form>
                            )}
                            {r.serviceRecoveryStatus !== "RESOLVED" && r.serviceRecoveryStatus !== "NONE" && (
                              <form action={resolvedAction.bind(null, r.id)}>
                                <button className="text-club-green-700 hover:underline">Mark resolved</button>
                              </form>
                            )}
                            <form action={assignAction.bind(null, r.id)} className="space-y-1">
                              <label className="block text-[10px] uppercase tracking-wide text-stone-500">Assign follow-up</label>
                              <select name="userId" defaultValue={r.assignedToUserId ?? ""} className="input text-xs">
                                <option value="">— Unassigned —</option>
                                {eligibleAssignees.map((u) => (
                                  <option key={u.id} value={u.id}>{u.name ?? u.email}</option>
                                ))}
                              </select>
                              <button className="text-club-green-700 hover:underline">Save owner</button>
                            </form>
                            <form action={noteAction.bind(null, r.id)} className="space-y-1">
                              <label className="block text-[10px] uppercase tracking-wide text-stone-500">Add internal note</label>
                              <textarea name="note" rows={2} maxLength={4000} className="input text-xs" />
                              <button className="text-club-green-700 hover:underline">Add note</button>
                            </form>
                          </div>
                        </details>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

// "Needs attention" = unresolved + not 5/5. Resolved + NONE both exit
// the queue. Filters out anything fully resolved so the queue clears
// when a manager finishes service recovery.
function needsAttentionFilter(r: { serviceRecoveryStatus: string; rating: number }): boolean {
  if (r.serviceRecoveryStatus === "NONE") return false;
  if (r.serviceRecoveryStatus === "RESOLVED") return false;
  return r.rating < 5;
}

// Urgent first (rating <= 2), then by submitted date desc.
function sortNeedsAttention(
  a: { urgent: boolean; submittedAt: Date },
  b: { urgent: boolean; submittedAt: Date },
): number {
  if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
  return b.submittedAt.getTime() - a.submittedAt.getTime();
}

function parseDate(s?: string): Date | undefined {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(s + "T00:00:00.000Z");
  return Number.isNaN(d.getTime()) ? undefined : d;
}
function parseDateEnd(s?: string): Date | undefined {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(s + "T23:59:59.999Z");
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// Map a 0–100 percentage to one of 13 discrete Tailwind width classes.
// The class names are baked into the source verbatim so Tailwind's JIT
// picks them up at build time. ~8% granularity — fine for a histogram
// where the eye reads bar heights at a glance, not exact percentages.
function widthBucketClass(pct: number): string {
  const p = Math.max(0, Math.min(100, pct));
  if (p < 4)  return "w-0";
  if (p < 12) return "w-1/12";
  if (p < 20) return "w-1/6";
  if (p < 28) return "w-1/4";
  if (p < 37) return "w-1/3";
  if (p < 45) return "w-5/12";
  if (p < 54) return "w-1/2";
  if (p < 62) return "w-7/12";
  if (p < 70) return "w-2/3";
  if (p < 79) return "w-3/4";
  if (p < 87) return "w-5/6";
  if (p < 96) return "w-11/12";
  return "w-full";
}

function SummaryCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "red" | "amber" }) {
  const toneCls = tone === "red" ? "border-red-200 bg-red-50" : tone === "amber" ? "border-amber-200 bg-amber-50" : "border-stone-200 bg-white";
  return (
    <div className={`rounded-md border px-3 py-2 ${toneCls}`}>
      <div className="text-[10px] uppercase tracking-wide text-stone-500">{label}</div>
      <div className="mt-1 font-serif text-xl text-stone-900">{value}</div>
      {sub && <div className="text-[10px] text-stone-500">{sub}</div>}
    </div>
  );
}

// Rating pill with the spec's colour scheme:
//   1-3 → red,  4 → amber,  5 → green. Urgent flag pins it red even on 3.
function RatingPill({ rating, urgent }: { rating: number; urgent: boolean }) {
  const tone =
    urgent || rating <= 3 ? "border-red-300 bg-red-50 text-red-700" :
    rating === 4 ? "border-amber-300 bg-amber-50 text-amber-800" :
    "border-club-green-300 bg-club-green-50 text-club-green-800";
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium ${tone}`}>
      <span>{"⭐".repeat(rating)}</span>
      <span className="text-[10px]">{rating}/5</span>
      {urgent && (
        <span className="ml-1 inline-flex rounded-sm border border-red-400 bg-red-100 px-1 text-[9px] uppercase tracking-wide text-red-800">
          Urgent
        </span>
      )}
    </span>
  );
}

function recoveryBadge(status: string) {
  const map: Record<string, { label: string; tone: string }> = {
    NONE: { label: "5/5 ✓", tone: "bg-club-green-50 text-club-green-800 border-club-green-300" },
    NEEDS_REVIEW: { label: "Needs review", tone: "bg-amber-50 text-amber-800 border-amber-300" },
    IN_PROGRESS: { label: "In progress", tone: "bg-blue-50 text-blue-800 border-blue-300" },
    RESOLVED: { label: "Resolved", tone: "bg-stone-100 text-stone-700 border-stone-300" },
  };
  const meta = map[status] ?? { label: status, tone: "bg-stone-100 text-stone-700 border-stone-300" };
  return <span className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wide ${meta.tone}`}>{meta.label}</span>;
}
