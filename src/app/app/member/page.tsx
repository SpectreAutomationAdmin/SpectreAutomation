import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getActiveMember } from "@/lib/active-member";
import { Badge } from "@/components/Badge";
import { BoardPackageTile } from "@/components/dashboard/BoardPackageTile";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/finance";
import { timeOfDayGreeting } from "@/lib/greeting";
import { listForMember, type WidgetKey, type WidgetSize } from "@/lib/member-widgets";
import { SortableHubGrid, type SortableItem } from "@/components/member-hub/SortableHubGrid";
import { listDiningForMember } from "@/lib/pos/lounge";
import { getMostRecentBoardPackageForUser } from "@/lib/reporting/monthly-package-lifecycle";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { reorderHubWidgetsAction, removeHubWidgetAction, setHubWidgetSizeAction } from "./_actions";

export default async function MemberHubPage({ searchParams }: { searchParams: { welcomeMember?: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const member = await getActiveMember(user, searchParams.welcomeMember);
  if (!member) {
    redirect(user.role === "MEMBER" ? "/login" : "/app/admin");
  }

  const [account, widgets, upcomingEvents, recentCharges, recentDining, club] = await Promise.all([
    prisma.memberAccount.findUnique({ where: { memberId: member.id } }),
    listForMember(member.id),
    prisma.clubEvent.findMany({
      where: { clubId: member.clubId, eventDate: { gte: new Date() }, status: "PUBLISHED" },
      orderBy: { eventDate: "asc" },
      take: 3,
    }),
    prisma.charge.findMany({ where: { memberId: member.id }, orderBy: { transactionDate: "desc" }, take: 8 }),
    // Dining widget reads real lounge POS rows directly — the receipt
    // detail page wants the same shape, so we fetch enough to render
    // the widget without going back to the DB.
    listDiningForMember(member.id, { limit: 5 }),
    prisma.club.findUnique({ where: { id: member.clubId } }),
  ]);

  const aging = account ? (account.sixtyDayBalance ?? 0) + (account.ninetyDayBalance ?? 0) : 0;
  const showAttentionBanner = aging > 0;

  // Shape dining data for the widget renderer. Prisma Decimal needs to
  // be serialized to a number — once, here — so the renderer never
  // touches Decimal arithmetic.
  const diningSummary = recentDining.map((s) => ({
    id: s.id,
    saleNumber: s.saleNumber,
    saleDate: s.saleDate,
    grandTotal: Number(s.grandTotal.toString()),
    lineCount: s.lines.length,
    topItem: s.lines[0]?.description ?? null,
  }));

  // Build the sortable item list. We pre-render BOTH the compact and
  // detailed trees on the server so the client can flip between them
  // instantly when the user toggles size — no round trip, no flash of
  // wrong-size content. The cost is rendering each widget twice, but
  // these are pure presentational subtrees over already-fetched data.
  const renderArgs = { account, upcomingEvents, recentCharges, recentDining: diningSummary, member };
  const items: SortableItem[] = widgets
    .filter((w) => w.enabled)
    .map((w) => ({
      id: w.widgetType,
      size: w.size,
      compactNode: renderWidget(w.widgetType, "COMPACT", renderArgs),
      detailedNode: renderWidget(w.widgetType, "DETAILED", renderArgs),
    }));

  // Board Package tile — only renders if this user is a recipient
  // on a SENT/PUBLISHED monthly package, or has board reporting
  // permission (rare for member-portal users but possible for staff
  // who also hold member accounts). Regular members without either
  // condition see nothing here.
  const principal = await getCurrentPrincipal();
  const boardPackage = principal
    ? await getMostRecentBoardPackageForUser(principal, member.clubId)
    : null;

  return (
    <div>
      {showAttentionBanner && (
        <div className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Your account requires attention. Please update payment or contact administration.
        </div>
      )}

      {/* WELCOME header is pinned — not draggable, since it's a greeting, not a tile. */}
      <div className="rounded-xl bg-gradient-to-br from-club-green-700 to-club-green-900 text-white px-8 py-5 shadow-elevated flex items-end justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.3em] text-club-green-200">{club?.name}</div>
          <h1 className="mt-2 font-serif text-4xl">{timeOfDayGreeting()}, {member.firstName}.</h1>
          <p className="mt-2 text-club-green-100 max-w-xl">Your member hub — curated to your interests at the club.</p>
        </div>
        <Link
          href="/app/member/widgets"
          className="shrink-0 inline-flex items-center gap-2 rounded-full border border-club-green-200/60 px-4 py-2 text-sm text-club-cream hover:bg-club-green-800/60"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 1.5v13M1.5 8h13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span>Explore widgets</span>
        </Link>
      </div>

      {boardPackage && (
        <div className="mt-6">
          <BoardPackageTile pkg={boardPackage} />
        </div>
      )}

      <SortableHubGrid
        items={items}
        onReorder={reorderHubWidgetsAction}
        onRemove={removeHubWidgetAction}
        onResize={setHubWidgetSizeAction}
      />

      {items.length === 0 && (
        <div className="mt-8 card card-body text-center">
          <p className="text-stone-600">You haven&rsquo;t added any widgets yet.</p>
          <Link href="/app/member/widgets" className="btn btn-primary mt-4 inline-block">Browse the widget catalog</Link>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-widget rendering. Pure (data already fetched) so each call returns a
// Server Component subtree that the client grid can wrap in a sortable cell.
// ---------------------------------------------------------------------------
type DiningSummary = {
  id: string;
  saleNumber: string;
  saleDate: Date;
  grandTotal: number; // serialized from Decimal for the renderer
  lineCount: number;
  topItem: string | null;
};
type WidgetRenderArgs = {
  account: { currentBalance: number; lastPaymentDate: Date | null } | null;
  upcomingEvents: Array<{ id: string; title: string; eventDate: Date }>;
  recentCharges: Array<{ id: string; description: string; amount: number; category: string }>;
  // POS dining sales for the dining widget. Shape pre-computed below so
  // the renderer doesn't need to know about Decimal vs number.
  recentDining: DiningSummary[];
  member: { firstName: string; paymentMethodStatus: string };
};

function renderWidget(key: WidgetKey, size: WidgetSize, args: WidgetRenderArgs): React.ReactNode {
  const compact = size === "COMPACT";
  // Local alias that forwards the size flag to the Widget chrome so every
  // case below renders with the correct padding / footer density without
  // each branch having to remember to pass `compact`.
  const W = (props: { title: string; children: React.ReactNode; footer?: React.ReactNode }) => (
    <Widget {...props} compact={compact} />
  );
  switch (key) {
    case "ACCOUNT_BALANCE": {
      const wholeDollars = `$${Math.round(args.account?.currentBalance ?? 0).toLocaleString()}`;
      return (
        <W
          title="Account Balance"
          footer={compact ? undefined : <Link href="/app/member/account" className="text-sm text-club-green-700 hover:underline">View account →</Link>}
        >
          {compact ? (
            <CompactValue value={wholeDollars} sub="Current" href="/app/member/account" />
          ) : (
            <>
              <div className="font-serif text-4xl text-club-ink truncate">{formatCurrency(args.account?.currentBalance ?? 0)}</div>
              <div className="mt-2 text-xs text-stone-500">
                Last payment: {formatDate(args.account?.lastPaymentDate ?? null)}
              </div>
            </>
          )}
        </W>
      );
    }
    case "PAYMENT_METHOD_STATUS":
      return (
        <W
          title="Payment Method"
          footer={compact ? undefined : <Link href="/app/member/payment-methods" className="text-sm text-club-green-700 hover:underline">Manage methods →</Link>}
        >
          {compact ? (
            // Badge is its own visual element; anchor it at the bottom
            // for vertical rhythm with the other compact tiles.
            <div className="mt-auto min-w-0">
              <Link href="/app/member/payment-methods" className="inline-block">
                <Badge status={args.member.paymentMethodStatus} />
              </Link>
            </div>
          ) : (
            <>
              <Badge status={args.member.paymentMethodStatus} />
              <p className="mt-3 text-sm text-stone-600">{describePaymentStatus(args.member.paymentMethodStatus)}</p>
            </>
          )}
        </W>
      );
    case "WEATHER":
      return (
        <W
          title="Conditions"
          footer={compact ? undefined : <span className="text-xs text-stone-500">Live weather pending integration</span>}
        >
          {compact ? (
            <CompactValue value="21°" sub="Light breeze" />
          ) : (
            <div className="flex items-center gap-4">
              <div className="font-serif text-4xl text-club-ink">21°C</div>
              <div className="text-sm text-stone-600">
                <div>Light breeze · 8 km/h NW</div>
                <div>Course: open · cart path only #4</div>
              </div>
            </div>
          )}
        </W>
      );
    case "UPCOMING_TEE_TIMES":
      return (
        <W
          title="Upcoming Tee Times"
          footer={compact ? undefined : <span className="text-xs text-stone-500">Tee-sheet integration pending</span>}
        >
          {compact ? (
            <CompactValue value="Sat 9:48" sub="Next tee" />
          ) : (
            <ul className="space-y-2 text-sm">
              <li className="flex justify-between"><span>Sat · 9:48 AM</span><span className="text-stone-500">with J. Whitfield</span></li>
              <li className="flex justify-between"><span>Wed · 4:20 PM</span><span className="text-stone-500">Twilight</span></li>
            </ul>
          )}
        </W>
      );
    case "DRIVING_RANGE_CAMERA":
      return (
        <W
          title="Driving Range"
          footer={compact ? undefined : <span className="text-xs text-stone-500">Live camera pending integration</span>}
        >
          {compact ? (
            <div className="mt-auto min-w-0">
              <div className="h-14 w-full rounded-md bg-gradient-to-br from-club-green-300 to-club-green-700" aria-hidden="true" />
              <div className="mt-1.5 text-[10px] uppercase tracking-[0.08em] text-stone-500 truncate">Busy</div>
            </div>
          ) : (
            <div className="aspect-video rounded-md bg-gradient-to-br from-club-green-300 to-club-green-700 flex items-center justify-center text-white/80 font-serif">
              Live feed pending
            </div>
          )}
        </W>
      );
    case "LESSON_BOOKING":
      return (
        <W
          title="Lesson Booking"
          footer={compact ? undefined : <Link href="/golf/trackman-range" className="text-sm text-club-green-700 hover:underline">View the range →</Link>}
        >
          {compact ? (
            <CompactValue value="Book →" sub="Lesson" href="/contact" />
          ) : (
            <>
              <p className="text-sm text-stone-600">Book a session with our teaching professional.</p>
              <Link href="/contact" className="btn btn-secondary text-sm inline-block mt-3">
                Request a lesson
              </Link>
            </>
          )}
        </W>
      );
    case "PRO_SHOP_RECENT": {
      const items = args.recentCharges.filter((c) => c.category === "PRO_SHOP");
      return (
        <W
          title="Pro Shop"
          footer={compact ? undefined : <Link href="/app/member/account" className="text-sm text-club-green-700 hover:underline">View account →</Link>}
        >
          {compact ? (
            items[0]
              ? <CompactValue value={formatCurrency(items[0].amount)} sub="Most recent" href="/app/member/account" />
              : <CompactValue value="—" sub="None recent" />
          ) : (
            <ul className="space-y-2 text-sm">
              {items.slice(0, 3).map((c) => (
                <li key={c.id} className="flex justify-between"><span className="truncate">{c.description}</span><span>{formatCurrency(c.amount)}</span></li>
              ))}
              {items.length === 0 && <li className="text-stone-500">No recent pro shop purchases.</li>}
            </ul>
          )}
        </W>
      );
    }
    case "RESTAURANT_RECENT": {
      // Reads real POS sale rows (`POSSale` joined through `member`,
      // status COMPLETED, lounge location). The widget summarises each
      // sale by date + item count + top item; the receipt-detail page
      // at /app/member/dining/[id] shows the itemized version.
      const dining = args.recentDining;
      return (
        <W
          title="Dining"
          footer={compact ? undefined : <Link href="/app/member/dining" className="text-sm text-club-green-700 hover:underline">View dining →</Link>}
        >
          {compact ? (
            dining[0]
              ? <CompactValue value={formatCurrency(dining[0].grandTotal)} sub="Most recent" href={`/app/member/dining/${dining[0].id}`} />
              : <CompactValue value="—" sub="None recent" />
          ) : (
            <ul className="space-y-2 text-sm">
              {dining.slice(0, 3).map((s) => (
                <li key={s.id} className="flex justify-between gap-3">
                  <Link href={`/app/member/dining/${s.id}`} className="min-w-0 flex-1 hover:underline">
                    <div className="truncate text-club-ink">
                      {s.topItem ?? "Lounge order"}{s.lineCount > 1 ? ` +${s.lineCount - 1} more` : ""}
                    </div>
                    <div className="text-xs text-stone-500">{formatDateTime(s.saleDate)}</div>
                  </Link>
                  <span className="tabular-nums">{formatCurrency(s.grandTotal)}</span>
                </li>
              ))}
              {dining.length === 0 && <li className="text-stone-500">No recent dining purchases.</li>}
            </ul>
          )}
        </W>
      );
    }
    case "UPCOMING_EVENTS": {
      const first = args.upcomingEvents[0];
      return (
        <W
          title="Upcoming Events"
          footer={compact ? undefined : <Link href="/app/member/events" className="text-sm text-club-green-700 hover:underline">View all →</Link>}
        >
          {compact ? (
            first
              ? <CompactValue value={formatDate(first.eventDate)} sub={first.title} href="/app/member/events" />
              : <CompactValue value="—" sub="None upcoming" />
          ) : (
            <ul className="space-y-3 text-sm">
              {args.upcomingEvents.slice(0, 3).map((e) => (
                <li key={e.id}>
                  <div className="font-medium truncate">{e.title}</div>
                  <div className="text-xs text-stone-500">{formatDate(e.eventDate)}</div>
                </li>
              ))}
              {args.upcomingEvents.length === 0 && <li className="text-stone-500">No upcoming events.</li>}
            </ul>
          )}
        </W>
      );
    }
    case "LEAGUES":
      return (
        <W
          title="Leagues"
          footer={compact ? undefined : <span className="text-xs text-stone-500">League sign-up pending integration</span>}
        >
          {compact ? (
            <CompactValue value="Wed PM" sub="Men's league" />
          ) : (
            <ul className="text-sm space-y-2">
              <li className="flex justify-between"><span>Men&rsquo;s League</span><span className="text-stone-500">Wed PM</span></li>
              <li className="flex justify-between"><span>Mixed Couples</span><span className="text-stone-500">Sun AM</span></li>
            </ul>
          )}
        </W>
      );
    case "PRIVATE_EVENTS_INQUIRY":
      return (
        <W
          title="Private Events"
          footer={compact ? undefined : <Link href="/events" className="text-sm text-club-green-700 hover:underline">Venue details →</Link>}
        >
          {compact ? (
            <CompactValue value="Inquire →" sub="Bookings" href="/events/request" />
          ) : (
            <>
              <p className="text-sm text-stone-600">Considering a wedding, anniversary, or corporate function?</p>
              <Link href="/events/request" className="btn btn-secondary text-sm inline-block mt-3">
                Request a consultation
              </Link>
            </>
          )}
        </W>
      );
  }
}

// Compact-tile primary value. Renders one large serif value and an
// optional small-caps subtitle, sitting directly under the card title
// (no bottom-anchoring) so every widget reads top-down the same way.
// When `href` is set the value becomes a link — clicking navigates,
// dragging reorders (the parent's PointerSensor activates only after
// 6px of movement).
function CompactValue({ value, sub, href }: { value: React.ReactNode; sub?: React.ReactNode; href?: string }) {
  const valueClass = `font-serif text-2xl leading-none truncate ${href ? "text-club-green-700" : "text-club-ink"}`;
  const subEl = sub ? (
    <div className="mt-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-stone-500 truncate">{sub}</div>
  ) : null;
  if (href) {
    return (
      <Link href={href} className="min-w-0 block group/cv">
        <div className={`${valueClass} group-hover/cv:underline`}>{value}</div>
        {subEl}
      </Link>
    );
  }
  return (
    <div className="min-w-0">
      <div className={valueClass}>{value}</div>
      {subEl}
    </div>
  );
}

function Widget({ title, children, footer, compact }: { title: string; children: React.ReactNode; footer?: React.ReactNode; compact?: boolean }) {
  return (
    // `overflow-hidden` is a safety net: any per-widget content that
    // turns out to be wider than its slot is clipped at the rounded
    // card edge rather than spilling onto neighbouring tiles.
    //
    // Compact and detailed share the SAME title typography and the
    // SAME "content below title" layout — only padding and the footer
    // differ. This keeps the two sizes visually consistent so a
    // resize doesn't feel like a different widget.
    <div className="card h-full flex flex-col overflow-hidden">
      <div className={`flex-1 min-h-0 min-w-0 ${compact ? "p-4" : "card-body"}`}>
        <div className="text-sm font-medium uppercase tracking-wide text-stone-500 truncate">{title}</div>
        <div className={compact ? "mt-3" : "mt-4"}>{children}</div>
      </div>
      {!compact && footer && (
        <div className="border-t border-stone-100 px-6 py-3">{footer}</div>
      )}
    </div>
  );
}

function describePaymentStatus(s: string): string {
  switch (s) {
    case "NONE": return "No payment method on file. Please add one to keep your account in good standing.";
    case "PRIMARY_ON_FILE": return "Primary payment method on file.";
    case "PRIMARY_AND_BACKUP": return "Primary and backup payment methods on file.";
    default: return "";
  }
}
