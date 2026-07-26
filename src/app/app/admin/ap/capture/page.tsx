import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { listInbox, uploadCapture, rejectCapture, parseExtraction } from "@/lib/ap/capture";
import { isAppError } from "@/lib/errors";
import { Badge } from "@/components/Badge";
import { fmtMoney } from "@/lib/accounting/format";
import { formatDate } from "@/lib/finance";

async function uploadAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await uploadCapture(p, clubId, {
      name: String(formData.get("name") ?? "untitled.pdf"),
      mimeType: "application/pdf",
      sizeBytes: Number(formData.get("sizeBytes") ?? 0),
    });
  } catch (err) {
    if (isAppError(err)) redirect(`/app/admin/ap/capture?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
  revalidatePath("/app/admin/ap/capture");
}

async function rejectAction(captureId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await rejectCapture(p, captureId, String(formData.get("reason") ?? "")); } catch (err) { if (isAppError(err)) redirect(`/app/admin/ap/capture?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ap/capture");
}

export default async function CaptureInboxPage({ searchParams }: { searchParams: { error?: string; status?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "ap:capture:view")) redirect("/app/admin");
  const canUpload = hasPermission(p, clubId, "ap:capture:upload");

  const items = await listInbox(p, clubId, searchParams.status ? { status: searchParams.status } : undefined);

  return (
    <div>
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title">Capture Inbox</h1>
          <p className="mt-1 text-stone-500">Receipts and invoices uploaded for review. OCR runs automatically.</p>
        </div>
        {canUpload && (
          <form action={uploadAction} className="flex items-end gap-2">
            <div>
              <label className="label">Filename</label>
              <input className="input" name="name" placeholder="receipt.pdf" required />
            </div>
            <input type="hidden" name="sizeBytes" value="123456" />
            <button className="btn btn-primary">Upload (mock OCR)</button>
          </form>
        )}
      </div>

      <p className="mt-3 text-xs text-stone-500">
        File storage is wired in Phase 7. The mock adapter populates extracted fields + coding suggestion deterministically from the filename so the workflow is exercisable end-to-end.
      </p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 card overflow-hidden">
        <table className="table-base">
          <thead><tr><th>Uploaded</th><th>File</th><th>Vendor (extracted)</th><th>Invoice #</th><th>Date</th><th className="text-right">Total</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={8} className="px-4 py-6 text-center text-stone-500">Inbox is empty.</td></tr>}
            {items.map((c) => {
              const ex = parseExtraction(c);
              const isDup = c.status === "DUPLICATE";
              return (
                <tr key={c.id}>
                  <td className="text-xs text-stone-500">{formatDate(c.uploadedAt)}</td>
                  <td>{c.name}</td>
                  <td>{ex?.vendorName ?? "—"}</td>
                  <td className="font-mono text-xs">{ex?.invoiceNumber ?? "—"}</td>
                  <td>{ex?.invoiceDate ?? "—"}</td>
                  <td className="text-right tabular-nums">{ex?.total ? fmtMoney(ex.total) : "—"}</td>
                  <td><Badge status={c.status} /></td>
                  <td className="text-right space-x-2">
                    {c.status !== "CONVERTED" && c.status !== "REJECTED" && (
                      <Link className="text-xs text-club-green-700 hover:underline" href={`/app/admin/ap/invoices/new?capture=${c.id}`}>
                        {isDup ? "Re-review →" : "Convert →"}
                      </Link>
                    )}
                    {c.status !== "REJECTED" && c.status !== "CONVERTED" && canUpload && (
                      <form action={rejectAction.bind(null, c.id)} className="inline">
                        <input className="input inline-block w-24" name="reason" placeholder="Reason" />
                        <button className="text-xs text-red-600 hover:underline ml-1">Reject</button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
