"use client";

// HR-2C B2 §publish readiness (2026-08-20).
//
// Readiness list comes from B1 `checkPublishReadiness` — this
// component NEVER duplicates the readiness rules in React (§25
// explicit). If the list has reasons, Publish is disabled with a
// clear reason breakdown. If ready, Publish is enabled.

interface Props {
  readiness: { ready: boolean; reasons: string[] };
  canPublish: boolean;
  publishAction: () => Promise<void>;
}

export default function PublishPanel({ readiness, canPublish, publishAction }: Props) {
  if (readiness.ready && canPublish) {
    return (
      <div className="space-y-3" data-testid="training-publish-panel" data-ready="true">
        <p className="text-sm text-stone-700">
          Ready to publish. The current published version, if any, will be retired.
          Employees who already completed a prior version remain certified against
          that version.
        </p>
        <form action={publishAction}>
          <button type="submit" className="btn btn-primary" data-testid="training-publish-submit">
            Publish this version
          </button>
        </form>
      </div>
    );
  }
  return (
    <div className="space-y-3" data-testid="training-publish-panel" data-ready="false">
      <p className="text-sm text-stone-700">
        {canPublish
          ? "A few things need attention before this draft can be published:"
          : "You don't have permission to publish training. A Club administrator can review and publish this draft."}
      </p>
      {canPublish && (
        <ul className="text-sm text-amber-800 list-disc pl-5 space-y-1" data-testid="training-publish-readiness-reasons">
          {readiness.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      {canPublish && (
        <button
          type="button"
          className="btn btn-primary opacity-50 cursor-not-allowed"
          disabled
          data-testid="training-publish-submit"
        >
          Publish this version
        </button>
      )}
    </div>
  );
}
