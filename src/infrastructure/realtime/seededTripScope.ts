import type { TripRoute } from "~/domain/surface/boarding";

/** Shared feeds may only contribute trips proven to belong to the seeded operator. */
export function selectSeededTrips<T extends { readonly tripId?: string; readonly routeId: string }>(
  values: readonly T[],
  trips: ReadonlyMap<string, TripRoute> | undefined,
): T[] {
  if (!trips) throw new Error("Selected source agencies require seeded trip membership");
  return values.filter((value) => {
    const trip = value.tripId ? trips.get(value.tripId) : undefined;
    return trip !== undefined && trip.routeId === value.routeId;
  });
}
