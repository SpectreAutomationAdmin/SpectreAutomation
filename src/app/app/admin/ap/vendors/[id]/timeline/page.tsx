// Sprint 3 · Checkpoint 15M (2026-07-27) — Vendor relationship
// timeline page. Reusable route pattern: /app/admin/ap/vendors/[id]/timeline.
//
// Newest-first stream of every event tied to a vendor:
// vendor-created, email-received, invoice-ingested, AP-invoice-created,
// AP-invoice-posted, work-intake-opened / resolved.
//
// Tenant-scoped via loadVendorTimeline. A cross-tenant vendor id
// returns 404.

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { loadVendorTimeline } from "@/lib/vendor-timeline";

export default async function VendorTimelinePage({ params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  const timeline = await loadVendorTimeline(clubId, params.id);
  if (!timeline) notFound();
  const { header, events } = timeline;

  return (
    <div className="p-8 max-w-[1200px] mx-auto" data-testid="vendor-timeline-page">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.10em] text-[var(--spectre-text-secondary)]">Vendor timeline</div>
          <h1 className="text-2xl font-semibold mt-1">{header?.legalName}</h1>
          {header?.operatingName ? (
            <div className="text-sm text-[var(--spectre-text-secondary)]">Trading as {header.operatingName}</div>
          ) : null}
        </div>
        {/* 15P-7: gear icon links to the existing vendor settings
             page. Founder rule: the relationship timeline is the
             primary destination; settings sit behind the gear. */}
        <Link
          href={`/app/admin/ap/vendors/${params.id}`}
          className="spectre-vendor-gear"
          data-testid="vendor-timeline-settings-gear"
          aria-label="Vendor settings"
          title="Vendor settings"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </Link>
      </div>

      {header ? (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-8" data-testid="vendor-timeline-header">
          <HeaderStat k="Status" v={header.status} />
          <HeaderStat k="Vendor since" v={header.vendorSince ?? "—"} />
          <HeaderStat k="Terms" v={header.paymentTermsDays != null ? `Net ${header.paymentTermsDays}` : "—"} />
          <HeaderStat k="Currency" v={header.currency ?? "—"} />
          <HeaderStat k="Open invoices" v={String(header.openInvoices)} />
          <HeaderStat k="12-mo invoices" v={String(header.totalInvoices12mo)} />
        </div>
      ) : null}

      <div className="mb-3 text-[11px] uppercase tracking-[0.10em] text-[var(--spectre-text-secondary)]">
        Events (newest first) — {events.length}
      </div>
      {events.length === 0 ? (
        <div className="p-6 border border-[var(--spectre-border-hairline)] rounded text-sm text-[var(--spectre-text-secondary)]" data-testid="vendor-timeline-empty">
          No events on file yet for this vendor.
        </div>
      ) : (
        <ol className="space-y-3" data-testid="vendor-timeline-events">
          {events.map((e) => (
            <li
              key={e.id}
              className="flex gap-4 p-4 border border-[var(--spectre-border-hairline)] rounded bg-[var(--spectre-surface)]"
              data-testid={`vendor-timeline-event-${e.kind.toLowerCase()}`}
            >
              <div className="w-32 shrink-0 text-xs text-[var(--spectre-text-secondary)]">
                <div>{e.ts.slice(0, 10)}</div>
                <div className="text-[var(--spectre-text-muted)]">{e.ts.slice(11, 16)}</div>
              </div>
              <div className="grow">
                <div className="text-[10px] uppercase tracking-[0.10em] text-[var(--spectre-text-muted)]">{humanKind(e.kind)}</div>
                <div className="font-medium mt-0.5">{e.title}</div>
                {e.detail ? <div className="text-sm text-[var(--spectre-text-secondary)] mt-0.5">{e.detail}</div> : null}
                {e.actorLabel ? <div className="text-xs text-[var(--spectre-text-muted)] mt-1">by {e.actorLabel}</div> : null}
              </div>
              {e.href ? (
                <Link
                  href={e.href}
                  className="spectre-btn spectre-btn--tertiary spectre-btn--sm self-start"
                  data-testid={`vendor-timeline-event-link-${e.sourceId}`}
                >
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

function HeaderStat({ k, v }: { k: string; v: string }) {
  return (
    <div className="p-3 border border-[var(--spectre-border-hairline)] rounded bg-[var(--spectre-surface)]">
      <div className="text-[10px] uppercase tracking-[0.10em] text-[var(--spectre-text-secondary)]">{k}</div>
      <div className="font-medium mt-0.5">{v}</div>
    </div>
  );
}

function humanKind(k: string): string {
  return k.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
