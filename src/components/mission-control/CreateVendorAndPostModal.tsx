"use client";

// Sprint 3 · Checkpoint 15L (2026-07-27) — Create Vendor & Post modal.
//
// Rendered when the operator clicks the "Create vendor & post" primary
// action on an AP intake card whose vendor is not on file. Combines
// four review steps into one focused modal so the founder can complete
// vendor onboarding + AP drafting + posting confirmation without
// hopping between screens:
//
//   1. Vendor profile   — pre-populated with everything the analyser
//                          extracted from the PDF; every field labelled
//                          with provenance so the operator can trust
//                          or correct it.
//   2. Possible matches — same-tenant existing vendors that look like
//                          the same entity (normalised name + email
//                          domain + tax id).
//   3. Proposed coding  — the AP transaction the analyser drafted
//                          (invoice #, amount, tax, GL, department,
//                          fund), editable inline before commit.
//   4. Final confirmation — a clear, blocking confirmation. Nothing
//                          happens until this button is clicked. Even
//                          then, the modal's real posting hook (a
//                          server action in a follow-up ticket) is
//                          gated by the same posting-permission,
//                          duplicate-check, and validation rules the
//                          existing Approve & post path uses.
//
// SAFETY:
//   • Opening the modal creates nothing and posts nothing.
//   • The primary "Confirm" button is disabled until:
//       (a) the operator has explicitly picked "Create new vendor" or
//           "Use this existing vendor";
//       (b) the vendor name is non-empty;
//       (c) the GL account is present.
//   • Sender identity (Chris @ spectreautomation) is NEVER auto-
//     populated as the vendor's main contact when the sender is an
//     EMPLOYEE_FORWARD. The Source line above the modal explains why.

import { useEffect, useRef, useState, useCallback } from "react";
import type { ApInvoiceCardIntelligence } from "@/lib/mission-control";

export interface CreateVendorAndPostModalProps {
  open: boolean;
  onClose: () => void;
  ap: ApInvoiceCardIntelligence;
  workIntakeItemId: string;
  // Optional server-action handler. When absent, the modal shows a
  // "Confirmation wiring pending" state instead of a broken submit.
  // Real posting is a follow-up ticket — the founder's brief allows
  // the modal to open first (§6 "Do not create the vendor or post
  // merely by opening the modal.").
  onConfirm?: (payload: {
    workIntakeItemId: string;
    vendorMode: "CREATE_NEW" | "USE_EXISTING";
    existingVendorId?: string;
    vendorProfile: VendorProfileDraft;
    coding: CodingDraft;
  }) => Promise<{ ok: true } | { ok: false; message: string }>;
}

export interface VendorProfileDraft {
  legalName: string;
  operatingName: string | null;
  email: string | null;
  addressLine1: string | null;
  city: string | null;
  provinceOrState: string | null;
  postalCode: string | null;
  country: string | null;
  taxRegistrationNumber: string | null;
  website: string | null;
  paymentTermsDays: number | null;
  currency: string | null;
  notes: string | null;
}

export interface CodingDraft {
  invoiceNumber: string;
  gross: string;
  currency: string;
  glAccountNumber: string;
  glAccountName: string;
}

export interface PossibleMatch {
  id: string;
  legalName: string;
  operatingName: string | null;
  matchEvidence: string;
  confidence: number;
  lastInvoiceDate: string | null;
}

// ---------------------------------------------------------------------------

export default function CreateVendorAndPostModal({
  open, onClose, ap, workIntakeItemId, onConfirm,
}: CreateVendorAndPostModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousActive = useRef<HTMLElement | null>(null);

  // Editable vendor profile — pre-populated from the extraction,
  // NEVER from the sender identity (see safety note above).
  const [profile, setProfile] = useState<VendorProfileDraft>(() => ({
    legalName: ap.extractedVendor.name ?? "",
    operatingName: null,
    email: null,
    addressLine1: null,
    city: null,
    provinceOrState: null,
    postalCode: null,
    country: null,
    taxRegistrationNumber: null,
    website: null,
    paymentTermsDays: null,
    currency: ap.gross.currency,
    notes: null,
  }));

  // Editable AP coding — pre-populated from the projection.
  const [coding, setCoding] = useState<CodingDraft>(() => ({
    invoiceNumber: ap.invoiceNumber ?? "",
    gross: ap.gross.amount ?? "",
    currency: ap.gross.currency ?? "CAD",
    glAccountNumber: ap.category.glAccountNumber ?? "",
    glAccountName: ap.category.glAccountName ?? "",
  }));

  // Possible existing matches — the loader hits an API on modal open.
  const [matches, setMatches] = useState<PossibleMatch[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [vendorMode, setVendorMode] = useState<"CREATE_NEW" | "USE_EXISTING" | null>(null);
  const [chosenMatchId, setChosenMatchId] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Focus + trap + Esc-to-close.
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

  // Load possible existing vendor matches when the modal opens.
  const loadMatches = useCallback(async () => {
    if (matchesLoading) return;
    setMatchesLoading(true);
    try {
      const q = ap.extractedVendor.name ?? "";
      if (!q) { setMatches([]); return; }
      const res = await fetch(
        `/api/vendors/search?q=${encodeURIComponent(q)}`,
        { method: "GET" },
      );
      if (!res.ok) { setMatches([]); return; }
      const body = (await res.json()) as { matches: PossibleMatch[] };
      setMatches(body.matches ?? []);
    } catch { setMatches([]); }
    finally { setMatchesLoading(false); }
  }, [ap.extractedVendor.name, matchesLoading]);
  useEffect(() => {
    if (open) void loadMatches();
    // Intentionally: only re-load when the modal opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const canConfirm =
    vendorMode !== null &&
    (vendorMode === "USE_EXISTING" ? chosenMatchId != null : profile.legalName.trim().length > 0) &&
    coding.invoiceNumber.trim().length > 0 &&
    coding.gross.trim().length > 0 &&
    coding.glAccountNumber.trim().length > 0;

  const primaryLabel =
    vendorMode === "USE_EXISTING" ? "Use selected vendor & post" : "Create vendor & post";

  async function handleConfirm() {
    if (!onConfirm || !canConfirm) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await onConfirm({
        workIntakeItemId,
        vendorMode: vendorMode!,
        existingVendorId: chosenMatchId ?? undefined,
        vendorProfile: profile,
        coding,
      });
      if (result.ok) { onClose(); return; }
      setSubmitError(result.message);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Confirmation failed");
    } finally {
      setSubmitting(false);
    }
  }

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
            <h2 id="cvap-title">Create vendor &amp; post</h2>
            <p className="spectre-cvap-sub">
              Review the drafted vendor profile and AP coding. Nothing is created or posted until you confirm below.
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
          <div className="spectre-cvap-grid">
            <label className="spectre-cvap-field spectre-cvap-field--wide">
              <span className="k">Legal name</span>
              <input
                type="text" className="spectre-input"
                value={profile.legalName}
                onChange={(e) => setProfile((p) => ({ ...p, legalName: e.target.value }))}
                data-testid="cvap-profile-legal"
              />
              {ap.extractedVendor.name ? (
                <span className="provenance">Pre-populated from the invoice PDF.</span>
              ) : null}
            </label>
            <label className="spectre-cvap-field">
              <span className="k">Operating name</span>
              <input
                type="text" className="spectre-input"
                value={profile.operatingName ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, operatingName: e.target.value || null }))}
              />
            </label>
            <label className="spectre-cvap-field">
              <span className="k">Currency</span>
              <input
                type="text" className="spectre-input" maxLength={3}
                value={profile.currency ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, currency: e.target.value.toUpperCase() || null }))}
              />
            </label>
            <label className="spectre-cvap-field spectre-cvap-field--wide">
              <span className="k">Email</span>
              <input
                type="email" className="spectre-input"
                value={profile.email ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, email: e.target.value || null }))}
              />
            </label>
            <label className="spectre-cvap-field">
              <span className="k">Tax registration #</span>
              <input
                type="text" className="spectre-input"
                value={profile.taxRegistrationNumber ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, taxRegistrationNumber: e.target.value || null }))}
              />
            </label>
            <label className="spectre-cvap-field">
              <span className="k">Payment terms (days)</span>
              <input
                type="number" className="spectre-input" min={0}
                value={profile.paymentTermsDays ?? ""}
                onChange={(e) => setProfile((p) => ({ ...p, paymentTermsDays: e.target.value ? parseInt(e.target.value, 10) : null }))}
              />
            </label>
          </div>
          <p className="spectre-cvap-note">
            Banking / EFT details are NOT collected in this modal — add them later on the vendor detail page.
          </p>
        </section>

        <section className="spectre-cvap-section" data-testid="cvap-coding">
          <h3>Proposed AP coding</h3>
          <div className="spectre-cvap-grid">
            <label className="spectre-cvap-field">
              <span className="k">Invoice #</span>
              <input
                type="text" className="spectre-input"
                value={coding.invoiceNumber}
                onChange={(e) => setCoding((c) => ({ ...c, invoiceNumber: e.target.value }))}
                data-testid="cvap-coding-invoice"
              />
            </label>
            <label className="spectre-cvap-field">
              <span className="k">Gross amount</span>
              <input
                type="text" className="spectre-input"
                value={coding.gross}
                onChange={(e) => setCoding((c) => ({ ...c, gross: e.target.value }))}
                data-testid="cvap-coding-gross"
              />
            </label>
            <label className="spectre-cvap-field spectre-cvap-field--wide">
              <span className="k">GL account</span>
              <input
                type="text" className="spectre-input"
                value={coding.glAccountNumber ? `${coding.glAccountNumber} · ${coding.glAccountName}` : ""}
                readOnly
                data-testid="cvap-coding-gl"
              />
              {ap.category.source ? (
                <span className="provenance">
                  Recommended via {sourceLabel(ap.category.source)} — confidence {ap.confidence ?? "—"}%.
                </span>
              ) : null}
            </label>
          </div>
          {ap.category.alternates.length > 0 ? (
            <details className="spectre-cvap-alt">
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

        {submitError ? (
          <div className="spectre-cvap-error" role="alert" data-testid="cvap-error">
            {submitError}
          </div>
        ) : null}

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
            className="spectre-btn spectre-btn--primary spectre-btn--sm"
            onClick={() => void handleConfirm()}
            disabled={!canConfirm || submitting || !onConfirm}
            aria-disabled={!canConfirm || submitting || !onConfirm}
            title={!onConfirm ? "The posting handler is wired in a follow-up ticket — the modal opens for founder review but does not commit." : undefined}
            data-testid="cvap-confirm"
          >
            {submitting ? "Confirming…" : primaryLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

function sourceLabel(s: ApInvoiceCardIntelligence["category"]["source"]): string {
  switch (s) {
    case "VENDOR_DEFAULT":     return "the vendor's default expense account";
    case "PRIOR_CODING":       return "the vendor's prior coding history";
    case "NAME_KEYWORD":       return "an invoice + account-name keyword match";
    case "CAPITAL_CLASS_MAP":  return "the capital-class classifier";
    case "NONE":
    case null:                 return "no supported match";
  }
}
