"use client";

// HR-2A (2026-08-16) — Add Employee client form.
//
// Posts a multipart/form-data submission to `/api/people/employees`
// so the resume upload rides on the same round-trip as the profile
// fields. The route drives the canonical services (createEmployee,
// openEmploymentPeriod, createSession, uploadEmployeeDocument,
// setResume, linkEmployeeToMember) — this component is presentation
// + orchestration only. NO Prisma reads or writes happen here.
//
// UX notes (founder brief §7):
//   • The submitted employee starts in PRE_HIRE lifecycle with a
//     DRAFT onboarding session. The founder can then trigger the
//     invitation from the employee's profile shell.
//   • Optional Member link: the form surfaces candidate matches
//     from a lookup call and links only when the operator confirms.
//     No auto-linking, ever.
//   • Resume upload is optional at creation time; a later document-
//     upload flow can attach it after the fact. When present, PDF /
//     DOC / DOCX only.

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import SegmentedDateInput from "@/components/hr/SegmentedDateInput";

export interface AddEmployeeSelectOption {
  id: string;
  label: string;
}

export interface AddEmployeePositionOption {
  id: string;
  label: string;
  departmentId: string | null;
}

export interface AddEmployeeManagerOption {
  id: string;
  label: string;
}

export interface MemberCandidate {
  id: string;
  memberNumber: string;
  firstName: string;
  lastName: string;
  email: string | null;
}

interface Props {
  departments: AddEmployeeSelectOption[];
  /** HR-2B.3.6 — positions carry `departmentId` so the client-side
   *  cascade knows which options belong to the selected Department.
   *  Backwards-compatible: existing loader passes `departmentId: null`
   *  for unclassified positions; those never surface once a Department
   *  is chosen. */
  positions: AddEmployeePositionOption[];
  managers: AddEmployeeManagerOption[];
  /** True when the operator holds `hr:employee:write` and can therefore
   *  create a new EmployeePosition inline via POST /api/hr/positions. */
  canCreatePosition?: boolean;
  /** HR-2B.5 §11 — the operator must hold `hr:compensation:write` to
   *  set the employee's initial compensation. When absent, the compensation
   *  section is not rendered and the server route skips changeCompensation. */
  canSetCompensation?: boolean;
}

const EMPLOYMENT_TYPES = [
  { value: "FULL_TIME", label: "Full-time" },
  { value: "PART_TIME", label: "Part-time" },
  { value: "SEASONAL", label: "Seasonal" },
  { value: "CONTRACT", label: "Contract" },
];

// HR-2B.5 §11-13. The employee-facing labels; the values map 1:1 to
// EmployeeCompensation.cadence values validated in
// `src/lib/hr/compensation.ts`.
const COMPENSATION_CADENCES = [
  { value: "HOURLY", label: "Hourly" },
  { value: "SALARY", label: "Salary" },
];

export default function AddEmployeeForm({ departments, positions: initialPositions, managers, canCreatePosition, canSetCompensation }: Props) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Optional Member-link candidate lookup.
  const [memberQuery, setMemberQuery] = useState("");
  const [memberCandidates, setMemberCandidates] = useState<MemberCandidate[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  // HR-2B.3.6 (2026-08-19) — Position depends on Department.
  //
  // The full catalogue is kept in `positions` (loader-supplied +
  // inline-created); the visible dropdown is `filteredPositions`,
  // computed from `selectedDepartmentId`. Changing Department clears
  // the current Position selection so a stale cross-department
  // position never survives.
  const [positions, setPositions] = useState<AddEmployeePositionOption[]>(initialPositions);
  const [selectedDepartmentId, setSelectedDepartmentId] = useState<string>("");
  const [selectedPositionId, setSelectedPositionId] = useState<string>("");

  // HR-2B.5 §11-13 — Cadence toggles the rate helper text (per-hour
  // vs per-year) and the numeric formatting hint. Server always
  // persists the raw decimal via changeCompensation.
  const [compensationCadence, setCompensationCadence] = useState<"HOURLY" | "SALARY">("HOURLY");
  const [showAddPosition, setShowAddPosition] = useState(false);
  const [newPositionName, setNewPositionName] = useState("");
  const [newPositionRate, setNewPositionRate] = useState("");
  const [addingPosition, setAddingPosition] = useState(false);
  const [positionError, setPositionError] = useState<string | null>(null);

  const filteredPositions = selectedDepartmentId
    ? positions.filter((p) => p.departmentId === selectedDepartmentId)
    : [];

  useEffect(() => {
    // If Department changes and the current Position no longer belongs
    // to it, clear the Position selection. This is the "changing
    // Department clears Position" invariant from the founder brief.
    if (!selectedDepartmentId) {
      if (selectedPositionId) setSelectedPositionId("");
      return;
    }
    if (
      selectedPositionId &&
      !positions.some((p) => p.id === selectedPositionId && p.departmentId === selectedDepartmentId)
    ) {
      setSelectedPositionId("");
    }
  }, [selectedDepartmentId, positions, selectedPositionId]);

  async function submitNewPosition() {
    const name = newPositionName.trim();
    if (!name) {
      setPositionError("Please give the position a name.");
      return;
    }
    if (!selectedDepartmentId) {
      // Should not happen — the affordance is disabled without a
      // Department — but be explicit so a race doesn't silently
      // create a department-less position.
      setPositionError("Please select a Department first.");
      return;
    }
    setPositionError(null);
    setAddingPosition(true);
    try {
      const rate = newPositionRate.trim();
      const res = await fetch("/api/hr/positions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          departmentId: selectedDepartmentId,
          defaultPayRate: rate.length ? Number(rate) : 0,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.position?.id) {
        setPositionError(typeof data.error === "string" ? data.error : "Could not create position.");
        return;
      }
      const created = data.position as { id: string; name: string; code: string; departmentId: string | null };
      // HR-2B.3.2 §4 — name-only label; the system code stays internal.
      const label = created.name;
      setPositions((prev) =>
        [
          ...prev,
          { id: created.id, label, departmentId: created.departmentId ?? selectedDepartmentId },
        ].sort((a, b) => a.label.localeCompare(b.label)),
      );
      setSelectedPositionId(created.id);
      setShowAddPosition(false);
      setNewPositionName("");
      setNewPositionRate("");
    } catch {
      setPositionError("Network error — please try again.");
    } finally {
      setAddingPosition(false);
    }
  }

  async function searchMembers() {
    const q = memberQuery.trim();
    if (q.length < 2) {
      setMemberCandidates([]);
      return;
    }
    setIsSearching(true);
    try {
      const res = await fetch(`/api/people/employees/member-search?q=${encodeURIComponent(q)}`);
      if (!res.ok) {
        setMemberCandidates([]);
        return;
      }
      const data = await res.json();
      setMemberCandidates(Array.isArray(data.candidates) ? data.candidates.slice(0, 5) : []);
    } catch {
      setMemberCandidates([]);
    } finally {
      setIsSearching(false);
    }
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    if (selectedMemberId) fd.set("memberId", selectedMemberId);
    startTransition(async () => {
      try {
        const res = await fetch("/api/people/employees", {
          method: "POST",
          body: fd,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(typeof data.error === "string" ? data.error : "Could not create employee.");
          return;
        }
        if (typeof data.employeeId === "string") {
          router.push(`/app/admin/people/employees/${data.employeeId}`);
          router.refresh();
        }
      } catch {
        setError("Network error — please try again.");
      }
    });
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      encType="multipart/form-data"
      className="space-y-8"
    >
      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      <section className="card card-body space-y-4">
        <h2 className="section-title text-lg">Legal name</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label" htmlFor="firstName">Legal first name</label>
            <input id="firstName" name="firstName" className="input" required maxLength={80} />
          </div>
          <div>
            <label className="label" htmlFor="lastName">Legal last name</label>
            <input id="lastName" name="lastName" className="input" required maxLength={80} />
          </div>
          <div>
            <label className="label" htmlFor="middleName">Middle name (optional)</label>
            <input id="middleName" name="middleName" className="input" maxLength={80} />
          </div>
          <div>
            <label className="label" htmlFor="preferredName">Preferred name (optional)</label>
            <input id="preferredName" name="preferredName" className="input" maxLength={80} />
          </div>
        </div>
      </section>

      <section className="card card-body space-y-4">
        <h2 className="section-title text-lg">Contact</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label" htmlFor="personalEmail">Personal email</label>
            <input
              id="personalEmail"
              name="personalEmail"
              type="email"
              className="input"
              required
              maxLength={254}
            />
          </div>
          <div>
            <label className="label" htmlFor="mobilePhone">Mobile phone</label>
            <input
              id="mobilePhone"
              name="mobilePhone"
              className="input"
              required
              maxLength={40}
              placeholder="(555) 555-1234"
            />
          </div>
        </div>
      </section>

      {/* HR mobile-hotfix (2026-08-30) §1 — Optional home address.
         Admin may prefill; if left blank, the employee provides it
         during the onboarding Address step. No duplicate storage —
         these are the canonical Employee.home* columns. */}
      <section className="card card-body space-y-4" data-testid="add-employee-home-address">
        <div className="flex items-baseline justify-between">
          <h2 className="section-title text-lg">Home address</h2>
          <span className="text-xs text-stone-500">Optional — employee can add during onboarding</span>
        </div>
        <div>
          <label className="label" htmlFor="homeAddressLine1">Street address</label>
          <input
            id="homeAddressLine1"
            name="homeAddressLine1"
            className="input"
            autoComplete="address-line1"
            maxLength={200}
            placeholder="123 Fairway Lane"
            data-testid="new-emp-home-line1"
          />
        </div>
        <div>
          <label className="label" htmlFor="homeAddressLine2">Suite / apt</label>
          <input
            id="homeAddressLine2"
            name="homeAddressLine2"
            className="input"
            autoComplete="address-line2"
            maxLength={200}
            data-testid="new-emp-home-line2"
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label" htmlFor="homeCity">City</label>
            <input
              id="homeCity"
              name="homeCity"
              className="input"
              autoComplete="address-level2"
              maxLength={100}
              placeholder="Calgary"
              data-testid="new-emp-home-city"
            />
          </div>
          <div>
            <label className="label" htmlFor="homeProvince">Province / state</label>
            <input
              id="homeProvince"
              name="homeProvince"
              className="input uppercase"
              autoComplete="address-level1"
              maxLength={32}
              placeholder="AB"
              data-testid="new-emp-home-province"
            />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label" htmlFor="homePostalCode">Postal / ZIP code</label>
            <input
              id="homePostalCode"
              name="homePostalCode"
              className="input uppercase"
              autoComplete="postal-code"
              maxLength={16}
              placeholder="T2P 3H7"
              data-testid="new-emp-home-postal"
            />
          </div>
          <div>
            <label className="label" htmlFor="homeCountry">Country</label>
            <input
              id="homeCountry"
              name="homeCountry"
              className="input uppercase"
              autoComplete="country"
              maxLength={2}
              defaultValue="CA"
              placeholder="CA"
              data-testid="new-emp-home-country"
            />
          </div>
        </div>
      </section>

      <section className="card card-body space-y-4">
        <h2 className="section-title text-lg">Role &amp; team</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label" htmlFor="departmentId">Department</label>
            <select
              id="departmentId"
              name="departmentId"
              className="select"
              value={selectedDepartmentId}
              onChange={(e) => setSelectedDepartmentId(e.target.value)}
              data-testid="department-select"
            >
              <option value="">— Select —</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.label}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <label className="label" htmlFor="positionId">Position</label>
              {/* HR-2B.3.6 — Add-Position affordance is gated on Department: */}
              {canCreatePosition && selectedDepartmentId && !showAddPosition && (
                <button
                  type="button"
                  data-testid="add-position-inline-button"
                  className="text-xs text-emerald-800 hover:text-emerald-900 underline underline-offset-4"
                  onClick={() => {
                    setPositionError(null);
                    setShowAddPosition(true);
                  }}
                >
                  + Add position
                </button>
              )}
            </div>
            {!selectedDepartmentId ? (
              // HR-2B.3.6 — Position disabled before Department. Neutral,
              // non-clickable placeholder matching the "select-a-department-
              // first" spec in the founder brief.
              <>
                <select
                  id="positionId"
                  name="positionId"
                  className="select"
                  disabled
                  value=""
                  onChange={() => { /* disabled — never fires */ }}
                  data-testid="position-select"
                >
                  <option value="">Select a department first</option>
                </select>
                <input type="hidden" name="positionId" value="" />
              </>
            ) : filteredPositions.length > 0 ? (
              <select
                id="positionId"
                name="positionId"
                className="select"
                value={selectedPositionId}
                onChange={(e) => setSelectedPositionId(e.target.value)}
                data-testid="position-select"
              >
                <option value="">— Select —</option>
                {filteredPositions.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            ) : (
              <div
                className="rounded-md border border-dashed border-stone-300 bg-stone-50 px-3 py-3 text-sm text-stone-700"
                data-testid="position-empty-state"
              >
                No positions in this Department yet.
                {canCreatePosition ? (
                  <>
                    {" "}
                    <button
                      type="button"
                      data-testid="add-position-empty-button"
                      className="text-emerald-800 hover:text-emerald-900 underline underline-offset-4"
                      onClick={() => {
                        setPositionError(null);
                        setShowAddPosition(true);
                      }}
                    >
                      + Add one
                    </button>
                  </>
                ) : (
                  <span className="text-xs text-stone-500 block mt-1">Ask a Club administrator to add employee positions.</span>
                )}
                <input type="hidden" name="positionId" value="" />
              </div>
            )}
            {showAddPosition && (
              <div
                className="mt-3 rounded-md border border-stone-200 bg-white p-3 space-y-3"
                data-testid="add-position-panel"
              >
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="md:col-span-2">
                    <label className="label" htmlFor="newPositionName">Position name</label>
                    <input
                      id="newPositionName"
                      type="text"
                      className="input"
                      placeholder="e.g. Head Server"
                      value={newPositionName}
                      onChange={(e) => setNewPositionName(e.target.value)}
                      maxLength={80}
                      data-testid="new-position-name"
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor="newPositionRate">Default hourly rate (optional)</label>
                    <input
                      id="newPositionRate"
                      type="number"
                      step="0.01"
                      min="0"
                      className="input"
                      placeholder="0.00"
                      value={newPositionRate}
                      onChange={(e) => setNewPositionRate(e.target.value)}
                      data-testid="new-position-rate"
                    />
                  </div>
                </div>
                {positionError && (
                  <p className="text-xs text-red-700" role="alert" data-testid="new-position-error">{positionError}</p>
                )}
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={submitNewPosition}
                    disabled={addingPosition}
                    data-testid="new-position-save"
                  >
                    {addingPosition ? "Adding…" : "Add position"}
                  </button>
                  <button
                    type="button"
                    className="text-xs text-stone-500 hover:text-stone-800 underline"
                    onClick={() => {
                      setShowAddPosition(false);
                      setNewPositionName("");
                      setNewPositionRate("");
                      setPositionError(null);
                    }}
                    disabled={addingPosition}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
          <div>
            <label className="label" htmlFor="employmentType">Employment type</label>
            <select id="employmentType" name="employmentType" className="select" required defaultValue="FULL_TIME">
              {EMPLOYMENT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="expectedStartDate">Expected start date</label>
            <SegmentedDateInput
              id="expectedStartDate"
              name="expectedStartDate"
              required
              testIdPrefix="expected-start-date"
            />
            <p className="mt-1 text-xs text-stone-500">
              Type <span className="font-mono">YYYYMMDD</span> to move
              between segments automatically.
            </p>
          </div>
          <div className="md:col-span-2">
            <label className="label" htmlFor="managerEmployeeId">Reports to</label>
            <select id="managerEmployeeId" name="managerEmployeeId" className="select" defaultValue="">
              <option value="">— No manager —</option>
              {managers.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {canSetCompensation && (
        <section className="card card-body space-y-4" data-testid="compensation-section">
          <div>
            <h2 className="section-title text-lg">Compensation</h2>
            <p className="mt-1 text-xs text-stone-500">
              Sets the employee&rsquo;s initial pay rate. Effective on the expected start date
              above. Future changes preserve history.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label" htmlFor="compensationCadence">Compensation type</label>
              <select
                id="compensationCadence"
                name="compensationCadence"
                className="select"
                value={compensationCadence}
                onChange={(e) => setCompensationCadence(e.target.value as "HOURLY" | "SALARY")}
                data-testid="compensation-cadence"
              >
                {COMPENSATION_CADENCES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="compensationAmount">
                {compensationCadence === "HOURLY" ? "Hourly rate" : "Annual salary"}
              </label>
              <div className="flex items-center gap-2">
                <span className="text-stone-500">$</span>
                <input
                  id="compensationAmount"
                  name="compensationAmount"
                  type="number"
                  step={compensationCadence === "HOURLY" ? "0.01" : "1"}
                  min="0"
                  className="input"
                  placeholder={compensationCadence === "HOURLY" ? "22.50" : "72000"}
                  required
                  data-testid="compensation-amount"
                />
                <span className="text-xs text-stone-500 whitespace-nowrap">
                  {compensationCadence === "HOURLY" ? "/ hour" : "/ year"}
                </span>
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="card card-body space-y-4">
        <h2 className="section-title text-lg">Resume (optional)</h2>
        <p className="text-sm text-stone-500">
          PDF, DOC, or DOCX. Uploaded resumes attach to the employee profile as a
          STANDARD-sensitivity document.
        </p>
        <input
          type="file"
          name="resume"
          accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="block w-full text-sm text-stone-700 file:mr-3 file:rounded file:border-0 file:bg-stone-200 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-stone-800 hover:file:bg-stone-300"
        />
      </section>

      <section className="card card-body space-y-4">
        <h2 className="section-title text-lg">Link to a Club Member (optional)</h2>
        <p className="text-sm text-stone-500">
          If the new employee is also a club Member, search by name or email and confirm the
          match. Links are never made automatically.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            className="input flex-1"
            placeholder="Search by name or email…"
            value={memberQuery}
            onChange={(e) => setMemberQuery(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={searchMembers}
            disabled={isSearching || memberQuery.trim().length < 2}
          >
            {isSearching ? "Searching…" : "Search"}
          </button>
        </div>
        {memberCandidates.length > 0 && (
          <ul className="mt-2 divide-y divide-stone-100 rounded-md border border-stone-200 bg-white">
            {memberCandidates.map((m) => {
              const checked = selectedMemberId === m.id;
              return (
                <li key={m.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => setSelectedMemberId(e.target.checked ? m.id : null)}
                  />
                  <div>
                    <div className="font-medium text-club-ink">
                      {m.firstName} {m.lastName} · #{m.memberNumber}
                    </div>
                    <div className="text-xs text-stone-500">{m.email ?? "no email on file"}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="flex items-center justify-end gap-3">
        <button type="submit" className="btn btn-primary" disabled={isPending}>
          {isPending ? "Creating employee…" : "Create employee"}
        </button>
      </div>
    </form>
  );
}
