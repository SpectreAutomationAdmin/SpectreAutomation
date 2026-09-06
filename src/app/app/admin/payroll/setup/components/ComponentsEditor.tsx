"use client";

// Payroll-3C-6A (2026-09-05) — client-side Payroll Components editor.
//
// Renders the tenant's payroll component catalogue in a compact table
// with an "Edit GL mapping" dialog per row. Each row shows current
// mapping state (Configured / Missing expense / Missing liability)
// so the payroll admin can see readiness gaps before hitting POST.
//
// Requirements matrix mapping (3C-6A brief):
//   §3   — component-type-driven conditional fields (expense / liability)
//   §4   — tenant-scoped account picker; no cross-tenant leakage
//   §5   — PATCH via /api/clubs/[id]/payroll/components/[componentId]/gl-mapping
//   §7   — visible "Changes apply to future payrolls only" affordance
//   §8   — per-component readiness state visible without post attempt
//
// Client-side validation is best-effort UX; server-side is authoritative.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

interface Component {
  id: string;
  code: string;
  displayName: string;
  category: string;
  side: "EMPLOYEE" | "EMPLOYER";
  cashEffect: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT";
  displaySection: string;
  active: boolean;
  expenseAccountId:   string | null;
  liabilityAccountId: string | null;
  expenseAccountNumber:   string | null;
  liabilityAccountNumber: string | null;
}
interface Account {
  id: string;
  accountNumber: string;
  name: string;
  type: string;
}

// Per-brief §3 — required-field rules by (side, cashEffect).
function requiresExpense(c: Pick<Component, "side" | "cashEffect">): boolean {
  if (c.side === "EMPLOYER") return true;
  if (c.side === "EMPLOYEE" && c.cashEffect === "INCREASES_NET_PAY") return true;
  return false;
}
function requiresLiability(c: Pick<Component, "side" | "cashEffect">): boolean {
  if (c.side === "EMPLOYER" && c.cashEffect === "NO_NET_PAY_EFFECT") return true;
  if (c.side === "EMPLOYEE" && c.cashEffect === "DECREASES_NET_PAY") return true;
  return false;
}
function mappingStatus(c: Component): {
  code: "READY" | "MISSING_EXPENSE" | "MISSING_LIABILITY" | "MISSING_BOTH" | "NOT_REQUIRED";
  label: string;
} {
  const needExp = requiresExpense(c);
  const needLia = requiresLiability(c);
  const haveExp = c.expenseAccountId   != null;
  const haveLia = c.liabilityAccountId != null;
  if (!needExp && !needLia) return { code: "NOT_REQUIRED", label: "n/a" };
  if (needExp && !haveExp && needLia && !haveLia) return { code: "MISSING_BOTH", label: "Missing both" };
  if (needExp && !haveExp) return { code: "MISSING_EXPENSE",   label: "Missing expense" };
  if (needLia && !haveLia) return { code: "MISSING_LIABILITY", label: "Missing liability" };
  return { code: "READY", label: "Configured" };
}

// Filter picker options by expected type for a side.
function filterAccounts(
  all: Account[],
  side: "expense" | "liability",
): Account[] {
  const want = side === "expense" ? "EXPENSE" : "LIABILITY";
  return all.filter((a) => a.type === want);
}

export default function ComponentsEditor(props: {
  clubId: string;
  canWrite: boolean;
  initialComponents: Component[];
  accounts: Account[];
}) {
  const router = useRouter();
  const [components, setComponents] = useState(props.initialComponents);
  const [editing, setEditing] = useState<Component | null>(null);

  const readySummary = useMemo(() => {
    let ready = 0, notReady = 0;
    for (const c of components) {
      const s = mappingStatus(c);
      if (s.code === "READY" || s.code === "NOT_REQUIRED") ready += 1;
      else notReady += 1;
    }
    return { ready, notReady, total: components.length };
  }, [components]);

  const grouped = new Map<string, Component[]>();
  for (const c of components) {
    const list = grouped.get(c.displaySection) ?? [];
    list.push(c);
    grouped.set(c.displaySection, list);
  }
  const sectionOrder = ["EARNINGS", "BENEFITS", "DEDUCTIONS"];
  const sections = [
    ...sectionOrder.filter((s) => grouped.has(s)),
    ...Array.from(grouped.keys()).filter((s) => !sectionOrder.includes(s)),
  ];

  async function saveMapping(expenseAccountId: string | null, liabilityAccountId: string | null) {
    if (!editing) return;
    const res = await fetch(
      `/api/clubs/${props.clubId}/payroll/components/${editing.id}/gl-mapping`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expenseAccountId, liabilityAccountId }),
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(`Failed to save: ${body.error ?? res.statusText}`);
      return;
    }
    // Optimistic in-memory update so the row reflects the change
    // without a full page nav.
    setComponents((prev) => prev.map((c) => {
      if (c.id !== editing.id) return c;
      const nextExp = props.accounts.find((a) => a.id === expenseAccountId)   ?? null;
      const nextLia = props.accounts.find((a) => a.id === liabilityAccountId) ?? null;
      return {
        ...c,
        expenseAccountId,
        liabilityAccountId,
        expenseAccountNumber:   nextExp?.accountNumber ?? null,
        liabilityAccountNumber: nextLia?.accountNumber ?? null,
      };
    }));
    setEditing(null);
    // Also refresh so any server-side readiness banner recomputes.
    router.refresh();
  }

  return (
    <div>
      {/* Readiness summary — §8, §9 */}
      <div
        className="mb-4 rounded-lg border px-4 py-3 text-sm"
        style={{
          background: "var(--spectre-surface)",
          borderColor: "var(--spectre-border-muted)",
          color: "var(--spectre-text-primary)",
        }}
        data-testid="components-readiness-banner"
      >
        <span className="font-semibold">
          Payroll GL setup:{" "}
          <span data-testid="components-readiness-state">
            {readySummary.notReady === 0 ? "Ready" : "Action required"}
          </span>
        </span>
        <span className="ml-3 text-xs" style={{ color: "var(--spectre-text-secondary)" }}>
          {readySummary.ready} of {readySummary.total} components configured
          {readySummary.notReady > 0 ? ` — ${readySummary.notReady} still need mapping` : ""}
        </span>
      </div>

      {sections.map((section) => (
        <section key={section} className="mb-6" data-testid={`components-section:${section}`}>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide"
              style={{ color: "var(--spectre-text-muted)" }}>{section}</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b" style={{ borderColor: "var(--spectre-border-muted)" }}>
                  <Th>Code</Th>
                  <Th>Display name</Th>
                  <Th>Side</Th>
                  <Th>Cash effect</Th>
                  <Th>Expense a/c</Th>
                  <Th>Liability a/c</Th>
                  <Th>GL status</Th>
                  <Th>Active</Th>
                  <Th> </Th>
                </tr>
              </thead>
              <tbody>
                {(grouped.get(section) ?? []).map((c) => {
                  const st = mappingStatus(c);
                  return (
                    <tr key={c.id} className="border-b" style={{ borderColor: "var(--spectre-border-muted)" }}
                        data-testid={`component-row:${c.code}`}>
                      <Td mono>{c.code}</Td>
                      <Td>{c.displayName}</Td>
                      <Td>{c.side}</Td>
                      <Td>{shortCashEffect(c.cashEffect)}</Td>
                      <Td mono>{c.expenseAccountNumber   ?? "—"}</Td>
                      <Td mono>{c.liabilityAccountNumber ?? "—"}</Td>
                      <Td>
                        <span
                          className={
                            "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase " +
                            (st.code === "READY" || st.code === "NOT_REQUIRED"
                              ? "bg-emerald-50 text-emerald-800"
                              : "bg-amber-50 text-amber-800")
                          }
                          data-testid={`component-gl-status:${c.code}`}
                        >
                          {st.label}
                        </span>
                      </Td>
                      <Td>{c.active ? "active" : "inactive"}</Td>
                      <Td>
                        {props.canWrite ? (
                          <button
                            type="button"
                            className="text-xs underline"
                            style={{ color: "var(--spectre-text-secondary)" }}
                            onClick={() => setEditing(c)}
                            data-testid={`component-edit-gl:${c.code}`}
                          >
                            Edit GL
                          </button>
                        ) : (
                          <span className="text-xs" style={{ color: "var(--spectre-text-muted)" }}>read-only</span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {editing ? (
        <EditDialog
          component={editing}
          accounts={props.accounts}
          onCancel={() => setEditing(null)}
          onSave={saveMapping}
        />
      ) : null}
    </div>
  );
}

function EditDialog(props: {
  component: Component;
  accounts: Account[];
  onCancel: () => void;
  onSave: (expenseAccountId: string | null, liabilityAccountId: string | null) => Promise<void>;
}) {
  const { component, accounts } = props;
  const needExp = requiresExpense(component);
  const needLia = requiresLiability(component);
  const [expenseId,   setExpenseId]   = useState<string | null>(component.expenseAccountId);
  const [liabilityId, setLiabilityId] = useState<string | null>(component.liabilityAccountId);
  const [saving, setSaving] = useState(false);

  const expenseOptions   = filterAccounts(accounts, "expense");
  const liabilityOptions = filterAccounts(accounts, "liability");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog" aria-modal="true"
      data-testid="component-edit-dialog"
    >
      <div className="w-[520px] rounded-lg bg-white p-6 shadow-xl">
        <header className="mb-4">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-500">
            GL mapping · {component.code}
          </div>
          <h3 className="mt-1 text-lg font-semibold text-club-ink">{component.displayName}</h3>
          <p className="mt-1 text-xs text-stone-500">
            {component.side} · {shortCashEffect(component.cashEffect)}
          </p>
        </header>

        {needExp ? (
          <div className="mb-4">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-stone-600">
              Expense account
            </label>
            <select
              className="input w-full"
              value={expenseId ?? ""}
              onChange={(e) => setExpenseId(e.target.value || null)}
              data-testid="component-edit-expense-select"
            >
              <option value="">— None (posting will refuse) —</option>
              {expenseOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.accountNumber} — {a.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {needLia ? (
          <div className="mb-4">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-stone-600">
              Liability account
            </label>
            <select
              className="input w-full"
              value={liabilityId ?? ""}
              onChange={(e) => setLiabilityId(e.target.value || null)}
              data-testid="component-edit-liability-select"
            >
              <option value="">— None (posting will refuse) —</option>
              {liabilityOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.accountNumber} — {a.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {!needExp && !needLia ? (
          <p className="mb-4 rounded-md bg-stone-50 px-3 py-2 text-xs text-stone-600">
            This component does not require any GL mapping for its side + cash-effect combination.
            No change will be persisted.
          </p>
        ) : null}

        <p className="mb-4 text-[11px]" style={{ color: "var(--spectre-text-muted)" }}>
          Changes apply to <strong>future payrolls only</strong>. Existing prepared, calculated,
          approved, and posted batches retain their frozen accounting mappings.
        </p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={props.onCancel}
            disabled={saving}
            data-testid="component-edit-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try { await props.onSave(expenseId, liabilityId); }
              finally { setSaving(false); }
            }}
            data-testid="component-edit-save"
          >
            {saving ? "Saving…" : "Save mapping"}
          </button>
        </div>
      </div>
    </div>
  );
}

function shortCashEffect(v: string): string {
  switch (v) {
    case "INCREASES_NET_PAY": return "+ net";
    case "DECREASES_NET_PAY": return "− net";
    case "NO_NET_PAY_EFFECT": return "—";
    default: return v;
  }
}
function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide"
        style={{ color: "var(--spectre-text-muted)" }}>{children}</th>
  );
}
function Td({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <td className={"px-2 py-1.5 " + (mono ? "font-mono text-xs" : "")}
        style={{ color: "var(--spectre-text-primary)" }}>{children}</td>
  );
}
