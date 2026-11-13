export type CoordPair = [number, number];

/** Seeder's equirectangular RDP, with its existing eight metre tolerance. */
export function simplifyRdp(points: CoordPair[], epsilonMeters = 8): CoordPair[] {
  if (points.length <= 2) return points;
  let maxDist = 0;
  let index = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i++) {
    const d = perpendicularDistance(points[i], points[0], points[end]);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist > epsilonMeters) {
    const left = simplifyRdp(points.slice(0, index + 1), epsilonMeters);
    const right = simplifyRdp(points.slice(index), epsilonMeters);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[end]];
}

function perpendicularDistance(p: CoordPair, p1: CoordPair, p2: CoordPair): number {
  const [lat0, lon0] = p;
  const [lat1, lon1] = p1;
  const [lat2, lon2] = p2;
  if (lat1 === lat2 && lon1 === lon2) {
    return Math.sqrt(((lat0 - lat1) * 111139) ** 2 + ((lon0 - lon1) * 80350) ** 2);
  }
  const dx = (lon2 - lon1) * Math.cos(((lat1 + lat2) * Math.PI) / 360) * 111139;
  const dy = (lat2 - lat1) * 111139;
  const num = Math.abs(
    dx * (lat1 - lat0) * 111139 - (lon1 - lon0) * Math.cos((lat0 * Math.PI) / 180) * 111139 * dy,
  );
  const den = Math.sqrt(dx * dx + dy * dy);
  return den === 0 ? 0 : num / den;
}
