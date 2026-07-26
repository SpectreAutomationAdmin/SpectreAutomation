"use client";

import { useFormState, useFormStatus } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { saveClubProfileAction } from "./_actions";

type ProfileShape = {
  legalName: string | null;
  operatingName: string | null;
  yearFounded: number | null;
  businessNumber: string | null;
  gstNumber: string | null;
  fiscalYearEndMonth: number | null;
  fiscalYearEndDay: number | null;
  mailingAddress: string | null;
  physicalAddress: string | null;
  city: string | null;
  provinceState: string | null;
  mainPhone: string | null;
  generalEmail: string | null;
  websiteUrl: string | null;
  primaryContactName: string | null;
  primaryContactTitle: string | null;
  primaryContactEmail: string | null;
  primaryContactPhone: string | null;
  gstStatus: string | null;
  gstFilingFrequency: string | null;
  defaultGstRatePct: { toString(): string } | null;
  defaultCurrency: string | null;
  defaultArAccountId: string | null;
  defaultApAccountId: string | null;
  defaultRetainedEarningsAccountId: string | null;
  defaultCurrentYearEarningsAccountId: string | null;
  defaultOperatingBankAccountId: string | null;
  defaultReserveBankAccountId: string | null;
  defaultMemberReceivablesAccountId: string | null;
  defaultSalesTaxPayableAccountId: string | null;
};

type AccountOption = {
  id: string;
  accountNumber: string;
  name: string;
  type: string;
};

const initialState = { status: "idle" as const };

export function ClubSettingsForm({
  profile,
  accounts,
  canWrite,
}: {
  profile: ProfileShape | null;
  accounts: AccountOption[];
  canWrite: boolean;
}) {
  const [state, formAction] = useFormState(saveClubProfileAction, initialState);
  const formRef = useRef<HTMLFormElement>(null);
  const statusBannerRef = useRef<HTMLDivElement>(null);
  const [dirty, setDirty] = useState(false);

  // On save FAILURE, scroll the error banner into view + focus it.
  // The form is long; if a user only changed the bottom (e.g. the
  // fiscal-year-end fields) and validation failed on a stale field
  // higher up (e.g. GST rate), they could otherwise miss the red
  // banner at the top and walk away thinking the save succeeded.
  useEffect(() => {
    if (state.status === "error" && statusBannerRef.current) {
      statusBannerRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
      statusBannerRef.current.focus();
    }
  }, [state]);

  // Prevent accidental loss of unsaved changes. The browser will show
  // its native "leave site?" prompt while `dirty === true`.
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  // Clear dirty state once a save succeeds.
  useEffect(() => {
    if (state.status === "ok") setDirty(false);
  }, [state.status]);

  const fieldError = (name: string) => state.fieldErrors?.[name];

  const v = (key: keyof ProfileShape) => {
    const val = profile?.[key];
    if (val === null || val === undefined) return "";
    if (typeof val === "object" && val !== null && "toString" in val) return val.toString();
    return String(val);
  };

  return (
    <form
      ref={formRef}
      action={formAction}
      onChange={() => setDirty(true)}
      className="mt-6 space-y-8"
      data-testid="club-settings-form"
    >
      {/* status banner */}
      {state.status === "ok" ? (
        <div
          role="status"
          data-testid="club-settings-save-ok"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
        >
          {state.message ?? "Saved."}
        </div>
      ) : null}
      {state.status === "error" ? (
        <div
          ref={statusBannerRef}
          role="alert"
          tabIndex={-1}
          data-testid="club-settings-save-error"
          className="rounded-md border-2 border-red-400 bg-red-50 px-4 py-3 text-sm font-medium text-red-900 outline-none ring-2 ring-red-200 focus:ring-red-400"
        >
          <p>{state.message ?? "Could not save."}</p>
          {state.fieldErrors && Object.keys(state.fieldErrors).length > 0 ? (
            <ul className="mt-2 list-disc pl-5 text-xs">
              {Object.entries(state.fieldErrors).map(([field, msg]) => (
                <li key={field}>
                  <span className="font-mono">{field}</span>: {msg}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-2 text-xs opacity-80">
            Your save was NOT persisted. Fix the issues above and click Save
            again — the database still holds the previous values.
          </p>
        </div>
      ) : null}

      {/* 1. Club Identity */}
      <FormSection title="Club Identity" description="Names + registration the rest of the system uses on letterheads, reports, and invoices.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Legal name" name="legalName" defaultValue={v("legalName")} error={fieldError("legalName")} />
          <Field label="Operating / display name" name="operatingName" defaultValue={v("operatingName")} error={fieldError("operatingName")} />
          <Field label="Year founded" name="yearFounded" type="number" defaultValue={v("yearFounded")} error={fieldError("yearFounded")} hint="Cannot be in the future." />
          <Field label="Business number" name="businessNumber" defaultValue={v("businessNumber")} error={fieldError("businessNumber")} hint="9 digits, optionally followed by program/reference (e.g. 123456789 RT0001)." />
        </div>
      </FormSection>

      {/* 2. Address & Contact */}
      <FormSection title="Address & Contact">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Mailing address" name="mailingAddress" defaultValue={v("mailingAddress")} error={fieldError("mailingAddress")} multiline />
          <Field label="Physical address (if different)" name="physicalAddress" defaultValue={v("physicalAddress")} error={fieldError("physicalAddress")} multiline />
          <Field label="City" name="city" defaultValue={v("city")} error={fieldError("city")} hint="Shown on the Monthly Reporting Package cover (CITY, PROVINCE · EST. YEAR)." />
          <Field label="Province / State" name="provinceState" defaultValue={v("provinceState")} error={fieldError("provinceState")} />
          <Field label="Main phone" name="mainPhone" defaultValue={v("mainPhone")} error={fieldError("mainPhone")} />
          <Field label="General email" name="generalEmail" type="email" defaultValue={v("generalEmail")} error={fieldError("generalEmail")} />
          <Field label="Website URL" name="websiteUrl" type="url" defaultValue={v("websiteUrl")} error={fieldError("websiteUrl")} hint="https:// will be auto-added if you enter a bare domain." />
        </div>
        <div className="mt-2 text-xs font-medium uppercase tracking-wide text-stone-500">Primary contact</div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Name" name="primaryContactName" defaultValue={v("primaryContactName")} error={fieldError("primaryContactName")} />
          <Field label="Title" name="primaryContactTitle" defaultValue={v("primaryContactTitle")} error={fieldError("primaryContactTitle")} />
          <Field label="Email" name="primaryContactEmail" type="email" defaultValue={v("primaryContactEmail")} error={fieldError("primaryContactEmail")} />
          <Field label="Phone" name="primaryContactPhone" defaultValue={v("primaryContactPhone")} error={fieldError("primaryContactPhone")} />
        </div>
      </FormSection>

      {/* 3. Tax Registration */}
      <FormSection title="Tax Registration">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="GST/HST number" name="gstNumber" defaultValue={v("gstNumber")} error={fieldError("gstNumber")} hint="9 digits, optionally followed by RT and 4 digits." />
          <SelectField
            label="GST/HST registration status"
            name="gstStatus"
            defaultValue={v("gstStatus")}
            error={fieldError("gstStatus")}
            options={[
              { value: "", label: "—" },
              { value: "REGISTERED", label: "Registered" },
              { value: "NOT_REGISTERED", label: "Not registered" },
              { value: "SMALL_SUPPLIER", label: "Small supplier" },
            ]}
          />
          <SelectField
            label="Filing frequency"
            name="gstFilingFrequency"
            defaultValue={v("gstFilingFrequency")}
            error={fieldError("gstFilingFrequency")}
            options={[
              { value: "", label: "—" },
              { value: "MONTHLY", label: "Monthly" },
              { value: "QUARTERLY", label: "Quarterly" },
              { value: "ANNUAL", label: "Annual" },
            ]}
          />
          <Field label="Default GST/HST rate (%)" name="defaultGstRatePct" defaultValue={v("defaultGstRatePct")} error={fieldError("defaultGstRatePct")} hint="e.g. 5 or 12.50" />
        </div>
      </FormSection>

      {/* 4. Fiscal Year & Reporting */}
      <FormSection title="Fiscal Year & Reporting" description="Drives the Period N of 12 label on every reporting screen.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <SelectField
            label="Fiscal year end — month"
            name="fiscalYearEndMonth"
            defaultValue={v("fiscalYearEndMonth")}
            error={fieldError("fiscalYearEndMonth")}
            options={[
              { value: "", label: "—" },
              { value: "1", label: "January" }, { value: "2", label: "February" },
              { value: "3", label: "March" }, { value: "4", label: "April" },
              { value: "5", label: "May" }, { value: "6", label: "June" },
              { value: "7", label: "July" }, { value: "8", label: "August" },
              { value: "9", label: "September" }, { value: "10", label: "October" },
              { value: "11", label: "November" }, { value: "12", label: "December" },
            ]}
          />
          <Field label="Fiscal year end — day" name="fiscalYearEndDay" type="number" defaultValue={v("fiscalYearEndDay")} error={fieldError("fiscalYearEndDay")} hint="1–31, must form a valid calendar day." />
          <Field label="Default reporting currency" name="defaultCurrency" defaultValue={v("defaultCurrency")} error={fieldError("defaultCurrency")} hint="3-letter ISO 4217 code (CAD, USD, …)." />
        </div>
      </FormSection>

      {/* 5. Accounting Defaults */}
      <FormSection title="Accounting Defaults" description="Default chart-of-account targets used by posting routines. Each list shows only this club's accounts.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <AccountSelect label="Default A/R control account" name="defaultArAccountId" defaultValue={v("defaultArAccountId")} accounts={accounts} error={fieldError("defaultArAccountId")} />
          <AccountSelect label="Default A/P control account" name="defaultApAccountId" defaultValue={v("defaultApAccountId")} accounts={accounts} error={fieldError("defaultApAccountId")} />
          <AccountSelect label="Default retained earnings" name="defaultRetainedEarningsAccountId" defaultValue={v("defaultRetainedEarningsAccountId")} accounts={accounts} error={fieldError("defaultRetainedEarningsAccountId")} />
          <AccountSelect label="Default current year earnings" name="defaultCurrentYearEarningsAccountId" defaultValue={v("defaultCurrentYearEarningsAccountId")} accounts={accounts} error={fieldError("defaultCurrentYearEarningsAccountId")} />
          <AccountSelect label="Default operating bank account" name="defaultOperatingBankAccountId" defaultValue={v("defaultOperatingBankAccountId")} accounts={accounts} error={fieldError("defaultOperatingBankAccountId")} />
          <AccountSelect label="Default capital reserve bank account" name="defaultReserveBankAccountId" defaultValue={v("defaultReserveBankAccountId")} accounts={accounts} error={fieldError("defaultReserveBankAccountId")} />
          <AccountSelect label="Default member receivables" name="defaultMemberReceivablesAccountId" defaultValue={v("defaultMemberReceivablesAccountId")} accounts={accounts} error={fieldError("defaultMemberReceivablesAccountId")} />
          <AccountSelect label="Default sales tax payable" name="defaultSalesTaxPayableAccountId" defaultValue={v("defaultSalesTaxPayableAccountId")} accounts={accounts} error={fieldError("defaultSalesTaxPayableAccountId")} />
        </div>
      </FormSection>

      <div className="flex justify-end gap-3">
        <SubmitButton disabled={!canWrite} />
      </div>
    </form>
  );
}

function FormSection({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <fieldset className="card card-body space-y-4">
      <legend className="flex flex-col gap-1 px-1">
        <span className="text-base font-medium text-stone-900">{title}</span>
        {description ? <span className="text-xs text-stone-500">{description}</span> : null}
      </legend>
      {children}
    </fieldset>
  );
}

function Field({
  label, name, defaultValue, error, hint, type = "text", multiline = false,
}: {
  label: string; name: string; defaultValue?: string; error?: string;
  hint?: string; type?: string; multiline?: boolean;
}) {
  return (
    <div>
      <label className="label" htmlFor={`field-${name}`}>{label}</label>
      {multiline ? (
        <textarea id={`field-${name}`} name={name} defaultValue={defaultValue} rows={2} className="input" data-testid={`field-${name}`} />
      ) : (
        <input id={`field-${name}`} name={name} defaultValue={defaultValue} type={type} className="input" data-testid={`field-${name}`} />
      )}
      {hint ? <div className="mt-1 text-xs text-stone-500">{hint}</div> : null}
      {error ? <div role="alert" className="mt-1 text-xs text-red-700" data-testid={`field-${name}-error`}>{error}</div> : null}
    </div>
  );
}

function SelectField({
  label, name, defaultValue, options, error,
}: {
  label: string; name: string; defaultValue?: string; error?: string;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div>
      <label className="label" htmlFor={`field-${name}`}>{label}</label>
      <select id={`field-${name}`} name={name} defaultValue={defaultValue} className="input" data-testid={`field-${name}`}>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      {error ? <div role="alert" className="mt-1 text-xs text-red-700" data-testid={`field-${name}-error`}>{error}</div> : null}
    </div>
  );
}

function AccountSelect({
  label, name, defaultValue, accounts, error,
}: {
  label: string; name: string; defaultValue?: string;
  accounts: AccountOption[]; error?: string;
}) {
  return (
    <SelectField
      label={label}
      name={name}
      defaultValue={defaultValue}
      error={error}
      options={[
        { value: "", label: "—" },
        ...accounts.map((a) => ({
          value: a.id,
          label: `${a.accountNumber} · ${a.name}`,
        })),
      ]}
    />
  );
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="btn btn-primary"
      data-testid="club-settings-save"
    >
      {pending ? "Saving…" : "Save changes"}
    </button>
  );
}
