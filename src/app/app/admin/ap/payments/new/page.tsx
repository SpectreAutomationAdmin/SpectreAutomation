import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { createBatch } from "@/lib/ap/payment-batches";
import { isAppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

async function createAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    const b = await createBatch(p, clubId, {
      description: String(formData.get("description") ?? ""),
      paymentDate: String(formData.get("paymentDate") ?? new Date().toISOString().slice(0, 10)),
      bankAccountNumber: String(formData.get("bankAccountNumber") ?? "1010"),
      paymentMethod: String(formData.get("paymentMethod") ?? "EFT"),
    });
    redirect(`/app/admin/ap/payments/${b.id}`);
  } catch (err) {
    if (isAppError(err)) redirect(`/app/admin/ap/payments/new?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
}

export default async function NewBatchPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "ap:payment:create")) redirect("/app/admin/ap/payments");

  const bankAccounts = await prisma.account.findMany({
    where: { clubId, isBankAccount: true, isActive: true },
    orderBy: { accountNumber: "asc" },
  });

  return (
    <div className="max-w-xl">
      <Link href="/app/admin/ap/payments" className="text-sm text-stone-500 hover:text-club-ink">← Payment batches</Link>
      <h1 className="page-title mt-3">New payment batch</h1>
      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <form action={createAction} className="mt-6 card card-body space-y-4">
        <div>
          <label className="label">Description *</label>
          <input className="input" name="description" required maxLength={200} placeholder="Weekly EFT run" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="label">Payment date</label>
            <input className="input" type="date" name="paymentDate" defaultValue={new Date().toISOString().slice(0, 10)} />
          </div>
          <div>
            <label className="label">Method</label>
            <select className="select" name="paymentMethod" defaultValue="EFT">
              <option value="EFT">EFT</option>
              <option value="CHEQUE">Cheque</option>
            </select>
          </div>
          <div>
            <label className="label">Bank account</label>
            <select className="select" name="bankAccountNumber" defaultValue="1010">
              {bankAccounts.map((a) => <option key={a.id} value={a.accountNumber}>{a.accountNumber} · {a.name}</option>)}
            </select>
          </div>
        </div>
        <div className="flex justify-end">
          <button className="btn btn-primary">Create batch</button>
        </div>
      </form>
    </div>
  );
}
