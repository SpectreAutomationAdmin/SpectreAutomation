// WEB-1A photography registry (currently disused).
//
// Cycle 1 inspection observed that the Unsplash photo IDs I selected
// returned subject-matter that did not match the private-club direction
// (a residential bedroom for the hero) or failed to resolve (a black
// tile for Club Identity). Rather than gamble on unvetted IDs, WEB-1A
// ships with first-party SVG art direction for every visual moment
// (HeroCinematic + ClubHeritagePlate). This file remains as scaffolding
// for a future slice where the founder can curate specific licensed
// photographs and pin them by ID.
//
// If/when photography is added, populate PhotoAsset entries below and
// call unsplashSrc/unsplashSrcSet from a component. next.config.js
// already allows images.unsplash.com under remotePatterns.

export interface PhotoAsset {
  id: string;
  photographer: string;
  alt: string;
  focal: string;
}

export function unsplashSrc(asset: PhotoAsset, width: number, quality = 78): string {
  const u = new URL(`https://images.unsplash.com/${asset.id}`);
  u.searchParams.set("auto", "format,compress");
  u.searchParams.set("w", String(width));
  u.searchParams.set("q", String(quality));
  u.searchParams.set("fit", "crop");
  return u.toString();
}

export function unsplashSrcSet(asset: PhotoAsset): string {
  return [640, 960, 1280, 1600, 1920, 2560]
    .map((w) => `${unsplashSrc(asset, w)} ${w}w`)
    .join(", ");
}
