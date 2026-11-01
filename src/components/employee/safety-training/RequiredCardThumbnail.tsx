"use client";

// EP-UX-2C §2 (2026-11-01) — thumbnail with graceful fallback.
//
// Renders an <img> pointing at the authenticated per-version
// thumbnail proxy.  On any load failure (404 because no thumbnail
// has been extracted yet, backfill in progress, R2 miss, network
// error) it falls back to the branded dark-green gradient
// placeholder.  The fallback is identical to the EP-UX-2B
// placeholder shape so there is no visual regression when
// extraction fails.

import { useState } from "react";

interface Props {
  /** Null = no video on this course → always show the placeholder. */
  thumbnailUrl: string | null;
}

export default function RequiredCardThumbnail({ thumbnailUrl }: Props) {
  const [failed, setFailed] = useState(false);
  const showImage = thumbnailUrl !== null && !failed;
  return (
    <div
      className="relative w-full aspect-video bg-gradient-to-br from-club-green-800 to-club-green-900 flex items-center justify-center overflow-hidden"
      data-testid="portal-course-required-card-thumbnail"
      data-thumbnail-state={showImage ? "image" : "placeholder"}
    >
      {showImage && thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          onError={() => setFailed(true)}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div
          className="absolute inset-0 opacity-20"
          style={{ backgroundImage: "radial-gradient(ellipse at center, rgba(255,255,255,0.25) 0%, transparent 60%)" }}
        />
      )}
      <div className="relative h-12 w-12 rounded-full bg-black/35 border border-white/35 flex items-center justify-center text-white group-hover:scale-105 transition-transform backdrop-blur-sm">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M8 5v14l11-7z" />
        </svg>
      </div>
    </div>
  );
}
