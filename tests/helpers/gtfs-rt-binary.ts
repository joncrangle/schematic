/**
 * GTFS-RT FeedMessage binary fixture builders for unit tests.
 * Hand-roll the exact protobuf wire format (no protobufjs in this repo).
 */

export function encodeVarint(val: number): Uint8Array {
  const bytes: number[] = [];
  let n = val;
  while (n >= 0x80) {
    bytes.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  bytes.push(n);
  return new Uint8Array(bytes);
}

export function encodeString(fieldNum: number, str: string): Uint8Array {
  const strBytes = new TextEncoder().encode(str);
  const tag = (fieldNum << 3) | 2;
  const tagBytes = encodeVarint(tag);
  const lenBytes = encodeVarint(strBytes.length);

  const res = new Uint8Array(tagBytes.length + lenBytes.length + strBytes.length);
  res.set(tagBytes, 0);
  res.set(lenBytes, tagBytes.length);
  res.set(strBytes, tagBytes.length + lenBytes.length);
  return res;
}

export function encodeFloat(fieldNum: number, val: number): Uint8Array {
  const tag = (fieldNum << 3) | 5;
  const tagBytes = encodeVarint(tag);
  const buf = new Uint8Array(tagBytes.length + 4);
  buf.set(tagBytes, 0);
  const view = new DataView(buf.buffer, buf.byteOffset + tagBytes.length, 4);
  view.setFloat32(0, val, true);
  return buf;
}

export function encodeVarintField(fieldNum: number, val: number): Uint8Array {
  const tag = (fieldNum << 3) | 0;
  const tagBytes = encodeVarint(tag);
  const valBytes = encodeVarint(val);
  const res = new Uint8Array(tagBytes.length + valBytes.length);
  res.set(tagBytes, 0);
  res.set(valBytes, tagBytes.length);
  return res;
}

/**
 * Varint field holding a negative int32/int64. Protobuf sign-extends the value
 * to 64 bits, so a negative number always encodes as a 10-byte varint.
 */
export function encodeSignedVarintField(fieldNum: number, val: number): Uint8Array {
  const bytes: number[] = [];
  let n = BigInt.asUintN(64, BigInt(val));
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (n > 0n);
  return concatBuffers(encodeVarint((fieldNum << 3) | 0), new Uint8Array(bytes));
}

export function encodeMessage(fieldNum: number, content: Uint8Array): Uint8Array {
  const tag = (fieldNum << 3) | 2;
  const tagBytes = encodeVarint(tag);
  const lenBytes = encodeVarint(content.length);

  const res = new Uint8Array(tagBytes.length + lenBytes.length + content.length);
  res.set(tagBytes, 0);
  res.set(lenBytes, tagBytes.length);
  res.set(content, tagBytes.length + lenBytes.length);
  return res;
}

export function concatBuffers(...bufs: Uint8Array[]): Uint8Array {
  const total = bufs.reduce((acc, b) => acc + b.length, 0);
  const res = new Uint8Array(total);
  let offset = 0;
  for (const b of bufs) {
    res.set(b, offset);
    offset += b.length;
  }
  return res;
}

/** FeedHeader message: version="2.0" + epoch-second timestamp. */
export function encodeFeedHeader(timestampSec: number): Uint8Array {
  return encodeMessage(
    1,
    concatBuffers(encodeString(1, "2.0"), encodeVarintField(3, timestampSec)),
  );
}

/**
 * TripUpdate entity in the shape of the TTC subway feed: entity id
 * "subway-{tripId}|{Direction}" (direction lives ONLY here), TripDescriptor
 * without direction_id, one StopTimeUpdate with a predicted arrival time.
 */
export function encodeSubwayTripUpdateEntity(options: {
  entityId: string;
  tripId?: string;
  routeId?: string;
  stopSequence?: number;
  stopId: string;
  /** Epoch seconds for the StopTimeEvent time field (field 2). */
  arrivalTimeSec: number;
  scheduleRelationship?: number; // 1 = SKIPPED
  /** Destination display for the StopTimeUpdate stop_headsign field (field 7). */
  stopHeadsign?: string;
}): Uint8Array {
  const tripDescriptorParts = [
    encodeString(1, options.tripId ?? options.entityId.split("|")[0].replace(/^subway-/, "")),
  ];
  if (options.routeId !== undefined) tripDescriptorParts.push(encodeString(5, options.routeId));
  const tripDesc = concatBuffers(...tripDescriptorParts);

  const stopUpdateParts = [
    encodeVarintField(1, options.stopSequence ?? 5),
    encodeMessage(2, encodeVarintField(2, options.arrivalTimeSec)),
    encodeString(4, options.stopId),
  ];
  if (options.scheduleRelationship !== undefined) {
    stopUpdateParts.push(encodeVarintField(5, options.scheduleRelationship));
  }
  if (options.stopHeadsign !== undefined) {
    stopUpdateParts.push(encodeString(7, options.stopHeadsign));
  }
  const stopTimeUpdate = concatBuffers(...stopUpdateParts);

  const tripUpdateContent = concatBuffers(
    encodeMessage(1, tripDesc),
    encodeMessage(2, stopTimeUpdate),
  );

  return encodeMessage(
    2,
    concatBuffers(encodeString(1, options.entityId), encodeMessage(3, tripUpdateContent)),
  );
}

/**
 * Surface VehiclePosition entity in the shape the GTFS-RT decoder consumes:
 * entity id + TripDescriptor (with direction_id) + Position + schedule fields.
 */
export function encodeSurfaceVehiclePositionEntity(options: {
  entityId: string;
  vehicleId?: string;
  tripId?: string;
  routeId?: string;
  directionId?: number;
  latitude: number;
  longitude: number;
  bearing?: number;
  /** Meters per second (GTFS-RT semantic). */
  speed?: number;
  currentStopSequence?: number;
  /** GTFS-RT enum: 0 INCOMING_AT, 1 STOPPED_AT, 2 IN_TRANSIT_TO. */
  currentStatus?: number;
  stopId?: string;
  /** GTFS-RT enum index into the decoder's occupancy map. */
  occupancyStatus?: number;
  /** Epoch SECONDS for the VehiclePosition.timestamp field. */
  timestampSec?: number;
}): Uint8Array {
  const tripDescriptorParts: Uint8Array[] = [];
  if (options.tripId !== undefined) tripDescriptorParts.push(encodeString(1, options.tripId));
  if (options.routeId !== undefined) tripDescriptorParts.push(encodeString(5, options.routeId));
  if (options.directionId !== undefined) {
    tripDescriptorParts.push(encodeVarintField(6, options.directionId));
  }
  const tripDesc = concatBuffers(...tripDescriptorParts);

  const positionParts = [encodeFloat(1, options.latitude), encodeFloat(2, options.longitude)];
  if (options.bearing !== undefined) positionParts.push(encodeFloat(3, options.bearing));
  if (options.speed !== undefined) positionParts.push(encodeFloat(5, options.speed));
  const position = concatBuffers(...positionParts);

  const vehiclePositionParts: Uint8Array[] = [
    encodeMessage(1, tripDesc),
    encodeMessage(2, position),
  ];
  if (options.currentStopSequence !== undefined) {
    vehiclePositionParts.push(encodeVarintField(3, options.currentStopSequence));
  }
  if (options.currentStatus !== undefined) {
    vehiclePositionParts.push(encodeVarintField(4, options.currentStatus));
  }
  if (options.timestampSec !== undefined) {
    vehiclePositionParts.push(encodeVarintField(5, options.timestampSec));
  }
  if (options.stopId !== undefined) {
    vehiclePositionParts.push(encodeString(7, options.stopId));
  }
  if (options.vehicleId !== undefined) {
    vehiclePositionParts.push(encodeMessage(8, encodeString(1, options.vehicleId)));
  }
  if (options.occupancyStatus !== undefined) {
    vehiclePositionParts.push(encodeVarintField(9, options.occupancyStatus));
  }

  return encodeMessage(
    2,
    concatBuffers(
      encodeString(1, options.entityId),
      encodeMessage(4, concatBuffers(...vehiclePositionParts)),
    ),
  );
}

/** FeedMessage wrapping a FeedHeader plus fully-wrapped FeedEntity buffers. */
export function encodeFeed(timestampSec: number, entities: Uint8Array[]): Uint8Array {
  return concatBuffers(encodeFeedHeader(timestampSec), ...entities);
}

/**
 * Alert entity with one informed_entity selector per entry. A selector may name
 * a route, a trip, a stop, or several; the effect is the GTFS-RT enum value and
 * the active period is epoch seconds.
 */
export function encodeAlertEntity(options: {
  id: string;
  selectors: readonly { routeId?: string; tripId?: string; stopId?: string }[];
  effect: number;
  startSec?: number;
  endSec?: number;
}): Uint8Array {
  const parts: Uint8Array[] = [];
  if (options.startSec !== undefined || options.endSec !== undefined) {
    const period: Uint8Array[] = [];
    if (options.startSec !== undefined) period.push(encodeVarintField(1, options.startSec));
    if (options.endSec !== undefined) period.push(encodeVarintField(2, options.endSec));
    parts.push(encodeMessage(2, concatBuffers(...period)));
  }
  for (const selector of options.selectors) {
    const entity: Uint8Array[] = [];
    if (selector.routeId !== undefined) entity.push(encodeString(2, selector.routeId));
    if (selector.tripId !== undefined) {
      entity.push(encodeMessage(4, encodeString(1, selector.tripId)));
    }
    if (selector.stopId !== undefined) entity.push(encodeString(5, selector.stopId));
    parts.push(encodeMessage(5, concatBuffers(...entity)));
  }
  parts.push(encodeVarintField(7, options.effect));
  return encodeMessage(
    2,
    concatBuffers(encodeString(1, options.id), encodeMessage(5, concatBuffers(...parts))),
  );
}
