// HR mobile-hotfix continuation (2026-08-28) — subtle desktop footer.

interface Props {
  clubName: string;
  year?: number;
  versionLabel?: string;
}

export default function DesktopFooter({ clubName, year, versionLabel = "Employee Portal v1.0" }: Props) {
  // Year — passed from the parent so this remains deterministic and
  // does not drift from server / client rendering. Falls back to a
  // pinned literal only if the parent forgets.
  const y = year ?? 2026;
  return (
    <footer
      className="border-t border-stone-200/60 bg-transparent px-8 py-5 text-[12px] text-stone-500 flex items-center justify-between"
      data-testid="portal-desktop-footer"
    >
      <div>© {y} {clubName} · All rights reserved</div>
      <div className="tabular-nums">{versionLabel}</div>
    </footer>
  );
}
