import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { createVendor } from "@/lib/ap/vendors";
import { isAppError } from "@/lib/errors";

async function createAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    const vendor = await createVendor(p, clubId, {
      legalName: String(formData.get("legalName") ?? ""),
      operatingName: String(formData.get("operatingName") ?? ""),
      taxRegistrationNumber: String(formData.get("taxRegistrationNumber") ?? ""),
      taxRegion: String(formData.get("taxRegion") ?? ""),
      paymentTermsDays: Number(formData.get("paymentTermsDays") ?? 30),
      paymentMethod: String(formData.get("paymentMethod") ?? "CHEQUE"),
      email: String(formData.get("email") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      website: String(formData.get("website") ?? ""),
      address1: String(formData.get("address1") ?? ""),
      city: String(formData.get("city") ?? ""),
      provinceState: String(formData.get("provinceState") ?? ""),
      postalCode: String(formData.get("postalCode") ?? ""),
      country: String(formData.get("country") ?? "Canada"),
      notes: String(formData.get("notes") ?? ""),
      defaultExpenseAccountNumber: String(formData.get("defaultExpenseAccountNumber") ?? ""),
      defaultDepartmentCode: String(formData.get("defaultDepartmentCode") ?? ""),
      defaultTaxCodeKey: String(formData.get("defaultTaxCodeKey") ?? ""),
    });
    redirect(`/app/admin/ap/vendors/${vendor.id}`);
  } catch (err) {
    if (isAppError(err)) redirect(`/app/admin/ap/vendors/new?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
}

export default async function NewVendorPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "vendor:create")) redirect("/app/admin/ap/vendors");

  const [expenseAccounts, departments, taxCodes] = await Promise.all([
    prisma.account.findMany({ where: { clubId, type: "EXPENSE", isHeader: false, isActive: true }, orderBy: { accountNumber: "asc" } }),
    prisma.department.findMany({ where: { clubId, isActive: true }, orderBy: { sortOrder: "asc" } }),
    prisma.taxCode.findMany({ where: { clubId, isActive: true }, orderBy: { key: "asc" } }),
  ]);

  return (
    <div className="max-w-3xl">
      <Link href="/app/admin/ap/vendors" className="text-sm text-stone-500 hover:text-club-ink">← Vendors</Link>
      <h1 className="page-title mt-3">New vendor</h1>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <form action={createAction} className="mt-6 card card-body space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div><label className="label">Legal name *</label><input className="input" name="legalName" required maxLength={200} /></div>
          <div><label className="label">Operating name</label><input className="input" name="operatingName" maxLength={200} /></div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="label">Default expense account</label>
            <select className="select" name="defaultExpenseAccountNumber" defaultValue="">
              <option value="">— None —</option>
              {expenseAccounts.map((a) => <option key={a.id} value={a.accountNumber}>{a.accountNumber} · {a.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Default department</label>
            <select className="select" name="defaultDepartmentCode" defaultValue="">
              <option value="">— None —</option>
              {departments.map((d) => <option key={d.id} value={d.code}>{d.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Default tax code</label>
            <select className="select" name="defaultTaxCodeKey" defaultValue="">
              <option value="">— None —</option>
              {taxCodes.map((t) => <option key={t.id} value={t.key}>{t.key} · {t.name}</option>)}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="label">Payment terms (days)</label>
            <input className="input" name="paymentTermsDays" type="number" defaultValue={30} min={0} max={365} />
          </div>
          <div>
            <label className="label">Default payment method</label>
            <select className="select" name="paymentMethod" defaultValue="CHEQUE">
              <option value="CHEQUE">Cheque</option>
              <option value="EFT">EFT</option>
              <option value="CC">Credit card</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
          <div>
            <label className="label">Tax region</label>
            <input className="input" name="taxRegion" maxLength={20} placeholder="AB" />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div><label className="label">Email</label><input className="input" type="email" name="email" /></div>
          <div><label className="label">Phone</label><input className="input" name="phone" /></div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div><label className="label">Tax registration number</label><input className="input" name="taxRegistrationNumber" /></div>
          <div><label className="label">Website</label><input className="input" name="website" /></div>
        </div>
        <div><label className="label">Address</label><input className="input" name="address1" /></div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div><label className="label">City</label><input className="input" name="city" /></div>
          <div><label className="label">Province/State</label><input className="input" name="provinceState" /></div>
          <div><label className="label">Postal</label><input className="input" name="postalCode" /></div>
          <div><label className="label">Country</label><input className="input" name="country" defaultValue="Canada" /></div>
        </div>
        <div><label className="label">Notes</label><textarea className="textarea" name="notes" rows={2} maxLength={2000} /></div>
        <div className="flex justify-end"><button className="btn btn-primary">Create vendor</button></div>
      </form>
    </div>
  );
}
