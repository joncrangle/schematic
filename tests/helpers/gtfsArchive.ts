import { deflateRawSync } from "node:zlib";

/** ZIP fixture with a genuine central directory and CRCs. No network or filesystem. */
export function gtfsZip(
  files: Record<string, string>,
  deflated = false,
  zip64 = false,
): Uint8Array {
  const chunks: Uint8Array[] = [],
    directory: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = new TextEncoder().encode(name),
      data = new TextEncoder().encode(text);
    const payload = deflated ? deflateRawSync(data) : data;
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = new Uint8Array(30 + filename.length),
      view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, deflated ? 8 : 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, payload.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, filename.length, true);
    local.set(filename, 30);
    const central = new Uint8Array(46 + filename.length + (zip64 ? 28 : 0)),
      cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, zip64 ? 45 : 20, true);
    cv.setUint16(10, deflated ? 8 : 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, zip64 ? 0xffffffff : payload.length, true);
    cv.setUint32(24, zip64 ? 0xffffffff : data.length, true);
    cv.setUint16(28, filename.length, true);
    cv.setUint32(42, zip64 ? 0xffffffff : offset, true);
    if (zip64) {
      const extra = 46 + filename.length;
      cv.setUint16(30, 28, true);
      cv.setUint16(extra, 1, true);
      cv.setUint16(extra + 2, 24, true);
      cv.setBigUint64(extra + 4, BigInt(data.length), true);
      cv.setBigUint64(extra + 12, BigInt(payload.length), true);
      cv.setBigUint64(extra + 20, BigInt(offset), true);
    }
    central.set(filename, 46);
    chunks.push(local, payload);
    directory.push(central);
    offset += local.length + payload.length;
  }
  const end = new Uint8Array(22),
    ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, directory.length, true);
  ev.setUint16(10, directory.length, true);
  ev.setUint32(
    12,
    directory.reduce((n, c) => n + c.length, 0),
    true,
  );
  ev.setUint32(16, offset, true);
  const all = [...chunks, ...directory, end];
  const result = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let pos = 0;
  for (const chunk of all) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  return result;
}

export function topologyArchive(
  options: {
    moved?: boolean;
    removed?: boolean;
    count?: number;
    routeCount?: number;
    marker?: string;
  } = {},
): Uint8Array {
  const count = options.count ?? 3;
  const ids = Array.from({ length: count }, (_, i) => String(i + 1)).filter(
    (id) => !options.removed || id !== String(count),
  );
  const routeCount = options.routeCount ?? 1;
  const routes = Array.from({ length: routeCount }, (_, i) => ({
    route: routeCount === 1 ? "r" : `r${i}`,
    trip: routeCount === 1 ? "t" : `t${i}`,
    shape: routeCount === 1 ? "s" : `s${i}`,
  }));
  return gtfsZip({
    "routes.txt":
      "route_id,route_short_name,route_long_name,route_type\n" +
      routes.map((r, i) => `${r.route},${10 + i},Main,3\n`).join(""),
    "trips.txt":
      "route_id,trip_id,direction_id,shape_id,trip_headsign\n" +
      routes.map((r) => `${r.route},${r.trip},0,${r.shape},North - Main\n`).join(""),
    "stop_times.txt":
      "trip_id,stop_id,stop_sequence\n" +
      ids.map((id) => `${routes[(Number(id) - 1) % routeCount].trip},${id},${id}\n`).join(""),
    "stops.txt":
      "stop_id,stop_name,stop_lat,stop_lon,wheelchair_boarding,parent_station\n" +
      ids
        .map((id) => `${id},Stop ${id},${options.moved && id === "1" ? 44 : 43},-79,1,parent\n`)
        .join(""),
    "shapes.txt":
      "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n" +
      routes.map((r) => `${r.shape},43,-79,1\n${r.shape},44,-78,2\n`).join(""),
    "ignored.txt": options.marker ?? "first archive",
  });
}
