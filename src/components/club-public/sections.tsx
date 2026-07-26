// Re-usable section primitives for the public club site. Kept small so
// page files read as content + structure rather than a wall of Tailwind.

import Link from "next/link";

export function MarketingEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] uppercase tracking-[0.35em] text-club-green-700">{children}</div>
  );
}

export function SectionHeading({ eyebrow, title, lede }: { eyebrow?: string; title: React.ReactNode; lede?: React.ReactNode }) {
  return (
    <div className="max-w-3xl">
      {eyebrow ? <MarketingEyebrow>{eyebrow}</MarketingEyebrow> : null}
      <h2 className="mt-3 font-serif text-3xl md:text-4xl leading-tight text-club-ink">{title}</h2>
      {lede ? <p className="mt-4 text-lg leading-relaxed text-stone-600">{lede}</p> : null}
    </div>
  );
}

// A two-column block with an image-feeling panel on one side and prose on
// the other. The "image" is rendered as a layered gradient + brand
// accents so we don't hotlink real photographs — see
// docs/silver-springs-content-gaps.md for the real-asset plan.
export function ImagePanel({ variant = "fairway" }: { variant?: "fairway" | "clubhouse" | "events" | "trackman" | "course" }) {
  // Each variant maps to a distinct gradient + accent so the home page
  // doesn't feel like a wall of the same color.
  const styles: Record<string, string> = {
    fairway: "bg-gradient-to-br from-club-green-800 via-club-green-600 to-club-green-300",
    clubhouse: "bg-gradient-to-br from-club-sand via-club-cream to-club-stone",
    events: "bg-gradient-to-br from-club-green-50 via-club-cream to-club-gold/30",
    trackman: "bg-gradient-to-br from-stone-900 via-club-green-900 to-club-green-700",
    course: "bg-gradient-to-tr from-club-green-700 via-club-green-500 to-club-green-200",
  };
  return (
    <div className={`relative aspect-[4/3] md:aspect-[5/4] rounded-2xl overflow-hidden shadow-elevated ${styles[variant]}`}>
      {/* Subtle texture: diagonal sheen + corner mark. */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/20 via-transparent to-transparent" />
      <div className="absolute bottom-5 left-5 right-5 flex items-end justify-between text-club-cream/90">
        <div className="text-[11px] uppercase tracking-[0.3em]">Silver Springs</div>
        <div className="text-[11px] uppercase tracking-[0.3em] capitalize">{variant}</div>
      </div>
    </div>
  );
}

export function TwoColumn({
  imageSide = "left",
  variant,
  children,
}: {
  imageSide?: "left" | "right";
  variant?: Parameters<typeof ImagePanel>[0]["variant"];
  children: React.ReactNode;
}) {
  return (
    <div className={`grid md:grid-cols-2 gap-10 md:gap-16 items-center ${imageSide === "right" ? "md:[&>div:first-child]:order-2" : ""}`}>
      <div><ImagePanel variant={variant} /></div>
      <div>{children}</div>
    </div>
  );
}

export function PrimaryCTA({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center justify-center rounded-md bg-club-green-700 text-white px-6 py-3 text-sm font-medium tracking-wide hover:bg-club-green-800 transition-colors"
    >
      {children}
    </Link>
  );
}

export function SecondaryCTA({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center justify-center rounded-md border border-club-green-700 text-club-green-700 px-6 py-3 text-sm font-medium tracking-wide hover:bg-club-green-700 hover:text-white transition-colors"
    >
      {children}
    </Link>
  );
}

// Testimonial card. Names + tenure are draft / sample copy — see
// content-gaps doc for the "real testimonial" hand-off plan.
export function Testimonial({
  quote,
  name,
  tenure,
}: {
  quote: string;
  name: string;
  tenure: string;
}) {
  return (
    <figure className="bg-white rounded-2xl p-8 shadow-card border border-club-stone flex flex-col h-full">
      <svg className="h-8 w-8 text-club-green-700" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
        <path d="M9 8h6v6H9a4 4 0 00-4 4v2H3v-2a8 8 0 016-8zM23 8h6v6h-6a4 4 0 00-4 4v2h-2v-2a8 8 0 016-8z" />
      </svg>
      <blockquote className="mt-4 flex-1 font-serif text-xl leading-relaxed text-club-ink">
        &ldquo;{quote}&rdquo;
      </blockquote>
      <figcaption className="mt-6 text-sm text-stone-600">
        <div className="font-medium text-club-ink">{name}</div>
        <div className="text-xs uppercase tracking-wide text-stone-500">{tenure}</div>
      </figcaption>
    </figure>
  );
}

export function PillarCard({
  eyebrow,
  title,
  body,
  href,
  cta,
}: {
  eyebrow: string;
  title: string;
  body: string;
  href: string;
  cta: string;
}) {
  return (
    <Link
      href={href}
      className="group block bg-white rounded-2xl border border-club-stone p-8 shadow-card hover:shadow-elevated transition-shadow"
    >
      <MarketingEyebrow>{eyebrow}</MarketingEyebrow>
      <div className="mt-3 font-serif text-2xl text-club-ink">{title}</div>
      <p className="mt-3 text-sm leading-relaxed text-stone-600">{body}</p>
      <div className="mt-5 text-sm font-medium text-club-green-700 group-hover:text-club-green-800">{cta} →</div>
    </Link>
  );
}
