import "server-only";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { SchematicStationIndexEntry } from "~/agencies/types";
import { makeD1SurfaceDataStoreService } from "~/infrastructure/storage/d1SurfaceDataStore";
import {
  resolveRuntimeBinding,
  TRANSIT_BINDING_NAME,
} from "~/infrastructure/storage/RuntimeBindings";

/** The shared transit database binding could not be elected. */
export class AgencyStoreUnavailableError extends Data.TaggedError("AgencyStoreUnavailableError")<{
  readonly agencyId: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

type AgencySurfaceStore = ReturnType<typeof makeD1SurfaceDataStoreService>;

/**
 * An agency's surface store over the shared transit binding, elected on first
 * use and reused afterwards. A failed election is retried on the next call.
 */
export function lazyAgencySurfaceStore(
  agencyId: string,
  stationIndex?: readonly SchematicStationIndexEntry[],
): Effect.Effect<AgencySurfaceStore, AgencyStoreUnavailableError> {
  let store: AgencySurfaceStore | undefined;
  return Effect.suspend(() => {
    if (store) return Effect.succeed(store);
    return Effect.tryPromise({
      try: () => resolveRuntimeBinding(TRANSIT_BINDING_NAME),
      catch: (cause) =>
        new AgencyStoreUnavailableError({
          agencyId,
          message: `Transit database unavailable for ${agencyId}`,
          cause,
        }),
    }).pipe(
      Effect.map((db) => {
        store = makeD1SurfaceDataStoreService(db, { agencyId, stationIndex });
        return store;
      }),
    );
  });
}
