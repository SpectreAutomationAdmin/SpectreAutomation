import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getActiveMember } from "@/lib/active-member";
import { getDiningReceipt } from "@/lib/pos/lounge";
import { formatCurrency, formatDateTime } from "@/lib/finance";

// Itemized receipt for a single dining charge. `getDiningReceipt`
// returns null for any sale not owned by the calling member OR not in
// COMPLETED status, which is also what `notFound()` should render —
// members shouldn't see other members' receipts or sales that haven't
// finalised, and we want the URL probing surface to read the same as a
// genuinely missing row.
export default async function MemberDiningReceiptPage({ params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const member = await getActiveMember(user);
  if (!member) redirect(user.role === "MEMBER" ? "/login" : "/app/admin");

  const sale = await getDiningReceipt(params.id, member.id);
  if (!sale) notFound();

  const subtotal = Number(sale.subtotal.toString());
  const taxTotal = Number(sale.taxTotal.toString());
  const grandTotal = Number(sale.grandTotal.toString());
  const paid = sale.payments.reduce((s, p) => s + Number(p.amount.toString()), 0);

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between">
        <Link href="/app/member/dining" className="text-sm text-club-green-700 hover:underline">← All dining</Link>
        <div className="text-xs text-stone-500 font-mono">{sale.saleNumber}</div>
      </div>

      <div className="mt-4 card card-body">
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-stone-500">{sale.location.name}</div>
            <h1 className="mt-1 font-serif text-2xl text-club-ink">Receipt</h1>
            <div className="mt-1 text-sm text-stone-500">{formatDateTime(sale.saleDate)}</div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wide text-stone-500">Total</div>
            <div className="mt-1 font-serif text-3xl text-club-ink tabular-nums">{formatCurrency(grandTotal)}</div>
          </div>
        </div>

        <div className="mt-6 border-t border-stone-100 pt-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-stone-500 text-left">
                <th className="pb-2">Item</th>
                <th className="pb-2 text-right">Qty</th>
                <th className="pb-2 text-right">Each</th>
                <th className="pb-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {sale.lines.map((l) => {
                const qty = Number(l.quantity.toString());
                const unit = Number(l.unitPrice.toString());
                const lineTotal = Number(l.lineTotal.toString());
                // Snapshot of the modifiers as they were at settlement.
                // Allergy + free-text notes are surfaced separately
                // from the structured Remove/Add/Substitute list so the
                // receipt reads naturally.
                const mods = l.modifiers ?? [];
                const structured = mods.filter(
                  (m) => m.modifierType !== "ALLERGY" && m.modifierType !== "NOTE"
                );
                const allergyMods = mods.filter((m) => m.modifierType === "ALLERGY");
                const noteMod = mods.find((m) => m.modifierType === "NOTE");
                return (
                  <tr key={l.id} className="border-t border-stone-100 align-top">
                    <td className="py-2">
                      <div>{l.description}</div>
                      {structured.length > 0 && (
                        <ul className="mt-1 pl-3 space-y-0.5 text-xs text-stone-500">
                          {structured.map((m) => (
                            <li key={m.id}>· {m.label}</li>
                          ))}
                        </ul>
                      )}
                      {allergyMods.length > 0 && (
                        <div className="mt-1 text-xs text-red-700">
                          <span className="uppercase tracking-wide font-medium">Allergy:</span>{" "}
                          {allergyMods.map((m) => m.label).join(", ")}
                        </div>
                      )}
                      {noteMod && (
                        <div className="mt-1 text-xs text-stone-500 italic">&ldquo;{noteMod.label}&rdquo;</div>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums">{qty}</td>
                    <td className="py-2 text-right tabular-nums">{formatCurrency(unit)}</td>
                    <td className="py-2 text-right tabular-nums">{formatCurrency(lineTotal)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-4 border-t border-stone-100 pt-3 space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-stone-500">Subtotal</span>
            <span className="tabular-nums">{formatCurrency(subtotal)}</span>
          </div>
          {sale.taxLines.map((t) => (
            <div key={t.id} className="flex justify-between">
              <span className="text-stone-500">{t.label}</span>
              <span className="tabular-nums">{formatCurrency(Number(t.amount.toString()))}</span>
            </div>
          ))}
          {sale.taxLines.length === 0 && taxTotal > 0 && (
            <div className="flex justify-between">
              <span className="text-stone-500">Tax</span>
              <span className="tabular-nums">{formatCurrency(taxTotal)}</span>
            </div>
          )}
          <div className="flex justify-between font-medium pt-1 border-t border-stone-200 mt-1">
            <span>Total</span>
            <span className="tabular-nums">{formatCurrency(grandTotal)}</span>
          </div>
        </div>

        <div className="mt-4 border-t border-stone-100 pt-3 text-sm">
          <div className="flex justify-between">
            <span className="text-stone-500">Payment</span>
            <span>Charged to member account</span>
          </div>
          <div className="flex justify-between text-xs text-stone-500 mt-1">
            <span>Posted</span>
            <span className="tabular-nums">{formatCurrency(paid)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
