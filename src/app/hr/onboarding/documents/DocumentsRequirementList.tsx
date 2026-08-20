// HR-2B.4 (2026-08-19) — Client component for the Documents & Credentials
// requirement list.
//
// Uploads stream to /api/hr/onboarding/self/requirement-document/upload
// (canonical route calling `uploadSelfRequirementDocument`). Credential
// details + confirmations submit via server actions bound in the parent
// server component and passed in as props.

"use client";

import { useRef, useState } from "react";

export type RequirementKind = "DOCUMENT_UPLOAD" | "CREDENTIAL_WITH_EXPIRY" | "CONFIRMATION_ONLY";

export interface RequirementItem {
  id: string;
  code: string;
  displayName: string;
  explanation: string | null;
  kind: RequirementKind;
  documentCategory: string | null;
  required: boolean;
  requireExpiry: boolean;
  satisfied: boolean;
  documentId: string | null;
  expiresAt: string | null;
  acknowledgedAt: string | null;
}

interface Props {
  requirements: RequirementItem[];
  saveCredentialDetailsAction: (formData: FormData) => Promise<void>;
  confirmRequirementAction: (formData: FormData) => Promise<void>;
  continueFromDocumentsAction: () => Promise<void>;
  allRequiredSatisfied: boolean;
}

type UploadState =
  | { stage: "idle" }
  | { stage: "uploading" }
  | { stage: "success"; documentId: string; displayName: string | null }
  | { stage: "failed"; message: string };

function RequirementCard({
  req,
  saveCredentialDetailsAction,
  confirmRequirementAction,
}: {
  req: RequirementItem;
  saveCredentialDetailsAction: (formData: FormData) => Promise<void>;
  confirmRequirementAction: (formData: FormData) => Promise<void>;
}) {
  const [upload, setUpload] = useState<UploadState>({ stage: "idle" });
  const [uploadedDocId, setUploadedDocId] = useState<string | null>(req.documentId);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function handleUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setUpload({ stage: "uploading" });
    const fd = new FormData();
    fd.set("requirementId", req.id);
    fd.set("document", file);
    try {
      const res = await fetch("/api/hr/onboarding/self/requirement-document/upload", {
        method: "POST",
        body: fd,
        credentials: "same-origin",
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUpload({
          stage: "failed",
          message:
            payload && typeof payload.error === "string"
              ? payload.error
              : "We couldn't upload that document. Your progress is safe. Please try again.",
        });
        return;
      }
      setUploadedDocId(payload.documentId);
      setUpload({ stage: "success", documentId: payload.documentId, displayName: file.name });
    } catch {
      setUpload({ stage: "failed", message: "Network error — please try again." });
    }
  }

  const badgeTone = req.satisfied
    ? "border-emerald-300 bg-emerald-50 text-emerald-900"
    : req.required
      ? "border-amber-300 bg-amber-50 text-amber-900"
      : "border-stone-300 bg-stone-50 text-stone-700";

  return (
    <article
      className="rounded-lg border border-stone-200 bg-white px-6 py-6"
      data-testid={`requirement-card-${req.code}`}
    >
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-serif text-lg text-stone-900" data-testid={`requirement-name-${req.code}`}>
            {req.displayName}
          </h3>
          {req.explanation && (
            <p className="mt-1 text-sm text-stone-500 leading-relaxed">{req.explanation}</p>
          )}
        </div>
        <span
          className={`shrink-0 inline-block rounded-sm border px-2 py-0.5 text-[10px] uppercase tracking-wider ${badgeTone}`}
          data-testid={`requirement-status-${req.code}`}
        >
          {req.satisfied ? "Received" : req.required ? "Required" : "Optional"}
        </span>
      </header>

      {/* DOCUMENT_UPLOAD */}
      {req.kind === "DOCUMENT_UPLOAD" && (
        <form onSubmit={handleUpload} encType="multipart/form-data" className="mt-4 space-y-3" noValidate>
          <input
            ref={fileRef}
            type="file"
            name="document"
            accept=".pdf,image/*"
            required
            data-testid={`requirement-file-${req.code}`}
            className="block w-full text-sm text-stone-800 file:mr-4 file:rounded-md file:border-0 file:bg-stone-100 file:px-4 file:py-2 file:text-sm file:font-medium file:text-stone-800 hover:file:bg-stone-200"
          />
          <div className="flex items-center justify-end">
            <button
              type="submit"
              disabled={upload.stage === "uploading"}
              data-testid={`requirement-upload-${req.code}`}
              className="rounded-md bg-emerald-800 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-900 disabled:opacity-50"
            >
              {upload.stage === "uploading" ? "Uploading…" : req.satisfied ? "Replace document" : "Upload document"}
            </button>
          </div>
          {upload.stage === "failed" && (
            <p className="text-xs text-amber-800" data-testid={`requirement-upload-error-${req.code}`}>
              {upload.message}
            </p>
          )}
          {upload.stage === "success" && (
            <p className="text-xs text-emerald-800" data-testid={`requirement-upload-success-${req.code}`}>
              Received: {upload.displayName ?? "your document"}.
            </p>
          )}
        </form>
      )}

      {/* CREDENTIAL_WITH_EXPIRY */}
      {req.kind === "CREDENTIAL_WITH_EXPIRY" && (
        <div className="mt-4 space-y-4">
          <form onSubmit={handleUpload} encType="multipart/form-data" className="space-y-3" noValidate>
            <label className="block">
              <span className="block text-sm text-stone-700">Certificate document</span>
              <input
                ref={fileRef}
                type="file"
                name="document"
                accept=".pdf,image/*"
                data-testid={`requirement-file-${req.code}`}
                className="mt-1 block w-full text-sm text-stone-800 file:mr-4 file:rounded-md file:border-0 file:bg-stone-100 file:px-4 file:py-2 file:text-sm file:font-medium file:text-stone-800 hover:file:bg-stone-200"
              />
            </label>
            <div className="flex items-center justify-end">
              <button
                type="submit"
                disabled={upload.stage === "uploading"}
                data-testid={`requirement-upload-${req.code}`}
                className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-800 hover:bg-stone-50 disabled:opacity-50"
              >
                {upload.stage === "uploading" ? "Uploading…" : uploadedDocId ? "Replace document" : "Upload certificate"}
              </button>
            </div>
            {upload.stage === "failed" && (
              <p className="text-xs text-amber-800" data-testid={`requirement-upload-error-${req.code}`}>
                {upload.message}
              </p>
            )}
            {upload.stage === "success" && (
              <p className="text-xs text-emerald-800" data-testid={`requirement-upload-success-${req.code}`}>
                Received: {upload.displayName ?? "certificate"}.
              </p>
            )}
          </form>

          <form action={saveCredentialDetailsAction} className="space-y-3">
            <input type="hidden" name="requirementId" value={req.id} />
            {uploadedDocId && <input type="hidden" name="documentId" value={uploadedDocId} />}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-sm text-stone-700">Certificate number <span className="text-stone-400 text-xs">(optional)</span></span>
                <input
                  type="text"
                  name="reference"
                  defaultValue={""}
                  maxLength={100}
                  data-testid={`requirement-reference-${req.code}`}
                  className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
                />
              </label>
              <label className="block">
                <span className="block text-sm text-stone-700">
                  Expiry date {req.requireExpiry && <span className="text-red-600">*</span>}
                </span>
                <input
                  type="date"
                  name="expiresAt"
                  defaultValue={req.expiresAt ?? ""}
                  required={req.requireExpiry}
                  data-testid={`requirement-expiry-${req.code}`}
                  className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
                />
              </label>
            </div>
            <div className="flex items-center justify-end pt-2">
              <button
                type="submit"
                data-testid={`requirement-save-${req.code}`}
                className="rounded-md bg-emerald-800 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-900"
              >
                Save credential
              </button>
            </div>
          </form>
        </div>
      )}

      {/* CONFIRMATION_ONLY */}
      {req.kind === "CONFIRMATION_ONLY" && (
        <form action={confirmRequirementAction} className="mt-4">
          <input type="hidden" name="requirementId" value={req.id} />
          <label className="flex items-start gap-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-3">
            <input
              type="checkbox"
              required
              defaultChecked={!!req.acknowledgedAt}
              disabled={!!req.acknowledgedAt}
              data-testid={`requirement-confirm-check-${req.code}`}
              className="mt-1 text-emerald-700 focus:ring-emerald-700"
            />
            <span className="text-sm text-stone-800">
              I confirm the above.
            </span>
          </label>
          {!req.acknowledgedAt && (
            <div className="mt-3 flex items-center justify-end">
              <button
                type="submit"
                data-testid={`requirement-confirm-${req.code}`}
                className="rounded-md bg-emerald-800 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-900"
              >
                Confirm
              </button>
            </div>
          )}
        </form>
      )}
    </article>
  );
}

export default function DocumentsRequirementList(props: Props) {
  const { requirements, saveCredentialDetailsAction, confirmRequirementAction, continueFromDocumentsAction, allRequiredSatisfied } = props;

  if (requirements.length === 0) {
    return (
      <article
        className="rounded-lg border border-stone-200 bg-white px-6 py-8 md:px-10 md:py-10"
        data-testid="documents-empty-state"
      >
        <h2 className="font-serif text-2xl leading-tight text-stone-900">
          You&apos;re all set here.
        </h2>
        <p className="mt-2 text-sm text-stone-500 leading-relaxed">
          The Club doesn&apos;t need any additional documents for your role.
        </p>
        <form action={continueFromDocumentsAction} className="mt-6 flex items-center justify-end">
          <button
            type="submit"
            data-testid="documents-continue-empty"
            className="rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900"
          >
            Continue
          </button>
        </form>
      </article>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-md border border-stone-200 bg-white px-6 py-4">
        <p className="text-sm text-stone-600 leading-relaxed">
          A couple of documents before you&apos;re finished. Only what&apos;s applicable to your role appears below.
        </p>
      </div>
      {requirements.map((r) => (
        <RequirementCard
          key={r.id}
          req={r}
          saveCredentialDetailsAction={saveCredentialDetailsAction}
          confirmRequirementAction={confirmRequirementAction}
        />
      ))}
      <form action={continueFromDocumentsAction} className="flex items-center justify-end">
        <button
          type="submit"
          disabled={!allRequiredSatisfied}
          data-testid="documents-continue"
          className="rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 disabled:opacity-50 disabled:cursor-not-allowed"
          title={allRequiredSatisfied ? "" : "Please complete the required items before continuing."}
        >
          {allRequiredSatisfied ? "Continue" : "Please complete required items"}
        </button>
      </form>
    </div>
  );
}
