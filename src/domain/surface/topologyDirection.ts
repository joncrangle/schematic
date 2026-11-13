import type { RouteTopology } from "./topologySource";

export function inferVehicleDirectionFromTopology(
  routes: readonly RouteTopology[],
  routeId: string,
  lat: number,
  lon: number,
  bearing: number | undefined,
): number {
  let best = Infinity,
    direction = 0;
  for (const route of routes) {
    if (route.routeId !== routeId) continue;
    for (let i = 1; i < route.stops.length; i++) {
      const a = route.stops[i - 1],
        b = route.stops[i];
      const scale = Math.cos((lat * Math.PI) / 180),
        dx = (b.lon - a.lon) * scale,
        dy = b.lat - a.lat;
      const length = dx * dx + dy * dy;
      if (!length) continue;
      const px = (lon - a.lon) * scale,
        py = lat - a.lat,
        t = Math.max(0, Math.min(1, (px * dx + py * dy) / length));
      const distance = (px - t * dx) ** 2 + (py - t * dy) ** 2;
      const alignment =
        bearing === undefined ? 0 : 1 - Math.cos((bearing * Math.PI) / 180 - Math.atan2(dx, dy));
      const score = distance + alignment * 1e-8;
      if (score < best) {
        best = score;
        direction = route.directionId;
      }
    }
  }
  return direction;
}
