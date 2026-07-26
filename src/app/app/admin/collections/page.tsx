import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import {
  generateNoticeFromTemplate,
  markNoticeSent,
  markNoticeResolved,
  applyAccessAction,
} from "@/lib/services/collections";
import { isAppError } from "@/lib/errors";
import { Badge } from "@/components/Badge";
import { formatCurrency, formatDate } from "@/lib/finance";

function bounce(err: unknown) {
  if (isAppError(err)) redirect(`/app/admin/collections?error=${encodeURIComponent(err.safeMessage)}`);
  throw err;
}

async function generateAction(memberId: string, templateKey: string, stageKey: string) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  try { await generateNoticeFromTemplate(p, memberId, templateKey, stageKey); } catch (err) { bounce(err); }
  revalidatePath("/app/admin/collections");
}

async function sentAction(noticeId: string) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  try { await markNoticeSent(p, noticeId); } catch (err) { bounce(err); }
  revalidatePath("/app/admin/collections");
}

async function resolvedAction(noticeId: string) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  try { await markNoticeResolved(p, noticeId); } catch (err) { bounce(err); }
  revalidatePath("/app/admin/collections");
}

async function accessAction(memberId: string, kind: "SUSPEND_CHARGE" | "SUSPEND_TEE" | "FULL_SUSPEND" | "RESTORE") {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  try { await applyAccessAction(p, memberId, kind); } catch (err) { bounce(err); }
  revalidatePath("/app/admin/collections");
}

export default async function CollectionsPage({ searchParams }: { searchParams: { error?: string } }) {
  const user = await getCurrentPrincipal();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId({ clubId: user.activeClubId ?? null, role: "" });

  const [stages, over30, over60, over90, over120, failedPayments, missingPayment, notices, promises] = await Promise.all([
    prisma.collectionStage.findMany({ where: { clubId, isActive: true }, orderBy: { sortOrder: "asc" } }),
    prisma.member.findMany({ where: { clubId, account: { thirtyDayBalance: { gt: 0 } } }, include: { account: true }, orderBy: { lastName: "asc" }, take: 50 }),
    prisma.member.findMany({ where: { clubId, account: { sixtyDayBalance: { gt: 0 } } }, include: { account: true }, orderBy: { lastName: "asc" }, take: 50 }),
    prisma.member.findMany({ where: { clubId, account: { ninetyDayBalance: { gt: 0 } } }, include: { account: true }, orderBy: { lastName: "asc" }, take: 50 }),
    prisma.member.findMany({ where: { clubId, account: { oneTwentyDayBalance: { gt: 0 } } }, include: { account: true }, orderBy: { lastName: "asc" }, take: 50 }),
    prisma.payment.findMany({ where: { clubId, status: "FAILED" }, include: { member: true }, orderBy: { paymentDate: "desc" } }),
    prisma.member.findMany({ where: { clubId, paymentMethodStatus: "NONE", status: "ACTIVE" }, orderBy: { lastName: "asc" } }),
    prisma.collectionNotice.findMany({ where: { clubId }, orderBy: { createdAt: "desc" }, take: 50, include: { member: true, template: true } }),
    prisma.paymentPromise.findMany({ where: { clubId, status: "ACTIVE" }, include: { member: true }, orderBy: { promisedDate: "asc" } }),
  ]);

  const stageMap = Object.fromEntries(stages.map((s) => [s.key, s]));

  return (
    <div>
      <h1 className="page-title">Collections</h1>
      <p className="mt-1 text-stone-500">Members requiring follow-up, recent notices, and active payment promises.</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-8 grid grid-cols-1 lg:grid-cols-4 gap-6">
        <AgingCard title="Over 30 days" tone="default" members={over30} bucket="thirtyDayBalance" stageKey="STAGE_30" stage={stageMap.STAGE_30} action={generateAction} />
        <AgingCard title="Over 60 days" tone="warning" members={over60} bucket="sixtyDayBalance" stageKey="STAGE_60" stage={stageMap.STAGE_60} action={generateAction} />
        <AgingCard title="Over 90 days" tone="warning" members={over90} bucket="ninetyDayBalance" stageKey="STAGE_90" stage={stageMap.STAGE_90} action={generateAction} />
        <AgingCard title="Over 120 days" tone="danger" members={over120} bucket="oneTwentyDayBalance" stageKey="STAGE_120" stage={stageMap.STAGE_120} action={generateAction} />
      </div>

      <div className="mt-10 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Failed payments</div>
          <table className="table-base">
            <thead><tr><th>Member</th><th>Date</th><th className="text-right">Amount</th><th>Reason</th></tr></thead>
            <tbody>
              {failedPayments.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-stone-500">No failed payments.</td></tr>}
              {failedPayments.map((p) => (
                <tr key={p.id}>
                  <td><Link href={`/app/admin/members/${p.memberId}`} className="font-medium hover:text-club-green-700">{p.member.firstName} {p.member.lastName}</Link></td>
                  <td>{formatDate(p.paymentDate)}</td>
                  <td className="text-right tabular-nums">{formatCurrency(p.amount)}</td>
                  <td className="text-stone-600 text-xs">{p.failureReason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Missing payment method</div>
          <table className="table-base">
            <thead><tr><th>Member</th><th>Category</th><th>Status</th></tr></thead>
            <tbody>
              {missingPayment.length === 0 && <tr><td colSpan={3} className="px-4 py-8 text-center text-stone-500">All active members have a payment method on file.</td></tr>}
              {missingPayment.map((m) => (
                <tr key={m.id}>
                  <td><Link href={`/app/admin/members/${m.id}`} className="font-medium hover:text-club-green-700">{m.firstName} {m.lastName}</Link></td>
                  <td className="text-stone-600">{m.membershipCategory ?? "—"}</td>
                  <td><Badge status={m.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-10 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
            <span className="font-medium">Active payment promises</span>
            <Link href="/app/admin/collections/templates" className="text-xs text-club-green-700 hover:underline">Manage templates →</Link>
          </div>
          <table className="table-base">
            <thead><tr><th>Member</th><th>Promised</th><th className="text-right">Amount</th></tr></thead>
            <tbody>
              {promises.length === 0 && <tr><td colSpan={3} className="px-4 py-8 text-center text-stone-500">None recorded.</td></tr>}
              {promises.map((p) => (
                <tr key={p.id}>
                  <td><Link href={`/app/admin/members/${p.memberId}`} className="font-medium hover:text-club-green-700">{p.member.firstName} {p.member.lastName}</Link></td>
                  <td>{formatDate(p.promisedDate)}</td>
                  <td className="text-right tabular-nums">{formatCurrency(p.promisedAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card card-body">
          <div className="font-medium">Collection stages</div>
          <ul className="mt-3 space-y-2 text-sm">
            {stages.map((s) => (
              <li key={s.id} className="rounded-md bg-stone-50 px-3 py-2">
                <div className="flex items-center justify-between">
                  <div className="font-medium">{s.name}</div>
                  <span className="text-xs text-stone-500">≥ {s.triggerAgeDays}d</span>
                </div>
                <div className="text-xs text-stone-500">
                  Notice: {s.defaultTemplateKey ?? "—"}
                  {s.autoSuspendChargeAccount && " · suspends charge"}
                  {s.autoSuspendTeeSheet && " · suspends tee"}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-10">
        <h2 className="section-title">Notices</h2>
        <div className="mt-4 card overflow-hidden">
          <table className="table-base">
            <thead><tr><th>Member</th><th>Type</th><th>Created</th><th>Sent</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {notices.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-stone-500">No notices.</td></tr>}
              {notices.map((n) => (
                <tr key={n.id}>
                  <td><Link href={`/app/admin/members/${n.memberId}`} className="font-medium hover:text-club-green-700">{n.member.firstName} {n.member.lastName}</Link></td>
                  <td>{(n.template?.name ?? n.noticeType).replace(/_/g, " ")}</td>
                  <td>{formatDate(n.createdAt)}</td>
                  <td>{formatDate(n.sentAt)}</td>
                  <td><Badge status={n.status} /></td>
                  <td className="space-x-2 text-right">
                    {n.status === "DRAFT" && (
                      <form action={sentAction.bind(null, n.id)} className="inline"><button className="text-xs text-club-green-700 hover:underline">Mark sent</button></form>
                    )}
                    {n.status !== "RESOLVED" && (
                      <form action={resolvedAction.bind(null, n.id)} className="inline"><button className="text-xs text-club-green-700 hover:underline">Mark resolved</button></form>
                    )}
                    <form action={accessAction.bind(null, n.memberId, "SUSPEND_CHARGE")} className="inline"><button className="text-xs text-amber-700 hover:underline">Suspend charge</button></form>
                    <form action={accessAction.bind(null, n.memberId, "SUSPEND_TEE")} className="inline"><button className="text-xs text-amber-700 hover:underline">Suspend tee</button></form>
                    <form action={accessAction.bind(null, n.memberId, "RESTORE")} className="inline"><button className="text-xs text-club-green-700 hover:underline">Restore</button></form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function AgingCard({
  title, tone, members, bucket, stageKey, stage, action,
}: {
  title: string;
  tone: "default" | "warning" | "danger";
  members: Array<{ id: string; firstName: string; lastName: string; account: { sixtyDayBalance: number; thirtyDayBalance: number; ninetyDayBalance: number; oneTwentyDayBalance: number; currentBalance: number } | null }>;
  bucket: "thirtyDayBalance" | "sixtyDayBalance" | "ninetyDayBalance" | "oneTwentyDayBalance";
  stageKey: string;
  stage?: { defaultTemplateKey: string | null };
  action: (memberId: string, templateKey: string, stageKey: string) => Promise<void>;
}) {
  const accent = tone === "danger" ? "border-l-red-500" : tone === "warning" ? "border-l-amber-400" : "border-l-stone-300";
  const templateKey = stage?.defaultTemplateKey ?? "OVER_30";
  return (
    <div className={`card border-l-4 ${accent}`}>
      <div className="card-body">
        <div className="card-title">{title}</div>
        <div className="mt-2 text-2xl font-serif">{members.length} member{members.length === 1 ? "" : "s"}</div>
        <ul className="mt-4 space-y-2 text-sm">
          {members.slice(0, 6).map((m) => (
            <li key={m.id} className="flex items-center justify-between">
              <Link href={`/app/admin/members/${m.id}`} className="hover:text-club-green-700">{m.firstName} {m.lastName}</Link>
              <div className="flex items-center gap-2">
                <span className="tabular-nums text-stone-600">{formatCurrency((m.account?.[bucket] ?? 0))}</span>
                <form action={action.bind(null, m.id, templateKey, stageKey)} className="inline">
                  <button className="text-xs text-club-green-700 hover:underline">Notice</button>
                </form>
              </div>
            </li>
          ))}
          {members.length === 0 && <li className="text-stone-500">No members in this bucket.</li>}
        </ul>
      </div>
    </div>
  );
}
