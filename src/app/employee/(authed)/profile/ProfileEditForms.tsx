"use client";

// HR-2C Portal Refinement (2026-08-24 / expanded 2026-08-28) —
// Employee-side Profile self-service inline forms.
//
// Sections:
//   * PersonalContactSection — email + mobile
//   * AddressSection         — home / mailing address (6 fields)
//   * EmergencyContactSection — primary emergency contact
//   * DirectDepositSection   — masked view + secure replacement
//
// Each section is guarded by an Edit affordance so the read state
// stays dense and calm. All delegate to server actions in
// `_actions.ts`, which delegate to canonical portal self-service
// helpers. No admin permissions granted at any point.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface ActionOk<T = void> { ok: true; result?: T }
interface ActionErr { ok: false; error: string }

// ---------------------------------------------------------------------------
// Personal contact — email + mobile
// ---------------------------------------------------------------------------

interface PersonalContactProps {
  personalEmail: string | null;
  mobilePhone: string | null;
  action: (input: { personalEmail?: string | null; mobilePhone?: string | null }) => Promise<ActionOk | ActionErr>;
}

export function PersonalContactSection({ personalEmail, mobilePhone, action }: PersonalContactProps) {
  const [editing, setEditing] = useState(false);
  const [emailInput, setEmailInput] = useState(personalEmail ?? "");
  const [phoneInput, setPhoneInput] = useState(mobilePhone ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <section
      className="rounded-lg border border-stone-200 bg-white px-6 py-6"
      data-testid="portal-profile-personal-contact"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
          Contact information
        </h2>
        {!editing && (
          <button
            type="button"
            onClick={() => { setEditing(true); setError(null); }}
            className="text-xs underline underline-offset-4 text-stone-600 hover:text-stone-900"
            data-testid="btn-edit-personal-contact"
          >
            Edit
          </button>
        )}
      </div>

      {!editing ? (
        <dl className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Personal email</div>
            <div className="mt-1 text-sm text-club-ink" data-testid="portal-profile-email">
              {personalEmail ?? "—"}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Mobile phone</div>
            <div className="mt-1 text-sm text-club-ink" data-testid="portal-profile-mobile">
              {mobilePhone ?? "—"}
            </div>
          </div>
        </dl>
      ) : (
        <form
          className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4"
          data-testid="edit-personal-contact-form"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              setError(null);
              const result = await action({
                personalEmail: emailInput.trim() || null,
                mobilePhone: phoneInput.trim() || null,
              });
              if (result.ok) { setEditing(false); router.refresh(); }
              else setError(result.error);
            });
          }}
        >
          <label className="text-xs text-stone-500">
            Personal email
            <input
              type="email"
              className="input mt-1 w-full"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              maxLength={254}
              data-testid="edit-personal-email"
              placeholder="you@example.com"
            />
          </label>
          <label className="text-xs text-stone-500">
            Mobile phone
            <input
              type="tel"
              className="input mt-1 w-full"
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              maxLength={32}
              data-testid="edit-personal-mobile"
              placeholder="(555) 555-0100"
            />
          </label>
          {error && (
            <p role="alert" className="text-xs text-red-700 md:col-span-2" data-testid="edit-personal-error">
              {error}
            </p>
          )}
          <div className="md:col-span-2 flex items-center justify-end gap-2">
            <button
              type="button"
              className="text-xs text-stone-500 underline"
              onClick={() => {
                setEditing(false);
                setEmailInput(personalEmail ?? "");
                setPhoneInput(mobilePhone ?? "");
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={pending}
              data-testid="save-personal-contact"
            >
              {pending ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Home / mailing address
// ---------------------------------------------------------------------------

interface AddressValue {
  homeAddressLine1: string | null;
  homeAddressLine2: string | null;
  homeCity: string | null;
  homeProvince: string | null;
  homePostalCode: string | null;
  homeCountry: string | null;
}

interface AddressProps {
  address: AddressValue;
  action: (input: Partial<AddressValue>) => Promise<ActionOk | ActionErr>;
}

const EMPTY_ADDRESS: AddressValue = {
  homeAddressLine1: null, homeAddressLine2: null, homeCity: null,
  homeProvince: null, homePostalCode: null, homeCountry: null,
};

function isAnyAddressSet(a: AddressValue): boolean {
  return Boolean(a.homeAddressLine1 || a.homeAddressLine2 || a.homeCity
    || a.homeProvince || a.homePostalCode || a.homeCountry);
}

export function AddressSection({ address, action }: AddressProps) {
  const hasAny = isAnyAddressSet(address);
  const [editing, setEditing] = useState(!hasAny);
  const [line1, setLine1] = useState(address.homeAddressLine1 ?? "");
  const [line2, setLine2] = useState(address.homeAddressLine2 ?? "");
  const [city, setCity] = useState(address.homeCity ?? "");
  const [province, setProvince] = useState(address.homeProvince ?? "");
  const [postal, setPostal] = useState(address.homePostalCode ?? "");
  const [country, setCountry] = useState(address.homeCountry ?? "CA");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <section
      className="rounded-lg border border-stone-200 bg-white px-6 py-6"
      data-testid="portal-profile-address"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
          Home / mailing address
        </h2>
        {!editing && hasAny && (
          <button
            type="button"
            onClick={() => { setEditing(true); setError(null); }}
            className="text-xs underline underline-offset-4 text-stone-600 hover:text-stone-900"
            data-testid="btn-edit-address"
          >
            Edit
          </button>
        )}
      </div>

      {!editing && hasAny ? (
        <div className="mt-3 text-sm text-club-ink space-y-0.5" data-testid="portal-profile-address-view">
          {address.homeAddressLine1 && <div data-testid="portal-profile-address-line1">{address.homeAddressLine1}</div>}
          {address.homeAddressLine2 && <div>{address.homeAddressLine2}</div>}
          <div>
            {[address.homeCity, address.homeProvince].filter(Boolean).join(", ")}
            {address.homePostalCode && ` ${address.homePostalCode}`}
          </div>
          {address.homeCountry && <div className="text-stone-500 text-xs">{address.homeCountry}</div>}
        </div>
      ) : (
        <form
          className="mt-3 grid grid-cols-1 md:grid-cols-6 gap-x-4 gap-y-3"
          data-testid="edit-address-form"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              setError(null);
              const result = await action({
                homeAddressLine1: line1.trim() || null,
                homeAddressLine2: line2.trim() || null,
                homeCity: city.trim() || null,
                homeProvince: province.trim() || null,
                homePostalCode: postal.trim() || null,
                homeCountry: country.trim() || null,
              });
              if (result.ok) { setEditing(false); router.refresh(); }
              else setError(result.error);
            });
          }}
        >
          <label className="text-xs text-stone-500 md:col-span-6">
            Address line 1
            <input type="text" className="input mt-1 w-full" value={line1}
              onChange={(e) => setLine1(e.target.value)}
              maxLength={200} data-testid="edit-address-line1" />
          </label>
          <label className="text-xs text-stone-500 md:col-span-6">
            Address line 2 (optional)
            <input type="text" className="input mt-1 w-full" value={line2}
              onChange={(e) => setLine2(e.target.value)}
              maxLength={200} data-testid="edit-address-line2" />
          </label>
          <label className="text-xs text-stone-500 md:col-span-3">
            City
            <input type="text" className="input mt-1 w-full" value={city}
              onChange={(e) => setCity(e.target.value)}
              maxLength={100} data-testid="edit-address-city" />
          </label>
          <label className="text-xs text-stone-500 md:col-span-1">
            Province / State
            <input type="text" className="input mt-1 w-full uppercase" value={province}
              onChange={(e) => setProvince(e.target.value)}
              maxLength={32} data-testid="edit-address-province" />
          </label>
          <label className="text-xs text-stone-500 md:col-span-1">
            Postal / ZIP
            <input type="text" className="input mt-1 w-full uppercase" value={postal}
              onChange={(e) => setPostal(e.target.value)}
              maxLength={16} data-testid="edit-address-postal" />
          </label>
          <label className="text-xs text-stone-500 md:col-span-1">
            Country
            <input type="text" className="input mt-1 w-full uppercase" value={country}
              onChange={(e) => setCountry(e.target.value)}
              maxLength={2} data-testid="edit-address-country" placeholder="CA" />
          </label>
          {error && (
            <p role="alert" className="text-xs text-red-700 md:col-span-6" data-testid="edit-address-error">
              {error}
            </p>
          )}
          <div className="md:col-span-6 flex items-center justify-end gap-2">
            {hasAny && (
              <button
                type="button"
                className="text-xs text-stone-500 underline"
                onClick={() => {
                  setEditing(false);
                  setLine1(address.homeAddressLine1 ?? "");
                  setLine2(address.homeAddressLine2 ?? "");
                  setCity(address.homeCity ?? "");
                  setProvince(address.homeProvince ?? "");
                  setPostal(address.homePostalCode ?? "");
                  setCountry(address.homeCountry ?? "CA");
                }}
              >
                Cancel
              </button>
            )}
            <button type="submit" className="btn btn-primary btn-sm"
              disabled={pending} data-testid="save-address">
              {pending ? "Saving…" : hasAny ? "Save changes" : "Add address"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Emergency contact — primary
// ---------------------------------------------------------------------------

interface EmergencyProps {
  contact: { name: string; relation: string; phone: string; email: string | null } | null;
  action: (input: { name: string; relation: string; phone: string; email?: string | null }) => Promise<ActionOk | ActionErr>;
}

export function EmergencyContactSection({ contact, action }: EmergencyProps) {
  const [editing, setEditing] = useState(contact === null);
  const [name, setName] = useState(contact?.name ?? "");
  const [relation, setRelation] = useState(contact?.relation ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <section
      className="rounded-lg border border-stone-200 bg-white px-6 py-6"
      data-testid="portal-profile-emergency-contact"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
          Emergency contact
        </h2>
        {!editing && contact && (
          <button
            type="button"
            onClick={() => { setEditing(true); setError(null); }}
            className="text-xs underline underline-offset-4 text-stone-600 hover:text-stone-900"
            data-testid="btn-edit-emergency-contact"
          >
            Edit
          </button>
        )}
      </div>

      {!editing && contact ? (
        <dl className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Name</div>
            <div className="mt-1 text-sm text-club-ink" data-testid="portal-profile-emergency-name">{contact.name}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Relationship</div>
            <div className="mt-1 text-sm text-club-ink">{contact.relation}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Phone</div>
            <div className="mt-1 text-sm text-club-ink" data-testid="portal-profile-emergency-phone">{contact.phone}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Email</div>
            <div className="mt-1 text-sm text-club-ink">{contact.email ?? "—"}</div>
          </div>
        </dl>
      ) : (
        <form
          className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4"
          data-testid="edit-emergency-contact-form"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              setError(null);
              const result = await action({ name, relation, phone, email: email.trim() || null });
              if (result.ok) { setEditing(false); router.refresh(); }
              else setError(result.error);
            });
          }}
        >
          <label className="text-xs text-stone-500">
            Name
            <input type="text" required maxLength={120} className="input mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} data-testid="edit-emergency-name" />
          </label>
          <label className="text-xs text-stone-500">
            Relationship
            <input type="text" required maxLength={60} className="input mt-1 w-full" value={relation} onChange={(e) => setRelation(e.target.value)} data-testid="edit-emergency-relation" />
          </label>
          <label className="text-xs text-stone-500">
            Phone
            <input type="tel" required maxLength={32} className="input mt-1 w-full" value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="edit-emergency-phone" />
          </label>
          <label className="text-xs text-stone-500">
            Email (optional)
            <input type="email" maxLength={254} className="input mt-1 w-full" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="edit-emergency-email" />
          </label>
          {error && (
            <p role="alert" className="text-xs text-red-700 md:col-span-2" data-testid="edit-emergency-error">
              {error}
            </p>
          )}
          <div className="md:col-span-2 flex items-center justify-end gap-2">
            {contact && (
              <button
                type="button"
                className="text-xs text-stone-500 underline"
                onClick={() => {
                  setEditing(false);
                  setName(contact.name); setRelation(contact.relation);
                  setPhone(contact.phone); setEmail(contact.email ?? "");
                }}
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={pending}
              data-testid="save-emergency-contact"
            >
              {pending ? "Saving…" : contact ? "Save changes" : "Add emergency contact"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Direct deposit — masked read + secure replacement
// ---------------------------------------------------------------------------

interface DirectDepositProps {
  masked: { accountMasked: string; holderName: string; status: string } | null;
  action: (input: { holderName: string; institutionNumber: string; transitNumber: string; accountNumber: string }) => Promise<ActionOk | ActionErr>;
}

function statusLabel(status: string): string {
  switch (status) {
    case "PENDING_PENNY_TEST": return "Awaiting Club verification";
    case "VERIFIED": return "Verified";
    case "REJECTED": return "Rejected — please resubmit";
    case "INACTIVE": return "Inactive";
    default: return status;
  }
}

export function DirectDepositSection({ masked, action }: DirectDepositProps) {
  const [editing, setEditing] = useState(false);
  const [holderName, setHolderName] = useState(masked?.holderName ?? "");
  const [inst, setInst] = useState("");
  const [transit, setTransit] = useState("");
  const [acct, setAcct] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const openEditor = () => {
    setInst(""); setTransit(""); setAcct("");
    setError(null); setEditing(true);
  };

  return (
    <section
      className="rounded-lg border border-stone-200 bg-white px-6 py-6"
      data-testid="portal-profile-banking"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
          Direct deposit
        </h2>
        {!editing && (
          <button
            type="button"
            onClick={openEditor}
            className="text-xs underline underline-offset-4 text-stone-600 hover:text-stone-900"
            data-testid="btn-change-direct-deposit"
          >
            {masked ? "Change direct deposit" : "Add direct deposit"}
          </button>
        )}
      </div>

      {!editing ? (
        <dl className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-x-8 gap-y-4">
          {masked ? (
            <>
              <div>
                <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Account</div>
                <div className="mt-1 text-sm text-club-ink font-mono" data-testid="portal-profile-banking-masked">
                  {masked.accountMasked}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Name on account</div>
                <div className="mt-1 text-sm text-club-ink" data-testid="portal-profile-banking-holder">
                  {masked.holderName}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Status</div>
                <div className="mt-1 text-sm text-club-ink" data-testid="portal-profile-banking-status">
                  {statusLabel(masked.status)}
                </div>
              </div>
            </>
          ) : (
            <div className="md:col-span-3 text-sm text-stone-500" data-testid="portal-profile-banking-empty">
              No direct deposit on file. Add your banking information so
              your Club can pay you electronically.
            </div>
          )}
        </dl>
      ) : (
        <form
          className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-x-4 gap-y-3"
          data-testid="edit-direct-deposit-form"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              setError(null);
              const result = await action({
                holderName: holderName.trim(),
                institutionNumber: inst.trim(),
                transitNumber: transit.trim(),
                accountNumber: acct.trim(),
              });
              if (result.ok) {
                setEditing(false);
                setInst(""); setTransit(""); setAcct("");
                router.refresh();
              } else setError(result.error);
            });
          }}
        >
          <label className="text-xs text-stone-500 md:col-span-3">
            Name on account
            <input type="text" required maxLength={200} className="input mt-1 w-full"
              value={holderName} onChange={(e) => setHolderName(e.target.value)}
              data-testid="edit-direct-deposit-holder" />
          </label>
          <label className="text-xs text-stone-500">
            Institution number (3 digits)
            <input type="text" required inputMode="numeric" className="input mt-1 w-full font-mono"
              value={inst} onChange={(e) => setInst(e.target.value)}
              placeholder="001" maxLength={5}
              data-testid="edit-direct-deposit-institution" />
          </label>
          <label className="text-xs text-stone-500">
            Transit number (5 digits)
            <input type="text" required inputMode="numeric" className="input mt-1 w-full font-mono"
              value={transit} onChange={(e) => setTransit(e.target.value)}
              placeholder="12345" maxLength={7}
              data-testid="edit-direct-deposit-transit" />
          </label>
          <label className="text-xs text-stone-500">
            Account number (7–12 digits)
            <input type="text" required inputMode="numeric" className="input mt-1 w-full font-mono"
              value={acct} onChange={(e) => setAcct(e.target.value)}
              placeholder="1234567" maxLength={14}
              data-testid="edit-direct-deposit-account" />
          </label>
          <p className="md:col-span-3 text-xs text-stone-500" data-testid="edit-direct-deposit-notice">
            {masked && masked.status === "VERIFIED"
              ? "Your current account will remain on file until the new one is verified by your Club, then it will be replaced automatically."
              : "Your Club will verify these details before your first electronic deposit."}
          </p>
          {error && (
            <p role="alert" className="text-xs text-red-700 md:col-span-3" data-testid="edit-direct-deposit-error">
              {error}
            </p>
          )}
          <div className="md:col-span-3 flex items-center justify-end gap-2">
            <button
              type="button"
              className="text-xs text-stone-500 underline"
              onClick={() => { setEditing(false); setInst(""); setTransit(""); setAcct(""); }}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary btn-sm"
              disabled={pending} data-testid="save-direct-deposit">
              {pending ? "Submitting…" : masked ? "Submit replacement" : "Submit direct deposit"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
