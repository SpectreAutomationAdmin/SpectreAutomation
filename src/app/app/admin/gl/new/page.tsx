"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type AccountOption = { number: string; name: string; type: string; allowManualPosting: boolean; isHeader: boolean };
type DeptOption = { code: string; name: string };

export default function NewJournalPage() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [departments, setDepartments] = useState<DeptOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  const [entryDate, setEntryDate] = useState(today);
  const [description, setDescription] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState([
    { accountNumber: "", departmentCode: "", debit: "", credit: "", description: "" },
    { accountNumber: "", departmentCode: "", debit: "", credit: "", description: "" },
  ]);

  // Load options once. Server action would also work; client fetch keeps the
  // page snappy when the controller is iterating.
  if (accounts.length === 0) {
    fetch("/api/admin/coa/options")
      .then((r) => r.json())
      .then((d) => { setAccounts(d.accounts); setDepartments(d.departments); })
      .catch(() => {});
  }

  const setLine = (i: number, patch: Partial<typeof lines[number]>) =>
    setLines((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const addLine = () => setLines((rows) => [...rows, { accountNumber: "", departmentCode: "", debit: "", credit: "", description: "" }]);
  const removeLine = (i: number) => setLines((rows) => rows.length <= 2 ? rows : rows.filter((_, j) => j !== i));

  const totalDr = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCr = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const diff = Math.round((totalDr - totalCr) * 100) / 100;

  const submit = (action: "draft" | "post") => {
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/admin/journal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entryDate, description, memo, action, lines }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not save journal entry");
        return;
      }
      router.push(`/app/admin/gl/${data.id}`);
    });
  };

  return (
    <div>
      <Link href="/app/admin/gl" className="text-sm text-stone-500 hover:text-club-ink">← General Ledger</Link>
      <h1 className="page-title mt-3">New journal entry</h1>
      <p className="mt-1 text-stone-500">Manual debit/credit entry. Debits must equal credits.</p>

      {error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      <div className="mt-6 card card-body space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="label">Entry date *</label>
            <input className="input" type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <label className="label">Description *</label>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </div>
        </div>
        <div>
          <label className="label">Memo</label>
          <textarea className="textarea" rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={4000} />
        </div>
      </div>

      <div className="mt-6 card overflow-hidden">
        <table className="table-base">
          <thead>
            <tr>
              <th className="w-10">#</th>
              <th>Account</th>
              <th>Dept</th>
              <th>Description</th>
              <th className="text-right">Debit</th>
              <th className="text-right">Credit</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="text-stone-500">{i + 1}</td>
                <td>
                  <select className="select" value={l.accountNumber} onChange={(e) => setLine(i, { accountNumber: e.target.value })}>
                    <option value="">— Account —</option>
                    {accounts.filter((a) => !a.isHeader && a.allowManualPosting).map((a) => (
                      <option key={a.number} value={a.number}>{a.number} · {a.name}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <select className="select" value={l.departmentCode} onChange={(e) => setLine(i, { departmentCode: e.target.value })}>
                    <option value="">—</option>
                    {departments.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
                  </select>
                </td>
                <td>
                  <input className="input" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} maxLength={500} />
                </td>
                <td>
                  <input className="input text-right tabular-nums font-mono" type="number" step="0.01" min="0" value={l.debit}
                         onChange={(e) => setLine(i, { debit: e.target.value, credit: "" })} />
                </td>
                <td>
                  <input className="input text-right tabular-nums font-mono" type="number" step="0.01" min="0" value={l.credit}
                         onChange={(e) => setLine(i, { credit: e.target.value, debit: "" })} />
                </td>
                <td>
                  {lines.length > 2 && (
                    <button type="button" onClick={() => removeLine(i)} className="text-xs text-red-600 hover:underline">Remove</button>
                  )}
                </td>
              </tr>
            ))}
            <tr className="font-medium bg-stone-50">
              <td colSpan={4} className="text-right">Totals</td>
              <td className="text-right tabular-nums font-mono">${totalDr.toFixed(2)}</td>
              <td className="text-right tabular-nums font-mono">${totalCr.toFixed(2)}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
        <div className="px-6 py-3 border-t border-stone-200 flex items-center justify-between">
          <button type="button" onClick={addLine} className="text-sm text-club-green-700 hover:underline">+ Add line</button>
          <div className={"text-sm font-medium " + (diff === 0 ? "text-club-green-700" : "text-amber-700")}>
            {diff === 0 ? "Balanced" : `Out of balance: ${diff > 0 ? "+" : ""}${diff.toFixed(2)}`}
          </div>
        </div>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <button disabled={pending} onClick={() => submit("draft")} className="btn btn-secondary">Save draft</button>
        <button disabled={pending || diff !== 0 || !description.trim()} onClick={() => submit("post")} className="btn btn-primary">Save &amp; post</button>
      </div>
    </div>
  );
}
