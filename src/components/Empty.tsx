export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-dashed border-stone-300 bg-white px-6 py-10 text-center">
      <div className="font-serif text-lg text-club-ink">{title}</div>
      {body && <p className="mt-1 text-sm text-stone-500 max-w-md mx-auto">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
