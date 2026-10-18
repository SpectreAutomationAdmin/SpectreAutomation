// AP-ORB-1 (2026-10-14) — staging-only demo route for founder
// motion acceptance.
//
// Renders the SAME production `VendorFieldClient` component used
// by the real AP Invoice Review page's Vendor cell.  The ONLY
// difference from the production path is that the vendor string
// here is a hardcoded demo value ("Club Support Inc") because the
// current Coulee staging dataset does not have an AP intake with
// an extracted vendor.  Everything else — the orb package, the
// choreography, the clipped cell, the replay button, the reduced-
// motion gate, every CSS token — is byte-identical to production.
//
// This route is removable without any change to the Vendor-cell
// implementation (per directive §4).  Delete this folder and the
// production Vendor-cell behaviour is unaffected.

import Link from "next/link";
import VendorFieldAuthenticClient from "@/components/work-intake/review/VendorFieldAuthenticClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Vendor Orb · Demo" };

export default function VendorOrbDemoPage() {
  // AP-ORB-1 §4 — "Replay must use the existing persisted Vendor
  // value."  On a real intake this comes from
  // `RealReviewData.invoice.vendor`; on this staging-only demo
  // route the value is a static demo string so the production
  // component tree still receives a `vendor: string` prop.
  const demoVendor = "Club Support Inc";
  return (
    <div className="wi-review-root" data-testid="ap-orb-vendor-orb-demo-root">
      <div style={{ maxWidth: 720, margin: "60px auto", padding: "0 24px" }}>
        <Link
          href="/app/admin/work-intake"
          style={{
            fontSize: 12,
            color: "var(--wi-ink-3)",
            textDecoration: "none",
          }}
        >
          ← Back to Work Intake
        </Link>
        <h1 style={{
          marginTop: 24,
          marginBottom: 6,
          fontFamily: "Georgia, serif",
          fontSize: 22,
          fontWeight: 600,
          color: "var(--wi-ink)",
        }}>
          Vendor Orb · Demo
        </h1>
        <p style={{ fontSize: 12.5, color: "var(--wi-ink-3)", marginBottom: 28 }}>
          Staging-only route for founder motion acceptance.  Renders the
          production <code>VendorFieldAuthenticClient</code> with a demo
          vendor string.  Append <code>?orb=1</code> to see the Replay
          button, which hides the vendor name and shows the authentic
          AP-ORB-3 <code>&lt;ThinkingOrb/&gt;</code> at 64 px for ~2 s
          before restoring the name.
        </p>

        <div className="wi-review-card wi-review-card--details" aria-label="Vendor demo">
          <div className="wi-review-card-head">
            <h2 className="wi-review-card-title">Vendor</h2>
          </div>
          <div style={{
            padding: "14px 18px",
            display: "flex",
            alignItems: "baseline",
            gap: 16,
          }}>
            <div style={{
              minWidth: 118,
              fontSize: 10.5,
              letterSpacing: "0.9px",
              textTransform: "uppercase",
              color: "var(--wi-ink-3)",
            }}>
              Vendor
            </div>
            <div style={{
              fontSize: 13,
              color: "var(--wi-ink)",
              fontVariantNumeric: "tabular-nums",
            }}>
              <VendorFieldAuthenticClient vendor={demoVendor} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
