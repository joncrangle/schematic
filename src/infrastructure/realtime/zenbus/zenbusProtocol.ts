import { ProtobufReader } from "../ProtobufReader";

// Field numbers follow the publisher's public zenbus_realtime proto3 contract.
interface Field {
  readonly type: "id" | "int" | "float" | "string" | Message;
  readonly repeated?: boolean;
}
type Message = Readonly<Record<number, readonly [string, Field]>>;
const point: Message = { 1: ["latitude", { type: "float" }], 2: ["longitude", { type: "float" }] };
const stop: Message = {
  1: ["id", { type: "id" }],
  2: ["center", { type: point }],
  3: ["name", { type: "string" }],
  4: ["code", { type: "string" }],
  8: ["wheelchair", { type: "int" }],
};
const line: Message = {
  1: ["id", { type: "id" }],
  2: ["name", { type: "string" }],
  4: ["code", { type: "string" }],
  7: ["color", { type: "string" }],
  8: ["textColor", { type: "string" }],
};
const stopRef: Message = { 1: ["id", { type: "id" }], 2: ["stop", { type: stop }] };
const itinerary: Message = {
  1: ["id", { type: "id" }],
  2: ["lineId", { type: "id" }],
  3: ["line", { type: line }],
  4: ["stops", { type: stopRef, repeated: true }],
  5: ["name", { type: "string" }],
};
const shape: Message = {
  1: ["id", { type: "id" }],
  2: ["itineraryId", { type: "id" }],
  6: ["points", { type: { 1: ["points", { type: point, repeated: true }] } }],
};
const time: Message = {
  1: ["index", { type: "int" }],
  5: ["arrival", { type: "int" }],
  6: ["departure", { type: "int" }],
  7: ["arriparture", { type: "int" }],
  17: ["noTime", { type: "int" }],
};
const pos: Message = {
  ...point,
  3: ["seconds", { type: "int" }],
  4: ["millis", { type: "int" }],
  8: ["heading", { type: "float" }],
  9: ["speed", { type: "float" }],
};
const columnId: Message = {
  2: ["column", { type: "int" }],
  5: ["itineraryId", { type: "id" }],
  7: ["timetableId", { type: "id" }],
};
const column: Message = {
  1: ["aimed", { type: time, repeated: true }],
  3: ["target", { type: "int" }],
  4: ["estimates", { type: time, repeated: true }],
  5: ["positions", { type: pos, repeated: true }],
  6: ["id", { type: columnId }],
  7: ["column", { type: "int" }],
  10: ["itineraryId", { type: "id" }],
  11: ["itinerary", { type: itinerary }],
  12: ["vehicleId", { type: "id" }],
  14: ["relationship", { type: "int" }],
  17: ["headsign", { type: "string" }],
  106: ["midnight", { type: "int" }],
};
const timetable: Message = {
  1: ["id", { type: "id" }],
  2: ["itineraryId", { type: "id" }],
  3: ["itinerary", { type: itinerary }],
  6: ["midnight", { type: "int" }],
  7: ["columns", { type: column, repeated: true }],
};

function read(reader: ProtobufReader, schema: Message): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, field] of Object.values(schema)) if (field.repeated) result[name] = [];
  while (reader.hasMore()) {
    const [number, wire] = reader.readTag()!;
    if (!number) throw new Error("Invalid Zenbus field tag");
    const entry = schema[number];
    if (!entry) {
      reader.skip(wire);
      continue;
    }
    const [name, field] = entry;
    const expected =
      typeof field.type === "object" || field.type === "string"
        ? 2
        : field.type === "float"
          ? 5
          : 0;
    if (wire !== expected) throw new Error("Invalid Zenbus wire type");
    const value =
      typeof field.type === "object"
        ? read(reader.readSubReader(), field.type)
        : field.type === "id"
          ? reader.readInt64String()
          : field.type === "int"
            ? reader.readInt64()
            : field.type === "float"
              ? reader.readFloat()
              : reader.readString();
    if (field.repeated) (result[name] as unknown[]).push(value);
    else result[name] = value;
  }
  return result;
}
export interface ZenbusStop {
  id: string;
  name: string;
  code?: string;
  center: { latitude: number; longitude: number };
  wheelchair?: number;
}
export interface ZenbusLine {
  id: string;
  name: string;
  code: string;
  color?: string;
  textColor?: string;
}
export interface ZenbusItinerary {
  id: string;
  lineId?: string;
  line?: ZenbusLine;
  stops: { id?: string; stop?: ZenbusStop }[];
  name?: string;
}
export interface ZenbusShape {
  id: string;
  itineraryId?: string;
  points?: { points: { latitude: number; longitude: number }[] };
}
export interface ZenbusStatic {
  shapes: ZenbusShape[];
  lines: ZenbusLine[];
  stops: ZenbusStop[];
  itineraries: ZenbusItinerary[];
}
export interface ZenbusTime {
  index?: number;
  arrival?: number;
  departure?: number;
  arriparture?: number;
  noTime?: number;
}
export interface ZenbusColumn {
  aimed: ZenbusTime[];
  estimates: ZenbusTime[];
  positions: {
    latitude: number;
    longitude: number;
    seconds?: number;
    millis?: number;
    heading?: number;
    speed?: number;
  }[];
  column?: number;
  id?: { column?: number; itineraryId?: string };
  target?: number;
  itineraryId?: string;
  itinerary?: ZenbusItinerary;
  vehicleId?: string;
  relationship?: number;
  headsign?: string;
  midnight?: number;
}
export interface ZenbusTable {
  id?: string;
  itineraryId?: string;
  itinerary?: ZenbusItinerary;
  midnight: number;
  columns: ZenbusColumn[];
}
export interface ZenbusLive {
  tables: ZenbusTable[];
  columns: ZenbusColumn[];
  processed: number;
}
export function decodeZenbusStatic(bytes: Uint8Array): ZenbusStatic {
  const data = read(new ProtobufReader(bytes), {
    1: ["lines", { type: line, repeated: true }],
    2: ["itineraries", { type: itinerary, repeated: true }],
    3: ["shapes", { type: shape, repeated: true }],
    5: ["stops", { type: stop, repeated: true }],
  }) as unknown as ZenbusStatic;
  if (!data.lines.length || !data.stops.length || !data.itineraries.length)
    throw new Error("Incomplete Zenbus topology");
  for (const s of data.stops)
    if (
      !s.id ||
      !s.name ||
      !s.center ||
      !Number.isFinite(s.center.latitude) ||
      !Number.isFinite(s.center.longitude) ||
      Math.abs(s.center.latitude) > 90 ||
      Math.abs(s.center.longitude) > 180
    )
      throw new Error("Invalid Zenbus stop");
  for (const l of data.lines)
    if (!l.id || !l.code || !l.name) throw new Error("Invalid Zenbus line");
  for (const i of data.itineraries)
    if (!i.id || !(i.lineId ?? i.line?.id) || i.stops.length < 2)
      throw new Error("Invalid Zenbus itinerary");
  return data;
}
export function decodeZenbusLive(bytes: Uint8Array): ZenbusLive {
  const data = read(new ProtobufReader(bytes), {
    1: ["tables", { type: timetable, repeated: true }],
    2: ["columns", { type: column, repeated: true }],
    4: ["processed", { type: "int" }],
  }) as unknown as ZenbusLive;
  if (!Number.isFinite(data.processed) || !data.tables.length)
    throw new Error("Incomplete Zenbus live document");
  return data;
}

const selector: Message = { 2: ["lineId", { type: "id" }] };
const wallMessage: Message = {
  2: ["id", { type: "id" }],
  3: ["target", { type: "int" }],
  101: ["about", { type: "id" }],
  102: ["entities", { type: selector, repeated: true }],
  4: ["notifyStart", { type: "int" }],
  5: ["notifyEnd", { type: "int" }],
  6: ["eventStart", { type: "int" }],
  7: ["eventEnd", { type: "int" }],
  9: ["modified", { type: "int" }],
  10: ["deleted", { type: "int" }],
  11: ["cause", { type: "int" }],
  12: ["effect", { type: "int" }],
  13: ["priority", { type: "int" }],
  14: ["message", { type: "string" }],
  15: ["shortMessage", { type: "string" }],
};
export interface ZenbusMessage {
  id: string;
  target?: number;
  about?: string;
  entities: { lineId?: string }[];
  notifyStart?: number;
  notifyEnd?: number;
  eventStart?: number;
  eventEnd?: number;
  modified?: number;
  deleted?: number;
  cause?: number;
  effect?: number;
  priority?: number;
  message?: string;
  shortMessage?: string;
}
export function decodeZenbusWall(bytes: Uint8Array): ZenbusMessage[] {
  const data = read(new ProtobufReader(bytes), {
    1: ["messages", { type: wallMessage, repeated: true }],
    3: ["version", { type: "int" }],
  }) as { messages: ZenbusMessage[]; version?: number };
  if (bytes.length && !data.messages.length && data.version === undefined)
    throw new Error("Unrecognized Zenbus message board");
  return data.messages;
}
