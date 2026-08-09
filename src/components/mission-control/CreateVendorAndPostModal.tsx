"use client";

// Sprint 3 · Checkpoint 15P-2 (2026-07-27) — Create Vendor & Post
// modal (two-step guided flow, refined).
//
//   Step 1 · Vendor profile     — reached only when the vendor
//                                 doesn't exist yet (or the operator
//                                 explicitly opens it). Compact
//                                 3-col grid (15P-1) with inline
//                                 provenance chips.
//
//   Step 2 · AP coding          — the founder-approved coding
//                                 review. Shows summary + tax split
//                                 + FULL debit/credit journal
//                                 preview (server-computed via the
//                                 shared buildProposedApEntry helper
//                                 that the posting action also uses).
//                                 Editing GL / tax / dates re-renders
//                                 the preview. Posting is blocked
//                                 unless debits === credits.
//
// 15P-2 additions:
//   • Optional `initialStep="AP_CODING"` + `preselectedVendorId`
//     props so the AP card's "Approve & post" primary can open the
//     SAME modal directly at Step 2 for an already-matched vendor.
//   • Payment-terms initial value follows the precedence chain
//     (vendor profile → invoice PDF → prior invoices → club default
//     → Spectre default of Net 30). Provenance rendered honestly —
//     never "From invoice PDF" for the Spectre fallback.
//   • Step 2 replaced with the founder-approved layout: summary,
//     coding, tax, proposed accounting entry (debit/credit table),
//     source link, action footer.
//
// Server actions:
//   src/app/app/admin/ap/_create-vendor-actions.ts     (Step 1)
//   src/app/app/admin/ap/_preview-ap-entry-actions.ts  (Step 2 preview)
//   src/app/app/admin/ap/_post-ap-invoice-actions.ts   (Step 2 commit)
//
// Safety invariants preserved from 15O:
//   • Opening the modal creates nothing and posts nothing.
//   • Step 2 posting is DISABLED until the preview is balanced.
//   • Sender identity from an internal forwarder (EMPLOYEE_FORWARD)
//     is NEVER auto-populated as the vendor's main contact.

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { ApInvoiceCardIntelligence } from "@/lib/mission-control";
import DocumentPreviewModal from "./DocumentPreviewModal";
import {
  resolvePaymentTerms,
  parseExtractedTermsValue,
  type ResolvedPaymentTerms,
} from "@/lib/ap-intelligence/payment-terms-resolve";
import type { ProposedApEntry } from "@/lib/ap-intelligence/proposed-ap-entry";
import {
  deriveVendorStepConfidence,
  deriveCodingStepConfidence,
} from "@/lib/mission-control/modal-confidence";
import ModalConfidenceLine from "./ModalConfidenceLine";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CreateVendorAndPostModalProps {
  open: boolean;
  onClose: () => void;
  ap: ApInvoiceCardIntelligence;
  workIntakeItemId: string;
  // 15P-2: caller can open the modal directly at Step 2 for an
  // already-matched active vendor (the "Approve & post" primary
  // action on the AP card uses this). When omitted the modal
  // starts at Step 1 as before.
  initialStep?: "PROFILE" | "AP_CODING";
  // Required when initialStep === "AP_CODING". Identifies the
  // matched vendor row that Step 2 codes against.
  preselectedVendorId?: string;
  preselectedVendorName?: string;
  // 15P-4: when the AP card auto-resolved the vendor via the shared
  // `resolveModalEntry` rule, this flag switches the modal to the
  // single-step AP-Coding-only presentation (no two-step progress
  // header, compact vendor summary + "Review/change vendor" action).
  // When true, `preselectedVendorId` MUST be set.
  autoResolvedVendor?: boolean;
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
  // 15P-2: subtotal + tax are separate fields (was just `taxTotal`
  // and `gross`). Gross is subtotal + tax; the modal enforces the
  // arithmetic on edit.
  subtotal: string;
  tax: string;
  gross: string;
  currency: string;
  glAccountNumber: string;
  glAccountName: string;
  paymentTermsDays: number | null;
  taxTreatment: "RECOVERABLE" | "NON_RECOVERABLE" | "NONE";
  taxCodeKey: string | null;
  invoiceDateIso: string;
  explicitInvoiceDueDateIso: string | null;
}

interface PossibleMatch {
  id: string;
  legalName: string;
  operatingName: string | null;
  // 15P-3: evidence-based match result.
  matchEvidence: string;
  classification: "exact" | "strong" | "possible" | "conflicting";
  matchedFields: string[];
  differedFields: string[];
  notComparableFields: string[];
  fieldsCompared: number;
  matchedWeight: number;
  differedWeight: number;
  netEvidenceWeight: number;
  rankingScore: number;
  lastInvoiceDate: string | null;
}

type Step = "PROFILE" | "AP_CODING" | "SAVED_FOR_LATER";

// ---------------------------------------------------------------------------

export default function CreateVendorAndPostModal({
  open, onClose, ap, workIntakeItemId,
  initialStep, preselectedVendorId, preselectedVendorName,
  autoResolvedVendor,
}: CreateVendorAndPostModalProps) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousActive = useRef<HTMLElement | null>(null);

  // 15P-2: when the caller passed initialStep="AP_CODING" + a preselected
  // vendor id, skip Step 1 entirely and open on the coding review.
  const openDirectAtStep2 =
    initialStep === "AP_CODING" && !!preselectedVendorId;

  // 15P-4: auto-resolved vendors get a SINGLE-STEP modal (no two-
  // step progress header). The user can reveal Vendor Profile via
  // the "Review / change vendor" action at the top of AP Coding.
  // `reviewingVendor` tracks whether the user chose to review; once
  // true, the modal renders the two-step header + supports free
  // back-and-forth navigation between the two steps.
  const [reviewingVendor, setReviewingVendor] = useState(false);
  const isAutoResolvedSingleStep = !!autoResolvedVendor && openDirectAtStep2 && !reviewingVendor;

  const [step, setStep] = useState<Step>(openDirectAtStep2 ? "AP_CODING" : "PROFILE");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Vendor id resolved by Step 1 (either newly created or a picked
  // existing match) OR provided by the caller when opening at Step 2.
  const [createdVendorId, setCreatedVendorId] = useState<string | null>(preselectedVendorId ?? null);
  const [createdVendorName, setCreatedVendorName] = useState<string | null>(preselectedVendorName ?? null);

  // Sprint 3 · Checkpoint 15P — pull the extracted vendor profile
  // and use it to pre-populate every field the invoice PDF supports.
  // Each populated field also gets a provenance chip below the input
  // so the operator can see what came from the PDF vs what they
  // typed. Fields with confidence < the extractor's threshold are
  // returned as null and stay blank (the founder's "never guess"
  // rule).
  const extracted = ap.extractedVendorProfile;

  // 15P-2: payment-terms precedence chain resolves the initial
  // proposed value + honest provenance chip. The vendor profile
  // wins whenever an existing vendor was matched; otherwise we
  // fall through extractor → prior invoices → club default →
  // Spectre default (Net 30).
  const resolvedTerms: ResolvedPaymentTerms = resolvePaymentTerms({
    // A preselected (matched) vendor supplies the profile term. The
    // matched vendor's actual paymentTermsDays isn't in the AP card
    // projection today, so we conservatively skip this branch and
    // rely on ap.paymentTerms / extraction. The server RE-RESOLVES
    // from the Vendor row on post, so this branch not firing here
    // is purely a UI-provenance issue, never a persistence issue.
    vendorProfileTermsDays: null,
    extractedTerms: parseExtractedTermsValue(extracted?.paymentTerms?.value ?? null),
    // The projection surfaces vendor / prior terms via ap.paymentTerms
    // + ap.paymentTermsSource. When source is VENDOR_PROFILE or
    // PRIOR_INVOICE and the string parses to Net N, use it.
    priorInvoiceTermsDays: (() => {
      if (ap.paymentTermsSource !== "PRIOR_INVOICE" && ap.paymentTermsSource !== "VENDOR_PROFILE") return null;
      const m = (ap.paymentTerms ?? "").match(/Net\s*(\d{1,3})/i);
      return m ? parseInt(m[1], 10) : null;
    })(),
  });
  const paymentTermsDaysInitial = resolvedTerms.days;
  const paymentTermsSourceInitial = resolvedTerms.source;
  const paymentTermsProvenanceHuman = resolvedTerms.provenanceHuman;

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
    // 15P-2: uses the precedence-chain resolver (vendor profile →
    // invoice PDF → prior → club → Spectre default of Net 30).
    // Was `paymentTermsDaysFromExtracted` which only read the PDF.
    paymentTermsDays: paymentTermsDaysInitial,
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

  // Step 2 — AP coding draft. 15P-2: honest defaults across every
  // money field so the preview server action can compute a valid
  // entry on first render.
  const initialTaxFromExtraction = (() => {
    // The AP card projection doesn't carry a per-invoice tax total
    // today, but the GST-verification field indicates whether the
    // extractor split a rate correctly. When ap.gstRatePercent is
    // set and ap.gross.amount is present, compute tax = gross ×
    // rate / (1 + rate) so we seed the coding with the right split.
    if (ap.gstVerification !== "VERIFIED" || !ap.gstRatePercent || !ap.gross.amount) return { subtotal: "", tax: "0.00" };
    const gross = Number(ap.gross.amount);
    if (!Number.isFinite(gross) || gross <= 0) return { subtotal: "", tax: "0.00" };
    const rate = ap.gstRatePercent / 100;
    const tax = Math.round((gross * rate / (1 + rate)) * 100) / 100;
    const subtotal = Math.round((gross - tax) * 100) / 100;
    return { subtotal: subtotal.toFixed(2), tax: tax.toFixed(2) };
  })();
  const [coding, setCoding] = useState<CodingDraft>(() => ({
    invoiceNumber: ap.invoiceNumber ?? "",
    subtotal: initialTaxFromExtraction.subtotal,
    tax: initialTaxFromExtraction.tax,
    gross: ap.gross.amount ?? "",
    currency: ap.gross.currency ?? "CAD",
    glAccountNumber: ap.category.glAccountNumber ?? "",
    glAccountName: ap.category.glAccountName ?? "",
    paymentTermsDays: paymentTermsDaysInitial,
    // Canadian tenants → GST recoverable by default when tax is
    // present. NON_RECOVERABLE / NONE selectable in the UI.
    taxTreatment: initialTaxFromExtraction.tax !== "0.00" ? "RECOVERABLE" : "NONE",
    taxCodeKey: initialTaxFromExtraction.tax !== "0.00" ? "GST_5" : null,
    invoiceDateIso: new Date().toISOString(),
    explicitInvoiceDueDateIso: null,
  }));

  // 15P-2: journal-preview state — fetched from the preview server
  // action every time the coding form changes. `null` while loading
  // or after an error; the modal footer disables Post until we have
  // a balanced entry in hand.
  const [preview, setPreview] = useState<ProposedApEntry | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // 15P-7 success-confirmation state. Set on a successful post
  // response so the modal renders the "Invoice posted" panel with
  // the lifecycle summary before auto-closing.
  const [postResult, setPostResult] = useState<{
    ok: true;
    invoiceNumber: string;
    journalEntryId: string;
    lifecycle: {
      apInvoicePosted: true;
      journalEntryPosted: true;
      workIntakeResolved: true;
      emailArchive:
        | { status: "QUEUED"; jobId: string }
        | { status: "NOT_APPLICABLE"; reason: string }
        | { status: "ENQUEUE_FAILED"; error: string };
      fiscalPeriodBootstrapped: boolean;
    };
  } | null>(null);

  // Possible existing matches.
  const [matches, setMatches] = useState<PossibleMatch[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);
  // Sprint 3 · Checkpoint 15P-1 — the profile is visible the moment
  // the modal opens; CREATE_NEW is the default so the founder never
  // has to click a radio to "reveal" it. If existing matches surface
  // and the operator picks one, vendorMode flips to USE_EXISTING and
  // the profile block dims.
  const [vendorMode, setVendorMode] = useState<"CREATE_NEW" | "USE_EXISTING">("CREATE_NEW");
  const [chosenMatchId, setChosenMatchId] = useState<string | null>(null);

  // Sprint 3 · Checkpoint 15P-1 — clickable "Source" chip in the
  // Step-1 header opens the invoice PDF preview inline (blob URL,
  // same DocumentPreviewModal the AP card uses).
  const [previewOpen, setPreviewOpen] = useState(false);
  const primaryDoc = ap.primaryAttachment;

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
  //
  // 15P-3: switched from GET `?q=<name>` to POST with the FULL
  // extracted vendor profile. The server now scores every candidate
  // against every persisted field it can compare — no more
  // hardcoded 65 % name-only ceiling.
  const loadMatches = useCallback(async () => {
    if (matchesLoading) return;
    setMatchesLoading(true);
    try {
      const legalName = ap.extractedVendor.name ?? "";
      if (!legalName) { setMatches([]); return; }
      const body = {
        extracted: {
          legalName,
          operatingName:         null,
          addressLine1:          extracted?.address?.line1?.value ?? null,
          addressLine2:          extracted?.address?.line2?.value ?? null,
          city:                  extracted?.address?.city?.value ?? null,
          provinceState:         extracted?.address?.provinceState?.value ?? null,
          postalCode:            extracted?.address?.postalCode?.value ?? null,
          country:               extracted?.address?.country?.value ?? null,
          phone:                 extracted?.phone?.value ?? null,
          website:               extracted?.website?.value ?? null,
          email:                 extracted?.customerSupportEmail?.value ?? null,
          arEmail:               extracted?.arEmail?.value ?? null,
          apRemittanceEmail:     extracted?.remittanceEmail?.value ?? null,
          taxRegistrationNumber: extracted?.taxRegistrationNumber?.value ?? null,
          paymentTermsDays:      paymentTermsDaysInitial ?? null,
          mainContactName:       ap.sender.relationship === "VENDOR" ? ap.sender.name : null,
          mainContactEmail:      ap.sender.relationship === "VENDOR" ? ap.sender.email : null,
        },
      };
      const res = await fetch(`/api/vendors/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { setMatches([]); return; }
      const json = (await res.json()) as { matches: PossibleMatch[] };
      setMatches(json.matches ?? []);
    } catch { setMatches([]); }
    finally { setMatchesLoading(false); }
  }, [ap.extractedVendor.name, ap.sender.relationship, ap.sender.name, ap.sender.email, extracted, paymentTermsDaysInitial, matchesLoading]);
  useEffect(() => {
    if (open) void loadMatches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset internal state when the modal closes.
  useEffect(() => {
    if (open) return;
    // 15P-2: honour initialStep + preselected vendor on the next
    // open. When the caller opened us directly at Step 2 we must
    // NOT reset createdVendorId to null (the "vendor" IS the
    // preselected one).
    setStep(openDirectAtStep2 ? "AP_CODING" : "PROFILE");
    setSubmitError(null);
    setCreatedVendorId(preselectedVendorId ?? null);
    setCreatedVendorName(preselectedVendorName ?? null);
    setPreview(null);
    setPreviewError(null);
    setPostResult(null);
    setReviewingVendor(false);
  }, [open, openDirectAtStep2, preselectedVendorId, preselectedVendorName]);

  // 15P-2: fetch (or refresh) the journal preview whenever we're
  // on Step 2 with enough coding data to produce one. Uses a small
  // debounce so keystroke-by-keystroke edits don't fire one RPC per
  // character. The preview server action is safe to call as often as
  // we like — it never persists.
  useEffect(() => {
    if (step !== "AP_CODING") return;
    if (!createdVendorId) return;
    const gl = coding.glAccountNumber.trim();
    const inv = coding.invoiceNumber.trim();
    const subtotal = coding.subtotal.trim();
    const tax = coding.tax.trim();
    const gross = coding.gross.trim();
    if (!gl || !inv || !subtotal || !gross) { setPreview(null); return; }
    // 15P-5: switched from dynamic-import of a Next.js server action
    // to a plain fetch() against a stable API-route URL. Server-
    // action ids get rehashed on every deploy; API route paths do
    // not. Founder-observed "Preview unavailable" after every deploy
    // is eliminated by construction — the URL is stable, so a
    // pre-deploy browser session posts to the same handler and
    // either succeeds or gets a plain 4xx / 5xx with an actionable
    // JSON message.
    const controller = new AbortController();
    const t = window.setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const res = await fetch(`/api/mission-control/ap-preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            workIntakeItemId,
            vendorId: createdVendorId,
            coding: {
              invoiceNumber: inv,
              subtotal,
              tax: tax || "0",
              gross,
              currency: coding.currency,
              glAccountNumber: gl,
              taxTreatment: coding.taxTreatment,
              taxCodeKey: coding.taxCodeKey,
            },
          }),
        });
        if (controller.signal.aborted) return;
        // Both success and business-error responses are valid JSON
        // bodies with `{ ok: boolean, ... }`. Only genuine network /
        // transport failures throw.
        const result = (await res.json().catch(() => null)) as
          | { ok: true; entry: import("@/lib/ap-intelligence/proposed-ap-entry").ProposedApEntry }
          | { ok: false; message: string; code: string }
          | null;
        if (!result) {
          // Server returned a non-JSON body — rare, but treat as an
          // actionable validation error rather than a raw exception.
          setPreview(null);
          setPreviewError(`Preview request returned an unexpected response (HTTP ${res.status}).`);
          return;
        }
        if (!result.ok) { setPreview(null); setPreviewError(result.message); return; }
        setPreview(result.entry);
      } catch (e) {
        if (controller.signal.aborted) return;
        setPreviewError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!controller.signal.aborted) setPreviewLoading(false);
      }
    }, 250);
    return () => { controller.abort(); window.clearTimeout(t); };
  }, [
    step, createdVendorId, workIntakeItemId,
    coding.invoiceNumber, coding.subtotal, coding.tax, coding.gross,
    coding.glAccountNumber, coding.currency, coding.taxTreatment, coding.taxCodeKey,
  ]);

  if (!open) return null;

  // ---- Validation ---------------------------------------------------------
  // 15P-1: default mode is CREATE_NEW, so the check reduces to
  //   USE_EXISTING → require a picked match id
  //   CREATE_NEW   → require a legal name
  const canStep1Continue =
    vendorMode === "USE_EXISTING"
      ? chosenMatchId != null
      : profile.legalName.trim().length > 0;

  // 15P-2: Step 2 is postable ONLY when the server-side preview
  // returned a balanced entry. The client never posts blindly.
  const canStep2Post =
    coding.invoiceNumber.trim().length > 0 &&
    coding.gross.trim().length > 0 &&
    coding.glAccountNumber.trim().length > 0 &&
    preview !== null &&
    preview.isBalanced;

  // ---- Handlers -----------------------------------------------------------

  async function handleStep1(finishLater: boolean) {
    if (!canStep1Continue) return;
    // 15P-4: two-way navigation guard. Once the vendor is created
    // (or preselected via auto-resolution), Step 1's "Create vendor
    // & continue" must NOT invoke createVendorAction a second time —
    // that would either throw a duplicate error or create an
    // orphaned second vendor. The correct behaviour on re-visit is
    // a plain navigation to Step 2 with all state preserved.
    if (createdVendorId) {
      if (finishLater) { setStep("SAVED_FOR_LATER"); return; }
      setStep("AP_CODING");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { createVendorAction } = await import("@/app/app/admin/ap/_create-vendor-actions");
      if (typeof createVendorAction !== "function") {
        // 15P-4 defence — stale bundle after a deploy race.
        setSubmitError("Spectre has been updated. Please refresh the page and try again.");
        return;
      }
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
      if (!result) {
        setSubmitError("Spectre has been updated. Please refresh the page and try again.");
        return;
      }
      if (!result.ok) { setSubmitError(result.message); return; }
      setCreatedVendorId(result.vendorId);
      setCreatedVendorName(result.vendorLegalName);
      if (result.finishedLater) {
        setStep("SAVED_FOR_LATER");
      } else {
        setStep("AP_CODING");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Vendor creation failed.";
      if (/Failed to find Server Action/.test(msg)) {
        setSubmitError("Spectre has been updated. Please refresh the page and try again.");
      } else {
        setSubmitError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStep2Post() {
    if (!createdVendorId || !canStep2Post || !preview) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { postApInvoiceAction } = await import("@/app/app/admin/ap/_post-ap-invoice-actions");
      if (typeof postApInvoiceAction !== "function") {
        setSubmitError("Spectre has been updated. Please refresh the page and try again.");
        return;
      }
      // 15P-2: send the full split (subtotal + tax + gross), the
      // resolved terms provenance, dates, tax treatment, and the
      // client's snapshot of the totals so the server can log any
      // client<->server drift. The server RE-RESOLVES and RE-BUILDS
      // via the shared `buildProposedApEntry` before persisting.
      const result = await postApInvoiceAction({
        workIntakeItemId,
        vendorId: createdVendorId,
        coding: {
          invoiceNumber: coding.invoiceNumber,
          subtotal: coding.subtotal,
          tax: coding.tax || "0",
          gross: coding.gross,
          currency: coding.currency,
          glAccountNumber: coding.glAccountNumber,
          glAccountName: coding.glAccountName,
          paymentTermsDays: coding.paymentTermsDays,
          paymentTermsSource: paymentTermsSourceInitial,
          invoiceDate: coding.invoiceDateIso,
          explicitInvoiceDueDate: coding.explicitInvoiceDueDateIso,
          taxTreatment: coding.taxTreatment,
          taxCodeKey: coding.taxCodeKey,
          clientTotalDebits: preview.totalDebits,
          clientTotalCredits: preview.totalCredits,
          // Phase 11 — coding precedent: was the operator accepting
          // Spectre's TOP recommended GL account?
          recommendationAccepted: (ap.category.glAccountNumber ?? "") === coding.glAccountNumber,
        },
      });
      if (!result) {
        setSubmitError("Spectre has been updated. Please refresh the page and try again.");
        return;
      }
      if (!result.ok) { setSubmitError(result.message); return; }
      // 15P-7 success confirmation — render an unmistakable panel
      // BEFORE closing the modal. Preserves the lifecycle summary
      // (JE posted, WI cleared, email archive status) so the
      // operator sees exactly what happened. Modal closes after
      // ~1.8s so the confirmation is visible but doesn't force a
      // manual dismissal step.
      setPostResult(result);
      window.setTimeout(() => {
        router.refresh();
        onClose();
      }, 1800);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Post failed.";
      if (/Failed to find Server Action/.test(msg)) {
        setSubmitError("Spectre has been updated. Please refresh the page and try again.");
      } else {
        setSubmitError(msg);
      }
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
            <div className="spectre-cvap-title-row">
              <h2 id="cvap-title" data-testid="cvap-step-title">
                {step === "PROFILE" ? "Vendor profile"
                  : step === "AP_CODING" ? "Review and post invoice"
                  : "Vendor saved"}
              </h2>
              {step === "PROFILE" && primaryDoc ? (
                <button
                  type="button"
                  className="spectre-cvap-source-link"
                  onClick={() => setPreviewOpen(true)}
                  data-testid="cvap-source-link"
                  aria-label={`Preview source document ${primaryDoc.filename}`}
                  title="Preview the source invoice PDF"
                >
                  <span className="spectre-cvap-source-label">Source</span>
                  <span className="spectre-cvap-source-filename">{primaryDoc.filename}</span>
                </button>
              ) : null}
            </div>
            <p className="spectre-cvap-sub">
              {step === "PROFILE"
                ? "Review the extracted profile. Every populated field came from the invoice — chips beside each field show where the value was found."
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

        {previewOpen && primaryDoc ? (
          <DocumentPreviewModal
            documentId={primaryDoc.documentId}
            filename={primaryDoc.filename}
            open={previewOpen}
            onClose={() => setPreviewOpen(false)}
            contextLabel="Vendor-profile source"
          />
        ) : null}

        {/* Step indicator — hidden entirely when the vendor was
            auto-resolved by the shared VendorResolution rule. In that
            single-step mode the modal presents only AP Coding + a
            compact vendor summary at the top; the "Review / change
            vendor" action inside Step 2 flips `reviewingVendor` and
            reveals the two-step header + interactive navigation. */}
        {isAutoResolvedSingleStep ? null : (
          <div className="spectre-cvap-steps" data-testid="cvap-step-indicator" data-active={step}>
            <button
              type="button"
              className={`spectre-cvap-step spectre-cvap-step-btn ${step === "PROFILE" ? "is-active" : createdVendorId ? "is-done" : ""}`}
              onClick={() => setStep("PROFILE")}
              data-testid="cvap-step-1-btn"
            >
              <span className="num">1</span>
              <span className="lbl">Vendor profile</span>
            </button>
            <span className="spectre-cvap-step-sep" aria-hidden="true" />
            <button
              type="button"
              className={`spectre-cvap-step spectre-cvap-step-btn ${step === "AP_CODING" ? "is-active" : ""} ${!createdVendorId ? "is-disabled" : ""}`}
              onClick={() => { if (createdVendorId) setStep("AP_CODING"); }}
              disabled={!createdVendorId}
              data-testid="cvap-step-2-btn"
            >
              <span className="num">2</span>
              <span className="lbl">AP coding</span>
            </button>
          </div>
        )}

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
  // Sprint 3 · Checkpoint 15P-1 — the entire profile is visible the
  // moment the modal opens. No radio gate. Existing matches (if any)
  // sit in a compact chooser strip at the top; picking one flips to
  // USE_EXISTING mode and dims the profile grid. The profile grid
  // itself is one 3-column layout — no ADDRESS / CONTACT / PAYMENT
  // subheadings — with every populated field carrying an inline
  // provenance chip below the input.
  function renderStep1() {
    const usingExisting = vendorMode === "USE_EXISTING";
    return (
      <>
        {matchesLoading || matches.length > 0 ? (
          <section className="spectre-cvap-section spectre-cvap-section--tight" data-testid="cvap-matches">
            {matchesLoading ? (
              <p className="spectre-cvap-note">Checking for existing vendor matches…</p>
            ) : (
              <div className="spectre-cvap-match-strip">
                <div className="spectre-cvap-match-strip-label">
                  Existing match{matches.length > 1 ? "es" : ""}
                </div>
                <div className="spectre-cvap-match-strip-items">
                  {matches.map((m) => (
                    <MatchChip
                      key={m.id}
                      match={m}
                      picked={chosenMatchId === m.id}
                      onToggle={() => {
                        if (chosenMatchId === m.id) {
                          setChosenMatchId(null); setVendorMode("CREATE_NEW");
                        } else {
                          setChosenMatchId(m.id); setVendorMode("USE_EXISTING");
                        }
                      }}
                    />
                  ))}
                </div>
              </div>
            )}
          </section>
        ) : null}

        {/* Slice 3 §5-§8 — Supplier identity confidence. Focused on
             the vendor-step decision; kept subtle so the profile grid
             remains the primary surface. Vendor-match state is shown
             SEPARATELY per §6 so a strong document identity is not
             collapsed into "Low" merely because there is no on-file
             vendor row. */}
        {(() => {
          const v = deriveVendorStepConfidence(ap);
          return (
            <section
              className="spectre-cvap-section spectre-cvap-section--tight"
              data-testid="cvap-vendor-confidence"
            >
              <div className="spectre-cvap-supplier-row">
                <div className="spectre-cvap-supplier-primary">
                  <span className="spectre-cvap-supplier-name" data-testid="cvap-vendor-proposed-name">
                    {v.proposedName}
                  </span>
                  <ModalConfidenceLine
                    label="Supplier identity"
                    decision={v.supplier}
                    testid="cvap-vendor-supplier-confidence"
                  />
                </div>
                <div
                  className="spectre-cvap-supplier-match"
                  data-testid="cvap-vendor-match-state"
                  data-vendor-match={v.vendorMatch.state}
                >
                  <span className="spectre-cvap-supplier-match-label">Vendor match</span>
                  <span className="spectre-cvap-supplier-match-value">{v.vendorMatch.label}</span>
                </div>
              </div>
              <style jsx>{`
                .spectre-cvap-supplier-row {
                  display: flex;
                  flex-wrap: wrap;
                  gap: 24px;
                  align-items: baseline;
                  justify-content: space-between;
                }
                .spectre-cvap-supplier-primary {
                  display: flex;
                  flex-direction: column;
                  gap: 4px;
                }
                .spectre-cvap-supplier-name {
                  font-size: 13.5px;
                  font-weight: 500;
                  color: var(--spectre-ink, #1a1e24);
                }
                .spectre-cvap-supplier-match {
                  display: flex;
                  flex-direction: column;
                  gap: 2px;
                  text-align: right;
                }
                .spectre-cvap-supplier-match-label {
                  font-size: 10.5px;
                  text-transform: uppercase;
                  letter-spacing: 0.05em;
                  color: var(--spectre-muted, #566473);
                }
                .spectre-cvap-supplier-match-value {
                  font-size: 12px;
                  color: var(--spectre-ink, #1a1e24);
                }
              `}</style>
            </section>
          );
        })()}

        <section
          className={`spectre-cvap-section ${usingExisting ? "spectre-cvap-section--dim" : ""}`}
          data-testid="cvap-profile"
          aria-disabled={usingExisting}
        >
          <div className="spectre-cvap-profile-grid" data-testid="cvap-profile-grid">
            <ProfileField label="Legal name" span={2} provenance={ap.extractedVendor.name ? "invoice PDF" : null}>
              <input type="text" className="spectre-input" value={profile.legalName}
                disabled={usingExisting}
                onChange={(e) => setProfile((p) => ({ ...p, legalName: e.target.value }))}
                data-testid="cvap-profile-legal" />
            </ProfileField>
            <ProfileField label="Operating name">
              <input type="text" className="spectre-input" value={profile.operatingName ?? ""}
                disabled={usingExisting}
                onChange={(e) => setProfile((p) => ({ ...p, operatingName: e.target.value || null }))} />
            </ProfileField>

            <ProfileField label="Address line 1" span={2} provenance={provenanceLabel(extracted?.address?.line1)}>
              <input type="text" className="spectre-input" value={profile.addressLine1 ?? ""}
                disabled={usingExisting}
                onChange={(e) => setProfile((p) => ({ ...p, addressLine1: e.target.value || null }))}
                data-testid="cvap-profile-address-line1" />
            </ProfileField>
            <ProfileField label="Address line 2" provenance={provenanceLabel(extracted?.address?.line2)}>
              <input type="text" className="spectre-input" value={profile.addressLine2 ?? ""}
                disabled={usingExisting}
                onChange={(e) => setProfile((p) => ({ ...p, addressLine2: e.target.value || null }))} />
            </ProfileField>

            <ProfileField label="City" provenance={provenanceLabel(extracted?.address?.city)}>
              <input type="text" className="spectre-input" value={profile.city ?? ""}
                disabled={usingExisting}
                onChange={(e) => setProfile((p) => ({ ...p, city: e.target.value || null }))}
                data-testid="cvap-profile-city" />
            </ProfileField>
            <ProfileField label="Province / state" provenance={provenanceLabel(extracted?.address?.provinceState)}>
              <input type="text" className="spectre-input" value={profile.provinceOrState ?? ""}
                disabled={usingExisting}
                onChange={(e) => setProfile((p) => ({ ...p, provinceOrState: e.target.value || null }))}
                data-testid="cvap-profile-province" />
            </ProfileField>
            <ProfileField label="Postal / ZIP" provenance={provenanceLabel(extracted?.address?.postalCode)}>
              <input type="text" className="spectre-input" value={profile.postalCode ?? ""}
                disabled={usingExisting}
                onChange={(e) => setProfile((p) => ({ ...p, postalCode: e.target.value || null }))}
                data-testid="cvap-profile-postal" />
            </ProfileField>

            <ProfileField label="Country" provenance={provenanceLabel(extracted?.address?.country)}>
              <input type="text" className="spectre-input" value={profile.country ?? ""}
                disabled={usingExisting}
                onChange={(e) => setProfile((p) => ({ ...p, country: e.target.value || null }))}
                data-testid="cvap-profile-country" />
            </ProfileField>
            <ProfileField label="Phone" provenance={provenanceLabel(extracted?.phone)}>
              <input type="tel" className="spectre-input" value={profile.phone ?? ""}
                disabled={usingExisting}
                onChange={(e) => setProfile((p) => ({ ...p, phone: e.target.value || null }))}
                data-testid="cvap-profile-phone" />
            </ProfileField>
            <ProfileField label="Website" provenance={provenanceLabel(extracted?.website)}>
              <input type="url" className="spectre-input" value={profile.website ?? ""}
                disabled={usingExisting}
                onChange={(e) => setProfile((p) => ({ ...p, website: e.target.value || null }))}
                data-testid="cvap-profile-website" />
            </ProfileField>

            <ProfileField label="Vendor email" provenance={provenanceLabel(extracted?.customerSupportEmail)}>
              <input type="email" className="spectre-input" value={profile.email ?? ""}
                disabled={usingExisting}
                onChange={(e) => setProfile((p) => ({ ...p, email: e.target.value || null }))} />
            </ProfileField>
            <ProfileField label="AR email" provenance={provenanceLabel(extracted?.arEmail)}>
              <input type="email" className="spectre-input" value={profile.arEmail ?? ""}
                disabled={usingExisting}
                onChange={(e) => setProfile((p) => ({ ...p, arEmail: e.target.value || null }))} />
            </ProfileField>
            <ProfileField label="AP remittance email" provenance={provenanceLabel(extracted?.remittanceEmail)}>
              <input type="email" className="spectre-input" value={profile.apRemittanceEmail ?? ""}
                disabled={usingExisting}
                onChange={(e) => setProfile((p) => ({ ...p, apRemittanceEmail: e.target.value || null }))} />
            </ProfileField>

            <ProfileField label="Payment terms (days)" provenance={provenanceLabel(extracted?.paymentTerms)}>
              <input type="number" className="spectre-input" min={0} value={profile.paymentTermsDays ?? ""}
                disabled={usingExisting}
                onChange={(e) => setProfile((p) => ({ ...p, paymentTermsDays: e.target.value ? parseInt(e.target.value, 10) : null }))}
                data-testid="cvap-profile-terms" />
            </ProfileField>
            <ProfileField label="Tax registration #" provenance={provenanceLabel(extracted?.taxRegistrationNumber)}>
              <input type="text" className="spectre-input" value={profile.taxRegistrationNumber ?? ""}
                disabled={usingExisting}
                onChange={(e) => setProfile((p) => ({ ...p, taxRegistrationNumber: e.target.value || null }))}
                data-testid="cvap-profile-tax-reg" />
            </ProfileField>
            <ProfileField label="Currency" provenance={ap.gross.currency ? "invoice PDF" : null}>
              <input type="text" className="spectre-input" maxLength={3} value={profile.currency ?? ""}
                disabled={usingExisting}
                onChange={(e) => setProfile((p) => ({ ...p, currency: e.target.value.toUpperCase() || null }))} />
            </ProfileField>

            <ProfileField
              label="Main contact"
              span={2}
              provenance={ap.sender.relationship === "VENDOR" ? "email sender" : null}
            >
              <input type="text" className="spectre-input" placeholder="Name"
                value={profile.mainContactName ?? ""}
                disabled={usingExisting}
                onChange={(e) => setProfile((p) => ({ ...p, mainContactName: e.target.value || null }))} />
            </ProfileField>
            <ProfileField label="Main contact email"
              provenance={ap.sender.relationship === "VENDOR" ? "email sender" : null}>
              <input type="email" className="spectre-input" value={profile.mainContactEmail ?? ""}
                disabled={usingExisting}
                onChange={(e) => setProfile((p) => ({ ...p, mainContactEmail: e.target.value || null }))}
                data-testid="cvap-profile-main-contact-email" />
            </ProfileField>

            <ProfileField label="Notes" span={3}>
              <textarea className="spectre-input" rows={2} value={profile.notes ?? ""}
                disabled={usingExisting}
                onChange={(e) => setProfile((p) => ({ ...p, notes: e.target.value || null }))} />
            </ProfileField>
          </div>

          {ap.sender.relationship === "EMPLOYEE_FORWARD" ? (
            <p className="spectre-cvap-note spectre-cvap-note--dim">
              Forwarded by <strong>{ap.sender.email}</strong> — internal forwarder, not populated as vendor contact.
            </p>
          ) : null}
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
            Save and finish later
          </button>
          <button
            type="button"
            className="spectre-btn spectre-btn--primary spectre-btn--sm"
            onClick={() => void handleStep1(false)}
            disabled={!canStep1Continue || submitting}
            aria-disabled={!canStep1Continue || submitting}
            data-testid="cvap-step1-primary"
          >
            {submitting ? "Working…" : usingExisting ? "Use selected vendor" : "Create vendor & continue"}
          </button>
        </footer>
      </>
    );
  }

  // ---- Step 2 body — 15P-2 --------------------------------------------------
  // Four ordered sections:
  //   1. Summary            (vendor, invoice #, dates, terms, gross)
  //   2. Coding             (GL selector + alternates + department/fund placeholder)
  //   3. Tax                (subtotal + tax + gross with rate verification)
  //   4. Proposed accounting entry — debit/credit table with balance
  //
  // The journal preview is server-computed via `previewApEntryAction`
  // and re-fetched (debounced 250ms) whenever the coding form changes.
  // Posting is disabled until the preview returns balanced.
  function renderStep2() {
    const dueDatePreviewIso = (() => {
      if (coding.explicitInvoiceDueDateIso) return coding.explicitInvoiceDueDateIso;
      const d = new Date(coding.invoiceDateIso).getTime() + (coding.paymentTermsDays ?? 30) * 86_400_000;
      return new Date(d).toISOString();
    })();
    const humanShort = (iso: string) => new Date(iso).toISOString().slice(0, 10);
    const money = (v: string | number, cur = coding.currency) => `${cur} ${Number(v).toFixed(2)}`;

    // 15P-4: Payment-terms display label — distinguish AUTO_PAY
    // from a literal Net 0. The resolver already flags isAutoPay
    // and sets a distinct provenance string; we mirror that in the
    // summary cell so the operator sees "Auto-pay" not "Net 0".
    const paymentTermsLabel =
      resolvedTerms.isAutoPay
        ? "Auto-pay"
        : coding.paymentTermsDays != null ? `Net ${coding.paymentTermsDays}` : "—";
    const dueDateProvenance =
      coding.explicitInvoiceDueDateIso ? "Due date on invoice"
      : resolvedTerms.isAutoPay ? "Auto-pay — charged automatically"
      : `Invoice date + ${coding.paymentTermsDays ?? 30} days`;

    return (
      <>
        {/* 15P-4: compact vendor header — shown ONLY when the modal
             opened directly on AP Coding via auto-resolution. Gives
             the operator a one-line record of who they're posting
             against + a "Review / change vendor" action that reveals
             the two-step Vendor Profile flow with interactive
             navigation. */}
        {isAutoResolvedSingleStep ? (
          <section className="spectre-cvap-section spectre-cvap-section--tight" data-testid="cvap-vendor-header">
            <div className="spectre-cvap-vendor-header">
              <div className="spectre-cvap-vendor-header-body">
                <div className="spectre-cvap-vendor-header-label">Vendor</div>
                <div className="spectre-cvap-vendor-header-name">{createdVendorName ?? "—"}</div>
                <div className="spectre-cvap-vendor-header-hint">Auto-resolved from existing record · matched on invoice fields</div>
              </div>
              <button
                type="button"
                className="spectre-btn spectre-btn--tertiary spectre-btn--sm"
                onClick={() => {
                  // Reveal the two-step header + drop the operator
                  // on Vendor Profile. The vendor is already resolved,
                  // so we DON'T re-run createVendorAction on return —
                  // the interactive step buttons handle navigation.
                  setReviewingVendor(true);
                  setStep("PROFILE");
                }}
                data-testid="cvap-review-vendor"
              >
                Review / change vendor
              </button>
            </div>
          </section>
        ) : null}

        {/* 1. Summary */}
        <section className="spectre-cvap-section spectre-cvap-section--tight" data-testid="cvap-step2-summary">
          <div className="spectre-cvap-summary-grid" data-testid="cvap-summary-grid">
            <SummaryCell label="Vendor" value={createdVendorName ?? "—"} testid="cvap-summary-vendor" />
            <SummaryCell label="Invoice #" value={coding.invoiceNumber || "—"} testid="cvap-summary-inv-number" />
            <SummaryCell label="Invoice date" value={humanShort(coding.invoiceDateIso)} testid="cvap-summary-inv-date" />
            <SummaryCell label="Due date"
              value={humanShort(dueDatePreviewIso)}
              provenance={dueDateProvenance}
              testid="cvap-summary-due-date" />
            <SummaryCell label="Payment terms" value={paymentTermsLabel}
              provenance={paymentTermsProvenanceHuman}
              testid="cvap-summary-terms" />
            <SummaryCell label="Gross" value={money(coding.gross || "0")} testid="cvap-summary-gross" />
          </div>
        </section>

        {/* 2. Coding — GL, department, fund, alternates
             Slice 3 §9-§15 — confidence header sits ABOVE the coding
             grid. Transaction understanding + GL recommendation are
             shown as decision-specific qualitative labels; the
             recommended account itself remains visible in the grid
             regardless of confidence (§10). */}
        {(() => {
          const c = deriveCodingStepConfidence(ap);
          return (
            <section className="spectre-cvap-section spectre-cvap-section--tight" data-testid="cvap-step2-coding">
              <div className="spectre-cvap-coding-head">
                <div className="spectre-cvap-subheading">Coding</div>
                <div className="spectre-cvap-coding-confidence" data-testid="cvap-coding-confidence-row">
                  <ModalConfidenceLine
                    label="Transaction understanding"
                    decision={c.transaction}
                    testid="cvap-coding-transaction-confidence"
                  />
                  <ModalConfidenceLine
                    label="GL recommendation"
                    decision={c.gl}
                    testid="cvap-coding-gl-confidence"
                  />
                </div>
              </div>
              {c.recommendedAccount ? (
                <div className="spectre-cvap-coding-recommend" data-testid="cvap-coding-recommended">
                  <span className="spectre-cvap-coding-recommend-label">Recommended account</span>
                  <span className="spectre-cvap-coding-recommend-value">
                    <span className="acct-num">{c.recommendedAccount.number}</span>{" "}
                    <span className="acct-name">{c.recommendedAccount.name}</span>
                  </span>
                </div>
              ) : c.recommendedAccountAbstained ? (
                <div className="spectre-cvap-coding-recommend" data-testid="cvap-coding-recommended-abstain">
                  <span className="spectre-cvap-coding-recommend-label">Recommended account</span>
                  <span className="spectre-cvap-coding-recommend-value spectre-cvap-coding-recommend-abstain">
                    Needs review — Spectre understands the purchase but did not commit to a single GL account
                  </span>
                </div>
              ) : null}
              <div className="spectre-cvap-profile-grid">
                <ProfileField label="Expense / asset account" span={2}>
                  <input type="text" className="spectre-input"
                    value={coding.glAccountNumber ? `${coding.glAccountNumber} · ${coding.glAccountName}` : ""}
                    readOnly data-testid="cvap-coding-gl" />
                </ProfileField>
                <ProfileField label="Payment terms (days)" provenance={paymentTermsProvenanceHuman}>
                  <input type="number" className="spectre-input" min={0}
                    value={coding.paymentTermsDays ?? ""}
                    onChange={(e) => setCoding((c) => ({ ...c, paymentTermsDays: e.target.value ? parseInt(e.target.value, 10) : null }))}
                    data-testid="cvap-coding-terms" />
                </ProfileField>
                <ProfileField label="Invoice #">
                  <input type="text" className="spectre-input" value={coding.invoiceNumber}
                    onChange={(e) => setCoding((c) => ({ ...c, invoiceNumber: e.target.value }))}
                    data-testid="cvap-coding-invoice" />
                </ProfileField>
                <ProfileField label="Invoice date">
                  <input type="date" className="spectre-input" value={coding.invoiceDateIso.slice(0, 10)}
                    onChange={(e) => setCoding((c) => ({ ...c, invoiceDateIso: new Date(e.target.value).toISOString() }))}
                    data-testid="cvap-coding-invoice-date" />
                </ProfileField>
                <ProfileField label="Due date (override)">
                  <input type="date" className="spectre-input" value={coding.explicitInvoiceDueDateIso?.slice(0, 10) ?? ""}
                    onChange={(e) => setCoding((c) => ({ ...c, explicitInvoiceDueDateIso: e.target.value ? new Date(e.target.value).toISOString() : null }))}
                    data-testid="cvap-coding-due-date" />
                </ProfileField>
              </div>
              {/* Slice 3 §12-§13 — humanised GL alternative disclosure.
                   Progressive: hidden by default under a <details>.
                   Each row explains WHY the alternative was not picked
                   in founder language, never a score. */}
              {c.glAlternatives.length > 0 ? (
                <details className="spectre-cvap-alt" data-testid="cvap-alternates">
                  <summary>Other compatible accounts ({c.glAlternatives.length})</summary>
                  <ul>
                    {c.glAlternatives.map((a) => (
                      <li key={a.accountNumber} data-testid={`cvap-alt-${a.accountNumber}`}>
                        <div className="spectre-cvap-alt-account">
                          <button
                            type="button"
                            className="spectre-btn spectre-btn--tertiary spectre-btn--sm"
                            onClick={() => setCoding((prev) => ({ ...prev, glAccountNumber: a.accountNumber, glAccountName: a.accountName }))}
                            data-testid={`cvap-alt-pick-${a.accountNumber}`}
                          >
                            {a.accountNumber} · {a.accountName}
                          </button>
                        </div>
                        <div className="spectre-cvap-alt-reason" data-testid={`cvap-alt-reason-${a.accountNumber}`}>
                          {a.rejectionReason}
                        </div>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              <style jsx>{`
                .spectre-cvap-coding-head {
                  display: flex;
                  justify-content: space-between;
                  align-items: baseline;
                  gap: 16px;
                  flex-wrap: wrap;
                  margin-bottom: 6px;
                }
                .spectre-cvap-coding-confidence {
                  display: inline-flex;
                  gap: 18px;
                  flex-wrap: wrap;
                }
                .spectre-cvap-coding-recommend {
                  display: flex;
                  gap: 10px;
                  align-items: baseline;
                  margin-bottom: 8px;
                  padding: 6px 10px;
                  background: rgba(0, 0, 0, 0.02);
                  border-left: 2px solid var(--spectre-accent, #2f5832);
                  border-radius: 2px;
                }
                .spectre-cvap-coding-recommend-label {
                  font-size: 10.5px;
                  text-transform: uppercase;
                  letter-spacing: 0.05em;
                  color: var(--spectre-muted, #566473);
                }
                .spectre-cvap-coding-recommend-value {
                  font-size: 12.5px;
                  color: var(--spectre-ink, #1a1e24);
                }
                .spectre-cvap-coding-recommend-abstain {
                  color: var(--spectre-status-warning, #a86200);
                  font-style: italic;
                }
                .spectre-cvap-alt-account { margin-bottom: 2px; }
                .spectre-cvap-alt-reason {
                  font-size: 11.5px;
                  font-style: italic;
                  color: var(--spectre-muted, #566473);
                  margin: 2px 0 8px 12px;
                }
              `}</style>
            </section>
          );
        })()}

        {/* Sprint 3 · Checkpoint 15V — Allocations section. Renders
             the multi-GL allocations when the analyser produced 2+
             material allocations. Editable per-allocation amount +
             account picker (from alternatives). Journal preview
             below still reconciles all debits + recoverable tax to
             the AP credit. */}
        {ap.allocations && ap.allocations.entries.length >= 2 ? (() => {
          // Slice 3 §16-§17 — per-allocation confidence. The overall
          // transaction may be strong while a single allocation's GL
          // is only Moderate; the founder must see that per-row, not
          // collapsed into one badge.
          const codingCv = deriveCodingStepConfidence(ap);
          const allocConfById: Record<string, typeof codingCv.allocations[number]> = {};
          for (const a of codingCv.allocations) allocConfById[a.entryId] = a;
          return (
          <section className="spectre-cvap-section spectre-cvap-section--tight" data-testid="cvap-step2-allocations">
            <div className="spectre-cvap-subheading">
              GL allocations
              <span className="spectre-cvap-subheading-hint">
                {" · "}{ap.allocations.entries.length} debit line{ap.allocations.entries.length === 1 ? "" : "s"} · variance {money(ap.allocations.totals.allocationVariance.toFixed(2))}
              </span>
            </div>
            <table className="spectre-cvap-journal" data-testid="cvap-allocations-table">
              <thead>
                <tr>
                  <th>Concept</th>
                  <th>Account</th>
                  <th>Description</th>
                  <th className="num">Amount</th>
                  <th>Tax</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {ap.allocations!.entries.map((entry) => {
                  const conf = allocConfById[entry.id];
                  return (
                  <tr
                    key={entry.id}
                    data-testid={`cvap-allocation-${entry.id}`}
                    data-concept={entry.economicPurposeConcept}
                    data-account={entry.recommendedAccount?.accountNumber ?? "unresolved"}
                    data-allocation-confidence={conf?.level ?? "MODERATE"}
                  >
                    <td className="dim">{entry.economicPurposeConcept.replace(/_/g, " ")}</td>
                    <td>
                      {entry.recommendedAccount ? (
                        <>
                          <span className="acct-num">{entry.recommendedAccount.accountNumber}</span>{" "}
                          <span className="acct-name">{entry.recommendedAccount.accountName}</span>
                        </>
                      ) : (
                        <span className="dim">Review required</span>
                      )}
                    </td>
                    <td className="dim">{entry.descriptions.slice(0, 2).join("; ") + (entry.descriptions.length > 2 ? `, +${entry.descriptions.length - 2} more` : "")}</td>
                    <td className="num">
                      <input
                        type="text"
                        inputMode="decimal"
                        className="spectre-input spectre-cvap-allocation-amount"
                        defaultValue={entry.amount.toFixed(2)}
                        data-testid={`cvap-allocation-amount-${entry.id}`}
                        aria-label={`Amount for ${entry.recommendedAccount?.accountName ?? entry.economicPurposeConcept}`}
                      />
                    </td>
                    <td className="dim">{entry.taxTreatment}</td>
                    <td
                      className="dim"
                      data-testid={`cvap-allocation-confidence-${entry.id}`}
                      title={conf?.reason ?? undefined}
                    >
                      {conf?.label ?? "Moderate"}
                    </td>
                  </tr>
                  );
                })}
                <tr>
                  <td colSpan={3} className="total-label">Allocations subtotal</td>
                  <td className="num" data-testid="cvap-allocations-subtotal">{money(ap.allocations!.totals.allocationsSubtotal.toFixed(2))}</td>
                  <td />
                  <td />
                </tr>
                {ap.allocations!.totals.creditTotal > 0 ? (
                  <tr>
                    <td colSpan={3} className="total-label">Credits</td>
                    <td className="num" data-testid="cvap-allocations-credits">{money((-ap.allocations!.totals.creditTotal).toFixed(2))}</td>
                    <td />
                    <td />
                  </tr>
                ) : null}
                <tr>
                  <td colSpan={3} className="total-label">Tax</td>
                  <td className="num" data-testid="cvap-allocations-tax">{money(ap.allocations!.totals.taxTotal.toFixed(2))}</td>
                  <td />
                  <td />
                </tr>
                <tr>
                  <td colSpan={3} className="total-label">Gross payable (Accounts Payable credit)</td>
                  <td className="num" data-testid="cvap-allocations-gross">{money(ap.allocations!.totals.grossTotal.toFixed(2))}</td>
                  <td />
                  <td />
                </tr>
              </tbody>
            </table>
            <p className="spectre-cvap-note">
              {Math.abs(ap.allocations!.totals.allocationVariance) < 0.02
                ? "Allocations + tax − credits balance the Accounts Payable credit."
                : `Variance ${money(ap.allocations!.totals.allocationVariance.toFixed(2))} between allocations and printed gross — review before posting.`}
            </p>
          </section>
          );
        })() : null}

        {/* 3. Tax split */}
        <section className="spectre-cvap-section spectre-cvap-section--tight" data-testid="cvap-step2-tax">
          <div className="spectre-cvap-subheading">Tax</div>
          <div className="spectre-cvap-profile-grid">
            <ProfileField label="Subtotal (pre-tax)">
              <input type="text" inputMode="decimal" className="spectre-input" value={coding.subtotal}
                onChange={(e) => {
                  const sub = e.target.value;
                  setCoding((c) => {
                    const s = Number(sub); const t = Number(c.tax || "0");
                    const g = Number.isFinite(s) && Number.isFinite(t) ? (s + t).toFixed(2) : c.gross;
                    return { ...c, subtotal: sub, gross: g };
                  });
                }}
                data-testid="cvap-coding-subtotal" />
            </ProfileField>
            <ProfileField label="GST / HST">
              <input type="text" inputMode="decimal" className="spectre-input" value={coding.tax}
                onChange={(e) => {
                  const tx = e.target.value;
                  setCoding((c) => {
                    const s = Number(c.subtotal || "0"); const t = Number(tx);
                    const g = Number.isFinite(s) && Number.isFinite(t) ? (s + t).toFixed(2) : c.gross;
                    return { ...c, tax: tx, gross: g };
                  });
                }}
                data-testid="cvap-coding-tax" />
            </ProfileField>
            <ProfileField label="Gross (subtotal + tax)">
              <input type="text" inputMode="decimal" className="spectre-input" value={coding.gross}
                onChange={(e) => setCoding((c) => ({ ...c, gross: e.target.value }))}
                data-testid="cvap-coding-gross" />
            </ProfileField>
            <ProfileField label="Currency">
              <input type="text" className="spectre-input" maxLength={3} value={coding.currency}
                onChange={(e) => setCoding((c) => ({ ...c, currency: e.target.value.toUpperCase() }))} />
            </ProfileField>
            <ProfileField label="Tax treatment" span={2}>
              <select className="spectre-input" value={coding.taxTreatment}
                onChange={(e) => setCoding((c) => ({ ...c, taxTreatment: e.target.value as CodingDraft["taxTreatment"] }))}
                data-testid="cvap-coding-tax-treatment">
                <option value="RECOVERABLE">Recoverable (GST/HST — ITC)</option>
                <option value="NON_RECOVERABLE">Non-recoverable (rolls into expense)</option>
                <option value="NONE">No tax</option>
              </select>
            </ProfileField>
          </div>
          {ap.gstVerification === "VERIFIED" && ap.gstRatePercent != null ? (
            <p className="spectre-cvap-note" data-testid="cvap-tax-verify">
              GST verified at {ap.gstRatePercent}% (subtotal × rate ≈ tax).
            </p>
          ) : ap.gstVerification === "EXTRACTED_UNVERIFIED" ? (
            <p className="spectre-cvap-note spectre-cvap-note--warn">
              Tax extracted but rate not reconciled — confirm before posting.
            </p>
          ) : null}
        </section>

        {/* 4. Proposed accounting entry — debit/credit table.
             15P-5: stale-deploy defence removed — the preview is
             now a plain POST API route with a stable URL, so the
             class of bug that produced "Preview unavailable" no
             longer exists. The three legitimate render states are:
                loading — preview request in flight
                error   — server returned a validation / config problem
                preview — a balanced (or unbalanced) proposed entry
             plus the empty-inputs "Enter GL, subtotal, and gross"
             placeholder. */}
        <section className="spectre-cvap-section spectre-cvap-section--tight" data-testid="cvap-step2-journal">
          <div className="spectre-cvap-subheading">Proposed accounting entry</div>
          {previewLoading ? (
            <p className="spectre-cvap-note">Rebuilding preview…</p>
          ) : previewError ? (
            <p className="spectre-cvap-note spectre-cvap-note--warn" data-testid="cvap-journal-error">{previewError}</p>
          ) : !preview ? (
            <p className="spectre-cvap-note">Enter GL, subtotal, and gross to see the entry.</p>
          ) : (
            <>
              <table className="spectre-cvap-journal" data-testid="cvap-journal-table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Description</th>
                    <th className="num">Debit</th>
                    <th className="num">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.lines.map((l, i) => (
                    <tr key={`${l.accountNumber}-${i}`} data-testid={`cvap-journal-line-${l.accountNumber}`}>
                      <td><span className="acct-num">{l.accountNumber}</span> <span className="acct-name">{l.accountName}</span></td>
                      <td className="dim">{l.description}</td>
                      <td className="num">{Number(l.debit) > 0 ? money(l.debit) : "—"}</td>
                      <td className="num">{Number(l.credit) > 0 ? money(l.credit) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2} className="total-label">Totals</td>
                    <td className="num" data-testid="cvap-journal-total-debits">{money(preview.totalDebits)}</td>
                    <td className="num" data-testid="cvap-journal-total-credits">{money(preview.totalCredits)}</td>
                  </tr>
                  <tr>
                    <td colSpan={2} className="total-label">Difference</td>
                    <td colSpan={2} className={`num ${preview.isBalanced ? "balanced" : "unbalanced"}`}
                      data-testid="cvap-journal-difference">
                      {money(preview.difference)}{preview.isBalanced ? " · balanced" : " · UNBALANCED — cannot post"}
                    </td>
                  </tr>
                </tfoot>
              </table>
              {preview.warnings.length > 0 ? (
                <ul className="spectre-cvap-warnings" data-testid="cvap-journal-warnings">
                  {preview.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              ) : null}
            </>
          )}
        </section>

        <footer className="spectre-cvap-foot">
          {/* 15P-4: the "Back to vendor profile" button is present
              whenever the two-step header is visible — i.e. either
              (a) the operator arrived via the new-vendor Step 1 flow
              OR (b) they auto-resolved and then clicked "Review /
              change vendor". Auto-resolved SINGLE-STEP mode hides
              the button (they never went through Step 1). */}
          {!isAutoResolvedSingleStep ? (
            <button
              type="button"
              className="spectre-btn spectre-btn--secondary spectre-btn--sm"
              onClick={() => setStep("PROFILE")}
              data-testid="cvap-back-to-profile"
            >
              Back to vendor profile
            </button>
          ) : null}
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
            disabled={!canStep2Post || submitting || postResult != null}
            aria-disabled={!canStep2Post || submitting || postResult != null}
            aria-busy={submitting}
            data-testid="cvap-post-invoice"
            title={
              !preview ? "Preview loading — please wait" :
              !preview.isBalanced ? "Entry is not balanced — cannot post" :
              undefined
            }
          >
            {/* 15P-7: label + loading state.
                Founder brief: rename primary "Post invoice" →
                "Post & clear work item" so the operator understands
                that posting completes the accounting transaction AND
                removes the item from the active Work Intake feed.
                Loading text "Posting and clearing…" signals both
                sides of the atomic transaction. Post-success the
                confirmation panel takes over — the button gets
                disabled so no double-submit is possible. */}
            {submitting ? (
              <>
                <span className="spectre-cvap-spinner" aria-hidden="true" />
                Posting and clearing…
              </>
            ) : postResult ? "Posted" : "Post & clear work item"}
          </button>
        </footer>

        {/* 15P-7 success confirmation. Rendered after handleStep2Post
             sets postResult; visible for ~1.8s before the modal
             auto-closes. Distinguishes accounting-side success from
             email-archive status. */}
        {postResult ? (
          <div
            className="spectre-cvap-post-success"
            role="status"
            aria-live="polite"
            data-testid="cvap-post-success"
          >
            <div className="spectre-cvap-post-success-headline">
              Invoice posted
              <span className="spectre-cvap-post-success-ref"> · {postResult.invoiceNumber}</span>
            </div>
            <div className="spectre-cvap-post-success-detail">
              Journal entry balanced and Work Intake item cleared.
            </div>
            <div
              className="spectre-cvap-post-success-archive"
              data-testid="cvap-post-success-archive"
              data-archive-status={postResult.lifecycle.emailArchive.status}
            >
              {postResult.lifecycle.emailArchive.status === "QUEUED"
                ? "Source email queued for archive."
                : postResult.lifecycle.emailArchive.status === "NOT_APPLICABLE"
                ? "No linked source email to archive."
                : "Email archive queue temporarily unavailable — will retry."}
            </div>
          </div>
        ) : null}
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
// 15P-3: Match chip — replaces the pre-15P-3 hardcoded "N %"
// display with an evidence-based summary + disclosure that lists
// matched / differing / not-compared fields.
//
// The chip does NOT show a percentage. The founder rule: "Do not
// display a percentage unless it is clearly labelled as an internal
// match score and product review establishes that it is more useful
// than the plain-language evidence. The preferred implementation is
// to remove the percentage from the user-facing chip."
// ---------------------------------------------------------------------------
function humaniseFieldName(k: string): string {
  const map: Record<string, string> = {
    legalName: "legal name",
    operatingName: "operating name",
    addressLine1: "address line 1",
    addressLine2: "address line 2",
    city: "city",
    provinceState: "province / state",
    postalCode: "postal / ZIP",
    country: "country",
    phone: "phone",
    website: "website",
    email: "email",
    arEmail: "AR email",
    apRemittanceEmail: "AP remittance email",
    taxRegistrationNumber: "tax registration #",
    paymentTermsDays: "payment terms",
    mainContactName: "main contact",
    mainContactEmail: "main contact email",
  };
  return map[k] ?? k;
}

function MatchChip({
  match, picked, onToggle,
}: {
  match: {
    id: string; legalName: string; operatingName: string | null;
    matchEvidence: string;
    classification: "exact" | "strong" | "possible" | "conflicting";
    matchedFields: string[]; differedFields: string[]; notComparableFields: string[];
    lastInvoiceDate: string | null;
  };
  picked: boolean;
  onToggle: () => void;
}) {
  const stateLabel = (
    match.classification === "exact"       ? "Exact match"
    : match.classification === "strong"    ? "Strong match"
    : match.classification === "possible"  ? (match.matchedFields.length === 1 ? "Exact name match" : "Possible match")
    : "Conflicting match"
  );
  const stateSummary = (
    match.classification === "conflicting"
      ? `${match.differedFields.length} field${match.differedFields.length === 1 ? "" : "s"} differ`
      : match.classification === "possible" && match.matchedFields.length === 1
      ? "limited evidence"
      : `${match.matchedFields.length} field${match.matchedFields.length === 1 ? "" : "s"} verified`
  );
  return (
    <div
      className={`spectre-cvap-match-chip-wrapper ${picked ? "is-picked" : ""}`}
      data-classification={match.classification}
      data-testid={`cvap-match-${match.id}`}
    >
      <button
        type="button"
        className={`spectre-cvap-match-chip ${picked ? "is-picked" : ""} classification-${match.classification}`}
        onClick={onToggle}
        data-testid={`cvap-match-chip-${match.id}`}
      >
        <span className="name">{match.operatingName ?? match.legalName}</span>
        <span className="evidence">
          <span className={`spectre-cvap-classification classification-${match.classification}`}>{stateLabel}</span>
          <span className="separator"> · </span>
          <span className="summary">{stateSummary}</span>
        </span>
      </button>
      <details className="spectre-cvap-match-details" data-testid={`cvap-match-details-${match.id}`}>
        <summary>Evidence</summary>
        <dl>
          <dt>Matched</dt>
          <dd data-testid={`cvap-match-matched-${match.id}`}>
            {match.matchedFields.length
              ? match.matchedFields.map(humaniseFieldName).join(", ")
              : "—"}
          </dd>
          {match.differedFields.length > 0 ? (
            <>
              <dt>Differs</dt>
              <dd data-testid={`cvap-match-differed-${match.id}`}>
                {match.differedFields.map(humaniseFieldName).join(", ")}
              </dd>
            </>
          ) : null}
          <dt>Not compared</dt>
          <dd className="dim">
            {match.notComparableFields.length
              ? match.notComparableFields.map(humaniseFieldName).join(", ")
              : "—"}
          </dd>
          {match.lastInvoiceDate ? (
            <>
              <dt>Last invoice</dt>
              <dd>{match.lastInvoiceDate}</dd>
            </>
          ) : null}
        </dl>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compact read-only summary cell for the Step 2 header. Value +
// optional provenance line (e.g. "Spectre default").
// ---------------------------------------------------------------------------
function SummaryCell({
  label, value, provenance, testid,
}: {
  label: string;
  value: string;
  provenance?: string;
  testid?: string;
}) {
  return (
    <div className="spectre-cvap-summary-cell" data-testid={testid}>
      <span className="k">{label}</span>
      <span className="v">{value}</span>
      {provenance ? <span className="provenance">{provenance}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field wrapper — keeps label + input + provenance consistent
// ---------------------------------------------------------------------------
function ProfileField({
  label, wide, span, provenance, children,
}: {
  label: string;
  wide?: boolean;
  // 15P-1: explicit column span for the 3-col compressed grid. Overrides
  // `wide` when provided. Values: 1 (default), 2, or 3.
  span?: 1 | 2 | 3;
  provenance?: string | null;
  children: React.ReactNode;
}) {
  const spanClass =
    span === 3 ? "spectre-cvap-field--span3"
    : span === 2 ? "spectre-cvap-field--span2"
    : wide ? "spectre-cvap-field--wide"
    : "";
  return (
    <label className={`spectre-cvap-field ${spanClass}`}>
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
  return sourceHuman[f.source] ?? `From ${f.source}`;
}

