"use client";

// EP-TRAIN-4Y-Q §3+§4+§6+§7 — inline draft action row for the
// canonical editor's AI panel. One row per draft, with actions
// scoped to the draft's current lifecycle state:
//
//   REQUIRES_HUMAN_REVIEW
//     - Attest cited segments  (clears pendingReview for this draft's
//       grounding; routes POST /api/admin/training/transcript-segments/<id>/attest)
//     - Revalidate             (re-runs the validator; writes a new
//       TrainingQuestionAiValidation row)
//     - Reject                 (writes REVIEWER_REJECTED state transition)
//     - Approve                (opens the existing approval dialog
//       flow by navigating to the persisted-review surface — kept
//       intentionally since approval requires evidence attestation
//       + verifiedCorrectAnswerIndex + idempotencyKey that are better
//       collected in the dedicated modal)
//
//   APPROVED_DRAFT
//     - Promote                (destination = CHECKPOINT or FINAL_ASSESSMENT)
//
//   REJECTED
//     - (read-only) explains the rejection reason
//
// All actions call authorised API routes. No direct DB access. Error
// messages surface the server's `error` code + `message`.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type DraftState =
  | "REQUIRES_HUMAN_REVIEW"
  | "APPROVED_DRAFT"
  | "REJECTED"
  | "EDITED_VALIDATION_STALE"
  | string;

export interface InlineDraftProps {
  readonly draftId: string;
  readonly contentHash: string;
  readonly state: DraftState;
  readonly questionText: string;
  readonly options: readonly { readonly text: string; readonly isCorrect: boolean }[];
  readonly explanation: string;
  readonly sourceSegmentIds: readonly number[];
  readonly citedSegmentRows: readonly {
    readonly id: string;
    readonly segmentIndex: number;
    readonly text: string;
    readonly reviewerAttestedAt: string | null;
  }[];
  readonly latestVerdict: string | null;
  readonly latestValidationErrors: readonly {
    readonly code: string;
    readonly message: string;
  }[];
  readonly checkpointOptions: readonly { readonly id: string; readonly label: string }[];
  readonly reviewUrl: string;
}

export function AiDraftInlineActions(props: InlineDraftProps): React.ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [promoteDest, setPromoteDest] = useState<string>(
    props.checkpointOptions[0]?.id ?? "FINAL_ASSESSMENT",
  );

  async function postJson(url: string, body?: unknown): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : "{}",
    });
  }

  async function deleteJson(url: string): Promise<Response> {
    return fetch(url, { method: "DELETE" });
  }

  async function handleAttestCited(): Promise<void> {
    setErr(null);
    setMsg(null);
    setBusy("attest");
    try {
      let attested = 0;
      let skipped = 0;
      for (const seg of props.citedSegmentRows) {
        if (seg.reviewerAttestedAt !== null) {
          skipped++;
          continue;
        }
        const r = await postJson(
          `/api/admin/training/transcript-segments/${seg.id}/attest`,
          { note: `EP-TRAIN-4Y-Q attestation for draft ${props.draftId.slice(0, 10)}` },
        );
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
          throw new Error(`segment ${seg.segmentIndex}: ${body.error ?? r.status}`);
        }
        attested++;
      }
      setMsg(`Attested ${attested} segment${attested === 1 ? "" : "s"}${skipped ? ` (${skipped} already attested)` : ""}.`);
      startTransition(() => router.refresh());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleRevalidate(): Promise<void> {
    setErr(null);
    setMsg(null);
    setBusy("revalidate");
    try {
      const r = await postJson(`/api/admin/ai-training/drafts/${props.draftId}/revalidate`);
      const body = (await r.json().catch(() => ({}))) as { verdict?: string; error?: string; message?: string };
      if (!r.ok) {
        throw new Error(body.message ?? body.error ?? `HTTP ${r.status}`);
      }
      setMsg(`Validator verdict: ${body.verdict ?? "unknown"}`);
      startTransition(() => router.refresh());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleReject(): Promise<void> {
    setErr(null);
    setMsg(null);
    const reason = window.prompt("Rejection reason (visible to the audit log, min 3 chars):");
    if (!reason || reason.trim().length < 3) return;
    setBusy("reject");
    try {
      const r = await postJson(`/api/admin/ai-training/drafts/${props.draftId}/reject`, {
        reason: reason.trim(),
      });
      const body = (await r.json().catch(() => ({}))) as { state?: string; error?: string; message?: string };
      if (!r.ok) throw new Error(body.message ?? body.error ?? `HTTP ${r.status}`);
      setMsg("Draft rejected.");
      startTransition(() => router.refresh());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handlePromote(): Promise<void> {
    setErr(null);
    setMsg(null);
    setBusy("promote");
    try {
      // Approved drafts are promoted via the existing 4T route. We
      // need the draft's validationId from the parent-rendered data;
      // the inline component surfaces the Promote button only once
      // the draft is APPROVED_DRAFT (eligibility already enforced
      // server-side).
      const dest =
        promoteDest === "FINAL_ASSESSMENT"
          ? { kind: "FINAL_ASSESSMENT" }
          : { kind: "CHECKPOINT", checkpointId: promoteDest };
      // NOTE: validationId lookup required; we fetch it server-side
      // on demand via the AiSuggestionsPanel's inner provider, but
      // here we fall back to the AI workspace's /promote request
      // which includes expectedValidationId derivation. In the MVP
      // we accept a 409 and surface the message.
      const r = await postJson(`/api/admin/ai-training/drafts/${props.draftId}/promote`, {
        destination: dest,
        expectedDraftContentHash: props.contentHash,
        // expectedValidationId is validated server-side; the inline
        // component relies on the server-side latest-validation
        // lookup when omitted. If the server requires it explicitly,
        // the error surfaces here and the manager can retry from the
        // persisted-review detail surface.
      });
      const body = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      if (!r.ok || !body.ok) {
        throw new Error(body.message ?? body.error ?? `HTTP ${r.status}`);
      }
      setMsg("Promoted into draft course.");
      startTransition(() => router.refresh());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const unattestedCount = props.citedSegmentRows.filter((s) => s.reviewerAttestedAt === null).length;
  const hasPendingReviewBlocker = props.latestValidationErrors.some(
    (e) => e.code === "ERR_CONVERT_SEGMENT_PENDING_REVIEW",
  );

  return (
    <div
      className="rounded border border-stone-200 p-3 space-y-2"
      data-testid={`ai-draft-inline-${props.draftId}`}
      data-state={props.state}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-stone-800">{props.questionText}</p>
          <p className="mt-1 text-[11px] text-stone-500 font-mono">
            hash {props.contentHash.slice(0, 10)}… · state{" "}
            <span
              className={
                props.state === "APPROVED_DRAFT"
                  ? "text-emerald-700 font-medium"
                  : props.state === "REJECTED"
                    ? "text-red-700 font-medium"
                    : props.state === "REQUIRES_HUMAN_REVIEW"
                      ? "text-amber-700 font-medium"
                      : "text-stone-700 font-medium"
              }
            >
              {props.state.replace(/_/g, " ").toLowerCase()}
            </span>
            {" · "}verdict{" "}
            <span className="font-medium text-stone-700">{props.latestVerdict ?? "—"}</span>
          </p>
          <ul className="mt-2 ml-4 text-xs text-stone-700 list-disc space-y-0.5">
            {props.options.slice(0, 4).map((o, i) => (
              <li key={i}>
                {o.isCorrect ? <strong>{o.text}</strong> : o.text}
                {o.isCorrect && (
                  <span className="ml-1 text-[10px] uppercase tracking-widest text-emerald-700">
                    correct
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-stone-500">
            cites segments [{props.sourceSegmentIds.join(", ")}] ·{" "}
            {props.citedSegmentRows.filter((s) => s.reviewerAttestedAt !== null).length}/
            {props.citedSegmentRows.length} attested
          </p>
        </div>
        <Link
          href={props.reviewUrl}
          className="btn btn-secondary btn-sm shrink-0"
          data-testid={`ai-draft-inline-open-review-${props.draftId}`}
        >
          Review detail
        </Link>
      </div>

      {hasPendingReviewBlocker && unattestedCount > 0 && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          Blocked by <code>ERR_CONVERT_SEGMENT_PENDING_REVIEW</code>. Attest the cited transcript
          segments (verify they transcribe the audio accurately) then revalidate.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {props.state === "REQUIRES_HUMAN_REVIEW" && (
          <>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={pending || busy !== null || unattestedCount === 0}
              onClick={handleAttestCited}
              data-testid={`ai-draft-inline-attest-${props.draftId}`}
            >
              {busy === "attest" ? "Attesting…" : `Attest ${unattestedCount} cited segment${unattestedCount === 1 ? "" : "s"}`}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={pending || busy !== null}
              onClick={handleRevalidate}
              data-testid={`ai-draft-inline-revalidate-${props.draftId}`}
            >
              {busy === "revalidate" ? "Revalidating…" : "Revalidate"}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={pending || busy !== null}
              onClick={handleReject}
              data-testid={`ai-draft-inline-reject-${props.draftId}`}
            >
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </button>
            <Link
              href={props.reviewUrl}
              className="btn btn-primary btn-sm"
              data-testid={`ai-draft-inline-approve-${props.draftId}`}
            >
              Approve (opens review)
            </Link>
          </>
        )}
        {props.state === "APPROVED_DRAFT" && (
          <>
            <select
              className="input !py-1 !text-xs"
              value={promoteDest}
              onChange={(e) => setPromoteDest(e.target.value)}
              data-testid={`ai-draft-inline-promote-dest-${props.draftId}`}
            >
              {props.checkpointOptions.map((cp) => (
                <option key={cp.id} value={cp.id}>
                  {cp.label}
                </option>
              ))}
              <option value="FINAL_ASSESSMENT">Final assessment</option>
            </select>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={pending || busy !== null}
              onClick={handlePromote}
              data-testid={`ai-draft-inline-promote-${props.draftId}`}
            >
              {busy === "promote" ? "Promoting…" : "Promote"}
            </button>
          </>
        )}
        {props.state === "REJECTED" && (
          <span className="text-xs text-red-700">Rejected — excluded from course assembly.</span>
        )}
      </div>

      {err && (
        <p
          className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1"
          data-testid={`ai-draft-inline-error-${props.draftId}`}
        >
          {err}
        </p>
      )}
      {msg && (
        <p
          className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1"
          data-testid={`ai-draft-inline-msg-${props.draftId}`}
        >
          {msg}
        </p>
      )}
    </div>
  );
}
