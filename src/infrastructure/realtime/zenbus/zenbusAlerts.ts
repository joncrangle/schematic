import { parseWallClock } from "../wallClock";
import type { DecodedFeed, GenericAlert } from "../gtfsRealtimeDecoder";
import { decodeZenbusWall } from "./zenbusProtocol";

function date(value: number | undefined, timeZone: string): number | undefined {
  if (!value) return undefined;
  const text = String(value);
  if (/^20\d{6}$/u.test(text))
    return parseWallClock(
      `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)} 00:00:00`,
      timeZone,
    );
  if (!Number.isSafeInteger(value) || value < 100000000000)
    throw new Error("Invalid Zenbus message timestamp");
  return value;
}
export function decodeZenbusAlerts(
  bytes: Uint8Array,
  now: number,
  options: {
    readonly timeZone?: string;
    readonly stopCodeMap?: Readonly<Record<string, string>>;
  } = {},
): DecodedFeed {
  const timeZone = options.timeZone ?? "UTC";
  const alerts: GenericAlert[] = [];
  for (const msg of decodeZenbusWall(bytes)) {
    if (msg.deleted) continue;
    if (!msg.id || BigInt(msg.id) <= 0n || !(msg.shortMessage?.trim() || msg.message?.trim()))
      throw new Error("Incomplete Zenbus message");
    const routeIds = [
      ...new Set([
        ...msg.entities.flatMap((entity) => (entity.lineId ? [entity.lineId] : [])),
        ...(msg.target === 2 && msg.about ? [msg.about] : []),
      ]),
    ];
    const startsAt = date(msg.notifyStart, timeZone) ?? 0,
      endsAt = date(msg.notifyEnd, timeZone);
    const message = `${msg.shortMessage ?? ""} ${msg.message ?? ""}`.split(
      /\b(?:utilisez|utiliser|reportez-vous|vers|remplacement|recommandés?|temporaires?)\b/iu,
    )[0];
    const stopIds = [
      ...new Set(
        [
          ...message.matchAll(
            /arr[êe]ts?\s*\(?\s*#?\s*(\d+(?:\s*[,/]\s*#?\s*\d+|\s+et\s+#?\s*\d+)*)/giu,
          ),
        ].flatMap(
          (m) => m[1].match(/\d+/gu)?.map((code) => options.stopCodeMap?.[code] ?? code) ?? [],
        ),
      ),
    ];
    const eventStart = date(msg.eventStart, timeZone),
      eventEnd = date(msg.eventEnd, timeZone);
    if (eventStart !== undefined && eventEnd !== undefined && eventEnd < eventStart)
      throw new Error("Invalid Zenbus impact period");
    if (endsAt && endsAt < startsAt) throw new Error("Invalid Zenbus message period");
    alerts.push({
      id: msg.id,
      title: msg.shortMessage?.trim() || msg.message!.trim(),
      description: msg.message?.trim() || undefined,
      startsAt,
      endsAt,
      impactPeriods:
        eventStart || eventEnd
          ? [{ startsAt: eventStart ?? 0, ...(eventEnd ? { endsAt: eventEnd } : {}) }]
          : undefined,
      routeIds,
      targets: stopIds.length
        ? stopIds.flatMap((stopId) =>
            (routeIds.length ? routeIds : [undefined]).map((routeId) => ({
              ...(routeId ? { routeId } : {}),
              stopId,
            })),
          )
        : routeIds.map((routeId) => ({ routeId })),
      ...(stopIds.length ? { stopScoped: true as const, affectedStations: stopIds } : {}),
      effect: msg.effect || undefined,
      sourceFields: {
        priority: msg.priority ?? 0,
        cause: msg.cause ?? 0,
        ...(stopIds.length ? { stopScoped: true } : {}),
      },
      updatedAt: msg.modified || now,
    });
  }
  return {
    header: { version: "zenbus-messages", timestamp: now },
    tripUpdates: [],
    vehiclePositions: [],
    alerts,
  };
}
