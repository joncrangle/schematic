export function NearbyLoadingSkeleton() {
  return (
    <div class="flex flex-col gap-2.5 animate-pulse">
      {[1, 2, 3].map(() => (
        <div class="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
          <div class="flex items-center gap-2">
            <div class="h-7 w-12 rounded-md bg-accent" />
            <div class="flex flex-1 flex-col gap-1">
              <div class="h-3.5 w-3/4 rounded bg-accent" />
              <div class="h-2.5 w-1/2 rounded bg-muted" />
            </div>
          </div>
          <div class="h-2.5 w-2/3 rounded bg-muted" />
          <div class="mt-1 flex gap-2">
            <div class="h-5 w-14 rounded-md bg-accent" />
            <div class="h-5 w-14 rounded-md bg-muted" />
            <div class="h-5 w-14 rounded-md bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}
