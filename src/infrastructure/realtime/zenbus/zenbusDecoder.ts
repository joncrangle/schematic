import type { ArrivalPrediction, LiveVehiclePosition } from "~/domain/surface/types";
import { calculateFreshness } from "~/domain/freshness";
import { decodeZenbusLive, type ZenbusTable } from "./zenbusProtocol";

export interface ZenbusPattern {
  readonly routeId: string;
  readonly stopIds: readonly string[];
  readonly directionId: 0 | 1;
  readonly headsign: string;
}
export type ZenbusIndex = Readonly<Record<string, ZenbusPattern>>;

export function decodeZenbusDocument(bytes: Uint8Array, index: ZenbusIndex, now: number) {
  const live = decodeZenbusLive(bytes);
  if (now - live.processed > 300_000 || live.processed > now + 60_000)
    throw new Error("Stale Zenbus processing timestamp");
  const vehicles = new Map<string, LiveVehiclePosition>();
  const arrivals: ArrivalPrediction[] = [];
  const tables: ZenbusTable[] = [
    ...live.tables,
    ...live.columns.map((c) => ({
      midnight: c.midnight ?? 0,
      itineraryId: c.itineraryId ?? c.id?.itineraryId,
      columns: [c],
    })),
  ];
  for (const table of tables)
    for (const column of table.columns) {
      if (column.relationship === 103 || (column.relationship ?? 0) >= 400) continue;
      const midnight = (column.midnight ?? table.midnight) * 1000;
      const positions = column.positions
        .map((p) => ({
          ...p,
          timestamp: p.millis ?? (p.seconds === undefined ? NaN : midnight + p.seconds * 1000),
        }))
        .sort((a, b) => b.timestamp - a.timestamp);
      const pos = positions[0];
      if (
        !pos ||
        !Number.isFinite(pos.timestamp) ||
        now - pos.timestamp > 300_000 ||
        pos.timestamp > now + 60_000
      )
        continue;
      if (
        !Number.isFinite(pos.latitude) ||
        !Number.isFinite(pos.longitude) ||
        Math.abs(pos.latitude) > 90 ||
        Math.abs(pos.longitude) > 180
      )
        throw new Error("Invalid Zenbus live position");
      const itineraryId =
        column.itineraryId ??
        column.itinerary?.id ??
        column.id?.itineraryId ??
        table.itineraryId ??
        table.itinerary?.id;
      const pattern = itineraryId && index[itineraryId];
      if (!pattern) throw new Error("Unknown live Zenbus itinerary; reseed topology");
      const col = column.column ?? column.id?.column;
      if (!Number.isFinite(midnight) || midnight <= 0 || col === undefined)
        throw new Error("Missing Zenbus trip identity");
      const tripId = `${itineraryId}:${midnight / 1000}:${col}`;
      const vehicleId = column.vehicleId ?? tripId;
      const freshness = calculateFreshness(now, pos.timestamp).state;
      const vehicle: LiveVehiclePosition = {
        vehicleId,
        tripId,
        routeId: pattern.routeId,
        directionId: pattern.directionId,
        latitude: pos.latitude,
        longitude: pos.longitude,
        bearing: pos.heading,
        speed: pos.speed,
        timestamp: pos.timestamp,
        freshness: freshness === "unavailable" ? "stale" : freshness,
      };
      if (!vehicles.has(vehicleId) || vehicles.get(vehicleId)!.timestamp < vehicle.timestamp)
        vehicles.set(vehicleId, vehicle);
      for (const estimate of column.estimates) {
        const stopIndex = estimate.index ?? 0;
        if (
          estimate.noTime ||
          stopIndex < (column.target ?? 0) ||
          stopIndex === pattern.stopIds.length - 1
        )
          continue;
        const seconds = estimate.departure ?? estimate.arrival ?? estimate.arriparture;
        if (seconds === undefined) continue;
        const predictedTime = midnight + seconds * 1000;
        if (predictedTime <= now) continue;
        const stopId = pattern.stopIds[stopIndex];
        if (!stopId) throw new Error("Unknown Zenbus stop index; reseed topology");
        const aimed = column.aimed.find((s) => (s.index ?? 0) === stopIndex);
        const scheduled = aimed?.departure ?? aimed?.arrival ?? aimed?.arriparture;
        arrivals.push({
          tripId,
          vehicleId,
          routeId: pattern.routeId,
          directionId: pattern.directionId,
          directionInferred: true,
          stopId,
          stopSequence: stopIndex + 1,
          predictedTime,
          delaySeconds: scheduled === undefined ? 0 : seconds - scheduled,
          scheduleRelationship: "SCHEDULED",
          isRealtime: true,
          headsign: column.headsign ?? pattern.headsign,
          freshness: vehicle.freshness,
        });
      }
    }
  return { vehicles: [...vehicles.values()], arrivals };
}
