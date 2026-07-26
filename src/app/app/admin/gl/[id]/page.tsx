import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getJournal, post as postJournal, approve as approveJournal, voidDraft, reverse } from "@/lib/accounting/journal";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { Badge } from "@/components/Badge";
import { fmtMoney } from "@/lib/accounting/format";
import { formatDate } from "@/lib/finance";

function bounce(id: string, err: unknown): never {
  if (isAppError(err)) redirect(`/app/admin/gl/${id}?error=${encodeURIComponent(err.safeMessage)}`);
  throw err;
}

async function approveAction(id: string) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  try { await approveJournal(p, id); } catch (err) { bounce(id, err); }
  redirect(`/app/admin/gl/${id}`);
}
async function postAction(id: string) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  try { await postJournal(p, id); } catch (err) { bounce(id, err); }
  redirect(`/app/admin/gl/${id}`);
}
async function voidAction(id: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  try { await voidDraft(p, id, String(formData.get("reason") ?? "").trim()); } catch (err) { bounce(id, err); }
  redirect(`/app/admin/gl/${id}`);
}
async function reverseAction(id: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) bounce(id, { } as never);
  try {
    const contra = await reverse(p, id, { reason });
    redirect(`/app/admin/gl/${contra.id}`);
  } catch (err) { bounce(id, err); }
}

export default async function JournalDetailPage({ params, searchParams }: { params: { id: string }; searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  let entry;
  try { entry = await getJournal(p, params.id); }
  catch { notFound(); }
  if (!entry) notFound();

  const canPost = hasPermission(p, entry.clubId, "gl:post");
  const canReverse = hasPermission(p, entry.clubId, "gl:reverse");

  return (
    <div>
      <Link href="/app/admin/gl" className="text-sm text-stone-500 hover:text-club-ink">← General Ledger</Link>
      <div className="mt-3 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="page-title font-mono">{entry.entryNumber}</h1>
          <div className="mt-2 flex items-center gap-3 flex-wrap">
            <Badge status={entry.status} />
            <span className="text-sm text-stone-500">{formatDate(entry.entryDate)} · {entry.period.label} · source {entry.source}</span>
          </div>
        </div>
        <div className="flex gap-2">
          {entry.reverses && (
            <Link className="text-sm text-stone-500 hover:text-club-ink" href={`/app/admin/gl/${entry.reverses.id}`}>← reverses {entry.reverses.entryNumber}</Link>
          )}
          {entry.reversedBy && (
            <Link className="text-sm text-stone-500 hover:text-club-ink" href={`/app/admin/gl/${entry.reversedBy.id}`}>reversed by {entry.reversedBy.entryNumber} →</Link>
          )}
        </div>
      </div>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="card-body">
            <div className="text-sm text-stone-500">Description</div>
            <div className="mt-1 font-serif text-lg">{entry.description}</div>
            {entry.memo && <p className="mt-2 text-sm text-stone-600 whitespace-pre-wrap">{entry.memo}</p>}
          </div>
          <table className="table-base">
            <thead>
              <tr>
                <th className="w-10">#</th>
                <th>Account</th>
                <th>Dept</th>
                <th>Description</th>
                <th className="text-right">Debit</th>
                <th className="text-right">Credit</th>
              </tr>
            </thead>
            <tbody>
              {entry.lines.map((l) => (
                <tr key={l.id}>
                  <td className="text-stone-500">{l.lineNumber}</td>
                  <td>
                    <Link href={`/app/admin/gl/account/${l.accountId}`} className="hover:text-club-green-700">
                      <span className="font-mono">{l.account.accountNumber}</span> · {l.account.name}
                    </Link>
                  </td>
                  <td className="text-stone-500 text-xs">{l.department?.name ?? "—"}</td>
                  <td className="text-stone-600 text-xs">{l.description ?? "—"}</td>
                  <td className="text-right tabular-nums">{fmtMoney(l.debit as unknown as number)}</td>
                  <td className="text-right tabular-nums">{fmtMoney(l.credit as unknown as number)}</td>
                </tr>
              ))}
              <tr className="font-medium bg-stone-50">
                <td colSpan={4} className="text-right">Totals</td>
                <td className="text-right tabular-nums">{fmtMoney(entry.totalDebits as unknown as number)}</td>
                <td className="text-right tabular-nums">{fmtMoney(entry.totalCredits as unknown as number)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="space-y-4">
          <div className="card card-body text-sm text-stone-600">
            <div><span className="text-stone-400">Posted:</span> {entry.postedAt ? formatDate(entry.postedAt) : "—"}</div>
            <div><span className="text-stone-400">Approved:</span> {entry.approvedAt ? formatDate(entry.approvedAt) : "—"}</div>
            {entry.voidedAt && <div><span className="text-stone-400">Voided:</span> {formatDate(entry.voidedAt)}</div>}
            {entry.voidReason && <div className="mt-1 text-xs">Reason: {entry.voidReason}</div>}
            {entry.sourceEntityType && (
              <div className="mt-1 text-xs"><span className="text-stone-400">Source:</span> {entry.sourceEntityType}:{entry.sourceEntityId}</div>
            )}
          </div>

          {entry.status === "DRAFT" && canPost && (
            <>
              <form action={approveAction.bind(null, entry.id)} className="card card-body">
                <h3 className="font-medium">Approve</h3>
                <p className="mt-1 text-sm text-stone-500">Optional gate for segregation of duties.</p>
                <button className="btn btn-secondary mt-3 w-full">Approve</button>
              </form>
              <form action={postAction.bind(null, entry.id)} className="card card-body">
                <h3 className="font-medium">Post to GL</h3>
                <p className="mt-1 text-sm text-stone-500">Finalize this entry. After posting, only reversal is possible.</p>
                <button className="btn btn-primary mt-3 w-full">Post</button>
              </form>
              <form action={voidAction.bind(null, entry.id)} className="card card-body">
                <h3 className="font-medium">Void</h3>
                <textarea className="textarea mt-3" name="reason" rows={2} placeholder="Reason" />
                <button className="btn btn-danger mt-3 w-full">Void draft</button>
              </form>
            </>
          )}

          {entry.status === "APPROVED" && canPost && (
            <form action={postAction.bind(null, entry.id)} className="card card-body">
              <h3 className="font-medium">Post to GL</h3>
              <button className="btn btn-primary mt-3 w-full">Post</button>
            </form>
          )}

          {entry.status === "POSTED" && canReverse && !entry.reversedBy && (
            <form action={reverseAction.bind(null, entry.id)} className="card card-body">
              <h3 className="font-medium">Reverse</h3>
              <p className="mt-1 text-sm text-stone-500">Posts a contra-entry that nets this one. Original remains for audit.</p>
              <textarea className="textarea mt-3" name="reason" rows={2} required placeholder="Reason (required)" />
              <button className="btn btn-secondary mt-3 w-full">Reverse posted entry</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
