// AP-ORB-2 (2026-10-14) — staging-only size selector for the
// Vendor orb comparison demo.
//
// Renders the SAME production `VendorFieldClient` component with
// a 20 px or 64 px orb (founder's choice).  The selector lives
// ONLY on `/app/admin/work-intake/vendor-orb-demo` — the real
// AP Invoice Review page never imports this component.
//
// A full remount (via `key`) is forced when the size flips, so a
// mid-animation flip at one size doesn't leak into the other.

"use client";

import { useState } from "react";
import VendorFieldClient from "./VendorFieldClient";

type Size = 20 | 64;

interface Props {
  vendor: string;
  initial?: Size;
}

export default function VendorOrbDemoSelector({ vendor, initial = 20 }: Props) {
  const [size, setSize] = useState<Size>(initial);
  return (
    <div className="ap-orb-vendor-demo-selector-wrap">
      <div
        className="ap-orb-vendor-demo-selector"
        role="radiogroup"
        aria-label="Orb size for comparison"
      >
        <button
          type="button"
          role="radio"
          aria-checked={size === 20}
          data-testid="ap-orb-demo-size-20"
          data-active={size === 20 ? "true" : "false"}
          className="ap-orb-vendor-demo-size"
          onClick={() => setSize(20)}
        >
          20 px
        </button>
        <span aria-hidden="true" className="ap-orb-vendor-demo-divider">
          |
        </span>
        <button
          type="button"
          role="radio"
          aria-checked={size === 64}
          data-testid="ap-orb-demo-size-64"
          data-active={size === 64 ? "true" : "false"}
          className="ap-orb-vendor-demo-size"
          onClick={() => setSize(64)}
        >
          64 px
        </button>
      </div>
      <div
        className="ap-orb-vendor-demo-stage"
        data-testid="ap-orb-demo-stage"
        data-ap-orb-demo-size={size}
      >
        {/* `key` forces a full remount when the size flips so any
            mid-animation state at the previous size is discarded. */}
        <VendorFieldClient key={size} vendor={vendor} size={size} />
      </div>
    </div>
  );
}
