"use client";

// Post-onboarding-admin hotfix (2026-09-13) §17-19 — Admin-side Basic
// Details editor. Rendered inline as a collapsible panel next to the
// Basic Details section header when the operator holds `hr:employee:write`.
// Legal name is editable but visually flagged so the operator knows the
// change is auditable (§18). Address fields respect §19 — a single
// canonical write, no second address model.
//
// Sensitive fields (SIN, banking, TD1) are intentionally excluded (§24).

import { useState, useTransition } from "react";

interface BasicDetailsPayload {
  firstName: string;
  middleName: string | null;
  lastName: string;
  preferredName: string | null;
  personalEmail: string | null;
  mobilePhone: string | null;
  // v399 Slice-1 followup #2 (2026-09-15) §2 — DOB is a civil date.
  // Wire format is the same ISO string used elsewhere on the profile.
  // The form itself edits YYYY-MM-DD; the wire value is normalized on
  // save to the same UTC-midnight civil-date form onboarding writes.
  dateOfBirth: string | null;
  homeAddressLine1: string | null;
  homeAddressLine2: string | null;
  homeCity: string | null;
  homeProvince: string | null;
  homePostalCode: string | null;
  homeCountry: string | null;
}

// Convert an ISO string (Employee.dateOfBirth serialized as
// 1993-09-04T00:00:00.000Z) into a YYYY-MM-DD value for the `<input
// type="date">`. Reads UTC components so a civil-date DOB never
// appears one day off for viewers west of UTC.
function isoToInputDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function EditBasicDetailsPanel({
  employeeId,
  initial,
}: {
  employeeId: string;
  initial: BasicDetailsPayload;
}) {
  const [open, setOpen] = useState(false);
  // DOB comes in from the server as an ISO string; the input expects
  // YYYY-MM-DD. Normalize at construction and on cancel-reset.
  const normalized: BasicDetailsPayload = {
    ...initial,
    dateOfBirth: initial.dateOfBirth ? isoToInputDate(initial.dateOfBirth) : null,
  };
  const [form, setForm] = useState<BasicDetailsPayload>(normalized);
  const [pending, startTransition] = useTransition();
  const [banner, setBanner] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  function update<K extends keyof BasicDetailsPayload>(k: K, v: BasicDetailsPayload[K]) {
    setForm((prev) => ({ ...prev, [k]: v }));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setBanner(null);
    startTransition(async () => {
      const res = await fetch(`/api/people/employees/${employeeId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          firstName: form.firstName.trim(),
          middleName: nullIfEmpty(form.middleName),
          lastName: form.lastName.trim(),
          preferredName: nullIfEmpty(form.preferredName),
          personalEmail: nullIfEmpty(form.personalEmail),
          mobilePhone: nullIfEmpty(form.mobilePhone),
          // §2 — DOB flows as YYYY-MM-DD or null; the service normalizes.
          dateOfBirth: nullIfEmpty(form.dateOfBirth),
          homeAddressLine1: nullIfEmpty(form.homeAddressLine1),
          homeAddressLine2: nullIfEmpty(form.homeAddressLine2),
          homeCity: nullIfEmpty(form.homeCity),
          homeProvince: nullIfEmpty(form.homeProvince)?.toUpperCase() ?? null,
          homePostalCode: nullIfEmpty(form.homePostalCode),
          homeCountry: nullIfEmpty(form.homeCountry)?.toUpperCase() ?? null,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setBanner({ tone: "error", text: j.error ?? `Update failed (HTTP ${res.status})` });
        return;
      }
      const updated = (await res.json()) as BasicDetailsPayload;
      setForm(updated);
      setBanner({ tone: "success", text: "Saved. Reload to see changes reflected everywhere." });
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        className="spectre-person-edit-btn"
        style={{
          fontSize: "12px",
          color: "#1e3a2a",
          background: "transparent",
          border: "1px solid #d0c9bd",
          borderRadius: 4,
          padding: "2px 10px",
          cursor: "pointer",
        }}
        onClick={() => setOpen(true)}
        data-testid="employee-edit-basic-details-btn"
      >
        Edit
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="spectre-person-edit-form"
      data-testid="employee-edit-basic-details-form"
      style={{
        border: "1px solid #d0c9bd",
        borderRadius: 6,
        padding: 16,
        marginTop: 12,
        background: "#fbfaf7",
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Legal first name" value={form.firstName} onChange={(v) => update("firstName", v)} testId="edit-firstName" />
        <Field label="Legal last name" value={form.lastName} onChange={(v) => update("lastName", v)} testId="edit-lastName" />
        <Field label="Middle name" value={form.middleName ?? ""} onChange={(v) => update("middleName", v)} testId="edit-middleName" />
        <Field label="Preferred name" value={form.preferredName ?? ""} onChange={(v) => update("preferredName", v)} testId="edit-preferredName" />
        <Field label="Personal email" value={form.personalEmail ?? ""} onChange={(v) => update("personalEmail", v)} type="email" testId="edit-personalEmail" />
        <Field label="Mobile phone" value={form.mobilePhone ?? ""} onChange={(v) => update("mobilePhone", v)} type="tel" testId="edit-mobilePhone" />
        {/* §2 — canonical DOB. Input type=date returns YYYY-MM-DD which
            the update service normalizes to UTC-midnight civil date. */}
        <Field label="Date of birth" value={form.dateOfBirth ?? ""} onChange={(v) => update("dateOfBirth", v)} type="date" testId="edit-dateOfBirth" />
      </div>
      <h4 style={{ marginTop: 16, marginBottom: 8, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, color: "#6b6357" }}>
        Home address
      </h4>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Street address" value={form.homeAddressLine1 ?? ""} onChange={(v) => update("homeAddressLine1", v)} testId="edit-homeAddressLine1" />
        <Field label="Suite / apt" value={form.homeAddressLine2 ?? ""} onChange={(v) => update("homeAddressLine2", v)} testId="edit-homeAddressLine2" />
        <Field label="City" value={form.homeCity ?? ""} onChange={(v) => update("homeCity", v)} testId="edit-homeCity" />
        <Field label="Province / State" value={form.homeProvince ?? ""} onChange={(v) => update("homeProvince", v)} maxLength={2} testId="edit-homeProvince" />
        <Field label="Postal / ZIP" value={form.homePostalCode ?? ""} onChange={(v) => update("homePostalCode", v)} testId="edit-homePostalCode" />
        <Field label="Country" value={form.homeCountry ?? ""} onChange={(v) => update("homeCountry", v)} maxLength={2} testId="edit-homeCountry" />
      </div>
      {banner && (
        <div
          data-testid="employee-edit-basic-details-banner"
          style={{
            marginTop: 12,
            padding: "8px 12px",
            borderRadius: 4,
            fontSize: 13,
            background: banner.tone === "success" ? "#f0fdf4" : "#fef2f2",
            color: banner.tone === "success" ? "#14532d" : "#7f1d1d",
            border: `1px solid ${banner.tone === "success" ? "#166534" : "#b91c1c"}`,
          }}
        >
          {banner.text}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <button
          type="button"
          onClick={() => { setOpen(false); setForm(normalized); setBanner(null); }}
          disabled={pending}
          style={{ padding: "6px 14px", fontSize: 13, border: "1px solid #d0c9bd", background: "transparent", borderRadius: 4, cursor: "pointer" }}
          data-testid="employee-edit-basic-details-cancel"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending}
          style={{ padding: "6px 14px", fontSize: 13, background: "#1e3a2a", color: "white", border: "none", borderRadius: 4, cursor: "pointer", opacity: pending ? 0.6 : 1 }}
          data-testid="employee-edit-basic-details-save"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function Field({
  label, value, onChange, type, maxLength, testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  maxLength?: number;
  testId?: string;
}) {
  return (
    <label style={{ display: "block", fontSize: 12, color: "#4a453d" }}>
      <span style={{ display: "block", marginBottom: 4 }}>{label}</span>
      <input
        type={type ?? "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={maxLength}
        data-testid={testId}
        style={{
          width: "100%",
          padding: "6px 8px",
          fontSize: 14,
          border: "1px solid #d0c9bd",
          borderRadius: 4,
          background: "white",
        }}
      />
    </label>
  );
}

function nullIfEmpty(s: string | null): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}
