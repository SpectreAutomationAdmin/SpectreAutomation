// HR-2B.4 (2026-08-19) — Admin client for onboarding-requirement CRUD.
//
// Minimum-viable surface: table of existing requirements + inline
// "add requirement" form + activate/deactivate toggle. Advanced editing
// (renaming, changing applicability after creation) is deliberately
// scoped tight — a follow-up slice can extend once founder confirms
// this is the right surface.

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Kind = "DOCUMENT_UPLOAD" | "CREDENTIAL_WITH_EXPIRY" | "CONFIRMATION_ONLY";

interface Requirement {
  id: string;
  code: string;
  displayName: string;
  explanation: string | null;
  kind: string;
  documentCategory: string | null;
  appliesToAll: boolean;
  appliesToDeptIds: string[];
  appliesToPositionIds: string[];
  required: boolean;
  requireExpiry: boolean;
  active: boolean;
  displayOrder: number;
}

interface Props {
  clubId: string;
  requirements: Requirement[];
  departments: Array<{ id: string; name: string }>;
  positions: Array<{ id: string; name: string; departmentId: string | null }>;
}

const DOC_CATEGORIES = [
  { value: "work_permit", label: "Work permit (RESTRICTED)" },
  { value: "certification", label: "Certification" },
  { value: "safety_certificate", label: "Safety certificate" },
  { value: "drivers_licence", label: "Driver's licence (RESTRICTED)" },
  { value: "handbook_acknowledgement", label: "Handbook acknowledgement" },
  { value: "other", label: "Other" },
];

export default function AdminOnboardingRequirementsClient({ clubId, requirements: initial, departments, positions }: Props) {
  const router = useRouter();
  const [requirements, setRequirements] = useState<Requirement[]>(initial);
  const [showAdd, setShowAdd] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [explanation, setExplanation] = useState("");
  const [kind, setKind] = useState<Kind>("DOCUMENT_UPLOAD");
  const [documentCategory, setDocumentCategory] = useState<string>("certification");
  const [appliesToAll, setAppliesToAll] = useState(false);
  const [deptIds, setDeptIds] = useState<string[]>([]);
  const [positionIds, setPositionIds] = useState<string[]>([]);
  const [required, setRequired] = useState(true);
  const [requireExpiry, setRequireExpiry] = useState(false);

  function toggleInSet(id: string, set: string[], setter: (v: string[]) => void) {
    setter(set.includes(id) ? set.filter((v) => v !== id) : [...set, id]);
  }

  async function submitCreate() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/hr/onboarding-requirements", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code,
            displayName,
            explanation: explanation || null,
            kind,
            documentCategory: kind === "CONFIRMATION_ONLY" ? null : documentCategory,
            appliesToAll,
            appliesToDeptIds: deptIds,
            appliesToPositionIds: positionIds,
            required,
            requireExpiry: kind === "CREDENTIAL_WITH_EXPIRY" ? requireExpiry : false,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(typeof data.error === "string" ? data.error : "Could not create requirement.");
          return;
        }
        setShowAdd(false);
        setCode(""); setDisplayName(""); setExplanation("");
        setKind("DOCUMENT_UPLOAD"); setDocumentCategory("certification");
        setAppliesToAll(false); setDeptIds([]); setPositionIds([]);
        setRequired(true); setRequireExpiry(false);
        router.refresh();
        setRequirements((prev) => [...prev, data.requirement]);
      } catch {
        setError("Network error — please try again.");
      }
    });
  }

  async function setActive(id: string, active: boolean) {
    const res = await fetch(`/api/hr/onboarding-requirements/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active }),
    });
    if (res.ok) {
      setRequirements((prev) => prev.map((r) => (r.id === id ? { ...r, active } : r)));
      router.refresh();
    }
  }

  return (
    <div className="space-y-6">
      {/* Existing */}
      <section className="card overflow-hidden">
        {requirements.length === 0 ? (
          <div className="p-6 text-sm text-stone-500">
            No requirements yet. Add one below to start asking new employees for a document or credential.
          </div>
        ) : (
          <table className="table-base" data-testid="onboarding-requirements-table">
            <thead>
              <tr>
                <th>Requirement</th>
                <th>Kind</th>
                <th>Applies to</th>
                <th>Required</th>
                <th>Status</th>
                <th className="w-32"></th>
              </tr>
            </thead>
            <tbody>
              {requirements.map((r) => {
                const applyLabel = r.appliesToAll
                  ? "All roles"
                  : `${r.appliesToDeptIds.length} dept(s) · ${r.appliesToPositionIds.length} position(s)`;
                return (
                  <tr key={r.id} data-testid={`requirement-row-${r.code}`}>
                    <td>
                      <div className="font-medium text-club-ink">{r.displayName}</div>
                      <div className="text-xs text-stone-500 font-mono">{r.code}</div>
                    </td>
                    <td className="text-stone-600 text-xs">{r.kind}</td>
                    <td className="text-stone-600 text-xs">{applyLabel}</td>
                    <td className="text-xs">{r.required ? "Required" : "Optional"}</td>
                    <td className="text-xs">
                      <span className={r.active ? "text-emerald-800" : "text-stone-400"}>
                        {r.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="text-right">
                      <button
                        type="button"
                        onClick={() => setActive(r.id, !r.active)}
                        data-testid={`requirement-toggle-${r.code}`}
                        className="text-xs text-emerald-800 hover:text-emerald-900 underline underline-offset-4"
                      >
                        {r.active ? "Deactivate" : "Reactivate"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {!showAdd ? (
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          data-testid="add-requirement-button"
          className="btn btn-primary"
        >
          + Add requirement
        </button>
      ) : (
        <section className="card card-body space-y-4" data-testid="add-requirement-panel">
          <h2 className="section-title text-lg">New requirement</h2>
          {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">Machine code</label>
              <input
                type="text"
                className="input"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
                placeholder="PROSERVE"
                maxLength={40}
                data-testid="new-requirement-code"
              />
              <p className="mt-1 text-xs text-stone-500">Internal identifier — never shown to the employee.</p>
            </div>
            <div>
              <label className="label">Display name</label>
              <input
                type="text"
                className="input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="ProServe certificate"
                maxLength={200}
                data-testid="new-requirement-display-name"
              />
            </div>
            <div className="md:col-span-2">
              <label className="label">Why does the Club need this? <span className="text-xs text-stone-400">(shown to employee)</span></label>
              <textarea
                className="input"
                rows={2}
                value={explanation}
                onChange={(e) => setExplanation(e.target.value)}
                placeholder="Because your role may involve serving alcohol, the Club needs a copy of your current ProServe certificate."
                data-testid="new-requirement-explanation"
              />
            </div>
            <div>
              <label className="label">Kind</label>
              <select className="select" value={kind} onChange={(e) => setKind(e.target.value as Kind)} data-testid="new-requirement-kind">
                <option value="DOCUMENT_UPLOAD">Document upload</option>
                <option value="CREDENTIAL_WITH_EXPIRY">Credential with expiry</option>
                <option value="CONFIRMATION_ONLY">Confirmation only</option>
              </select>
            </div>
            {kind !== "CONFIRMATION_ONLY" && (
              <div>
                <label className="label">Document category</label>
                <select className="select" value={documentCategory} onChange={(e) => setDocumentCategory(e.target.value)} data-testid="new-requirement-doc-category">
                  {DOC_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={required}
                  onChange={(e) => setRequired(e.target.checked)}
                  data-testid="new-requirement-required"
                />
                <span>Required (blocks onboarding completion)</span>
              </label>
            </div>
            {kind === "CREDENTIAL_WITH_EXPIRY" && (
              <div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={requireExpiry}
                    onChange={(e) => setRequireExpiry(e.target.checked)}
                    data-testid="new-requirement-require-expiry"
                  />
                  <span>Require expiry date</span>
                </label>
              </div>
            )}
          </div>

          {/* Applicability */}
          <div className="border-t border-stone-100 pt-4">
            <h3 className="text-sm font-medium">Applies to</h3>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={appliesToAll}
                onChange={(e) => setAppliesToAll(e.target.checked)}
                data-testid="new-requirement-applies-to-all"
              />
              <span>Every employee at this Club</span>
            </label>
            {!appliesToAll && (
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <div className="text-xs font-medium text-stone-700 mb-1">Departments</div>
                  <div className="space-y-1 max-h-40 overflow-auto rounded-md border border-stone-200 p-2">
                    {departments.map((d) => (
                      <label key={d.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={deptIds.includes(d.id)}
                          onChange={() => toggleInSet(d.id, deptIds, setDeptIds)}
                          data-testid={`new-requirement-dept-${d.id}`}
                        />
                        <span>{d.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-medium text-stone-700 mb-1">Positions</div>
                  <div className="space-y-1 max-h-40 overflow-auto rounded-md border border-stone-200 p-2">
                    {positions.map((p) => (
                      <label key={p.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={positionIds.includes(p.id)}
                          onChange={() => toggleInSet(p.id, positionIds, setPositionIds)}
                          data-testid={`new-requirement-position-${p.id}`}
                        />
                        <span>{p.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={submitCreate}
              disabled={isPending || !displayName || !code}
              data-testid="new-requirement-save"
              className="btn btn-primary"
            >
              {isPending ? "Saving…" : "Add requirement"}
            </button>
            <button
              type="button"
              onClick={() => { setShowAdd(false); setError(null); }}
              className="text-xs text-stone-500 hover:text-stone-800 underline"
            >
              Cancel
            </button>
          </div>
        </section>
      )}
      <input type="hidden" value={clubId} />
    </div>
  );
}
