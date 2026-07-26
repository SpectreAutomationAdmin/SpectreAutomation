import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { reviewDetail, decideReviewItem, completeReview } from "@/lib/compliance";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function decideAction(reviewId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try {
    await decideReviewItem(p, {
      itemId: String(formData.get("itemId")),
      decision: String(formData.get("decision")),
      notes: String(formData.get("notes") ?? "") || undefined,
    });
  } catch (err) {
    if (isAppError(err)) cookies().set("spectre_compliance_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath(`/app/admin/compliance/${reviewId}`);
}

async function completeAction(reviewId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try {
    await completeReview(p, reviewId);
  } catch (err) {
    if (isAppError(err)) cookies().set("spectre_compliance_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath(`/app/admin/compliance/${reviewId}`);
}

export default async function ReviewDetailPage({ params }: { params: { id: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  let review;
  try { review = await reviewDetail(p, params.id); }
  catch { notFound(); }
  if (!review) notFound();
  if (!hasPermission(p, review.clubId, "users:roles:write")) redirect("/app/admin/compliance");
  const error = cookies().get("spectre_compliance_error")?.value;
  if (error) cookies().delete("spectre_compliance_error");
  const pendingCount = review.items.filter((i) => i.decision === "PENDING").length;

  return (
    <div>
      <Link href="/app/admin/compliance" className="text-sm text-stone-500 hover:text-club-ink">← Compliance</Link>
      <h1 className="mt-3 page-title">{review.title}</h1>
      <p className="mt-1 text-stone-500">Scope: <span className="font-mono">{review.scope}</span> · Started {formatDate(review.startedAt)} · <Badge status={review.status} /></p>
      {error && <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {review.status !== "COMPLETED" && pendingCount === 0 && (
        <form action={completeAction.bind(null, review.id)} className="mt-4">
          <button className="btn btn-primary">Mark review complete</button>
        </form>
      )}

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Items ({review.items.length}) — pending {pendingCount}</div>
        <table className="table-base">
          <thead><tr><th>Subject</th><th>Type</th><th>Decision</th><th>By</th><th></th></tr></thead>
          <tbody>
            {review.items.map((it) => (
              <tr key={it.id}>
                <td>{it.subjectLabel ?? it.subjectId}</td>
                <td className="text-xs">{it.subjectType}</td>
                <td className="text-xs"><Badge status={it.decision} /></td>
                <td className="text-xs">{it.decidedByUserId ? it.decidedByUserId.slice(0, 8) : "—"}</td>
                <td className="text-right">
                  {it.decision === "PENDING" && review.status !== "COMPLETED" && (
                    <div className="flex justify-end gap-2">
                      <form action={decideAction.bind(null, review.id)} className="flex items-center gap-1">
                        <input type="hidden" name="itemId" value={it.id} />
                        <input type="hidden" name="decision" value="APPROVED" />
                        <button className="btn btn-primary btn-sm">Approve</button>
                      </form>
                      <form action={decideAction.bind(null, review.id)} className="flex items-center gap-1">
                        <input type="hidden" name="itemId" value={it.id} />
                        <input type="hidden" name="decision" value="REVOKED" />
                        <button className="btn btn-secondary btn-sm">Revoke</button>
                      </form>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
