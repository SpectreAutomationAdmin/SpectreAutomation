// HR-2B.3.2 §1 (2026-08-18) — Direct-deposit card selector with
// extract + confirm flow.
//
// Two side-by-side cards:
//   1. "Enter my banking information" — unchanged manual form,
//      POSTs to `saveBankAccountAction` (canonical
//      `submitSelfBankAccount`).
//   2. "Upload a void cheque or direct-deposit form" — replaces the
//      previous silent-persistence flow. The upload button now
//      streams the file to `/api/hr/onboarding/self/banking-document/
//      upload`, waits for the server to persist + extract, and
//      renders a pre-filled version of the manual form. The
//      employee edits any wrong / missing field and clicks
//      "Confirm and save"; that submits via the SAME canonical
//      `saveBankAccountAction`, so banking data becomes canonical
//      ONLY at the confirmation step.
//
// The previous flow POSTed to a server action, redirected back to
// the same page, and the client's `choice` state reset — the
// employee saw the upload UI disappear and thought nothing happened.

"use client";

import { useEffect, useRef, useState } from "react";

type Choice = "none" | "manual" | "upload";
type UploadStage = "picking" | "reading" | "confirming" | "failed";

type Confidence = "high" | "medium" | "low" | "missing";
interface ExtractedField {
  value: string | null;
  confidence: Confidence;
}
interface Extraction {
  holderName: ExtractedField;
  institutionNumber: ExtractedField;
  transitNumber: ExtractedField;
  accountNumber: ExtractedField;
  meta: {
    pages?: number;
    mimeType: string;
    sha256Prefix: string;
    readOutcome: string;
  };
}

interface UploadResponse {
  documentId: string;
  uploadedAt: string;
  category: "void_cheque" | "direct_deposit_form";
  extraction: Extraction;
}

interface Props {
  hasBank: boolean;
  hasDoc: boolean;
  saveBankAccountAction: (formData: FormData) => Promise<void>;
  /** Retained for progressive-enhancement fallback if the fetch
   *  path fails at the network layer (older browsers, offline). */
  uploadBankingDocumentAction: (formData: FormData) => Promise<void>;
}

export default function DirectDepositCards({
  hasBank,
  hasDoc,
  saveBankAccountAction,
  uploadBankingDocumentAction,
}: Props) {
  // Default to the missing-piece so returning employees land where
  // there's still work to do.
  const initial: Choice = !hasBank ? "manual" : !hasDoc ? "upload" : "none";
  const [choice, setChoice] = useState<Choice>(initial);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [selectedSize, setSelectedSize] = useState<number | null>(null);
  const [selectedIsPdf, setSelectedIsPdf] = useState<boolean>(false);
  const [selectedCategory, setSelectedCategory] = useState<"void_cheque" | "direct_deposit_form">("void_cheque");

  const [uploadStage, setUploadStage] = useState<UploadStage>("picking");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [uploadedDocumentId, setUploadedDocumentId] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const uploadFormRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function resetFilePicker() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setSelectedName(null);
    setSelectedSize(null);
    setSelectedIsPdf(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleUpload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setUploadError("Please choose a file to upload.");
      setUploadStage("failed");
      return;
    }
    setUploadStage("reading");
    setUploadError(null);

    const body = new FormData();
    body.append("document", file);
    body.append("category", selectedCategory);

    try {
      const res = await fetch("/api/hr/onboarding/self/banking-document/upload", {
        method: "POST",
        body,
      });
      const contentType = res.headers.get("content-type") ?? "";
      const payload = contentType.includes("application/json") ? await res.json() : null;
      if (!res.ok) {
        // Progressive-enhancement fallback: if the fetch failed for
        // a reason the server-action would also have surfaced, hand
        // off to the server action so the employee still gets a
        // response (redirect-based, but at least visible).
        const message =
          (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string")
            ? (payload as { error: string }).error
            : "We couldn't upload that document. Please try again.";
        setUploadError(message);
        setUploadStage("failed");
        return;
      }
      const response = payload as UploadResponse;
      setUploadedDocumentId(response.documentId);
      setExtraction(response.extraction);
      setUploadStage("confirming");
    } catch (err) {
      // Network / transport failure. Fall back to the legacy server-
      // action path so the upload at least completes; the employee
      // will land back on this page with the file persisted but the
      // extract-and-confirm UX degraded to manual entry.
      void err;
      if (uploadFormRef.current) {
        // We rebuild the form data because React's synthetic event
        // may already have been consumed.
        const fallback = new FormData();
        fallback.append("document", file);
        fallback.append("category", selectedCategory);
        try {
          await uploadBankingDocumentAction(fallback);
        } catch {
          /* server action redirects on success/failure; ignore
             throws from React's transition machinery. */
        }
      }
    }
  }

  const hasAnyExtracted =
    !!extraction &&
    (extraction.holderName.value != null ||
      extraction.institutionNumber.value != null ||
      extraction.transitNumber.value != null ||
      extraction.accountNumber.value != null);

  return (
    <div className="mt-8">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setChoice("manual")}
          data-testid="banking-choice-manual"
          className={`text-left rounded-md border px-4 py-4 transition-colors ${
            choice === "manual"
              ? "border-emerald-700 bg-emerald-50/40"
              : "border-stone-200 hover:border-stone-300"
          }`}
        >
          <p className="text-sm font-medium text-stone-900">
            Enter my banking information
          </p>
          <p className="mt-1 text-xs text-stone-500 leading-relaxed">
            Institution, transit, and account numbers from your cheque or
            online banking.
          </p>
        </button>
        <button
          type="button"
          onClick={() => setChoice("upload")}
          data-testid="banking-choice-upload"
          className={`text-left rounded-md border px-4 py-4 transition-colors ${
            choice === "upload"
              ? "border-emerald-700 bg-emerald-50/40"
              : "border-stone-200 hover:border-stone-300"
          }`}
        >
          <p className="text-sm font-medium text-stone-900">
            Upload a void cheque or direct-deposit form
          </p>
          <p className="mt-1 text-xs text-stone-500 leading-relaxed">
            PDF or a photo. We&apos;ll read it and let you confirm every field.
          </p>
        </button>
      </div>

      {choice === "manual" && (
        <ManualBankingForm
          saveBankAccountAction={saveBankAccountAction}
          initial={null}
          testIdPrefix="banking"
          submitLabel="Save banking"
        />
      )}

      {choice === "upload" && uploadStage !== "confirming" && (
        <form
          ref={uploadFormRef}
          onSubmit={handleUpload}
          encType="multipart/form-data"
          className="mt-6 space-y-5"
          noValidate
        >
          <fieldset>
            <legend className="text-sm text-stone-700">What are you uploading?</legend>
            <div className="mt-2 space-y-2">
              <label className="flex items-start gap-3 rounded-md border border-stone-200 px-3 py-2 cursor-pointer hover:border-stone-300">
                <input
                  type="radio"
                  name="category"
                  value="void_cheque"
                  checked={selectedCategory === "void_cheque"}
                  onChange={() => setSelectedCategory("void_cheque")}
                  className="mt-1 text-emerald-700 focus:ring-emerald-700"
                />
                <span className="text-sm text-stone-800">A void cheque</span>
              </label>
              <label className="flex items-start gap-3 rounded-md border border-stone-200 px-3 py-2 cursor-pointer hover:border-stone-300">
                <input
                  type="radio"
                  name="category"
                  value="direct_deposit_form"
                  checked={selectedCategory === "direct_deposit_form"}
                  onChange={() => setSelectedCategory("direct_deposit_form")}
                  className="mt-1 text-emerald-700 focus:ring-emerald-700"
                />
                <span className="text-sm text-stone-800">
                  A completed direct-deposit form from my bank
                </span>
              </label>
            </div>
          </fieldset>

          <label className="block">
            <span className="block text-sm text-stone-700">Choose a file</span>
            <input
              ref={fileRef}
              type="file"
              name="document"
              accept=".pdf,image/*"
              required
              data-testid="void-cheque-input"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) {
                  resetFilePicker();
                  return;
                }
                if (previewUrl) URL.revokeObjectURL(previewUrl);
                const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
                setSelectedIsPdf(isPdf);
                setSelectedName(f.name);
                setSelectedSize(f.size);
                setPreviewUrl(isPdf ? null : URL.createObjectURL(f));
                // Any prior extraction / error is stale once a new
                // file is picked.
                setUploadStage("picking");
                setUploadError(null);
                setExtraction(null);
                setUploadedDocumentId(null);
              }}
              className="mt-2 block w-full text-sm text-stone-800 file:mr-4 file:rounded-md file:border-0 file:bg-stone-100 file:px-4 file:py-2 file:text-sm file:font-medium file:text-stone-800 hover:file:bg-stone-200"
            />
            <span className="mt-2 block text-xs text-stone-500">
              PDF, JPG, PNG, or HEIC. Up to 15 MB.
            </span>
          </label>

          {(selectedName || previewUrl) && (
            <div className="flex items-center gap-4 rounded-md border border-stone-200 bg-stone-50 px-3 py-3">
              {previewUrl && !selectedIsPdf ? (
                /* eslint-disable-next-line @next/next/no-img-element -- client-only object URL preview, no remote resource */
                <img
                  src={previewUrl}
                  alt="Selected document preview"
                  className="h-20 w-20 rounded-md object-cover"
                />
              ) : (
                <div className="flex h-20 w-20 items-center justify-center rounded-md bg-stone-200 text-xs font-medium text-stone-600">
                  PDF
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-stone-800">{selectedName}</p>
                {selectedSize != null && (
                  <p className="text-xs text-stone-500">
                    {(selectedSize / 1024).toFixed(0)} KB
                  </p>
                )}
                <button
                  type="button"
                  onClick={resetFilePicker}
                  className="mt-1 text-xs text-stone-500 hover:text-stone-800 underline"
                >
                  Choose a different file
                </button>
              </div>
            </div>
          )}

          {uploadStage === "reading" && (
            <div
              data-testid="banking-extraction-processing"
              className="flex items-center gap-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-3 text-sm text-stone-700"
            >
              <span
                aria-hidden
                className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-emerald-700"
              />
              <span>Reading your document&hellip;</span>
            </div>
          )}

          {uploadStage === "failed" && uploadError && (
            <div
              data-testid="banking-extraction-error"
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900"
            >
              {uploadError}
            </div>
          )}

          <div className="flex items-center justify-end pt-2">
            <button
              type="submit"
              data-testid="banking-upload-submit"
              disabled={uploadStage === "reading" || !selectedName}
              className="rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {uploadStage === "reading" ? "Reading…" : "Upload & read"}
            </button>
          </div>
        </form>
      )}

      {choice === "upload" && uploadStage === "confirming" && extraction && (
        <div className="mt-6 space-y-5">
          <div
            className="rounded-md border border-emerald-100 bg-emerald-50/60 px-4 py-3 text-sm text-emerald-900"
          >
            {hasAnyExtracted ? (
              <>
                <p className="font-medium">We read your document — please review each field below.</p>
                <p className="mt-1 text-xs text-emerald-900/80">
                  Anything marked &ldquo;please verify&rdquo; or &ldquo;not detected&rdquo; needs
                  your attention. Edit any field, then click &ldquo;Confirm and save&rdquo;.
                </p>
              </>
            ) : (
              <>
                <p className="font-medium">
                  We couldn&apos;t read the banking details automatically.
                </p>
                <p className="mt-1 text-xs text-emerald-900/80">
                  Please enter them below. Your uploaded document is saved on
                  your file for the Club to reference.
                </p>
              </>
            )}
          </div>

          <ManualBankingForm
            saveBankAccountAction={saveBankAccountAction}
            initial={extraction}
            testIdPrefix="banking"
            submitLabel="Confirm and save"
            confirmationMode
          />

          <p className="text-xs text-stone-500" data-testid="banking-uploaded-document-id">
            Document ref: {uploadedDocumentId ? uploadedDocumentId.slice(-8) : ""}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Extracted manual form — reused for both the from-scratch entry and
// the post-extraction confirmation. In confirmation mode the fields
// pre-fill from `initial` and render a per-field confidence badge.
// ---------------------------------------------------------------------------
function ManualBankingForm({
  saveBankAccountAction,
  initial,
  testIdPrefix,
  submitLabel,
  confirmationMode = false,
}: {
  saveBankAccountAction: (formData: FormData) => Promise<void>;
  initial: Extraction | null;
  testIdPrefix: string;
  submitLabel: string;
  confirmationMode?: boolean;
}) {
  const holderDefault = initial?.holderName.value ?? "";
  const institutionDefault = initial?.institutionNumber.value ?? "";
  const transitDefault = initial?.transitNumber.value ?? "";
  const accountDefault = initial?.accountNumber.value ?? "";

  const testId = confirmationMode ? "banking-extracted-form" : undefined;

  return (
    <form
      action={saveBankAccountAction}
      className="mt-6 space-y-5"
      data-testid={testId}
      noValidate
    >
      <label className="block">
        <span className="block text-sm text-stone-700">Name on the account</span>
        <input
          type="text"
          name="holderName"
          required
          autoComplete="name"
          placeholder="e.g. Bethany Nakamura"
          maxLength={200}
          defaultValue={holderDefault}
          data-testid={`${testIdPrefix}-holder-name`}
          className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
        />
        {confirmationMode && (
          <ConfidenceBadge
            confidence={initial?.holderName.confidence ?? "missing"}
            testId={`${testIdPrefix}-holder-name-badge`}
          />
        )}
      </label>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <label className="block">
          <span className="block text-sm text-stone-700">Institution</span>
          <input
            type="text"
            name="institutionNumber"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={5}
            placeholder="123"
            defaultValue={institutionDefault}
            data-testid={`${testIdPrefix}-institution`}
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base font-mono text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
          />
          <span className="mt-1 block text-xs text-stone-500">3 digits.</span>
          {confirmationMode && (
            <ConfidenceBadge
              confidence={initial?.institutionNumber.confidence ?? "missing"}
              testId={`${testIdPrefix}-institution-badge`}
            />
          )}
        </label>
        <label className="block">
          <span className="block text-sm text-stone-700">Transit</span>
          <input
            type="text"
            name="transitNumber"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={7}
            placeholder="12345"
            defaultValue={transitDefault}
            data-testid={`${testIdPrefix}-transit`}
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base font-mono text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
          />
          <span className="mt-1 block text-xs text-stone-500">5 digits.</span>
          {confirmationMode && (
            <ConfidenceBadge
              confidence={initial?.transitNumber.confidence ?? "missing"}
              testId={`${testIdPrefix}-transit-badge`}
            />
          )}
        </label>
        <label className="block">
          <span className="block text-sm text-stone-700">Account</span>
          <input
            type="text"
            name="accountNumber"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={14}
            placeholder="1234567"
            defaultValue={accountDefault}
            data-testid={`${testIdPrefix}-account`}
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base font-mono text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
          />
          <span className="mt-1 block text-xs text-stone-500">7-12 digits.</span>
          {confirmationMode && (
            <ConfidenceBadge
              confidence={initial?.accountNumber.confidence ?? "missing"}
              testId={`${testIdPrefix}-account-badge`}
            />
          )}
        </label>
      </div>

      <div className="flex items-center justify-end pt-2">
        <button
          type="submit"
          data-testid={`${testIdPrefix}-save`}
          className="rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function ConfidenceBadge({ confidence, testId }: { confidence: Confidence; testId?: string }) {
  const label =
    confidence === "high"
      ? "Extracted (high confidence)"
      : confidence === "medium"
        ? "Extracted — please verify"
        : confidence === "low"
          ? "Extracted — please verify"
          : "Not detected — please fill in";
  const tone =
    confidence === "high"
      ? "bg-emerald-50 text-emerald-800 border-emerald-100"
      : confidence === "missing"
        ? "bg-amber-50 text-amber-800 border-amber-100"
        : "bg-stone-50 text-stone-700 border-stone-200";
  return (
    <span
      data-testid={testId}
      className={`mt-1 inline-block rounded-sm border px-2 py-0.5 text-[10px] uppercase tracking-wider ${tone}`}
    >
      {label}
    </span>
  );
}
