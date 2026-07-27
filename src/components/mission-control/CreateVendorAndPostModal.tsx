"use client";

// Sprint 3 · Checkpoint 15O (2026-07-27) — two-step Create Vendor &
// Post modal.
//
// Founder rule: the modal is a GUIDED FLOW.
//   Step 1 · Vendor profile
//     Review + edit the full vendor profile. Choose an existing
//     match OR create a new vendor. Actions:
//       • Create vendor            (primary; new vendor path)
//       • Use selected vendor      (primary; existing-match path)
//       • Save vendor and finish later  (secondary; stops after Step 1)
//     Does NOT post anything. Does NOT resolve the Work Intake.
//
//   Step 2 · AP coding
//     Only reachable after Step 1 succeeded (unless finish-later).
//     Review the drafted AP invoice, edit the GL / dates / terms,
//     then post. This step DOES resolve the Work Intake.
//     Actions:
//       • Post invoice             (primary)
//       • Back to vendor profile   (secondary; read-only re-visit)
//
// Server actions live in:
//   src/app/app/admin/ap/_create-vendor-actions.ts    (Step 1)
//   src/app/app/admin/ap/_post-ap-invoice-actions.ts  (Step 2)
//
// Safety invariants:
//   • Opening the modal creates nothing and posts nothing.
//   • Step 1 primary is DISABLED until the vendor mode is chosen
//     AND the required fields are filled.
//   • Step 2 is only reachable after Step 1 returned ok=true and
//     the user did NOT click Save-and-finish-later.
//   • Step 2 primary is DISABLED until the coding fields resolve.
//   • Sender identity from an internal forwarder (EMPLOYEE_FORWARD)
//     is NEVER auto-populated as the vendor's main contact.

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { ApInvoiceCardIntelligence } from "@/lib/mission-control";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CreateVendorAndPostModalProps {
  open: boolean;
  onClose: () => void;
  ap: ApInvoiceCardIntelligence;
  workIntakeItemId: string;
}

// ---------------------------------------------------------------------------
// Local shapes
// ---------------------------------------------------------------------------

interface VendorProfileDraft {
  legalName: string;
  operatingName: string | null;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  provinceOrState: string | null;
  postalCode: string | null;
  country: string | null;
  taxRegistrationNumber: string | null;
  website: string | null;
  paymentTermsDays: number | null;
  currency: string | null;
  notes: string | null;
  // Contact fields — captured for the audit trail + follow-up
  // "vendor contacts" model. Not persisted to the current Vendor
  // schema (see docs) but still user-editable in Step 1.
  mainContactName: string | null;
  mainContactTitle: string | null;
  mainContactEmail: string | null;
  mainContactPhone: string | null;
  arEmail: string | null;
  apRemittanceEmail: string | null;
}

interface CodingDraft {
  invoiceNumber: string;
  gross: string;
  currency: string;
  glAccountNumber: string;
  glAccountName: string;
  taxTotal: string;
  paymentTermsDays: number | null;
}

interface PossibleMatch {
  id: string;
  legalName: string;
  operatingName: string | null;
  matchEvidence: string;
  confidence: number;
  lastInvoiceDate: string | null;
}

type Step = "PROFILE" | "AP_CODING" | "SAVED_FOR_LATER";

// ---------------------------------------------------------------------------

export default function CreateVendorAndPostModal({
  open, onClose, ap, workIntakeItemId,
}: CreateVendorAndPostModalProps) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousActive = useRef<HTMLElement | null>(null);

  const [step, setStep] = useState<Step>("PROFILE");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Vendor id resolved by Step 1 (either newly created or a picked
  // existing match). Null until Step 1 succeeds.
  const [createdVendorId, setCreatedVendorId] = useState<string | null>(null);
  const [createdVendorName, setCreatedVendorName] = useState<string | null>(null);

  // Sprint 3 · Checkpoint 15P — pull the extracted vendor profile
  // and use it to pre-populate every field the invoice PDF supports.
  // Each populated field also gets a provenance chip below the input
  // so the operator can see what came from the PDF vs what they
  // typed. Fields with confidence < the extractor's threshold are
  // returned as null and stay blank (the founder's "never guess"
  // rule).
  const extracted = ap.extractedVendorProfile;
  const paymentTermsDaysFromExtracted = (() => {
    const t = extracted?.paymentTerms?.value ?? "";
    const m = t.match(/^Net\s*(\d{1,3})/i);
    return m ? parseInt(m[1], 10) : null;
  })();

  // Step 1 — vendor profile draft.
  const [profile, setProfile] = useState<VendorProfileDraft>(() => ({
    legalName: ap.extractedVendor.name ?? "",
    operatingName: null,
    email: extracted?.customerSupportEmail?.value ?? null,
    phone: extracted?.phone?.value ?? null,
    addressLine1: extracted?.address?.line1?.value ?? null,
    addressLine2: extracted?.address?.line2?.value ?? null,
    city: extracted?.address?.city?.value ?? null,
    provinceOrState: extracted?.address?.provinceState?.value ?? null,
    postalCode: extracted?.address?.postalCode?.value ?? null,
    country: extracted?.address?.country?.value ?? null,
    taxRegistrationNumber: extracted?.taxRegistrationNumber?.value ?? null,
    website: extracted?.website?.value ?? null,
    paymentTermsDays: paymentTermsDaysFromExtracted,
    currency: ap.gross.currency,
    notes: null,
    // Internal-forwarder rule (§Phase 4): EMPLOYEE_FORWARD senders
    // must NOT be pre-populated as the vendor's main contact. When
    // the sender is on the vendor's own domain (relationship: "VENDOR")
    // we DO pre-populate the contact fields.
    mainContactName: ap.sender.relationship === "VENDOR" ? ap.sender.name : null,
    mainContactTitle: null,
    mainContactEmail: ap.sender.relationship === "VENDOR" ? ap.sender.email : null,
    mainContactPhone: null,
    arEmail: extracted?.arEmail?.value ?? null,
    apRemittanceEmail: extracted?.remittanceEmail?.value ?? null,
  }));

  // Step 2 — AP coding draft.
  const [coding, setCoding] = useState<CodingDraft>(() => ({
    invoiceNumber: ap.invoiceNumber ?? "",
    gross: ap.gross.amount ?? "",
    currency: ap.gross.currency ?? "CAD",
    glAccountNumber: ap.category.glAccountNumber ?? "",
    glAccountName: ap.category.glAccountName ?? "",
    taxTotal: "",
    paymentTermsDays: null,
  }));

  // Possible existing matches.
  const [matches, setMatches] = useState<PossibleMatch[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [vendorMode, setVendorMode] = useState<"CREATE_NEW" | "USE_EXISTING" | null>(null);
  const [chosenMatchId, setChosenMatchId] = useState<string | null>(null);

  // Focus + Esc-to-close.
  useEffect(() => {
    if (!open) return;
    previousActive.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      previousActive.current?.focus?.();
    };
  }, [open, onClose]);

  // Load possible matches on open.
  const loadMatches = useCallback(async () => {
    if (matchesLoading) return;
    setMatchesLoading(true);
    try {
      const q = ap.extractedVendor.name ?? "";
      if (!q) { setMatches([]); return; }
      const res = await fetch(`/api/vendors/search?q=${encodeURIComponent(q)}`, { method: "GET" });
      if (!res.ok) { setMatches([]); return; }
      const body = (await res.json()) as { matches: PossibleMatch[] };
      setMatches(body.matches ?? []);
    } catch { setMatches([]); }
    finally { setMatchesLoading(false); }
  }, [ap.extractedVendor.name, matchesLoading]);
  useEffect(() => {
    if (open) void loadMatches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset internal state when the modal closes.
  useEffect(() => {
    if (open) return;
    setStep("PROFILE");
    setSubmitError(null);
    setCreatedVendorId(null);
    setCreatedVendorName(null);
  }, [open]);

  if (!open) return null;

  // ---- Validation ---------------------------------------------------------
  const canStep1Continue =
    vendorMode !== null &&
    (vendorMode === "USE_EXISTING" ? chosenMatchId != null : profile.legalName.trim().length > 0);

  const canStep2Post =
    coding.invoiceNumber.trim().length > 0 &&
    coding.gross.trim().length > 0 &&
    coding.glAccountNumber.trim().length > 0;

  // ---- Handlers -----------------------------------------------------------

  async function handleStep1(finishLater: boolean) {
    if (!canStep1Continue) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { createVendorAction } = await import("@/app/app/admin/ap/_create-vendor-actions");
      // Sprint 3 · Checkpoint 15P — pass the per-field provenance so
      // the audit log records which values came from the extractor
      // (and at what confidence) vs. which the operator typed. Only
      // fields with a non-null source are included.
      const provenance: Record<string, { source: string | null; confidence: number }> = {};
      if (extracted) {
        const add = (k: string, f?: { value: string | null; confidence: number; source: string | null }) => {
          if (f?.value && f.source) provenance[k] = { source: f.source, confidence: f.confidence };
        };
        add("addressLine1",         extracted.address.line1);
        add("addressLine2",         extracted.address.line2);
        add("city",                 extracted.address.city);
        add("provinceOrState",      extracted.address.provinceState);
        add("postalCode",           extracted.address.postalCode);
        add("country",              extracted.address.country);
        add("phone",                extracted.phone);
        add("website",              extracted.website);
        add("taxRegistrationNumber", extracted.taxRegistrationNumber);
        add("arEmail",              extracted.arEmail);
        add("apRemittanceEmail",    extracted.remittanceEmail);
        add("email",                extracted.customerSupportEmail);
        add("paymentTerms",         extracted.paymentTerms);
      }
      const result = await createVendorAction({
        workIntakeItemId,
        vendorMode: vendorMode!,
        existingVendorId: chosenMatchId ?? undefined,
        vendorProfile: profile,
        provenance,
        finishLater,
      });
      if (!result.ok) { setSubmitError(result.message); return; }
      setCreatedVendorId(result.vendorId);
      setCreatedVendorName(result.vendorLegalName);
      if (result.finishedLater) {
        setStep("SAVED_FOR_LATER");
      } else {
        setStep("AP_CODING");
      }
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Vendor creation failed.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStep2Post() {
    if (!createdVendorId || !canStep2Post) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { postApInvoiceAction } = await import("@/app/app/admin/ap/_post-ap-invoice-actions");
      const result = await postApInvoiceAction({
        workIntakeItemId,
        vendorId: createdVendorId,
        coding: {
          invoiceNumber: coding.invoiceNumber,
          gross: coding.gross,
          currency: coding.currency,
          glAccountNumber: coding.glAccountNumber,
          glAccountName: coding.glAccountName,
          taxTotal: coding.taxTotal || null,
          paymentTermsDays: coding.paymentTermsDays,
        },
      });
      if (!result.ok) { setSubmitError(result.message); return; }
      router.refresh();
      onClose();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Post failed.");
    } finally {
      setSubmitting(false);
    }
  }

  // ---- Render -------------------------------------------------------------

  return (
    <div
      className="spectre-doc-preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cvap-title"
      data-testid="create-vendor-and-post-modal"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div ref={dialogRef} tabIndex={-1} className="spectre-cvap-dialog">
        <header className="spectre-cvap-head">
          <div>
            <h2 id="cvap-title" data-testid="cvap-step-title">
              {step === "PROFILE" ? "Create vendor"
                : step === "AP_CODING" ? "Review and post invoice"
                : "Vendor saved"}
            </h2>
            <p className="spectre-cvap-sub">
              {step === "PROFILE"
                ? "Review and complete the vendor profile before creating the AP transaction."
                : step === "AP_CODING"
                ? `Review the AP coding for ${createdVendorName ?? "the vendor"} and post the invoice.`
                : `Vendor "${createdVendorName}" saved. Return to the Work Intake to complete the AP posting.`}
            </p>
          </div>
          <button
            type="button"
            className="spectre-btn spectre-btn--sm spectre-btn--tertiary"
            onClick={onClose}
            aria-label="Close"
            data-testid="cvap-close"
          >
            Close
          </button>
        </header>

        {/* Step indicator */}
        <div className="spectre-cvap-steps" data-testid="cvap-step-indicator" data-active={step}>
          <span className={`spectre-cvap-step ${step === "PROFILE" ? "is-active" : createdVendorId ? "is-done" : ""}`}>
            <span className="num">1</span>
            <span className="lbl">Vendor profile</span>
          </span>
          <span className="spectre-cvap-step-sep" aria-hidden="true" />
          <span className={`spectre-cvap-step ${step === "AP_CODING" ? "is-active" : ""} ${!createdVendorId ? "is-disabled" : ""}`}>
            <span className="num">2</span>
            <span className="lbl">AP coding</span>
          </span>
        </div>

        {step === "PROFILE" ? renderStep1() : step === "AP_CODING" ? renderStep2() : renderSavedForLater()}

        {submitError ? (
          <div className="spectre-cvap-error" role="alert" data-testid="cvap-error">
            {submitError}
          </div>
        ) : null}
      </div>
    </div>
  );

  // ---- Step 1 body --------------------------------------------------------
  function renderStep1() {
    return (
      <>
        <section className="spectre-cvap-section" data-testid="cvap-source">
          <h3>Source</h3>
          {ap.sender.relationship === "EMPLOYEE_FORWARD" ? (
            <p className="spectre-cvap-note">
              Forwarded by <strong>{ap.sender.email}</strong>. Not populated as the vendor&apos;s main contact — internal forwarders are provenance only.
            </p>
          ) : ap.sender.email ? (
            <p className="spectre-cvap-note">
              From <strong>{ap.sender.email}</strong>{ap.sender.relationship === "VENDOR" ? " (sender is on the vendor's own domain)" : ""}.
            </p>
          ) : (
            <p className="spectre-cvap-note">No sender identified.</p>
          )}
        </section>

        <section className="spectre-cvap-section" data-testid="cvap-matches">
          <h3>Possible existing matches</h3>
          {matchesLoading ? (
            <p className="spectre-cvap-note">Searching…</p>
          ) : matches.length === 0 ? (
            <p className="spectre-cvap-note">No same-tenant vendors matched the extracted name, tax number, or email domain.</p>
          ) : (
            <ul className="spectre-cvap-matches">
              {matches.map((m) => (
                <li key={m.id} className={chosenMatchId === m.id ? "picked" : ""}>
                  <label>
                    <input
                      type="radio"
                      name="cvap-existing-match"
                      value={m.id}
                      checked={chosenMatchId === m.id}
                      onChange={() => { setChosenMatchId(m.id); setVendorMode("USE_EXISTING"); }}
                      data-testid={`cvap-match-${m.id}`}
                    />
                    <div>
                      <div className="name">{m.operatingName ?? m.legalName}</div>
                      <div className="evidence">{m.matchEvidence} · confidence {m.confidence}%</div>
                      {m.lastInvoiceDate ? <div className="ts">Last invoice {m.lastInvoiceDate}</div> : null}
                    </div>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="spectre-cvap-choose-new">
            <label>
              <input
                type="radio"
                name="cvap-existing-match"
                value="__new__"
                checked={vendorMode === "CREATE_NEW"}
                onChange={() => { setVendorMode("CREATE_NEW"); setChosenMatchId(null); }}
                data-testid="cvap-choose-new"
              />
              Create a new vendor with the profile below
            </label>
          </div>
        </section>

        <section className="spectre-cvap-section" data-testid="cvap-profile" hidden={vendorMode !== "CREATE_NEW"}>
          <h3>Vendor profile</h3>

          <div className="spectre-cvap-subheading">Identity</div>
          <div className="spectre-cvap-grid">
            <ProfileField label="Legal name" wide provenance={ap.extractedVendor.name ? "From invoice PDF" : null}>
              <input type="text" className="spectre-input" value={profile.legalName}
                onChange={(e) => setProfile((p) => ({ ...p, legalName: e.target.value }))}
                data-testid="cvap-profile-legal" />
            </ProfileField>
            <ProfileField label="Operating name">
              <input type="text" className="spectre-input" value={profile.operatingName ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, operatingName: e.target.value || null }))} />
            </ProfileField>
            <ProfileField label="Currency" provenance={ap.gross.currency ? "From invoice PDF" : null}>
              <input type="text" className="spectre-input" maxLength={3} value={profile.currency ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, currency: e.target.value.toUpperCase() || null }))} />
            </ProfileField>
          </div>

          <div className="spectre-cvap-subheading">Address</div>
          <div className="spectre-cvap-grid">
            <ProfileField label="Address line 1" wide
              provenance={provenanceLabel(extracted?.address?.line1)}>
              <input type="text" className="spectre-input" value={profile.addressLine1 ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, addressLine1: e.target.value || null }))} />
            </ProfileField>
            <ProfileField label="Address line 2" wide
              provenance={provenanceLabel(extracted?.address?.line2)}>
              <input type="text" className="spectre-input" value={profile.addressLine2 ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, addressLine2: e.target.value || null }))} />
            </ProfileField>
            <ProfileField label="City"
              provenance={provenanceLabel(extracted?.address?.city)}>
              <input type="text" className="spectre-input" value={profile.city ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, city: e.target.value || null }))} />
            </ProfileField>
            <ProfileField label="Province / state"
              provenance={provenanceLabel(extracted?.address?.provinceState)}>
              <input type="text" className="spectre-input" value={profile.provinceOrState ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, provinceOrState: e.target.value || null }))} />
            </ProfileField>
            <ProfileField label="Postal / ZIP"
              provenance={provenanceLabel(extracted?.address?.postalCode)}>
              <input type="text" className="spectre-input" value={profile.postalCode ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, postalCode: e.target.value || null }))} />
            </ProfileField>
            <ProfileField label="Country"
              provenance={provenanceLabel(extracted?.address?.country)}>
              <input type="text" className="spectre-input" value={profile.country ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, country: e.target.value || null }))} />
            </ProfileField>
          </div>

          <div className="spectre-cvap-subheading">Contact</div>
          <div className="spectre-cvap-grid">
            <ProfileField label="Main contact name"
              provenance={ap.sender.relationship === "VENDOR" ? "From email sender" : null}>
              <input type="text" className="spectre-input" value={profile.mainContactName ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, mainContactName: e.target.value || null }))} />
            </ProfileField>
            <ProfileField label="Main contact title">
              <input type="text" className="spectre-input" value={profile.mainContactTitle ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, mainContactTitle: e.target.value || null }))} />
            </ProfileField>
            <ProfileField label="Main contact phone"
              provenance={provenanceLabel(extracted?.phone)}>
              <input type="tel" className="spectre-input" value={profile.mainContactPhone ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, mainContactPhone: e.target.value || null }))} />
            </ProfileField>
            <ProfileField label="Main contact email" wide
              provenance={ap.sender.relationship === "VENDOR" ? "From email sender" : null}>
              <input type="email" className="spectre-input" value={profile.mainContactEmail ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, mainContactEmail: e.target.value || null }))}
                data-testid="cvap-profile-main-contact-email" />
            </ProfileField>
            <ProfileField label="Vendor email (general)"
              provenance={provenanceLabel(extracted?.customerSupportEmail)}>
              <input type="email" className="spectre-input" value={profile.email ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, email: e.target.value || null }))} />
            </ProfileField>
            <ProfileField label="Phone (general)"
              provenance={provenanceLabel(extracted?.phone)}>
              <input type="tel" className="spectre-input" value={profile.phone ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, phone: e.target.value || null }))} />
            </ProfileField>
            <ProfileField label="AR email"
              provenance={provenanceLabel(extracted?.arEmail)}>
              <input type="email" className="spectre-input" value={profile.arEmail ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, arEmail: e.target.value || null }))} />
            </ProfileField>
            <ProfileField label="AP / remittance email"
              provenance={provenanceLabel(extracted?.remittanceEmail)}>
              <input type="email" className="spectre-input" value={profile.apRemittanceEmail ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, apRemittanceEmail: e.target.value || null }))} />
            </ProfileField>
            <ProfileField label="Website"
              provenance={provenanceLabel(extracted?.website)}>
              <input type="url" className="spectre-input" value={profile.website ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, website: e.target.value || null }))} />
            </ProfileField>
          </div>

          <div className="spectre-cvap-subheading">Payment &amp; tax</div>
          <div className="spectre-cvap-grid">
            <ProfileField label="Payment terms (days)"
              provenance={provenanceLabel(extracted?.paymentTerms)}>
              <input type="number" className="spectre-input" min={0} value={profile.paymentTermsDays ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, paymentTermsDays: e.target.value ? parseInt(e.target.value, 10) : null }))} />
            </ProfileField>
            <ProfileField label="Tax registration #"
              provenance={provenanceLabel(extracted?.taxRegistrationNumber)}>
              <input type="text" className="spectre-input" value={profile.taxRegistrationNumber ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, taxRegistrationNumber: e.target.value || null }))} />
            </ProfileField>
          </div>

          <div className="spectre-cvap-subheading">EFT / remittance</div>
          <p className="spectre-cvap-note">
            EFT details can be added after vendor creation. Banking fields are stored via the encrypted vendor-banking flow, not in this modal.
          </p>

          <div className="spectre-cvap-subheading">Notes</div>
          <div className="spectre-cvap-grid">
            <ProfileField label="Notes" wide>
              <textarea className="spectre-input" rows={2} value={profile.notes ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, notes: e.target.value || null }))} />
            </ProfileField>
          </div>
        </section>

        <footer className="spectre-cvap-foot">
          <button
            type="button"
            className="spectre-btn spectre-btn--secondary spectre-btn--sm"
            onClick={onClose}
            data-testid="cvap-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="spectre-btn spectre-btn--tertiary spectre-btn--sm"
            onClick={() => void handleStep1(true)}
            disabled={!canStep1Continue || submitting}
            data-testid="cvap-save-and-finish-later"
            title="Create the vendor but do NOT post the invoice — you can return later to complete AP coding."
          >
            Save vendor and finish later
          </button>
          <button
            type="button"
            className="spectre-btn spectre-btn--primary spectre-btn--sm"
            onClick={() => void handleStep1(false)}
            disabled={!canStep1Continue || submitting}
            aria-disabled={!canStep1Continue || submitting}
            data-testid="cvap-step1-primary"
          >
            {submitting ? "Working…" : vendorMode === "USE_EXISTING" ? "Use selected vendor" : "Create vendor"}
          </button>
        </footer>
      </>
    );
  }

  // ---- Step 2 body --------------------------------------------------------
  function renderStep2() {
    return (
      <>
        <section className="spectre-cvap-section" data-testid="cvap-step2-vendor">
          <h3>Vendor</h3>
          <p className="spectre-cvap-note" data-testid="cvap-step2-vendor-name">
            <strong>{createdVendorName}</strong>{" "}
            <span className="spectre-cvap-note--dim">(id: {createdVendorId})</span>
          </p>
        </section>

        <section className="spectre-cvap-section" data-testid="cvap-coding">
          <h3>Proposed AP coding</h3>
          <div className="spectre-cvap-grid">
            <ProfileField label="Invoice #">
              <input type="text" className="spectre-input" value={coding.invoiceNumber}
                onChange={(e) => setCoding((c) => ({ ...c, invoiceNumber: e.target.value }))}
                data-testid="cvap-coding-invoice" />
            </ProfileField>
            <ProfileField label="Gross amount">
              <input type="text" className="spectre-input" value={coding.gross}
                onChange={(e) => setCoding((c) => ({ ...c, gross: e.target.value }))}
                data-testid="cvap-coding-gross" />
            </ProfileField>
            <ProfileField label="Tax total">
              <input type="text" className="spectre-input" value={coding.taxTotal}
                onChange={(e) => setCoding((c) => ({ ...c, taxTotal: e.target.value }))} />
            </ProfileField>
            <ProfileField label="Currency">
              <input type="text" className="spectre-input" maxLength={3} value={coding.currency}
                onChange={(e) => setCoding((c) => ({ ...c, currency: e.target.value.toUpperCase() }))} />
            </ProfileField>
            <ProfileField label="Payment terms (days)">
              <input type="number" className="spectre-input" min={0}
                value={coding.paymentTermsDays ?? ""}
                onChange={(e) => setCoding((c) => ({ ...c, paymentTermsDays: e.target.value ? parseInt(e.target.value, 10) : null }))} />
            </ProfileField>
            <ProfileField label="GL account" wide>
              <input type="text" className="spectre-input"
                value={coding.glAccountNumber ? `${coding.glAccountNumber} · ${coding.glAccountName}` : ""}
                readOnly data-testid="cvap-coding-gl" />
              {ap.category.source ? (
                <span className="provenance">
                  Recommended via {sourceLabel(ap.category.source)} — confidence {ap.confidence ?? "—"}%.
                </span>
              ) : null}
            </ProfileField>
          </div>
          {ap.category.alternates.length > 0 ? (
            <details className="spectre-cvap-alt" data-testid="cvap-alternates">
              <summary>Alternate GL candidates ({ap.category.alternates.length})</summary>
              <ul>
                {ap.category.alternates.map((a) => (
                  <li key={a.accountNumber}>
                    <button
                      type="button"
                      className="spectre-btn spectre-btn--tertiary spectre-btn--sm"
                      onClick={() => setCoding((c) => ({ ...c, glAccountNumber: a.accountNumber, glAccountName: a.accountName }))}
                      data-testid={`cvap-alt-${a.accountNumber}`}
                    >
                      {a.accountNumber} · {a.accountName} ({a.confidence}%)
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {ap.gstVerification === "VERIFIED" && ap.gstRatePercent != null ? (
            <p className="spectre-cvap-note">GST verified at {ap.gstRatePercent}% via subtotal-plus-tax reconciliation.</p>
          ) : ap.gstVerification === "EXTRACTED_UNVERIFIED" ? (
            <p className="spectre-cvap-note spectre-cvap-note--warn">Tax extracted but rate not reconciled — confirm before posting.</p>
          ) : null}
        </section>

        <footer className="spectre-cvap-foot">
          <button
            type="button"
            className="spectre-btn spectre-btn--secondary spectre-btn--sm"
            onClick={() => setStep("PROFILE")}
            data-testid="cvap-back-to-profile"
          >
            Back to vendor profile
          </button>
          <button
            type="button"
            className="spectre-btn spectre-btn--tertiary spectre-btn--sm"
            onClick={onClose}
          >
            Finish later
          </button>
          <button
            type="button"
            className="spectre-btn spectre-btn--primary spectre-btn--sm"
            onClick={() => void handleStep2Post()}
            disabled={!canStep2Post || submitting}
            aria-disabled={!canStep2Post || submitting}
            data-testid="cvap-post-invoice"
          >
            {submitting ? "Posting…" : "Post invoice"}
          </button>
        </footer>
      </>
    );
  }

  // ---- Save-and-finish-later confirmation --------------------------------
  function renderSavedForLater() {
    return (
      <>
        <section className="spectre-cvap-section" data-testid="cvap-saved-later">
          <p className="spectre-cvap-note">
            <strong>{createdVendorName}</strong> was created and linked to this Work Intake item. The item stays open so you can return later and post the AP invoice.
          </p>
        </section>
        <footer className="spectre-cvap-foot">
          <button
            type="button"
            className="spectre-btn spectre-btn--primary spectre-btn--sm"
            onClick={() => { router.refresh(); onClose(); }}
            data-testid="cvap-saved-close"
          >
            Return to Mission Control
          </button>
        </footer>
      </>
    );
  }
}

// ---------------------------------------------------------------------------
// Field wrapper — keeps label + input + provenance consistent
// ---------------------------------------------------------------------------
function ProfileField({
  label, wide, provenance, children,
}: {
  label: string;
  wide?: boolean;
  provenance?: string | null;
  children: React.ReactNode;
}) {
  return (
    <label className={`spectre-cvap-field ${wide ? "spectre-cvap-field--wide" : ""}`}>
      <span className="k">{label}</span>
      {children}
      {provenance ? <span className="provenance">{provenance}</span> : null}
    </label>
  );
}

// Sprint 3 · Checkpoint 15P — build the small provenance chip that
// sits below every pre-populated field. Renders both the human-
// readable source ("From invoice PDF" / "From email signature" /
// "From prior invoice") AND the extractor's per-field confidence
// so the operator can see WHY a value showed up + how much Spectre
// trusts it. Returns null when the field is blank (below threshold)
// so the chip stays hidden.
function provenanceLabel(f: { value: string | null; confidence: number; source: string | null } | undefined | null): string | null {
  if (!f || !f.value || !f.source) return null;
  const sourceHuman: Record<string, string> = {
    "invoice-pdf":      "From invoice PDF",
    "email-signature":  "From email signature",
    "email-header":     "From email header",
    "ocr":              "From OCR",
    "prior-invoice":    "From a prior invoice",
    "vendor-profile":   "From existing vendor profile",
  };
  const label = sourceHuman[f.source] ?? `From ${f.source}`;
  return f.confidence > 0 ? `${label} · ${f.confidence}%` : label;
}

function sourceLabel(s: ApInvoiceCardIntelligence["category"]["source"]): string {
  switch (s) {
    case "VENDOR_DEFAULT":    return "the vendor's default expense account";
    case "PRIOR_CODING":      return "the vendor's prior coding history";
    case "NAME_KEYWORD":      return "an invoice + account-name keyword match";
    case "CAPITAL_CLASS_MAP": return "the capital-class classifier";
    case "NONE":
    case null:                return "no supported match";
  }
}
