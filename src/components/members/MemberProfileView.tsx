"use client";

// Phase 20 (Member Database, 2026-08-15) — Member Profile client view.
//
// Renders the reference-matching layout: identity header + primary
// tabs + Member tab content (person switcher, Basic Details grid,
// Member Picture, Groups, Other Information, Additional Information).
//
// Interactivity that must live client-side:
//   • primary tab selection
//   • person-switcher selection (primary vs household)
//   • toggling the Basic Details section between read + edit
//   • inline "+ ADD GROUP" input
//   • "+ add member" small form
//   • per-custom-field inline edit
//
// The server actions are passed in as bound-function props from the
// page.tsx server component so this component never imports them
// directly (avoids server-action leakage into the client bundle).

import { useState } from "react";
import Link from "next/link";
import { IconChevronLeft, IconClose, IconEdit, IconPlus } from "@/components/spectre/icons";

type Person = {
  id?: string;        // household member id — omitted for primary
  isPrimary?: boolean;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  nickname: string | null;
  salutation: string | null;
  gender: string | null;
  relationship?: string | null; // omitted for primary
  email: string | null;
  phone: string | null;
  homePhone: string | null;
  dateOfBirth: string | null;
  profileImageUrl: string | null;
};

interface Props {
  member: {
    id: string;
    memberNumber: string;
    status: string;
    membershipCategory: string | null;
    joinDate: string | null;
    firstName: string | null;
    middleName: string | null;
    lastName: string | null;
    nickname: string | null;
    salutation: string | null;
    gender: string | null;
    email: string | null;
    phone: string | null;
    homePhone: string | null;
    dateOfBirth: string | null;
    profileImageUrl: string | null;
  };
  household: Array<Person & { id: string; relationship: string }>;
  assignedGroups: Array<{ groupId: string; name: string }>;
  allGroups: Array<{ id: string; name: string }>;
  customFields: Array<{
    id: string;
    key: string;
    label: string;
    kind: string;
    helpText: string | null;
    valueText: string | null;
  }>;
  activePersonParam: string | null;
  activeTab: string;
  savedFlash: string | null;
  errorFlash: string | null;
  actions: {
    editPrimaryDetails: (formData: FormData) => Promise<void>;
    addAssociatedPerson: (formData: FormData) => Promise<void>;
    removeAssociatedPerson: (formData: FormData) => Promise<void>;
    addGroup: (formData: FormData) => Promise<void>;
    removeGroup: (formData: FormData) => Promise<void>;
    setCustomField: (formData: FormData) => Promise<void>;
  };
  /** HR-2A (2026-08-16) — reciprocal Employee indicator. When the
   *  member is also a club employee, the profile renders a subtle
   *  "Also an Employee" affordance in the identity header.
   *  `canNavigate` gates whether it's a link (`hr:directory:view`)
   *  or plain text. Null when the member has no linked employee. */
  employeeLink?: {
    employeeId: string;
    employeeNumber: string;
    canNavigate: boolean;
  } | null;
}

const TABS = [
  { key: "member",       label: "Member" },
  { key: "plan",         label: "Plan" },
  { key: "billing",      label: "Billing" },
  { key: "esignatures",  label: "E-signatures" },
  { key: "notes",        label: "Notes" },
  { key: "documents",    label: "Documents" },
] as const;

function formatDate(iso: string | null): string {
  if (!iso) return "Not provided";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Not provided";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function formatValue(v: string | null | undefined): string {
  return v && v.trim().length ? v : "Not provided";
}

function initials(first: string | null, last: string | null): string {
  const a = (first ?? "").trim().charAt(0);
  const b = (last ?? "").trim().charAt(0);
  return `${a}${b}`.toUpperCase() || "·";
}

function personLabel(p: Person): string {
  return `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim();
}

export default function MemberProfileView(props: Props) {
  const { member, household, assignedGroups, allGroups, customFields, actions } = props;
  const [tab, setTab] = useState<string>(props.activeTab);
  const [addingPerson, setAddingPerson] = useState<boolean>(false);
  const [addingGroup, setAddingGroup] = useState<boolean>(false);
  const [editingBasic, setEditingBasic] = useState<boolean>(false);
  const [editingCustomKey, setEditingCustomKey] = useState<string | null>(null);

  // Compose the list of people the switcher shows.
  const people: Array<Person & { switcherKey: string }> = [
    { ...member, isPrimary: true, switcherKey: "primary" } as Person & { switcherKey: string },
    ...household.map((h) => ({ ...h, isPrimary: false, switcherKey: h.id })),
  ];
  // Determine which person is currently selected. Default = primary.
  const activeKey = props.activePersonParam && people.some((p) => p.switcherKey === props.activePersonParam)
    ? props.activePersonParam
    : "primary";
  const activePerson = people.find((p) => p.switcherKey === activeKey) ?? people[0];

  const status = member.status.toUpperCase();
  const displayName = `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim();

  // Assigned-group id set — used to hide already-assigned entries in
  // the datalist of the add-group dropdown.
  const assignedIds = new Set(assignedGroups.map((g) => g.groupId));
  const availableGroups = allGroups.filter((g) => !assignedIds.has(g.id));

  return (
    <div className="spectre-member-profile">
      {props.savedFlash ? (
        <div className="spectre-member-profile-flash spectre-member-profile-flash--ok" role="status">
          Saved.
        </div>
      ) : null}
      {props.errorFlash ? (
        <div className="spectre-member-profile-flash spectre-member-profile-flash--err" role="alert">
          {props.errorFlash}
        </div>
      ) : null}

      {/* ---------------- Identity header ---------------- */}
      <header className="spectre-member-header">
        <Link href="/app/admin/members" className="spectre-member-back" aria-label="Back to members">
          <IconChevronLeft size={18} />
        </Link>
        <div className="spectre-member-header-photo">
          {member.profileImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={member.profileImageUrl} alt="" />
          ) : (
            <span className="spectre-member-header-photo-placeholder">{initials(member.firstName, member.lastName)}</span>
          )}
        </div>
        <div className="spectre-member-header-body">
          <h1 className="spectre-member-header-name">{displayName || "Member"}</h1>
          <div className="spectre-member-header-meta">
            <span className="uppercase-eyebrow">Member since {formatDate(member.joinDate)}</span>
            <span aria-hidden="true" className="spectre-member-header-sep">|</span>
            <span className="spectre-member-header-number spectre-mono">{member.memberNumber}</span>
            {props.employeeLink && (
              <>
                <span aria-hidden="true" className="spectre-member-header-sep">|</span>
                {props.employeeLink.canNavigate ? (
                  <a
                    href={`/app/admin/people/employees/${props.employeeLink.employeeId}`}
                    className="uppercase-eyebrow"
                    data-testid="member-employee-link"
                  >
                    Also an Employee · {props.employeeLink.employeeNumber}
                  </a>
                ) : (
                  <span className="uppercase-eyebrow" data-testid="member-employee-indicator">
                    Also an Employee
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        <span
          className={`spectre-member-status-pill spectre-member-status-pill--${status.toLowerCase()}`}
          data-testid="member-status-pill"
        >
          {status}
        </span>
      </header>

      {/* ---------------- Primary tabs ---------------- */}
      <nav className="spectre-member-tabs" role="tablist" aria-label="Member sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`spectre-member-tab${tab === t.key ? " is-active" : ""}`}
            data-testid={`member-tab-${t.key}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          className="spectre-member-tab-overflow"
          aria-label="More sections"
          title="More sections — additional actions live in a future phase."
          disabled
        >
          …
        </button>
      </nav>

      {/* ---------------- Tab body ---------------- */}
      {tab === "member" ? (
        <section className="spectre-member-body" data-testid="member-tab-body">
          <h2 className="spectre-member-section-title">Member info</h2>

          {/* Person switcher */}
          <div className="spectre-member-person-switcher" role="tablist" aria-label="People on this membership">
            {people.map((p) => (
              <Link
                key={p.switcherKey}
                href={`/app/admin/members/${member.id}?person=${p.switcherKey === "primary" ? "" : p.switcherKey}&tab=member`}
                scroll={false}
                role="tab"
                aria-selected={activeKey === p.switcherKey}
                className={`spectre-member-person${activeKey === p.switcherKey ? " is-active" : ""}`}
                data-testid={`member-person-${p.switcherKey}`}
              >
                {personLabel(p)}
                {!p.isPrimary ? (
                  <form
                    action={actions.removeAssociatedPerson}
                    className="spectre-member-person-remove"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input type="hidden" name="householdId" value={p.id ?? ""} />
                    <button
                      type="submit"
                      aria-label={`Remove ${personLabel(p)}`}
                      title={`Remove ${personLabel(p)}`}
                      className="spectre-member-person-remove-btn"
                    >
                      <IconClose size={12} />
                    </button>
                  </form>
                ) : null}
              </Link>
            ))}
            {addingPerson ? (
              <form
                action={actions.addAssociatedPerson}
                className="spectre-member-person-add-form"
                onSubmit={() => setAddingPerson(false)}
              >
                <input name="firstName" placeholder="First name" required maxLength={100} />
                <input name="lastName" placeholder="Last name" required maxLength={100} />
                <select name="relationship" defaultValue="SPOUSE">
                  <option value="SPOUSE">Spouse</option>
                  <option value="PARTNER">Partner</option>
                  <option value="CHILD">Child</option>
                  <option value="OTHER">Other</option>
                </select>
                <button type="submit" className="spectre-btn spectre-btn--sm spectre-btn--primary">Add</button>
                <button type="button" className="spectre-btn spectre-btn--sm spectre-btn--ghost" onClick={() => setAddingPerson(false)}>Cancel</button>
              </form>
            ) : (
              <button
                type="button"
                className="spectre-member-person-add"
                onClick={() => setAddingPerson(true)}
                data-testid="member-add-person"
              >
                + add member
              </button>
            )}
          </div>

          {/* Two-column body: LEFT = details + other + additional
              RIGHT = picture + groups. Follows the reference. */}
          <div className="spectre-member-columns">
            <div className="spectre-member-col-left">
              {/* BASIC DETAILS */}
              <div className="spectre-member-section" data-testid="member-basic-details">
                <div className="spectre-member-section-head">
                  <h3 className="spectre-member-eyebrow">Basic Details</h3>
                  {activePerson.isPrimary ? (
                    <button
                      type="button"
                      className="spectre-member-edit"
                      aria-label="Edit basic details"
                      onClick={() => setEditingBasic((v) => !v)}
                      data-testid="member-edit-basic"
                    >
                      <IconEdit size={12} />
                    </button>
                  ) : null}
                </div>
                {activePerson.isPrimary && editingBasic ? (
                  <form
                    action={actions.editPrimaryDetails}
                    className="spectre-member-edit-form"
                    onSubmit={() => setEditingBasic(false)}
                  >
                    <BasicEditRow label="First Name"    name="firstName"  defaultValue={member.firstName ?? ""} />
                    <BasicEditRow label="Middle Name"   name="middleName" defaultValue={member.middleName ?? ""} />
                    <BasicEditRow label="Last Name"     name="lastName"   defaultValue={member.lastName ?? ""} />
                    <BasicEditRow label="Email"         name="email"      defaultValue={member.email ?? ""} type="email" />
                    <BasicEditRow label="Mobile"        name="phone"      defaultValue={member.phone ?? ""} />
                    <BasicEditRow label="Home Phone"    name="homePhone"  defaultValue={member.homePhone ?? ""} />
                    <BasicEditRow label="Gender"        name="gender"     defaultValue={member.gender ?? ""} />
                    <BasicEditRow label="Date of Birth" name="dateOfBirth" defaultValue={member.dateOfBirth?.slice(0, 10) ?? ""} type="date" />
                    <BasicEditRow label="Salutation"    name="salutation" defaultValue={member.salutation ?? ""} />
                    <BasicEditRow label="Nickname"      name="nickname"   defaultValue={member.nickname ?? ""} />
                    <div className="spectre-member-edit-form-actions">
                      <button type="submit" className="spectre-btn spectre-btn--sm spectre-btn--primary">Save</button>
                      <button type="button" className="spectre-btn spectre-btn--sm spectre-btn--ghost" onClick={() => setEditingBasic(false)}>Cancel</button>
                    </div>
                  </form>
                ) : (
                  <dl className="spectre-member-grid">
                    <BasicRow label="First Name" value={activePerson.firstName} />
                    <BasicRow label="Middle Name" value={activePerson.middleName} />
                    <BasicRow label="Last Name" value={activePerson.lastName} />
                    <BasicRow label="Email" value={activePerson.email} kind="email" />
                    <BasicRow label="Mobile" value={activePerson.phone} kind="phone" />
                    <BasicRow label="Home Phone" value={activePerson.homePhone} kind="phone" />
                    <BasicRow label="Gender" value={activePerson.gender} />
                    <BasicRow label="Relationship" value={activePerson.isPrimary ? "Primary member" : (activePerson.relationship ?? "")} />
                    <BasicRow label="Date of Birth" value={formatDate(activePerson.dateOfBirth)} raw />
                    <BasicRow label="Salutation" value={activePerson.salutation} />
                    <BasicRow label="Nickname/Preferred Name" value={activePerson.nickname} />
                  </dl>
                )}
              </div>

              {/* OTHER INFORMATION */}
              <div className="spectre-member-section" data-testid="member-other-info">
                <div className="spectre-member-section-head">
                  <h3 className="spectre-member-eyebrow">Other Information</h3>
                </div>
                <dl className="spectre-member-grid">
                  <BasicRow label="Member Code" value={member.memberNumber} raw />
                  <BasicRow label="Category" value={member.membershipCategory} />
                </dl>
              </div>

              {/* ADDITIONAL INFORMATION (custom fields) */}
              <div className="spectre-member-section" data-testid="member-additional-info">
                <div className="spectre-member-section-head">
                  <h3 className="spectre-member-eyebrow">Additional Information</h3>
                </div>
                {customFields.length === 0 ? (
                  <p className="spectre-member-empty-note">No additional fields have been defined for this club yet.</p>
                ) : (
                  <dl className="spectre-member-grid">
                    {customFields.map((f) => (
                      <div key={f.id} className="spectre-member-row">
                        <dt>{f.label}</dt>
                        <dd>
                          {editingCustomKey === f.key ? (
                            <form
                              action={actions.setCustomField}
                              className="spectre-member-custom-form"
                              onSubmit={() => setEditingCustomKey(null)}
                            >
                              <input type="hidden" name="definitionId" value={f.id} />
                              <input name="valueText" defaultValue={f.valueText ?? ""} maxLength={2000} />
                              <button type="submit" className="spectre-btn spectre-btn--sm spectre-btn--primary">Save</button>
                              <button type="button" className="spectre-btn spectre-btn--sm spectre-btn--ghost" onClick={() => setEditingCustomKey(null)}>Cancel</button>
                            </form>
                          ) : (
                            <>
                              <span className={f.valueText ? "" : "spectre-member-not-provided"}>{formatValue(f.valueText)}</span>
                              <button
                                type="button"
                                className="spectre-member-inline-edit"
                                aria-label={`Edit ${f.label}`}
                                onClick={() => setEditingCustomKey(f.key)}
                              >
                                <IconEdit size={11} />
                              </button>
                            </>
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            </div>

            {/* Right column */}
            <div className="spectre-member-col-right">
              {/* MEMBER PICTURE */}
              <div className="spectre-member-section" data-testid="member-picture">
                <div className="spectre-member-section-head">
                  <h3 className="spectre-member-eyebrow">Member Picture</h3>
                </div>
                <div className="spectre-member-picture-wrap">
                  {activePerson.profileImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={activePerson.profileImageUrl} alt="" className="spectre-member-picture" />
                  ) : (
                    <div className="spectre-member-picture spectre-member-picture--placeholder">
                      <span>{initials(activePerson.firstName, activePerson.lastName)}</span>
                    </div>
                  )}
                  <p className="spectre-member-picture-hint">Photo upload lands in a follow-up phase.</p>
                </div>
              </div>

              {/* GROUPS */}
              <div className="spectre-member-section" data-testid="member-groups">
                <div className="spectre-member-section-head">
                  <h3 className="spectre-member-eyebrow">Groups</h3>
                </div>
                <div className="spectre-member-groups">
                  {assignedGroups.length === 0 && !addingGroup ? (
                    <p className="spectre-member-empty-note">No groups assigned.</p>
                  ) : null}
                  {assignedGroups.map((g) => (
                    <form
                      key={g.groupId}
                      action={actions.removeGroup}
                      className="spectre-member-chip"
                      data-testid="member-group-chip"
                    >
                      <input type="hidden" name="groupId" value={g.groupId} />
                      <span>{g.name.toUpperCase()}</span>
                      <button
                        type="submit"
                        aria-label={`Remove ${g.name}`}
                        title={`Remove ${g.name}`}
                        className="spectre-member-chip-remove"
                      >
                        <IconClose size={11} />
                      </button>
                    </form>
                  ))}
                  {addingGroup ? (
                    <form
                      action={actions.addGroup}
                      className="spectre-member-group-add-form"
                      onSubmit={() => setAddingGroup(false)}
                    >
                      <input
                        list="spectre-member-group-options"
                        name="name"
                        placeholder="Group name"
                        maxLength={64}
                        required
                        autoFocus
                      />
                      <datalist id="spectre-member-group-options">
                        {availableGroups.map((g) => <option key={g.id} value={g.name} />)}
                      </datalist>
                      <button type="submit" className="spectre-btn spectre-btn--sm spectre-btn--primary">Add</button>
                      <button type="button" className="spectre-btn spectre-btn--sm spectre-btn--ghost" onClick={() => setAddingGroup(false)}>Cancel</button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="spectre-member-chip spectre-member-chip--add"
                      onClick={() => setAddingGroup(true)}
                      data-testid="member-add-group"
                    >
                      <IconPlus size={11} /> ADD GROUP
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="spectre-member-body">
          <div className="spectre-member-placeholder-tab">
            <h2>{TABS.find((t) => t.key === tab)?.label ?? "Section"}</h2>
            <p>
              This section is scheduled for a subsequent phase.
              The founder-facing member data model + Member tab
              landed first so the full profile experience can be
              built out deliberately.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}

function BasicRow({
  label,
  value,
  raw,
  kind,
}: {
  label: string;
  value: string | null | undefined;
  raw?: boolean;
  kind?: "email" | "phone";
}) {
  const display = raw ? (value ?? "—") : formatValue(value);
  const isMissing = !raw && !(value && value.trim().length);
  return (
    <div className="spectre-member-row">
      <dt>{label}</dt>
      <dd>
        {isMissing ? (
          <span className="spectre-member-not-provided">Not provided</span>
        ) : kind === "email" && value ? (
          <a href={`mailto:${value}`} className="spectre-member-link">{value}</a>
        ) : kind === "phone" && value ? (
          <a href={`tel:${value}`} className="spectre-member-link">{value}</a>
        ) : (
          display
        )}
      </dd>
    </div>
  );
}

function BasicEditRow({
  label,
  name,
  defaultValue,
  type = "text",
}: {
  label: string;
  name: string;
  defaultValue: string;
  type?: "text" | "email" | "date";
}) {
  return (
    <div className="spectre-member-row">
      <label htmlFor={`me-${name}`}>{label}</label>
      <input
        id={`me-${name}`}
        name={name}
        type={type}
        defaultValue={defaultValue}
        maxLength={type === "email" ? 254 : 100}
        className="spectre-member-edit-input"
      />
    </div>
  );
}
