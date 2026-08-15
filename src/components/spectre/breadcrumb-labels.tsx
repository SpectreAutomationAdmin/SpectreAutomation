"use client";

// Phase 4R rev-5 (2026-08-15) — client-side dynamic breadcrumb-label
// registry.
//
// Problem the rev-5 slice solves: `HeaderContextRail` runs in the
// application shell and only sees `usePathname()`. It cannot know
// that `/app/admin/ap/vendors/cms4461to0002gypwkbhl8n67/timeline`
// belongs to `Microsoft Corporation` — only the vendor page has
// that data.
//
// Design:
//   • `<BreadcrumbLabelsProvider>` wraps the admin shell so both
//     the topbar (crumb consumer) and the page tree (label producer)
//     share ONE context. Rendered once at the admin layout level.
//   • Pages/layouts that own a dynamic entity render
//     `<RegisterBreadcrumbLabel id={vendor.id} label={vendor.legalName} />`.
//     The registration is a `useEffect`, so it survives client-side
//     navigation and is torn down cleanly on unmount.
//   • The topbar reads the current labels via `useBreadcrumbLabels()`
//     and passes them into `deriveBreadcrumbs(pathname, {dynamicLabels})`.
//
// Reusability: the map is keyed by the raw URL segment string, so the
// same mechanism works for vendor cuids, invoice ids, member cuids,
// GL account slugs, or any other named entity. No entity type is
// baked into the registry.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

interface RegistryState {
  labels: Record<string, string>;
  register: (id: string, label: string) => void;
  unregister: (id: string) => void;
}

const Ctx = createContext<RegistryState>({
  labels: {},
  register: () => {},
  unregister: () => {},
});

export function BreadcrumbLabelsProvider({ children }: { children: React.ReactNode }) {
  const [labels, setLabels] = useState<Record<string, string>>({});
  const register = useCallback((id: string, label: string) => {
    setLabels((prev) => (prev[id] === label ? prev : { ...prev, [id]: label }));
  }, []);
  const unregister = useCallback((id: string) => {
    setLabels((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
  }, []);
  const value = useMemo(() => ({ labels, register, unregister }), [labels, register, unregister]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Read the current dynamic-label map. Empty `{}` if the provider is
 * not mounted (defensive — the topbar still works without labels).
 */
export function useBreadcrumbLabels(): Record<string, string> {
  return useContext(Ctx).labels;
}

/**
 * Server-friendly wrapper — renders nothing and registers a
 * `(segmentId, displayLabel)` pair into the breadcrumb registry
 * for the current React tree. Pages/layouts render this as a small
 * client boundary next to their content:
 *
 *   <RegisterBreadcrumbLabel id={vendor.id} label={vendor.legalName} />
 *
 * The registration is idempotent — re-renders with the same values
 * do not thrash state, and unmount removes the entry cleanly so a
 * back-navigation cannot show a stale label under a different route.
 */
export function RegisterBreadcrumbLabel({ id, label }: { id: string; label: string }) {
  const { register, unregister } = useContext(Ctx);
  useEffect(() => {
    if (!id || !label) return;
    register(id, label);
    return () => unregister(id);
  }, [id, label, register, unregister]);
  return null;
}
