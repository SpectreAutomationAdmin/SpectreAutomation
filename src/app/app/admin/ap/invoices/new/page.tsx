"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

type Option = { value: string; label: string };

export default function NewInvoicePage() {
  const router = useRouter();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [vendors, setVendors] = useState<Option[]>([]);
  const [expenseAccounts, setExpenseAccounts] = useState<Option[]>([]);
  const [departments, setDepartments] = useState<Option[]>([]);
  const [taxCodes, setTaxCodes] = useState<Array<{ value: string; label: string; rate: number }>>([]);
  const [error, setError] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const [vendorId, setVendorId] = useState("");
  const [vendorReference, setVendorReference] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(today);
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState([
    { expenseAccountNumber: "", departmentCode: "", description: "", amount: "", taxCodeKey: "GST_5", taxAmount: "" },
  ]);

  useEffect(() => {
    (async () => {
      const r = await fetch("/api/admin/ap/options");
      const d = await r.json();
      setVendors(d.vendors);
      setExpenseAccounts(d.accounts);
      setDepartments(d.departments);
      setTaxCodes(d.taxCodes);
      // If query param ?capture=<id>, pre-fill from extraction.
      const captureId = sp.get("capture");
      if (captureId) {
        const cap = await fetch(`/api/admin/ap/captures/${captureId}`).then((r) => r.json()).catch(() => null);
        if (cap?.extraction) {
          // Match vendor by name.
          const v = d.vendors.find((vv: Option) => vv.label.toLowerCase().includes((cap.extraction.vendorName ?? "").toLowerCase()));
          if (v) setVendorId(v.value);
          if (cap.extraction.invoiceNumber) setVendorReference(cap.extraction.invoiceNumber);
          if (cap.extraction.invoiceDate) setInvoiceDate(cap.extraction.invoiceDate);
          if (cap.suggestion?.expenseAccountNumber) {
            const subtotal = String(cap.extraction.subtotal ?? "");
            const taxAmount = String(cap.extraction.taxAmount ?? "");
            setLines([{
              expenseAccountNumber: cap.suggestion.expenseAccountNumber ?? "",
              departmentCode: cap.suggestion.departmentCode ?? "",
              description: cap.extraction.vendorName ?? "",
              amount: subtotal,
              taxCodeKey: cap.suggestion.taxCodeKey ?? "GST_5",
              taxAmount,
            }]);
          }
          if (cap.extraction.vendorName) setDescription(`Capture: ${cap.extraction.vendorName}`);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLine = (i: number, patch: Partial<typeof lines[number]>) =>
    setLines((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addLine = () =>
    setLines((rows) => [...rows, { expenseAccountNumber: "", departmentCode: "", description: "", amount: "", taxCodeKey: "GST_5", taxAmount: "" }]);
  const removeLine = (i: number) => setLines((rows) => rows.length <= 1 ? rows : rows.filter((_, j) => j !== i));

  // Auto-calc tax when rate is known.
  const taxByKey = Object.fromEntries(taxCodes.map((t) => [t.value, t.rate]));
  const computedLines = lines.map((l) => {
    const amt = Number(l.amount) || 0;
    const rate = taxByKey[l.taxCodeKey] ?? 0;
    const tax = l.taxAmount === "" ? Math.round(amt * (rate / 100) * 100) / 100 : Number(l.taxAmount) || 0;
    return { ...l, computedTax: tax };
  });
  const subtotal = computedLines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const taxTotal = computedLines.reduce((s, l) => s + (l.computedTax || 0), 0);
  const total = Math.round((subtotal + taxTotal) * 100) / 100;

  const submit = (action: "draft" | "submit") => {
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/admin/ap/invoices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          vendorId, vendorReference: vendorReference || null,
          invoiceDate, description,
          captureId: sp.get("capture") || null,
          lines: computedLines.map((l) => ({
            expenseAccountNumber: l.expenseAccountNumber,
            departmentCode: l.departmentCode || null,
            description: l.description || null,
            amount: Number(l.amount) || 0,
            taxCodeKey: l.taxCodeKey || null,
            taxAmount: l.computedTax,
          })),
          action,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Could not save invoice"); return; }
      router.push(`/app/admin/ap/invoices/${data.id}`);
    });
  };

  return (
    <div>
      <Link href="/app/admin/ap/invoices" className="text-sm text-stone-500 hover:text-club-ink">← AP Invoices</Link>
      <h1 className="page-title mt-3">New AP invoice</h1>

      {error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      <div className="mt-6 card card-body space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="label">Vendor *</label>
            <select className="select" value={vendorId} onChange={(e) => setVendorId(e.target.value)} required>
              <option value="">— Select —</option>
              {vendors.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Vendor reference (invoice #)</label>
            <input className="input font-mono" value={vendorReference} onChange={(e) => setVendorReference(e.target.value)} maxLength={80} />
          </div>
          <div>
            <label className="label">Invoice date *</label>
            <input className="input" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} required />
          </div>
        </div>
        <div>
          <label className="label">Description</label>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </div>
      </div>

      <div className="mt-6 card overflow-hidden">
        <table className="table-base">
          <thead>
            <tr><th className="w-8">#</th><th>Account</th><th>Dept</th><th>Description</th><th className="text-right">Amount</th><th>Tax</th><th className="text-right">Tax amount</th><th></th></tr>
          </thead>
          <tbody>
            {computedLines.map((l, i) => (
              <tr key={i}>
                <td className="text-stone-500">{i + 1}</td>
                <td>
                  <select className="select" value={l.expenseAccountNumber} onChange={(e) => setLine(i, { expenseAccountNumber: e.target.value })}>
                    <option value="">— Account —</option>
                    {expenseAccounts.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                  </select>
                </td>
                <td>
                  <select className="select" value={l.departmentCode} onChange={(e) => setLine(i, { departmentCode: e.target.value })}>
                    <option value="">—</option>
                    {departments.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                  </select>
                </td>
                <td>
                  <input className="input" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} maxLength={500} />
                </td>
                <td><input className="input text-right tabular-nums font-mono" type="number" step="0.01" min="0" value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value, taxAmount: "" })} /></td>
                <td>
                  <select className="select" value={l.taxCodeKey} onChange={(e) => setLine(i, { taxCodeKey: e.target.value, taxAmount: "" })}>
                    {taxCodes.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </td>
                <td><input className="input text-right tabular-nums font-mono" type="number" step="0.01" min="0" value={l.taxAmount} placeholder={String(l.computedTax)} onChange={(e) => setLine(i, { taxAmount: e.target.value })} /></td>
                <td>{lines.length > 1 && <button onClick={() => removeLine(i)} className="text-xs text-red-600 hover:underline">Remove</button>}</td>
              </tr>
            ))}
            <tr className="font-medium bg-stone-50">
              <td colSpan={4} className="text-right">Totals</td>
              <td className="text-right tabular-nums font-mono">${subtotal.toFixed(2)}</td>
              <td></td>
              <td className="text-right tabular-nums font-mono">${taxTotal.toFixed(2)}</td>
              <td></td>
            </tr>
            <tr className="font-semibold bg-stone-100">
              <td colSpan={6} className="text-right">Invoice total</td>
              <td className="text-right tabular-nums font-mono">${total.toFixed(2)}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
        <div className="px-6 py-3 border-t border-stone-200">
          <button type="button" onClick={addLine} className="text-sm text-club-green-700 hover:underline">+ Add line</button>
        </div>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <button disabled={pending} onClick={() => submit("draft")} className="btn btn-secondary">Save draft</button>
        <button disabled={pending || !vendorId || total <= 0} onClick={() => submit("submit")} className="btn btn-primary">Save &amp; submit for approval</button>
      </div>
    </div>
  );
}
