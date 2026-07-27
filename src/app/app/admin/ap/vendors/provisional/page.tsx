// Sprint 3 · Checkpoint 15M (2026-07-27) — Provisional vendor
// timeline. Rendered when the AP card's vendor name is clicked but
// no Vendor record exists yet (Microsoft on Coulee Ridge). Uses the
// same loader shape as the matched vendor timeline so the transition
// after vendor creation preserves history without duplication.

import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { loadProvisionalVendorTimeline } from "@/lib/vendor-timeline";

export default async function ProvisionalVendorTimelinePage({
  searchParams,
}: {
  searchParams: { name?: string; workIntakeItemId?: string };
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  const extractedName = (searchParams.name ?? "").trim();
  if (!extractedName) redirect("/app/admin");

  const timeline = await loadProvisionalVendorTimeline(clubId, {
    extractedName,
    workIntakeItemId: searchParams.workIntakeItemId ?? null,
  });
  const events = timeline.events;

  return (
    <div className="p-8 max-w-[1200px] mx-auto" data-testid="provisional-vendor-timeline-page">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.10em] text-[var(--spectre-status-warning)]">Provisional vendor · not yet on file</div>
          <h1 className="text-2xl font-semibold mt-1">{extractedName}</h1>
          <p className="text-sm text-[var(--spectre-text-secondary)] mt-1">
            Nothing in this stream is lost when {extractedName} is created as a vendor. The Work Intake item, email, and PDF below will attach to the permanent vendor timeline the moment the vendor record is created.
          </p>
        </div>
        <Link
          href="/app/admin"
          className="spectre-btn spectre-btn--secondary spectre-btn--sm"
        >
          Back to Mission Control
        </Link>
      </div>

      <div className="mb-3 text-[11px] uppercase tracking-[0.10em] text-[var(--spectre-text-secondary)]">
        Pre-creation events (newest first) — {events.length}
      </div>
      {events.length === 0 ? (
        <div className="p-6 border border-[var(--spectre-border-hairline)] rounded text-sm text-[var(--spectre-text-secondary)]" data-testid="provisional-vendor-timeline-empty">
          No pre-creation events found for the extracted identity.
        </div>
      ) : (
        <ol className="space-y-3" data-testid="provisional-vendor-timeline-events">
          {events.map((e) => (
            <li
              key={e.id}
              className="flex gap-4 p-4 border border-[var(--spectre-border-hairline)] rounded bg-[var(--spectre-surface)]"
              data-testid={`provisional-vendor-timeline-event-${e.kind.toLowerCase()}`}
            >
              <div className="w-32 shrink-0 text-xs text-[var(--spectre-text-secondary)]">
                <div>{e.ts.slice(0, 10)}</div>
                <div className="text-[var(--spectre-text-muted)]">{e.ts.slice(11, 16)}</div>
              </div>
              <div className="grow">
                <div className="text-[10px] uppercase tracking-[0.10em] text-[var(--spectre-text-muted)]">{e.kind.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}</div>
                <div className="font-medium mt-0.5">{e.title}</div>
                {e.detail ? <div className="text-sm text-[var(--spectre-text-secondary)] mt-0.5">{e.detail}</div> : null}
                {e.actorLabel ? <div className="text-xs text-[var(--spectre-text-muted)] mt-1">by {e.actorLabel}</div> : null}
              </div>
              {e.href ? (
                <Link href={e.href} className="spectre-btn spectre-btn--tertiary spectre-btn--sm self-start">
                  Open source
                </Link>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
