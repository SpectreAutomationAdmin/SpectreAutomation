import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveMember } from "@/lib/active-member";
import { addPaymentMethod, setPrimary, setBackup, removePaymentMethod } from "@/lib/services/payment-methods";
import { isAppError } from "@/lib/errors";
import { Badge } from "@/components/Badge";

// IMPORTANT: For MVP we only store placeholder metadata. Never collect real
// PAN or banking numbers in this form. FUTURE: tokenize via Stripe / a CC vault.

async function addAction(memberId: string, formData: FormData) {
  "use server";
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  try {
    await addPaymentMethod(principal, memberId, {
      type: String(formData.get("type") ?? "CREDIT_CARD"),
      nickname: String(formData.get("nickname") ?? "").trim() || null,
      lastFour: String(formData.get("lastFour") ?? "").trim().slice(0, 4) || null,
      isPrimary: formData.get("isPrimary") === "on",
      isBackup: formData.get("isBackup") === "on",
    });
    revalidatePath("/app/member/payment-methods");
  } catch (err) {
    if (isAppError(err)) redirect(`/app/member/payment-methods?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
}

async function setPrimaryAction(memberId: string, methodId: string) {
  "use server";
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  try {
    await setPrimary(principal, memberId, methodId);
    revalidatePath("/app/member/payment-methods");
  } catch (err) {
    if (isAppError(err)) redirect(`/app/member/payment-methods?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
}

async function setBackupAction(memberId: string, methodId: string) {
  "use server";
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  try {
    await setBackup(principal, memberId, methodId);
    revalidatePath("/app/member/payment-methods");
  } catch (err) {
    if (isAppError(err)) redirect(`/app/member/payment-methods?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
}

async function removeAction(memberId: string, methodId: string) {
  "use server";
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  try {
    await removePaymentMethod(principal, memberId, methodId);
    revalidatePath("/app/member/payment-methods");
  } catch (err) {
    if (isAppError(err)) redirect(`/app/member/payment-methods?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
}

export default async function PaymentMethodsPage({ searchParams }: { searchParams: { welcomeMember?: string; error?: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const member = await getActiveMember(user, searchParams.welcomeMember);
  if (!member) redirect(user.role === "MEMBER" ? "/login" : "/app/admin");

  const methods = await prisma.paymentMethod.findMany({
    where: { memberId: member.id, status: { not: "REMOVED" } },
    orderBy: [{ isPrimary: "desc" }, { isBackup: "desc" }, { createdAt: "asc" }],
  });

  const add = addAction.bind(null, member.id);

  return (
    <div className="max-w-4xl">
      <h1 className="page-title">Payment Methods</h1>
      <p className="mt-1 text-stone-500">Manage your primary and backup payment methods.</p>

      <div className="mt-3 rounded-md border border-stone-200 bg-white px-4 py-3 text-xs text-stone-500">
        For this demo, only the metadata below (type, last four, nickname) is stored. In production, real card and bank details
        are tokenized by a PCI-compliant payments provider.
      </div>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 card overflow-hidden">
        <table className="table-base">
          <thead><tr><th>Type</th><th>Nickname</th><th>Last four</th><th>Roles</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {methods.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-stone-500">No payment methods yet.</td></tr>
            )}
            {methods.map((m) => (
              <tr key={m.id}>
                <td>{m.type === "CREDIT_CARD" ? "Credit Card" : "EFT"}</td>
                <td>{m.nickname ?? "—"}</td>
                <td className="font-mono">•••• {m.lastFour ?? "----"}</td>
                <td className="space-x-1">
                  {m.isPrimary && <span className="badge bg-club-green-50 text-club-green-700 ring-club-green-200">Primary</span>}
                  {m.isBackup && <span className="badge bg-blue-50 text-blue-700 ring-blue-200">Backup</span>}
                  {!m.isPrimary && !m.isBackup && <span className="text-xs text-stone-500">—</span>}
                </td>
                <td><Badge status={m.status} /></td>
                <td className="space-x-2 text-right">
                  {!m.isPrimary && (
                    <form action={setPrimaryAction.bind(null, member.id, m.id)} className="inline">
                      <button className="text-xs text-club-green-700 hover:underline">Set primary</button>
                    </form>
                  )}
                  {!m.isBackup && (
                    <form action={setBackupAction.bind(null, member.id, m.id)} className="inline">
                      <button className="text-xs text-club-green-700 hover:underline">Set backup</button>
                    </form>
                  )}
                  <form action={removeAction.bind(null, member.id, m.id)} className="inline">
                    <button className="text-xs text-red-600 hover:underline">Remove</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-8 card card-body">
        <h2 className="section-title text-lg">Add a payment method</h2>
        <form action={add} className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label">Type</label>
            <select className="select" name="type" defaultValue="CREDIT_CARD">
              <option value="CREDIT_CARD">Credit Card</option>
              <option value="EFT">EFT</option>
            </select>
          </div>
          <div>
            <label className="label">Nickname</label>
            <input className="input" name="nickname" placeholder="Personal Visa" maxLength={60} />
          </div>
          <div>
            <label className="label">Last four (placeholder)</label>
            <input className="input font-mono" name="lastFour" maxLength={4} placeholder="0000" pattern="\d{0,4}" />
          </div>
          <div className="flex items-end gap-4">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isPrimary" /> Primary</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isBackup" /> Backup</label>
          </div>
          <div className="md:col-span-2 flex justify-end">
            <button className="btn btn-primary" type="submit">Add payment method</button>
          </div>
        </form>
      </div>
    </div>
  );
}
