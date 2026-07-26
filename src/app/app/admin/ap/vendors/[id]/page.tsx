import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import {
  getVendor, submitVendorForApproval, activateVendor, blockVendor, deactivateVendor,
  addBankingProfile, submitBankingForApproval, verifyBanking, rejectBanking, initiatePennyTest, confirmPennyTest, getVendorBalance,
} from "@/lib/ap/vendors";
import { getRequestForEntity } from "@/lib/ap/approvals";
import { isAppError } from "@/lib/errors";
import { Badge } from "@/components/Badge";
import { fmtMoney } from "@/lib/accounting/format";
import { formatDate } from "@/lib/finance";

function bounce(id: string, err: unknown): never {
  if (isAppError(err)) redirect(`/app/admin/ap/vendors/${id}?error=${encodeURIComponent(err.safeMessage)}`);
  throw err;
}

async function submitAction(id: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await submitVendorForApproval(p, id); } catch (err) { bounce(id, err); }
  revalidatePath(`/app/admin/ap/vendors/${id}`);
}
async function activateAction(id: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await activateVendor(p, id); } catch (err) { bounce(id, err); }
  revalidatePath(`/app/admin/ap/vendors/${id}`);
}
async function blockAction(id: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await blockVendor(p, id, String(formData.get("reason") ?? "")); } catch (err) { bounce(id, err); }
  revalidatePath(`/app/admin/ap/vendors/${id}`);
}
async function deactivateAction(id: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await deactivateVendor(p, id); } catch (err) { bounce(id, err); }
  revalidatePath(`/app/admin/ap/vendors/${id}`);
}

async function addBankingAction(id: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try {
    await addBankingProfile(p, id, {
      type: String(formData.get("type") ?? "EFT"),
      bankName: String(formData.get("bankName") ?? ""),
      institutionNumber: String(formData.get("institutionNumber") ?? ""),
      transitNumber: String(formData.get("transitNumber") ?? ""),
      accountLastFour: String(formData.get("accountLastFour") ?? ""),
      processorToken: String(formData.get("processorToken") ?? ""),
    });
  } catch (err) { bounce(id, err); }
  revalidatePath(`/app/admin/ap/vendors/${id}`);
}
async function submitBankingAction(id: string, profileId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await submitBankingForApproval(p, profileId); } catch (err) { bounce(id, err); }
  revalidatePath(`/app/admin/ap/vendors/${id}`);
}
async function verifyBankingAction(id: string, profileId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await verifyBanking(p, profileId); } catch (err) { bounce(id, err); }
  revalidatePath(`/app/admin/ap/vendors/${id}`);
}
async function rejectBankingAction(id: string, profileId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await rejectBanking(p, profileId, String(formData.get("reason") ?? "")); } catch (err) { bounce(id, err); }
  revalidatePath(`/app/admin/ap/vendors/${id}`);
}
async function initiatePennyAction(id: string, profileId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await initiatePennyTest(p, profileId, { amount: Number(formData.get("amount") ?? 0.01) }); } catch (err) { bounce(id, err); }
  revalidatePath(`/app/admin/ap/vendors/${id}`);
}
async function confirmPennyAction(id: string, pennyTestId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await confirmPennyTest(p, pennyTestId, Number(formData.get("confirmedAmount") ?? 0)); } catch (err) { bounce(id, err); }
  revalidatePath(`/app/admin/ap/vendors/${id}`);
}

export default async function VendorDetailPage({ params, searchParams }: { params: { id: string }; searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  let vendor;
  try { vendor = await getVendor(p, params.id); }
  catch { notFound(); }
  if (!vendor) notFound();

  const canApprove = hasPermission(p, vendor.clubId, "vendor:approve");
  const canBankEdit = hasPermission(p, vendor.clubId, "vendor:banking:edit");
  const canBankApprove = hasPermission(p, vendor.clubId, "vendor:banking:approve");
  const canEdit = hasPermission(p, vendor.clubId, "vendor:edit");

  const balance = await getVendorBalance(vendor.clubId, vendor.id);
  const approvalReq = await getRequestForEntity(vendor.clubId, "VENDOR", vendor.id);

  return (
    <div>
      <Link href="/app/admin/ap/vendors" className="text-sm text-stone-500 hover:text-club-ink">← Vendors</Link>
      <div className="mt-3 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="page-title">{vendor.legalName}</h1>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <Badge status={vendor.status} />
            <span className="text-sm text-stone-500">{vendor.vendorNumber} · Net {vendor.paymentTermsDays}</span>
            {vendor.riskFlags.length > 0 && (
              <span className="badge bg-amber-50 text-amber-800 ring-amber-200">{vendor.riskFlags.length} open risk flag{vendor.riskFlags.length === 1 ? "" : "s"}</span>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wide text-stone-500">Open AP balance</div>
          <div className="font-serif text-2xl">{fmtMoney(balance, { showZero: true })}</div>
        </div>
      </div>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="card card-body">
            <h2 className="section-title text-lg">Profile</h2>
            <dl className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              <Field label="Email">{vendor.email ?? "—"}</Field>
              <Field label="Phone">{vendor.phone ?? "—"}</Field>
              <Field label="Tax registration">{vendor.taxRegistrationNumber ?? "—"}</Field>
              <Field label="Tax region">{vendor.taxRegion ?? "—"}</Field>
              <Field label="Default expense account">{vendor.defaultExpenseAccount ? `${vendor.defaultExpenseAccount.accountNumber} · ${vendor.defaultExpenseAccount.name}` : "—"}</Field>
              <Field label="Default department">{vendor.defaultDepartment?.name ?? "—"}</Field>
              <Field label="Address">
                {[vendor.address1, [vendor.city, vendor.provinceState].filter(Boolean).join(", "), [vendor.postalCode, vendor.country].filter(Boolean).join(" · ")].filter(Boolean).join(" · ") || "—"}
              </Field>
              <Field label="Default payment method">{vendor.paymentMethod}</Field>
            </dl>
          </div>

          <div className="card overflow-hidden">
            <div className="px-6 py-4 border-b border-stone-200 font-medium">Banking</div>
            <table className="table-base">
              <thead><tr><th>Type</th><th>Bank</th><th>Inst/Transit/Acc·last 4</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {vendor.bankingProfiles.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-stone-500">No banking on file.</td></tr>}
                {vendor.bankingProfiles.map((b) => (
                  <tr key={b.id}>
                    <td>{b.type}{b.isActive && " · active"}</td>
                    <td>{b.bankName}</td>
                    <td className="font-mono text-xs">{[b.institutionNumber, b.transitNumber, b.accountLastFour ? `••••${b.accountLastFour}` : null].filter(Boolean).join(" · ")}</td>
                    <td><Badge status={b.status} /></td>
                    <td className="space-x-2 text-right">
                      {canBankEdit && b.status === "DRAFT" && (
                        <form action={submitBankingAction.bind(null, vendor.id, b.id)} className="inline">
                          <button className="text-xs text-club-green-700 hover:underline">Submit for approval</button>
                        </form>
                      )}
                      {canBankApprove && b.status === "PENDING_APPROVAL" && (
                        <form action={verifyBankingAction.bind(null, vendor.id, b.id)} className="inline">
                          <button className="text-xs text-club-green-700 hover:underline">Verify &amp; activate</button>
                        </form>
                      )}
                      {canBankApprove && (b.status === "PENDING_APPROVAL" || b.status === "DRAFT") && (
                        <form action={rejectBankingAction.bind(null, vendor.id, b.id)} className="inline">
                          <input className="input mr-1 inline-block w-32" name="reason" placeholder="Reason" />
                          <button className="text-xs text-red-600 hover:underline">Reject</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {canBankEdit && (
              <form action={addBankingAction.bind(null, vendor.id)} className="px-6 py-4 border-t border-stone-200 grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                <div className="md:col-span-2">
                  <label className="label">Type</label>
                  <select className="select" name="type" defaultValue="EFT"><option>EFT</option><option>WIRE</option><option>CHEQUE</option></select>
                </div>
                <div className="md:col-span-3"><label className="label">Bank</label><input className="input" name="bankName" required /></div>
                <div className="md:col-span-2"><label className="label">Institution #</label><input className="input font-mono" name="institutionNumber" maxLength={4} placeholder="001" /></div>
                <div className="md:col-span-2"><label className="label">Transit #</label><input className="input font-mono" name="transitNumber" maxLength={6} placeholder="00010" /></div>
                <div className="md:col-span-2"><label className="label">Account last 4</label><input className="input font-mono" name="accountLastFour" maxLength={4} placeholder="1234" /></div>
                <div className="md:col-span-1 flex"><button className="btn btn-secondary text-sm">Add</button></div>
                <div className="md:col-span-12 text-xs text-stone-500">Banking is tokenized — full account numbers are never stored.</div>
              </form>
            )}
            <div className="px-6 py-3 border-t border-stone-200 text-xs text-stone-500">
              Penny tests: a confirmed test is required before a banking profile can be VERIFIED.
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="px-6 py-4 border-b border-stone-200 font-medium">Penny tests</div>
            <table className="table-base">
              <thead><tr><th>Profile</th><th>Sent</th><th>Amount</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {vendor.bankingProfiles.flatMap((b) => b.pennyTests ?? []).length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-stone-500">None.</td></tr>
                )}
                {vendor.bankingProfiles.map((b) => (b.pennyTests ?? []).map((pt) => (
                  <tr key={pt.id}>
                    <td className="font-mono text-xs">{b.bankName}</td>
                    <td>{formatDate(pt.sentAt)}</td>
                    <td className="font-mono">${pt.amount.toString()}</td>
                    <td><Badge status={pt.status} /></td>
                    <td className="text-right">
                      {canBankApprove && pt.status === "SENT" && (
                        <form action={confirmPennyAction.bind(null, vendor.id, pt.id)} className="inline">
                          <input className="input inline-block w-20 font-mono" name="confirmedAmount" type="number" step="0.01" min="0" />
                          <button className="text-xs text-club-green-700 hover:underline ml-1">Confirm</button>
                        </form>
                      )}
                    </td>
                  </tr>
                )))}
              </tbody>
            </table>
            {canBankEdit && vendor.bankingProfiles.length > 0 && (
              <form action={initiatePennyAction.bind(null, vendor.id, vendor.bankingProfiles[0].id)} className="px-6 py-3 border-t border-stone-200 text-sm flex items-end gap-2">
                <div><label className="label">Initiate penny test (most recent banking profile)</label><input className="input w-24 font-mono" name="amount" type="number" step="0.01" min="0.01" max="1" defaultValue="0.01" /></div>
                <button className="btn btn-secondary text-sm">Send</button>
              </form>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="card card-body">
            <h3 className="font-medium">Approval</h3>
            {approvalReq ? (
              <div className="mt-2 text-sm">
                <div><Badge status={approvalReq.status} /> · {approvalReq.decisions.length}/{approvalReq.requiredApprovals} approvals</div>
                <div className="text-xs text-stone-500 mt-1">Eligible: {approvalReq.eligibleRoleKeys}</div>
              </div>
            ) : (
              <p className="mt-2 text-sm text-stone-500">No approval request yet.</p>
            )}
          </div>
          {canEdit && vendor.status === "DRAFT" && (
            <form action={submitAction.bind(null, vendor.id)} className="card card-body">
              <h3 className="font-medium">Submit for approval</h3>
              <button className="btn btn-primary mt-3 w-full">Submit</button>
            </form>
          )}
          {canApprove && (vendor.status === "PENDING_APPROVAL" || vendor.status === "DRAFT") && (
            <form action={activateAction.bind(null, vendor.id)} className="card card-body">
              <h3 className="font-medium">Activate</h3>
              <p className="mt-1 text-sm text-stone-500">Requires the approval request to be APPROVED.</p>
              <button className="btn btn-primary mt-3 w-full">Activate</button>
            </form>
          )}
          {canApprove && vendor.status === "ACTIVE" && (
            <form action={blockAction.bind(null, vendor.id)} className="card card-body">
              <h3 className="font-medium">Block</h3>
              <textarea className="textarea mt-2" name="reason" rows={2} placeholder="Reason" required />
              <button className="btn btn-danger mt-3 w-full">Block vendor</button>
            </form>
          )}
          {canEdit && vendor.status === "ACTIVE" && (
            <form action={deactivateAction.bind(null, vendor.id)} className="card card-body">
              <h3 className="font-medium">Deactivate</h3>
              <button className="btn btn-secondary mt-3 w-full">Deactivate</button>
            </form>
          )}
        </div>
      </div>

      <div className="mt-8 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Recent invoices</div>
        <table className="table-base">
          <thead><tr><th>#</th><th>Date</th><th>Reference</th><th>Status</th><th className="text-right">Total</th></tr></thead>
          <tbody>
            {vendor.invoices.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-stone-500">No invoices yet.</td></tr>}
            {vendor.invoices.map((inv) => (
              <tr key={inv.id}>
                <td className="font-mono text-xs"><Link href={`/app/admin/ap/invoices/${inv.id}`} className="hover:text-club-green-700">{inv.invoiceNumber}</Link></td>
                <td>{formatDate(inv.invoiceDate)}</td>
                <td className="font-mono text-xs">{inv.vendorReference ?? "—"}</td>
                <td><Badge status={inv.status} /></td>
                <td className="text-right tabular-nums">{fmtMoney(inv.total as unknown as number)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-xs uppercase tracking-wide text-stone-500">{label}</dt><dd className="mt-0.5 text-club-ink">{children}</dd></div>;
}
