import * as Schema from "effect/Schema";
import type { TrainMapDecryption, TrainMapGtfsIndex } from "~/agencies/types";
import type { ArrivalPrediction, LiveVehiclePosition } from "~/domain/surface/types";
import { calculateFreshness } from "~/domain/freshness";
import { parseWallClock } from "../wallClock";
import type { NetworkTrainSnapshot } from "../networkTrains";

/** Records older than this are frozen positions, not a train being tracked. */
const MAX_RECORD_AGE_MS = 15 * 60_000;
const MPH_TO_METRES_PER_SECOND = 0.44704;
const HEADINGS: Readonly<Record<string, number>> = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
};

const OptionalText = Schema.optional(Schema.Union([Schema.String, Schema.Null]));
const CallSchema = Schema.Struct({
  code: Schema.String,
  schdep: OptionalText,
  estdep: OptionalText,
  postdep: OptionalText,
  schcmnt: OptionalText,
});
const TrainSchema = Schema.Struct({
  geometry: Schema.Struct({
    coordinates: Schema.Tuple([Schema.Number, Schema.Number]),
  }),
  properties: Schema.Record(Schema.String, Schema.Unknown),
});
const DocumentSchema = Schema.Struct({
  features: Schema.Array(TrainSchema).check(
    Schema.makeFilter((features) =>
      features.length > 0
        ? undefined
        : "Empty network document has not been established as a valid quiet feed",
    ),
  ),
});

const hexBytes = (value: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(value.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
const base64Bytes = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

async function aesCbc(
  data: Uint8Array<ArrayBuffer>,
  password: string,
  decryption: TrainMapDecryption,
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: hexBytes(decryption.salt),
      iterations: decryption.iterations,
      hash: "SHA-1",
    },
    material,
    { name: "AES-CBC", length: 128 },
    false,
    ["decrypt"],
  );
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-CBC", iv: hexBytes(decryption.iv) }, key, data),
  );
}

/** The body's tail is a `password|nonce` blob sealed with the public key; the password opens the rest. */
export async function decryptTrainMapDocument(
  wire: Uint8Array,
  decryption: TrainMapDecryption,
): Promise<Uint8Array> {
  const body = new TextDecoder().decode(wire).trim();
  if (body.length <= decryption.passwordLength) throw new Error("Train map body is truncated");
  const sealed = body.slice(-decryption.passwordLength);
  const cipher = body.slice(0, -decryption.passwordLength);
  const unsealed = new TextDecoder().decode(
    await aesCbc(base64Bytes(sealed), decryption.publicKey, decryption),
  );
  const password = unsealed.split("|")[0];
  if (!password) throw new Error("Train map password blob is unreadable");
  return aesCbc(base64Bytes(cipher), password, decryption);
}

/** `M/D/YYYY h:mm:ss AM` or `MM/DD/YYYY HH:mm:ss`, in the given zone. */
function parseLocal(value: string, timeZone: string): number {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})(?: ([AP]M))?$/.exec(
    value.trim(),
  );
  if (!match) throw new Error(`Invalid train map time: ${value}`);
  const [, month, day, year, rawHour, minute, second, meridiem] = match;
  let hour = Number(rawHour);
  if (meridiem) {
    if (hour < 1 || hour > 12) throw new Error(`Invalid train map time: ${value}`);
    hour = (hour % 12) + (meridiem === "PM" ? 12 : 0);
  }
  const pad = (part: string | number) => String(part).padStart(2, "0");
  return parseWallClock(
    `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${minute}:${second}`,
    timeZone,
  );
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Unknown or malformed trains are skipped so one never blanks the rest; none decoding fails the read. */
export function decodeTrainMapDocument(
  bytes: Uint8Array,
  index: TrainMapGtfsIndex,
  recordTimeZone: string,
  now: number,
): NetworkTrainSnapshot {
  const document = Schema.decodeUnknownSync(DocumentSchema)(
    JSON.parse(new TextDecoder().decode(bytes)),
  );
  const vehicles: LiveVehiclePosition[] = [];
  const arrivals: ArrivalPrediction[] = [];
  const failures: unknown[] = [];
  for (const feature of document.features) {
    try {
      const train = decodeTrain(feature, index, recordTimeZone, now);
      if (train?.vehicle) vehicles.push(train.vehicle);
      if (train) arrivals.push(...train.arrivals);
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length > 0 && vehicles.length === 0 && arrivals.length === 0) throw failures[0];
  return { vehicles, arrivals };
}

/** A current, active train the archive knows, with its future estimated departures. */
function decodeTrain(
  feature: (typeof DocumentSchema.Type)["features"][number],
  index: TrainMapGtfsIndex,
  recordTimeZone: string,
  now: number,
): { vehicle?: LiveVehiclePosition; arrivals: ArrivalPrediction[] } | undefined {
  const arrivals: ArrivalPrediction[] = [];
  let vehicle: LiveVehiclePosition | undefined;
  const properties = feature.properties;
  if (properties.TrainState !== "Active") return undefined;
  const number = text(properties.TrainNum);
  const trip = number ? index.trains[number] : undefined;
  const updatedAt = text(properties.updated_at);
  const originDeparture = text(properties.OrigSchDep);
  if (!number || !trip || !updatedAt || !originDeparture) return undefined;
  const timestamp = parseLocal(updatedAt, recordTimeZone);
  if (now - timestamp > MAX_RECORD_AGE_MS || timestamp > now + 60_000) return undefined;
  const originDate = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(originDeparture);
  if (!originDate) throw new Error(`Invalid train origin departure: ${originDeparture}`);
  const identity = `${number}:${originDate[3]}-${originDate[1].padStart(2, "0")}-${originDate[2].padStart(2, "0")}`;
  const destination = text(properties.DestCode);
  const terminal = destination ? index.stops[destination] : undefined;
  const headsign = terminal?.headsign ?? terminal?.name ?? destination ?? "";
  const freshnessState = calculateFreshness(now, timestamp).state;
  const freshness = freshnessState === "unavailable" ? "stale" : freshnessState;

  const [longitude, latitude] = feature.geometry.coordinates;
  if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
    const velocity = Number(properties.Velocity);
    const heading = text(properties.Heading);
    vehicle = {
      vehicleId: identity,
      tripId: identity,
      routeId: trip.routeId,
      directionId: trip.directionId,
      latitude,
      longitude,
      bearing: heading === undefined ? undefined : HEADINGS[heading],
      speed: Number.isFinite(velocity) ? velocity * MPH_TO_METRES_PER_SECOND : undefined,
      timestamp,
      freshness,
    };
  }

  const calls = Object.entries(properties)
    .flatMap(([key, value]) => {
      const sequence = /^Station(\d+)$/.exec(key);
      const raw = text(value);
      return sequence && raw ? [{ sequence: Number(sequence[1]), raw }] : [];
    })
    .sort((a, b) => a.sequence - b.sequence);
  for (const { sequence, raw } of calls) {
    const call = Schema.decodeUnknownSync(CallSchema)(JSON.parse(raw));
    const stop = index.stops[call.code];
    if (!stop || text(call.schcmnt)?.toLowerCase() === "canceled" || text(call.postdep)) continue;
    const estimated = text(call.estdep);
    const scheduled = text(call.schdep);
    if (!estimated || !scheduled) continue;
    const predictedTime = parseLocal(estimated, stop.timeZone);
    if (predictedTime <= now) continue;
    arrivals.push({
      tripId: identity,
      vehicleId: identity,
      routeId: trip.routeId,
      directionId: trip.directionId,
      stopSequence: sequence + 1,
      stopId: stop.stopId,
      predictedTime,
      delaySeconds: (predictedTime - parseLocal(scheduled, stop.timeZone)) / 1000,
      scheduleRelationship: "SCHEDULED",
      isRealtime: true,
      headsign,
      freshness,
    });
  }
  return { vehicle, arrivals };
}
