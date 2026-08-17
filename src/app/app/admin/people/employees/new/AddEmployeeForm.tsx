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

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export interface AddEmployeeSelectOption {
  id: string;
  label: string;
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
  positions: AddEmployeeSelectOption[];
  managers: AddEmployeeManagerOption[];
}

const EMPLOYMENT_TYPES = [
  { value: "FULL_TIME", label: "Full-time" },
  { value: "PART_TIME", label: "Part-time" },
  { value: "SEASONAL", label: "Seasonal" },
  { value: "CONTRACT", label: "Contract" },
];

export default function AddEmployeeForm({ departments, positions, managers }: Props) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Optional Member-link candidate lookup.
  const [memberQuery, setMemberQuery] = useState("");
  const [memberCandidates, setMemberCandidates] = useState<MemberCandidate[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);

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

      <section className="card card-body space-y-4">
        <h2 className="section-title text-lg">Role &amp; team</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label" htmlFor="departmentId">Department</label>
            <select id="departmentId" name="departmentId" className="select" defaultValue="">
              <option value="">— Select —</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="positionId">Position</label>
            <select id="positionId" name="positionId" className="select" defaultValue="">
              <option value="">— Select —</option>
              {positions.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
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
            <input
              id="expectedStartDate"
              name="expectedStartDate"
              type="date"
              className="input"
              required
            />
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
