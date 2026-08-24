"use client";

// HR-2C Portal Refinement (2026-08-24) — Employee-side Profile
// self-service inline forms.
//
// Two small forms, each guarded by an Edit affordance so the read
// state stays dense and calm. Both delegate to server actions in
// `_actions.ts`, which delegate to canonical portal self-service
// helpers. No admin permissions granted.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface ActionOk { ok: true }
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
