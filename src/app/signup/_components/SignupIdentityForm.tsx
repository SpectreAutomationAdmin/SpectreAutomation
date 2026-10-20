"use client";

// SIGNUP-1 — Screen 1 identity form (client component, native
// controls, keyboard-accessible).  Submits as multipart form data
// to /api/signup/start.  Error state is read from URL query by the
// server page.

import { useState, type FormEvent } from "react";

interface Props {
  provinces: string[];
}

const PROVINCE_NAMES: Record<string, string> = {
  AB: "Alberta",
  BC: "British Columbia",
  MB: "Manitoba",
  NB: "New Brunswick",
  NL: "Newfoundland and Labrador",
  NS: "Nova Scotia",
  ON: "Ontario",
  PE: "Prince Edward Island",
  QC: "Quebec",
  SK: "Saskatchewan",
  NT: "Northwest Territories",
  NU: "Nunavut",
  YT: "Yukon",
};

export function SignupIdentityForm({ provinces }: Props) {
  const [pending, setPending] = useState(false);

  function handleSubmit(_e: FormEvent<HTMLFormElement>) {
    // Native form submission; just lock the button to prevent
    // double-submission.
    setPending(true);
  }

  return (
    <form
      className="signup-form"
      method="POST"
      action="/api/signup/start"
      onSubmit={handleSubmit}
      data-testid="signup-identity-form"
      noValidate
    >
      <div className="signup-field span-2">
        <label htmlFor="legalName">Legal organization name</label>
        <input
          id="legalName"
          name="legalName"
          type="text"
          required
          minLength={2}
          maxLength={200}
          autoComplete="organization"
          data-testid="signup-input-legalName"
        />
        <span className="signup-hint">
          The name on your incorporation / registration documents.
        </span>
      </div>

      <div className="signup-field span-2">
        <label htmlFor="operatingName">Operating / display name <span style={{ color: "#67715f" }}>(optional)</span></label>
        <input
          id="operatingName"
          name="operatingName"
          type="text"
          maxLength={200}
          data-testid="signup-input-operatingName"
        />
        <span className="signup-hint">
          If different from the legal name — this is how Spectre refers to your Club in-app.
        </span>
      </div>

      <div className="signup-field">
        <label htmlFor="country">Country</label>
        <select
          id="country"
          name="country"
          required
          defaultValue="CA"
          data-testid="signup-select-country"
        >
          <option value="CA">Canada</option>
        </select>
        <span className="signup-hint">Spectre currently serves Canadian clubs.</span>
      </div>

      <div className="signup-field">
        <label htmlFor="provinceState">Province</label>
        <select
          id="provinceState"
          name="provinceState"
          required
          defaultValue=""
          data-testid="signup-select-province"
        >
          <option value="" disabled>Select a province or territory</option>
          {provinces.map((p) => (
            <option key={p} value={p}>{PROVINCE_NAMES[p] ?? p}</option>
          ))}
        </select>
      </div>

      <div className="signup-field span-2">
        <label htmlFor="addressLine1">Business address</label>
        <input
          id="addressLine1"
          name="addressLine1"
          type="text"
          required
          maxLength={200}
          autoComplete="street-address"
          placeholder="123 Example Boulevard"
          data-testid="signup-input-addressLine1"
        />
      </div>

      <div className="signup-field span-2">
        <label htmlFor="addressLine2">Address line 2 <span style={{ color: "#67715f" }}>(optional)</span></label>
        <input
          id="addressLine2"
          name="addressLine2"
          type="text"
          maxLength={200}
          data-testid="signup-input-addressLine2"
        />
      </div>

      <div className="signup-field">
        <label htmlFor="city">City</label>
        <input
          id="city"
          name="city"
          type="text"
          required
          maxLength={100}
          autoComplete="address-level2"
          data-testid="signup-input-city"
        />
      </div>

      <div className="signup-field">
        <label htmlFor="postalCode">Postal code</label>
        <input
          id="postalCode"
          name="postalCode"
          type="text"
          required
          maxLength={20}
          autoComplete="postal-code"
          placeholder="T2P 1J9"
          data-testid="signup-input-postalCode"
        />
      </div>

      <div className="signup-field span-2">
        <label htmlFor="websiteUrl">Club website <span style={{ color: "#67715f" }}>(optional)</span></label>
        <input
          id="websiteUrl"
          name="websiteUrl"
          type="url"
          maxLength={300}
          placeholder="https://your-club.ca"
          data-testid="signup-input-website"
        />
        <span className="signup-hint">
          Used to help verify your organization.
        </span>
      </div>

      <div className="signup-submit">
        <button
          type="submit"
          className="w1b-pill-cta"
          disabled={pending}
          aria-busy={pending}
          data-testid="signup-identity-submit"
        >
          {pending ? "Continuing…" : "Continue to administrator verification"}
        </button>
      </div>
    </form>
  );
}
