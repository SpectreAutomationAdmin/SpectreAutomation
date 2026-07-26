// Rendered when an inbound host doesn't match either the Spectre platform
// host or any ACTIVE ClubDomain row. The message is deliberately generic so
// the page can't be used to enumerate pending domains.

import { getActiveBranding } from "@/lib/branding";

export default async function UnknownDomainPage() {
  const branding = await getActiveBranding();
  const host = branding.hostname || "(unknown)";
  return (
    <div className="min-h-screen flex items-center justify-center bg-stone-50">
      <div className="max-w-lg text-center px-6">
        <h1 className="text-4xl font-medium text-club-ink">This site isn&rsquo;t configured here.</h1>
        <p className="mt-4 text-stone-600">
          The hostname <code className="font-mono">{host}</code> isn&rsquo;t recognized.
          If you&rsquo;ve recently set up a new domain, the activation may still be
          pending — please contact your club administrator.
        </p>
        <p className="mt-8 text-xs text-stone-400">
          Error reference: WHITELABEL_UNKNOWN_HOST
        </p>
      </div>
    </div>
  );
}
