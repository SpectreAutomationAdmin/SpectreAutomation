// HR-2B.3 (2026-08-19) — Direct-deposit card selector.
//
// Two side-by-side cards. Selecting one reveals the corresponding
// form. Both forms are POSTed to server actions in `../_actions.ts`.
// The upload card renders a client-side preview (thumbnail for
// images; filename + size for PDFs).

"use client";

import { useEffect, useRef, useState } from "react";

type Choice = "none" | "manual" | "upload";

interface Props {
  hasBank: boolean;
  hasDoc: boolean;
  saveBankAccountAction: (formData: FormData) => Promise<void>;
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
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

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
            PDF or a photo. We&apos;ll key it in and confirm with you.
          </p>
        </button>
      </div>

      {choice === "manual" && (
        <form action={saveBankAccountAction} className="mt-6 space-y-5" noValidate>
          <label className="block">
            <span className="block text-sm text-stone-700">Name on the account</span>
            <input
              type="text"
              name="holderName"
              required
              autoComplete="name"
              placeholder="e.g. Bethany Nakamura"
              maxLength={200}
              data-testid="banking-holder-name"
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
            />
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
                data-testid="banking-institution"
                className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base font-mono text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
              />
              <span className="mt-1 block text-xs text-stone-500">3 digits.</span>
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
                data-testid="banking-transit"
                className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base font-mono text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
              />
              <span className="mt-1 block text-xs text-stone-500">5 digits.</span>
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
                data-testid="banking-account"
                className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base font-mono text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
              />
              <span className="mt-1 block text-xs text-stone-500">7-12 digits.</span>
            </label>
          </div>

          <div className="flex items-center justify-end pt-2">
            <button
              type="submit"
              data-testid="banking-save"
              className="rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
            >
              Save banking
            </button>
          </div>
        </form>
      )}

      {choice === "upload" && (
        <form
          action={uploadBankingDocumentAction}
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
                  defaultChecked
                  className="mt-1 text-emerald-700 focus:ring-emerald-700"
                />
                <span className="text-sm text-stone-800">A void cheque</span>
              </label>
              <label className="flex items-start gap-3 rounded-md border border-stone-200 px-3 py-2 cursor-pointer hover:border-stone-300">
                <input
                  type="radio"
                  name="category"
                  value="direct_deposit_form"
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
                  if (previewUrl) URL.revokeObjectURL(previewUrl);
                  setPreviewUrl(null);
                  setSelectedName(null);
                  setSelectedSize(null);
                  setSelectedIsPdf(false);
                  return;
                }
                if (previewUrl) URL.revokeObjectURL(previewUrl);
                const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
                setSelectedIsPdf(isPdf);
                setSelectedName(f.name);
                setSelectedSize(f.size);
                setPreviewUrl(isPdf ? null : URL.createObjectURL(f));
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
                  onClick={() => {
                    if (previewUrl) URL.revokeObjectURL(previewUrl);
                    setPreviewUrl(null);
                    setSelectedName(null);
                    setSelectedSize(null);
                    setSelectedIsPdf(false);
                    if (fileRef.current) fileRef.current.value = "";
                  }}
                  className="mt-1 text-xs text-stone-500 hover:text-stone-800 underline"
                >
                  Choose a different file
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end pt-2">
            <button
              type="submit"
              data-testid="banking-upload-submit"
              className="rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
            >
              Upload
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
