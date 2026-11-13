import { ProtobufReader } from "./ProtobufReader";

/** Counts from one walk of a FeedMessage. */
export interface FeedMessageWalk {
  readonly decodedEntities: number;
  readonly droppedEntities: number;
}

/**
 * Walks a GTFS-RT FeedMessage with per-entity recovery.
 *
 * - The header (field 1) goes to `onHeader` when given. Its framing errors
 *   throw, so a broken header fails the whole feed.
 * - Each FeedEntity (field 2) goes to `onEntity`. If the entity's own length
 *   overruns the payload, that entity and the rest of the payload are dropped
 *   and the walk stops, since the framing after it cannot be trusted. If
 *   `onEntity` throws, only that entity is dropped and the walk continues.
 * - `onEntity` must be atomic: it commits output only after a complete parse,
 *   so a dropped entity leaves nothing behind.
 * - A feed whose entities all dropped throws, so the caller fails it. A feed
 *   with no entities at all is a clean, empty walk.
 */
export function walkFeedMessage(
  bytes: Uint8Array,
  handlers: {
    readonly onHeader?: (header: ProtobufReader) => void;
    readonly onEntity: (entity: ProtobufReader) => void;
  },
): FeedMessageWalk {
  const reader = new ProtobufReader(bytes);
  let decodedEntities = 0;
  let droppedEntities = 0;

  while (reader.hasMore()) {
    const tag = reader.readTag();
    if (!tag) break;
    const [fieldNum, wireType] = tag;

    if (fieldNum === 1 && wireType === 2 && handlers.onHeader) {
      handlers.onHeader(reader.readSubReader());
    } else if (fieldNum === 2 && wireType === 2) {
      let entity: ProtobufReader;
      try {
        entity = reader.readSubReader();
      } catch {
        // Truncated tail: the entity's own length overruns the payload.
        droppedEntities += 1;
        break;
      }
      try {
        handlers.onEntity(entity);
        decodedEntities += 1;
      } catch {
        droppedEntities += 1;
      }
    } else {
      reader.skip(wireType);
    }
  }

  if (droppedEntities > 0 && decodedEntities === 0) {
    throw new Error(`GTFS-RT feed has no decodable entities (${droppedEntities} malformed)`);
  }
  return { decodedEntities, droppedEntities };
}
