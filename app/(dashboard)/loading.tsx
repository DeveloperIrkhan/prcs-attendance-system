/**
 * Route-level loading state. Keep it small: a full-page dark overlay made slow
 * reports look as though they were failing and flashed on every refresh.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="w-full space-y-2 py-2"
    >
      <div className="h-1 w-full overflow-hidden rounded-full bg-red-100">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-red-800" />
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
