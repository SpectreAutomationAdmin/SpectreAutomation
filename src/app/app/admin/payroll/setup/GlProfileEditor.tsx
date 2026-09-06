"use client";

// Payroll-3C-6A (2026-09-05) — Global Payroll GL Accounting Profile editor.
// Renders 8 account pickers (3 expense + 5 liability) with server-side
// validation via PATCH /api/clubs/[id]/payroll/gl-profile. Profile
// changes apply to the NEXT post; historical journals are unaffected
// because they hold JournalEntryLine.accountId at post time.

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Account { id: string; accountNumber: string; name: string; type: string }
interface Profile {
  salaryExpenseAccountId:        string | null;
  employerCppExpenseAccountId:   string | null;
  employerEiExpenseAccountId:    string | null;
  netPayPayableAccountId:        string | null;
  cppPayableAccountId:           string | null;
  eiPayableAccountId:            string | null;
  federalTaxPayableAccountId:    string | null;
  provincialTaxPayableAccountId: string | null;
}

const FIELDS: Array<{
  key: keyof Profile;
  label: string;
  type: "EXPENSE" | "LIABILITY";
}> = [
  { key: "salaryExpenseAccountId",         label: "Salary / wage expense",         type: "EXPENSE" },
  { key: "employerCppExpenseAccountId",    label: "Employer CPP expense",          type: "EXPENSE" },
  { key: "employerEiExpenseAccountId",     label: "Employer EI expense",           type: "EXPENSE" },
  { key: "netPayPayableAccountId",         label: "Net pay payable (clearing)",    type: "LIABILITY" },
  { key: "cppPayableAccountId",            label: "CPP payable",                   type: "LIABILITY" },
  { key: "eiPayableAccountId",             label: "EI payable",                    type: "LIABILITY" },
  { key: "federalTaxPayableAccountId",     label: "Federal income tax payable",    type: "LIABILITY" },
  { key: "provincialTaxPayableAccountId",  label: "Provincial income tax payable", type: "LIABILITY" },
];

export default function GlProfileEditor(props: {
  clubId: string;
  canWrite: boolean;
  accounts: Account[];
  initialProfile: Profile;
}) {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile>(props.initialProfile);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const complete = FIELDS.every((f) => profile[f.key] != null);

  async function save() {
    // Refuse to save when incomplete — server does the same, but this
    // avoids a round-trip.
    if (!complete) {
      setMessage("Every field is required before saving the payroll GL profile.");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/clubs/${props.clubId}/payroll/gl-profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setMessage(`Save failed: ${body.error ?? res.statusText}`);
        return;
      }
      setMessage("Saved. Applies to future payrolls; historical journals are unchanged.");
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-testid="gl-profile-editor">
      <div
        className="mb-3 rounded-lg border px-3 py-2 text-xs"
        style={{
          background: "var(--spectre-surface)",
          borderColor: "var(--spectre-border-muted)",
          color: complete ? "var(--spectre-text-secondary)" : "#8a5a00",
        }}
        data-testid="gl-profile-readiness"
      >
        {complete
          ? "Payroll GL setup: Ready — all 8 statutory + clearing accounts are configured."
          : "Payroll GL setup: Action required — every statutory + clearing account must be assigned before payroll can post."}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {FIELDS.map((f) => (
          <label key={f.key} className="text-sm">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-stone-600">
              {f.label} <span className="text-[10px] text-stone-400">({f.type})</span>
            </span>
            <select
              className="input w-full"
              value={profile[f.key] ?? ""}
              disabled={!props.canWrite}
              onChange={(e) => setProfile({ ...profile, [f.key]: e.target.value || null })}
              data-testid={`gl-profile-${f.key}`}
            >
              <option value="">— Not configured —</option>
              {props.accounts
                .filter((a) => a.type === f.type)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.accountNumber} — {a.name}
                  </option>
                ))}
            </select>
          </label>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <p className="text-[11px]" style={{ color: "var(--spectre-text-muted)" }}>
          Changes apply to the <strong>next</strong> payroll post. Journal entries already posted
          keep the account they were written to at post time.
        </p>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!props.canWrite || saving}
          onClick={save}
          data-testid="gl-profile-save"
        >
          {saving ? "Saving…" : "Save GL profile"}
        </button>
      </div>

      {message ? (
        <p className="mt-3 text-xs" data-testid="gl-profile-message"
           style={{ color: message.startsWith("Saved") ? "#0f5d3a" : "#8a2f00" }}>
          {message}
        </p>
      ) : null}
    </div>
  );
}
