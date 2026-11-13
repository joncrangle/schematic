import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  AlertDeliveryRecord,
  AlertDeliveryStatus,
  PushRegistrationPolicy,
  PushSubscriptionRecord,
} from "~/domain/notifications/types";
import {
  PUSH_HARD_FAILURE_LIMIT,
  PUSH_RETRY_COUNT_LIMIT,
  PUSH_RETRY_MAX_DELAY_MS,
  PUSH_RETRY_BASE_DELAY_MS,
  pushRetryDelayMs,
} from "~/domain/notifications/pushRetryPolicy";
import { normalizeLocale } from "~/domain/locale";
import {
  CommuteScheduleSchema,
  FavouriteLineRefSchema,
  FavouriteStationRefSchema,
  FavouriteSurfaceRouteRefSchema,
} from "~/domain/preferences/UserPreferences";
import {
  type D1DatabaseBinding,
  type D1PreparedStatement,
  NOTIFICATIONS_BINDING_NAME,
  resolveRuntimeBinding,
} from "./RuntimeBindings";
import { ENSURE_SUBSCRIPTION_SCHEMA_SQL, SUBSCRIPTION_SCHEMA_VERSION } from "./subscriptionSchema";
import { getActiveAgency } from "~/agencies";
import { logger } from "~/infrastructure/logging/logger";
import { getPushRegistrationPolicy } from "~/infrastructure/env/ServerEnv";
import { clientNetworkKey } from "~/infrastructure/http/clientIp";
import type { InvocationBudget } from "~/infrastructure/http/InvocationIo";

export class SubscriptionStorageError extends Data.TaggedError("SubscriptionStorageError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface OutstandingDeliveryTarget {
  readonly agencyId: string;
  readonly subscriptionId: string;
}

export interface AlertDeliveryClaim {
  readonly agencyId: string;
  readonly alertId: string;
  readonly incidentKey: string;
  readonly subscriptionId: string;
  /** `*` shares a claim across locales for declared v2 incident identities. */
  readonly localeScope: string;
  readonly locale: string;
  readonly phase: "active" | "recovery";
  readonly ownerToken: string;
  readonly claimedAt: number;
  readonly expiresAt: number;
}

export type AlertDeliveryClaimOutcome = Omit<AlertDeliveryRecord, "status"> & {
  readonly status: "active_sent" | "cleared_sent";
};

export interface PushFailureUpdate {
  readonly attemptedAt: number;
  readonly hardFailure: boolean;
  readonly retryAfterAt?: number;
}

export interface PushFailureUpdateResult {
  readonly retryAt: number;
  readonly hardFailureCount: number;
}

export interface SubscriptionMutationReservation {
  readonly claimDelivery: SubscriptionRepositoryService["claimDelivery"];
  readonly completeDeliveryClaim: SubscriptionRepositoryService["completeDeliveryClaim"];
  readonly releaseDeliveryClaim: SubscriptionRepositoryService["releaseDeliveryClaim"];
  readonly deleteSubscriptionByEndpoint: SubscriptionRepositoryService["deleteSubscriptionByEndpoint"];
  readonly recordPushFailure: SubscriptionRepositoryService["recordPushFailure"];
  readonly release: () => void;
}

export interface RecipientRotationCursorReservation {
  readonly advance: (
    cursorId: string,
    expectedCursor: number,
    processedCount: number,
  ) => Effect.Effect<void, SubscriptionStorageError>;
  readonly release: () => void;
}

/**
 * `existing` endpoints are re-syncs and never limited; `admitted` consumed one
 * of the client's registrations for the current window.
 */
export type RegistrationAdmission = "existing" | "admitted" | "client_limited" | "instance_full";

export interface SubscriptionRepositoryService {
  /** Reserve the accepted or expired push outcome before contacting its transport. */
  readonly reserveMutation?: () => Effect.Effect<
    SubscriptionMutationReservation,
    SubscriptionStorageError
  >;
  readonly upsertSubscription: (
    sub: PushSubscriptionRecord,
  ) => Effect.Effect<void, SubscriptionStorageError>;

  /** Decide whether an endpoint may be stored; the client IP itself is never persisted. */
  readonly admitRegistration: (
    endpoint: string,
    clientIp: string | null,
    policy: PushRegistrationPolicy,
    now: number,
  ) => Effect.Effect<RegistrationAdmission, SubscriptionStorageError>;

  readonly deleteSubscriptionByEndpoint: (
    endpoint: string,
    beforeRevision?: number,
  ) => Effect.Effect<void, SubscriptionStorageError>;

  readonly deleteSubscriptionById: (id: string) => Effect.Effect<void, SubscriptionStorageError>;

  readonly getActiveSubscriptions: () => Effect.Effect<
    readonly PushSubscriptionRecord[],
    SubscriptionStorageError
  >;

  /** Distinct accepted incident targets belonging to existing subscribers. */
  readonly getOutstandingDeliveryTargets: () => Effect.Effect<
    readonly OutstandingDeliveryTarget[],
    SubscriptionStorageError
  >;

  readonly recordDelivery: (
    delivery: AlertDeliveryRecord,
    terminalAt?: number,
  ) => Effect.Effect<void, SubscriptionStorageError>;

  /** Atomically owns a recipient/incident claim until it is completed or released. */
  readonly claimDelivery: (
    claim: AlertDeliveryClaim,
  ) => Effect.Effect<boolean, SubscriptionStorageError>;

  /** Record an accepted push only while this owner still holds the claim. */
  readonly completeDeliveryClaim: (
    claim: AlertDeliveryClaim,
    delivery: AlertDeliveryClaimOutcome,
  ) => Effect.Effect<boolean, SubscriptionStorageError>;

  /** Release only this owner's claim; an expired owner cannot clear a successor. */
  readonly releaseDeliveryClaim: (
    claim: AlertDeliveryClaim,
  ) => Effect.Effect<void, SubscriptionStorageError>;

  /** Persist a rejected send while this owner still holds its delivery claim. */
  readonly recordPushFailure: (
    claim: AlertDeliveryClaim,
    failure: PushFailureUpdate,
  ) => Effect.Effect<PushFailureUpdateResult | null, SubscriptionStorageError>;

  readonly getDelivery: (
    agencyId: string,
    alertId: string,
    subscriptionId: string,
  ) => Effect.Effect<AlertDeliveryRecord | null, SubscriptionStorageError>;

  readonly getDeliveriesForAlert: (
    agencyId: string,
    alertId: string,
  ) => Effect.Effect<readonly AlertDeliveryRecord[], SubscriptionStorageError>;

  readonly getDeliveriesForSubscription: (
    agencyId: string,
    subscriptionId: string,
  ) => Effect.Effect<readonly AlertDeliveryRecord[], SubscriptionStorageError>;

  /** Outstanding deliveries for an agency's selected recipients, fetched together. */
  readonly getDeliveriesForSubscriptions: (
    agencyId: string,
    subscriptionIds: readonly string[],
  ) => Effect.Effect<readonly AlertDeliveryRecord[], SubscriptionStorageError>;

  readonly getRecipientRotationCursor: (
    cursorId: string,
  ) => Effect.Effect<number, SubscriptionStorageError>;
  readonly reserveRecipientRotationCursorAdvance?: () => Effect.Effect<
    RecipientRotationCursorReservation,
    SubscriptionStorageError
  >;
}

const SUBSCRIPTION_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const SUBSCRIPTION_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DELIVERY_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class SubscriptionRepository extends Context.Service<
  SubscriptionRepository,
  SubscriptionRepositoryService
>()("SubscriptionRepository") {}

/**
 * In-memory implementation of SubscriptionRepository for tests, local
 * development, and incident replay. `now` dates retention pruning, so a replay
 * of a past incident does not expire the subscription it is replaying.
 */
export function createMemorySubscriptionRepository(
  options: { readonly now?: () => number } = {},
): Layer.Layer<SubscriptionRepository> {
  const clock = options.now ?? Date.now;
  const subscriptions = new Map<string, PushSubscriptionRecord>();
  const tombstones = new Map<string, { policyRevision: number; deletedAt: number }>();
  const deliveries = new Map<string, AlertDeliveryRecord>();
  const deliveryClaims = new Map<string, AlertDeliveryClaim>();
  const recipientCursors = new Map<string, number>();
  const lastDeliveredAt = new Map<string, number>();
  const registrationSalts = new Map<number, string>();
  const registrationCounts = new Map<string, { windowStart: number; count: number }>();
  const deliveryClaimKey = (claim: AlertDeliveryClaim) =>
    JSON.stringify([claim.agencyId, claim.subscriptionId, claim.incidentKey, claim.localeScope]);

  return Layer.succeed(
    SubscriptionRepository,
    SubscriptionRepository.of({
      upsertSubscription: (sub) =>
        Effect.sync(() => {
          if ((sub.policyRevision ?? 0) <= (tombstones.get(sub.endpoint)?.policyRevision ?? -1))
            return;
          const existing = subscriptions.get(sub.endpoint);
          const revision = sub.policyRevision ?? 0;
          const current = existing?.policyRevision ?? 0;
          if (!existing || (revision === 0 && current === 0) || revision > current) {
            subscriptions.set(sub.endpoint, {
              ...sub,
              locale: normalizeLocale(sub.locale),
              id: existing?.id ?? sub.id,
              createdAt: existing?.createdAt ?? sub.createdAt,
              pushRetryCount: existing?.pushRetryCount ?? sub.pushRetryCount ?? 0,
              pushHardFailureCount: existing?.pushHardFailureCount ?? sub.pushHardFailureCount ?? 0,
              pushRetryAt: existing?.pushRetryAt ?? sub.pushRetryAt ?? 0,
            });
          }
        }),

      admitRegistration: (endpoint, clientIp, policy, now) =>
        Effect.tryPromise({
          try: async (): Promise<RegistrationAdmission> => {
            if (subscriptions.has(endpoint)) return "existing";
            const windowStart = registrationWindowStart(now, policy);
            for (const start of registrationSalts.keys())
              if (start < windowStart) registrationSalts.delete(start);
            for (const [key, entry] of registrationCounts)
              if (entry.windowStart < windowStart) registrationCounts.delete(key);
            const salt = registrationSalts.get(windowStart) ?? newRegistrationSalt();
            registrationSalts.set(windowStart, salt);
            const key = await registrationClientKey(salt, clientIp);
            const count = registrationCounts.get(key)?.count ?? 0;
            if (count >= policy.perClientLimit) return "client_limited";
            registrationCounts.set(key, { windowStart, count: count + 1 });
            return subscriptions.size >= policy.maxSubscriptions ? "instance_full" : "admitted";
          },
          catch: (cause) =>
            new SubscriptionStorageError({
              message: "Failed to admit push subscription registration",
              cause,
            }),
        }),

      deleteSubscriptionByEndpoint: (endpoint, beforeRevision) =>
        Effect.sync(() => {
          const current = subscriptions.get(endpoint)?.policyRevision ?? 0;
          const revision = beforeRevision ?? current;
          tombstones.set(endpoint, {
            policyRevision: Math.max(tombstones.get(endpoint)?.policyRevision ?? 0, revision),
            deletedAt: Date.now(),
          });
          if (current > revision) return;
          const removed = subscriptions.get(endpoint);
          if (removed) lastDeliveredAt.delete(removed.id);
          subscriptions.delete(endpoint);
        }),

      deleteSubscriptionById: (id) =>
        Effect.sync(() => {
          for (const [endpoint, sub] of subscriptions.entries()) {
            if (sub.id === id) {
              subscriptions.delete(endpoint);
              lastDeliveredAt.delete(id);
              break;
            }
          }
        }),

      getActiveSubscriptions: () =>
        Effect.sync(() => {
          const now = clock();
          const cutoff = now - SUBSCRIPTION_RETENTION_MS;
          const undeliveredCutoff = now - getPushRegistrationPolicy().undeliveredRetentionMs;
          for (const [endpoint, sub] of subscriptions) {
            const delivered = lastDeliveredAt.has(sub.id);
            if (sub.updatedAt < cutoff || (!delivered && sub.createdAt < undeliveredCutoff)) {
              subscriptions.delete(endpoint);
              lastDeliveredAt.delete(sub.id);
            }
          }
          for (const [endpoint, tombstone] of tombstones) {
            if (tombstone.deletedAt < cutoff) tombstones.delete(endpoint);
          }
          for (const [key, claim] of deliveryClaims) {
            if (claim.expiresAt <= Date.now()) deliveryClaims.delete(key);
          }
          return Array.from(subscriptions.values());
        }),

      getOutstandingDeliveryTargets: () =>
        Effect.sync(() => {
          const subscriberIds = new Set(Array.from(subscriptions.values(), (sub) => sub.id));
          const targets = new Map<string, Set<string>>();
          for (const delivery of deliveries.values()) {
            if (delivery.status !== "active_sent" || !subscriberIds.has(delivery.subscriptionId))
              continue;
            const ids = targets.get(delivery.agencyId) ?? new Set<string>();
            ids.add(delivery.subscriptionId);
            targets.set(delivery.agencyId, ids);
          }
          return Array.from(targets, ([agencyId, ids]) =>
            Array.from(ids, (subscriptionId) => ({ agencyId, subscriptionId })),
          ).flat();
        }),

      recordDelivery: (delivery) =>
        Effect.sync(() => {
          // Same row identity as the SQL adapter (ADR-0009): one row per
          // (agency, upstream alert id, subscription). Incident identity lives
          // in the row's incidentKey, resolved by the evaluator — never here.
          const key = `${delivery.agencyId}:${delivery.alertId}:${delivery.subscriptionId}`;
          deliveries.set(key, { ...delivery, locale: normalizeLocale(delivery.locale) });
          if (delivery.status === "active_sent")
            lastDeliveredAt.set(delivery.subscriptionId, delivery.deliveredAt);
        }),

      claimDelivery: (claim) =>
        Effect.sync(() => {
          const subscription = Array.from(subscriptions.values()).find(
            (candidate) => candidate.id === claim.subscriptionId,
          );
          if ((subscription?.pushRetryAt ?? 0) > claim.claimedAt) {
            return false;
          }
          const key = deliveryClaimKey(claim);
          const current = deliveryClaims.get(key);
          if (current !== undefined && current.expiresAt > claim.claimedAt) return false;

          const existing = Array.from(deliveries.values()).filter(
            (delivery) =>
              delivery.agencyId === claim.agencyId &&
              delivery.subscriptionId === claim.subscriptionId &&
              delivery.incidentKey === claim.incidentKey &&
              delivery.status === "active_sent",
          );
          if (claim.phase === "active") {
            if (
              existing.some(
                (delivery) =>
                  claim.localeScope === "*" || normalizeLocale(delivery.locale) === claim.locale,
              )
            )
              return false;
          } else if (
            !existing.some(
              (delivery) =>
                delivery.alertId === claim.alertId &&
                normalizeLocale(delivery.locale) === claim.locale,
            )
          ) {
            return false;
          }

          deliveryClaims.set(key, claim);
          return true;
        }),

      completeDeliveryClaim: (claim, delivery) =>
        Effect.sync(() => {
          const key = deliveryClaimKey(claim);
          const current = deliveryClaims.get(key);
          if (current?.ownerToken !== claim.ownerToken) return false;

          let recorded = false;
          if (delivery.status === "active_sent") {
            const rowKey = `${delivery.agencyId}:${delivery.alertId}:${delivery.subscriptionId}`;
            deliveries.set(rowKey, { ...delivery, locale: normalizeLocale(delivery.locale) });
            recorded = true;
          } else if (delivery.status === "cleared_sent") {
            for (const [rowKey, currentDelivery] of deliveries) {
              if (
                currentDelivery.agencyId === delivery.agencyId &&
                currentDelivery.subscriptionId === delivery.subscriptionId &&
                currentDelivery.incidentKey === delivery.incidentKey &&
                currentDelivery.status === "active_sent" &&
                normalizeLocale(currentDelivery.locale) === normalizeLocale(delivery.locale)
              ) {
                deliveries.set(rowKey, {
                  ...currentDelivery,
                  status: "cleared_sent",
                  deliveredAt: delivery.deliveredAt,
                });
                recorded = true;
              }
            }
          }

          if (recorded) {
            const subscription = Array.from(subscriptions.values()).find(
              (currentSubscription) => currentSubscription.id === claim.subscriptionId,
            );
            if (subscription) {
              subscriptions.set(subscription.endpoint, {
                ...subscription,
                pushRetryCount: 0,
                pushHardFailureCount: 0,
                pushRetryAt: 0,
              });
              lastDeliveredAt.set(subscription.id, delivery.deliveredAt);
            }
          }

          deliveryClaims.delete(key);
          return recorded;
        }),

      releaseDeliveryClaim: (claim) =>
        Effect.sync(() => {
          const key = deliveryClaimKey(claim);
          if (deliveryClaims.get(key)?.ownerToken === claim.ownerToken) deliveryClaims.delete(key);
        }),

      recordPushFailure: (claim, failure) =>
        Effect.sync(() => {
          const key = deliveryClaimKey(claim);
          if (deliveryClaims.get(key)?.ownerToken !== claim.ownerToken) return null;
          const existing = Array.from(subscriptions.values()).find(
            (subscription) => subscription.id === claim.subscriptionId,
          );
          if (!existing) return null;
          const retryCount = Math.min((existing.pushRetryCount ?? 0) + 1, PUSH_RETRY_COUNT_LIMIT);
          const hardFailureCount = failure.hardFailure
            ? Math.min((existing.pushHardFailureCount ?? 0) + 1, PUSH_HARD_FAILURE_LIMIT)
            : 0;
          const retryAt = Math.max(
            failure.attemptedAt + pushRetryDelayMs(retryCount),
            failure.retryAfterAt ?? 0,
          );
          subscriptions.set(existing.endpoint, {
            ...existing,
            pushRetryCount: retryCount,
            pushHardFailureCount: hardFailureCount,
            pushRetryAt: retryAt,
          });
          return { retryAt, hardFailureCount };
        }),

      getDelivery: (agencyId, alertId, subscriptionId) =>
        Effect.sync(() => {
          const key = `${agencyId}:${alertId}:${subscriptionId}`;
          return deliveries.get(key) ?? null;
        }),

      getDeliveriesForAlert: (agencyId, alertId) =>
        Effect.sync(() =>
          Array.from(deliveries.values()).filter(
            (d) => d.agencyId === agencyId && d.alertId === alertId,
          ),
        ),

      getDeliveriesForSubscription: (agencyId, subId) =>
        Effect.sync(() =>
          Array.from(deliveries.values()).filter(
            (d) => d.agencyId === agencyId && d.subscriptionId === subId,
          ),
        ),

      getDeliveriesForSubscriptions: (agencyId, subscriptionIds) =>
        Effect.sync(() => {
          const selected = new Set(subscriptionIds);
          return Array.from(deliveries.values()).filter(
            (delivery) =>
              delivery.agencyId === agencyId &&
              selected.has(delivery.subscriptionId) &&
              delivery.status === "active_sent",
          );
        }),

      getRecipientRotationCursor: (cursorId) =>
        Effect.sync(() => recipientCursors.get(cursorId) ?? 0),

      reserveRecipientRotationCursorAdvance: () =>
        Effect.succeed({
          advance: (cursorId, expectedCursor, processedCount) =>
            Effect.sync(() => {
              if ((recipientCursors.get(cursorId) ?? 0) === expectedCursor)
                recipientCursors.set(cursorId, expectedCursor + Math.max(1, processedCount));
            }),
          release: () => {},
        }),
    }),
  );
}

function registrationWindowStart(now: number, policy: PushRegistrationPolicy): number {
  return Math.floor(now / policy.windowMs) * policy.windowMs;
}

function newRegistrationSalt(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Callers without a parseable IP share the empty-network key, which no real address produces. */
async function registrationClientKey(salt: string, clientIp: string | null): Promise<string> {
  const network = (clientIp ? clientNetworkKey(clientIp) : null) ?? "";
  return endpointHash(`${salt}|${network}`);
}

async function endpointHash(endpoint: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const MemorySubscriptionRepositoryLive = createMemorySubscriptionRepository();

interface RawSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  favourite_lines_json: string | null;
  favourite_stations_json: string | null;
  favourite_routes_json: string | null;
  commute_schedules_json: string;
  timezone: string;
  created_at: number;
  updated_at: number;
  policy_revision?: number;
  locale?: string;
  push_retry_count?: number;
  push_hard_failure_count?: number;
  push_retry_at?: number;
}

interface RawDeliveryRow {
  id: string;
  agency_id: string;
  alert_id: string;
  incident_key: string;
  subscription_id: string;
  line_id: string | null;
  route_id: string | null;
  status: AlertDeliveryStatus;
  delivered_at: number;
  locale?: string;
}

const StoredFavouriteLineRefsSchema = Schema.Array(FavouriteLineRefSchema);
const StoredFavouriteStationRefsSchema = Schema.Array(FavouriteStationRefSchema);
const StoredFavouriteSurfaceRoutesSchema = Schema.Array(FavouriteSurfaceRouteRefSchema);
const StoredCommuteSchedulesSchema = Schema.Array(CommuteScheduleSchema);

function decodeStoredJson<S extends Schema.ConstraintDecoder<unknown>>(
  raw: string | null | undefined,
  schema: S,
  fallback: S["Type"],
  field: string,
): S["Type"] {
  if (!raw) return fallback;
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(raw));
  } catch (cause) {
    throw new Error(`Invalid ${field} JSON in push subscription`, { cause });
  }
}

// Share only schema initialization. Policies and fallback timezones remain
// local to each freshly resolved adapter, and bindings can be garbage-collected.
const schemaBootstraps = new WeakMap<D1DatabaseBinding, Promise<void>>();
const subscriptionPrunedAt = new WeakMap<D1DatabaseBinding, number>();

function ensureSubscriptionSchema(binding: D1DatabaseBinding, db = binding): Promise<void> {
  const existing = schemaBootstraps.get(binding);
  if (existing !== undefined) return existing;
  const initialization = (async () => {
    // One read lets a cold isolate skip the bootstrap; a missing table or row predates the marker.
    let meta: { schema_version: number; pruned_at: number } | null = null;
    try {
      meta = await db
        .prepare("SELECT schema_version, pruned_at FROM subscription_meta WHERE id = 1")
        .first<{ schema_version: number; pruned_at: number }>();
    } catch (cause) {
      if (!/no such table/i.test(String(cause))) throw cause;
    }
    // >= tolerates a rolled-back deploy because migrations are additive.
    if (meta !== null && meta.schema_version >= SUBSCRIPTION_SCHEMA_VERSION) {
      subscriptionPrunedAt.set(binding, meta.pruned_at);
      return;
    }
    const previousVersion = meta?.schema_version ?? 0;
    await db.exec(ENSURE_SUBSCRIPTION_SCHEMA_SQL);
    // Inspect all tables in one query. The scheduler shares a bounded query
    // budget with this bootstrap, so each migration column must not add a
    // separate metadata round-trip on a cold invocation.
    const inspectColumns = () =>
      db
        .prepare(
          `SELECT 'push_subscriptions' AS table_name, name FROM pragma_table_info('push_subscriptions')
           UNION ALL
           SELECT 'alert_deliveries' AS table_name, name FROM pragma_table_info('alert_deliveries')
           UNION ALL
           SELECT 'push_subscription_tombstones' AS table_name, name FROM pragma_table_info('push_subscription_tombstones')`,
        )
        .all<{ table_name: string; name: string }>();
    const columns = new Map<string, Set<string>>([
      ["push_subscriptions", new Set()],
      ["alert_deliveries", new Set()],
      ["push_subscription_tombstones", new Set()],
    ]);
    for (const column of (await inspectColumns()).results ?? []) {
      columns.get(column.table_name)?.add(column.name);
    }
    const columnsToEnsure = [
      ["push_subscriptions", "policy_revision", "INTEGER NOT NULL DEFAULT 0"],
      ["push_subscriptions", "locale", "TEXT NOT NULL DEFAULT 'en-CA'"],
      ["push_subscriptions", "last_delivered_at", "INTEGER NOT NULL DEFAULT 0"],
      ["alert_deliveries", "locale", "TEXT NOT NULL DEFAULT 'en-CA'"],
      ["alert_deliveries", "terminal_at", "INTEGER NOT NULL DEFAULT 0"],
      ["push_subscription_tombstones", "deleted_at", "INTEGER NOT NULL DEFAULT 0"],
    ] as const;
    for (const [table, columnName, definition] of columnsToEnsure) {
      const tableColumns = columns.get(table)!;
      if (tableColumns.has(columnName)) continue;
      let added = false;
      try {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnName} ${definition}`);
        tableColumns.add(columnName);
        added = true;
      } catch (error) {
        // Another adapter can migrate the same binding concurrently.
        const latest = await inspectColumns();
        const migrated = (latest.results ?? []).some(
          (column) => column.table_name === table && column.name === columnName,
        );
        if (!migrated) throw error;
        tableColumns.add(columnName);
      }
      if (added && table === "push_subscription_tombstones" && columnName === "deleted_at") {
        await db
          .prepare("UPDATE push_subscription_tombstones SET deleted_at = ? WHERE deleted_at = 0")
          .bind(Date.now())
          .run();
      }
    }
    // Rows predating delivery tracking are trusted rather than expired as never
    // delivered. Keyed on the version marker, not the ALTER, so an interrupted
    // migration re-runs the backfill before any adapter can prune.
    if (previousVersion < 2) {
      await db
        .prepare(
          "UPDATE push_subscriptions SET last_delivered_at = updated_at WHERE last_delivered_at = 0",
        )
        .run();
    }
    // A trigger records successful pushes so delivery adds no budgeted query.
    for (const event of ["INSERT", "UPDATE OF status"] as const) {
      await db
        .prepare(
          `CREATE TRIGGER IF NOT EXISTS trg_alert_deliveries_${event === "INSERT" ? "insert" : "update"}_delivered AFTER ${event} ON alert_deliveries WHEN NEW.status = 'active_sent' BEGIN UPDATE push_subscriptions SET last_delivered_at = MAX(last_delivered_at, NEW.delivered_at) WHERE id = NEW.subscription_id; END`,
        )
        .run();
    }
    // Keep daily retention work scoped to terminal history. Creating this
    // after the lazy column migration lets existing ledgers bootstrap safely.
    await db.exec(
      "CREATE INDEX IF NOT EXISTS idx_alert_deliveries_terminal ON alert_deliveries(terminal_at, delivered_at) WHERE status IN ('cleared_sent', 'cleared_silent')",
    );
    // Written last so no adapter sees the version before the migrations finish; MAX stops an older deploy lowering it.
    const marked = await db
      .prepare(
        "UPDATE subscription_meta SET schema_version = MAX(schema_version, ?) WHERE id = 1 RETURNING pruned_at",
      )
      .bind(SUBSCRIPTION_SCHEMA_VERSION)
      .first<{ pruned_at: number }>();
    subscriptionPrunedAt.set(binding, marked?.pruned_at ?? 0);
  })().catch((cause) => {
    schemaBootstraps.delete(binding);
    throw cause;
  });
  schemaBootstraps.set(binding, initialization);
  return initialization;
}

async function pruneAgedSubscriptions(binding: D1DatabaseBinding, db: D1DatabaseBinding) {
  const now = Date.now();
  const lastPrune = subscriptionPrunedAt.get(binding);
  if (
    lastPrune !== undefined &&
    now >= lastPrune &&
    now - lastPrune < SUBSCRIPTION_PRUNE_INTERVAL_MS
  )
    return;

  const cutoff = now - SUBSCRIPTION_RETENTION_MS;
  const deliveryCutoff = now - DELIVERY_HISTORY_RETENTION_MS;
  const policy = getPushRegistrationPolicy();
  const currentWindow = registrationWindowStart(now, policy);
  // One batch commits the prune time only with the deletes, so later cold isolates skip the window.
  await db.batch([
    db.prepare("DELETE FROM push_subscriptions WHERE updated_at < ?").bind(cutoff),
    db
      .prepare("DELETE FROM push_subscriptions WHERE last_delivered_at = 0 AND created_at < ?")
      .bind(now - policy.undeliveredRetentionMs),
    db.prepare("DELETE FROM push_registration_counts WHERE window_start < ?").bind(currentWindow),
    db.prepare("DELETE FROM push_registration_windows WHERE window_start < ?").bind(currentWindow),
    db
      .prepare("DELETE FROM push_subscription_tombstones WHERE deleted_at > 0 AND deleted_at < ?")
      .bind(cutoff),
    db.prepare("DELETE FROM alert_delivery_claims WHERE expires_at <= ?").bind(now),
    db
      .prepare(`
      DELETE FROM alert_deliveries
      WHERE status IN ('cleared_sent', 'cleared_silent')
        AND (
          (terminal_at > 0 AND terminal_at < ?)
          OR (terminal_at = 0 AND delivered_at < ?)
        )
    `)
      .bind(deliveryCutoff, deliveryCutoff),
    db.prepare("UPDATE subscription_meta SET pruned_at = ? WHERE id = 1").bind(now),
  ]);
  subscriptionPrunedAt.set(binding, now);
}

/** Count SQL executions, including individual statements inside D1 exec/batch. */
function accountQueries(binding: D1DatabaseBinding, beforeQuery: () => void): D1DatabaseBinding {
  const underlying = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  return {
    prepare: (query) => {
      let statement = binding.prepare(query);
      const accounted: D1PreparedStatement = {
        bind: (...values) => {
          statement = statement.bind(...values);
          underlying.set(accounted, statement);
          return accounted;
        },
        first: (column) => {
          beforeQuery();
          return statement.first(column);
        },
        all: () => {
          beforeQuery();
          return statement.all();
        },
        run: () => {
          beforeQuery();
          return statement.run();
        },
      };
      underlying.set(accounted, statement);
      return accounted;
    },
    exec: (query) => {
      // This repository executes canonical DDL or a single-statement migration.
      const count =
        query === ENSURE_SUBSCRIPTION_SCHEMA_SQL
          ? ENSURE_SUBSCRIPTION_SCHEMA_SQL.split(";\n").filter((sql) => sql.trim()).length
          : 1;
      for (let index = 0; index < count; index += 1) beforeQuery();
      return binding.exec(query);
    },
    batch: (statements) => {
      for (const _ of statements) beforeQuery();
      return binding.batch(statements.map((statement) => underlying.get(statement) ?? statement));
    },
  };
}

/**
 * SQL-backed repository with lazy schema bootstrap shared per binding identity.
 * Concurrent adapters share initialization; rejected initialization is retried
 * on the next operation. Bootstrap errors use each operation's error channel.
 */
export function makeD1SubscriptionRepositoryService(
  binding: D1DatabaseBinding,
  opts: { fallbackTimezone: string; readonly queryBudget?: InvocationBudget },
): SubscriptionRepositoryService {
  return makeSqlSubscriptionRepositoryService(binding, {
    fallbackTimezone: opts.fallbackTimezone,
    beforeQuery: opts.queryBudget?.consume,
    mutationBudget: opts.queryBudget,
  });
}

function makeSqlSubscriptionRepositoryService(
  binding: D1DatabaseBinding,
  opts: {
    fallbackTimezone: string;
    readonly beforeQuery?: () => void;
    readonly mutationBudget?: InvocationBudget;
  },
): SubscriptionRepositoryService {
  const db = opts.beforeQuery ? accountQueries(binding, opts.beforeQuery) : binding;
  const ensureSchema = () => ensureSubscriptionSchema(binding, db);

  const fallbackTimezone = opts.fallbackTimezone;
  const mutationBudget = opts.mutationBudget;

  return SubscriptionRepository.of({
    reserveMutation:
      mutationBudget === undefined
        ? undefined
        : () =>
            Effect.tryPromise({
              try: async () => {
                await ensureSchema();
                const budget = mutationBudget;
                const permits: ReturnType<InvocationBudget["reserve"]>[] = [];
                try {
                  // One query claims the incident. Four more cover the largest
                  // outcome: record failure, tombstone, delete the subscriber,
                  // and release its owner claim.
                  for (let index = 0; index < 5; index += 1) permits.push(budget.reserve());
                } catch (cause) {
                  for (const permit of permits) permit.release();
                  throw cause;
                }
                let next = 0;
                const reserved = makeSqlSubscriptionRepositoryService(binding, {
                  fallbackTimezone: opts.fallbackTimezone,
                  beforeQuery: () => {
                    const permit = permits[next++];
                    if (permit === undefined)
                      throw new Error("Notification mutation exceeded its reservation");
                    permit.consume();
                  },
                });
                return {
                  claimDelivery: reserved.claimDelivery,
                  completeDeliveryClaim: reserved.completeDeliveryClaim,
                  releaseDeliveryClaim: reserved.releaseDeliveryClaim,
                  recordPushFailure: reserved.recordPushFailure,
                  deleteSubscriptionByEndpoint: reserved.deleteSubscriptionByEndpoint,
                  release: () => {
                    for (const permit of permits) permit.release();
                  },
                };
              },
              catch: (cause) =>
                new SubscriptionStorageError({
                  message: "Failed to reserve notification mutation capacity before push",
                  cause,
                }),
            }),
    reserveRecipientRotationCursorAdvance: () =>
      Effect.tryPromise({
        try: async () => {
          await ensureSchema();
          const permit = mutationBudget?.reserve();
          const reservedDb =
            permit === undefined ? db : accountQueries(binding, () => permit.consume());
          return {
            advance: (cursorId, expectedCursor, processedCount) =>
              Effect.tryPromise({
                try: async () => {
                  const advanceBy = Math.max(1, processedCount);
                  await reservedDb
                    .prepare(`
                          UPDATE worker_recipient_cursors
                          SET cursor = cursor + ?
                          WHERE cursor_id = ? AND cursor = ?
                        `)
                    .bind(advanceBy, cursorId, expectedCursor)
                    .run();
                },
                catch: (cause) =>
                  new SubscriptionStorageError({
                    message: "Failed to advance Workers recipient rotation",
                    cause,
                  }),
              }),
            release: () => permit?.release(),
          } satisfies RecipientRotationCursorReservation;
        },
        catch: (cause) =>
          new SubscriptionStorageError({
            message: "Failed to reserve Workers recipient rotation capacity",
            cause,
          }),
      }),
    upsertSubscription: (sub) =>
      Effect.tryPromise({
        try: async () => {
          await ensureSchema();
          const query = `
              INSERT INTO push_subscriptions (
                id, endpoint, p256dh, auth, favourite_lines_json, favourite_stations_json,
                favourite_routes_json, commute_schedules_json, timezone, locale, created_at, updated_at, policy_revision
              ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
              WHERE ? > COALESCE((SELECT policy_revision FROM push_subscription_tombstones WHERE endpoint_hash = ?), -1)
              ON CONFLICT(endpoint) DO UPDATE SET
                p256dh = excluded.p256dh,
                auth = excluded.auth,
                favourite_lines_json = excluded.favourite_lines_json,
                favourite_stations_json = excluded.favourite_stations_json,
                favourite_routes_json = excluded.favourite_routes_json,
                commute_schedules_json = excluded.commute_schedules_json,
                timezone = excluded.timezone,
                locale = excluded.locale,
                updated_at = excluded.updated_at,
                policy_revision = excluded.policy_revision
              WHERE (excluded.policy_revision = 0 AND push_subscriptions.policy_revision = 0)
                 OR excluded.policy_revision > push_subscriptions.policy_revision
            `;

          await db
            .prepare(query)
            .bind(
              sub.id,
              sub.endpoint,
              sub.p256dh,
              sub.auth,
              JSON.stringify(sub.favouriteLines),
              JSON.stringify(sub.favouriteStations),
              JSON.stringify(sub.favouriteSurfaceRoutes),
              JSON.stringify(sub.commuteSchedules),
              sub.timezone,
              normalizeLocale(sub.locale),
              sub.createdAt,
              sub.updatedAt,
              sub.policyRevision ?? 0,
              sub.policyRevision ?? 0,
              await endpointHash(sub.endpoint),
            )
            .run();
        },
        catch: (err) =>
          new SubscriptionStorageError({
            message: "Failed to upsert push subscription",
            cause: err,
          }),
      }),

    admitRegistration: (endpoint, clientIp, policy, now) =>
      Effect.tryPromise({
        try: async (): Promise<RegistrationAdmission> => {
          await ensureSchema();
          const stored = await db
            .prepare("SELECT 1 AS found FROM push_subscriptions WHERE endpoint = ?")
            .bind(endpoint)
            .first<{ found: number }>();
          if (stored) return "existing";

          const windowStart = registrationWindowStart(now, policy);
          // Ended windows go first so their salts cannot link a stored key to an address.
          await db.batch([
            db
              .prepare("DELETE FROM push_registration_counts WHERE window_start < ?")
              .bind(windowStart),
            db
              .prepare("DELETE FROM push_registration_windows WHERE window_start < ?")
              .bind(windowStart),
          ]);
          const window = await db
            .prepare(
              `INSERT INTO push_registration_windows (window_start, salt) VALUES (?, ?)
               ON CONFLICT(window_start) DO UPDATE SET salt = push_registration_windows.salt
               RETURNING salt`,
            )
            .bind(windowStart, newRegistrationSalt())
            .first<{ salt: string }>();
          if (!window) throw new Error("Registration window salt was not stored");
          const counted = await db
            .prepare(
              `INSERT INTO push_registration_counts (client_key, window_start, count) VALUES (?, ?, 1)
               ON CONFLICT(client_key) DO UPDATE SET count = push_registration_counts.count + 1
               WHERE push_registration_counts.count < ?
               RETURNING count`,
            )
            .bind(
              await registrationClientKey(window.salt, clientIp),
              windowStart,
              policy.perClientLimit,
            )
            .first<{ count: number }>();
          if (!counted) return "client_limited";
          // Counted only after the client limit so a limited caller cannot force table scans.
          // Concurrent admissions can overshoot the ceiling by at most their number.
          const total = await db
            .prepare("SELECT COUNT(*) AS total FROM push_subscriptions")
            .first<{ total: number }>();
          return (total?.total ?? 0) >= policy.maxSubscriptions ? "instance_full" : "admitted";
        },
        catch: (err) =>
          new SubscriptionStorageError({
            message: "Failed to admit push subscription registration",
            cause: err,
          }),
      }),

    deleteSubscriptionByEndpoint: (endpoint, beforeRevision) =>
      Effect.tryPromise({
        try: async () => {
          await ensureSchema();
          // Tombstone and delete commit together. A late INSERT cannot resurrect
          // an older policy after removal; retain only a hash, never credentials.
          await db.batch([
            db
              .prepare(`INSERT INTO push_subscription_tombstones (endpoint_hash, policy_revision, deleted_at)
              VALUES (?, COALESCE(?, (SELECT policy_revision FROM push_subscriptions WHERE endpoint = ?), 0), ?)
              ON CONFLICT(endpoint_hash) DO UPDATE SET policy_revision = MAX(policy_revision, excluded.policy_revision), deleted_at = excluded.deleted_at`)
              .bind(await endpointHash(endpoint), beforeRevision ?? null, endpoint, Date.now()),
            db
              .prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND policy_revision <= ?")
              .bind(endpoint, beforeRevision ?? Number.MAX_SAFE_INTEGER),
          ]);
        },
        catch: (err) =>
          new SubscriptionStorageError({
            message: "Failed to delete push subscription by endpoint",
            cause: err,
          }),
      }),

    deleteSubscriptionById: (id) =>
      Effect.tryPromise({
        try: async () => {
          await ensureSchema();
          await db.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(id).run();
        },
        catch: (err) =>
          new SubscriptionStorageError({
            message: "Failed to delete push subscription by id",
            cause: err,
          }),
      }),

    getActiveSubscriptions: () =>
      Effect.tryPromise({
        try: async () => {
          await ensureSchema();
          await pruneAgedSubscriptions(binding, db);
          const query = `
              SELECT subscription.id, subscription.endpoint, subscription.p256dh, subscription.auth,
                     subscription.favourite_lines_json, subscription.favourite_stations_json,
                     subscription.favourite_routes_json, subscription.commute_schedules_json,
                     subscription.timezone, subscription.locale, subscription.created_at,
                     subscription.updated_at, subscription.policy_revision,
                     COALESCE(retry.retry_count, 0) AS push_retry_count,
                     COALESCE(retry.hard_failure_count, 0) AS push_hard_failure_count,
                     COALESCE(retry.retry_at, 0) AS push_retry_at
              FROM push_subscriptions AS subscription
              LEFT JOIN push_subscription_retry_state AS retry
                ON retry.subscription_id = subscription.id
            `;
          const result = await db.prepare(query).all<RawSubscriptionRow>();
          const rows = result.results ?? [];

          const subscriptions: PushSubscriptionRecord[] = [];
          let invalidPolicies = 0;
          for (const row of rows) {
            try {
              subscriptions.push({
                id: row.id,
                endpoint: row.endpoint,
                p256dh: row.p256dh,
                auth: row.auth,
                favouriteLines: decodeStoredJson(
                  row.favourite_lines_json,
                  StoredFavouriteLineRefsSchema,
                  [],
                  "favourite_lines",
                ),
                favouriteStations: decodeStoredJson(
                  row.favourite_stations_json,
                  StoredFavouriteStationRefsSchema,
                  [],
                  "favourite_stations",
                ),
                favouriteSurfaceRoutes: decodeStoredJson(
                  row.favourite_routes_json,
                  StoredFavouriteSurfaceRoutesSchema,
                  [],
                  "favourite_routes",
                ),
                commuteSchedules: decodeStoredJson(
                  row.commute_schedules_json,
                  StoredCommuteSchedulesSchema,
                  [],
                  "commute_schedules",
                ),
                timezone: row.timezone || fallbackTimezone,
                locale: normalizeLocale(row.locale),
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                policyRevision: row.policy_revision ?? 0,
                pushRetryCount: row.push_retry_count ?? 0,
                pushHardFailureCount: row.push_hard_failure_count ?? 0,
                pushRetryAt: row.push_retry_at ?? 0,
              });
            } catch {
              // Quarantine malformed policy, not the entire subscriber batch.
              // Neither repair nor delete private data without a fresh client sync.
              invalidPolicies++;
            }
          }
          if (invalidPolicies > 0) {
            logger.warn("SubscriptionRepository: invalid subscription policies skipped", {
              count: invalidPolicies,
            });
          }
          return subscriptions;
        },
        catch: (err) =>
          new SubscriptionStorageError({
            message: "Failed to fetch active push subscriptions",
            cause: err,
          }),
      }),

    getOutstandingDeliveryTargets: () =>
      Effect.tryPromise({
        try: async () => {
          await ensureSchema();
          const result = await db
            .prepare(`
          SELECT DISTINCT delivery.agency_id, delivery.subscription_id
          FROM alert_deliveries AS delivery
          JOIN push_subscriptions AS subscription ON subscription.id = delivery.subscription_id
          WHERE delivery.status = 'active_sent'
        `)
            .all<{ agency_id: string; subscription_id: string }>();
          return (result.results ?? []).map((row) => ({
            agencyId: row.agency_id,
            subscriptionId: row.subscription_id,
          }));
        },
        catch: (cause) =>
          new SubscriptionStorageError({
            message: "Failed to fetch outstanding notification agencies",
            cause,
          }),
      }),

    getRecipientRotationCursor: (cursorId) =>
      Effect.tryPromise({
        try: async () => {
          await ensureSchema();
          const row = await db
            .prepare("SELECT cursor FROM worker_recipient_cursors WHERE cursor_id = ?")
            .bind(cursorId)
            .first<{ cursor: number }>();
          return row?.cursor ?? 0;
        },
        catch: (cause) =>
          new SubscriptionStorageError({
            message: "Failed to read Workers recipient rotation",
            cause,
          }),
      }),

    recordDelivery: (delivery, terminalAt) =>
      Effect.tryPromise({
        try: async () => {
          await ensureSchema();
          const query = `
              INSERT INTO alert_deliveries (
                id, agency_id, alert_id, incident_key, subscription_id, line_id, route_id,
                status, delivered_at, locale, terminal_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(agency_id, alert_id, subscription_id) DO UPDATE SET
                incident_key = excluded.incident_key,
                line_id = excluded.line_id,
                route_id = excluded.route_id,
                status = excluded.status,
                delivered_at = excluded.delivered_at,
                locale = excluded.locale,
                terminal_at = excluded.terminal_at
            `;
          await db
            .prepare(query)
            .bind(
              delivery.id,
              delivery.agencyId,
              delivery.alertId,
              delivery.incidentKey,
              delivery.subscriptionId,
              delivery.lineId ?? null,
              delivery.routeId ?? null,
              delivery.status,
              delivery.deliveredAt,
              normalizeLocale(delivery.locale),
              delivery.status === "active_sent" ? 0 : (terminalAt ?? delivery.deliveredAt),
            )
            .run();
        },
        catch: (err) =>
          new SubscriptionStorageError({
            message: "Failed to record alert delivery",
            cause: err,
          }),
      }),

    claimDelivery: (claim) =>
      Effect.tryPromise({
        try: async () => {
          await ensureSchema();
          const claimColumns = `
            agency_id, subscription_id, incident_key, locale_scope, alert_id,
            phase, owner_token, claimed_at, expires_at
          `;
          const claimValues = `
            ?, ?, ?, ?, ?, ?, ?, ?, ?
          `;
          const conflict = `
            ON CONFLICT(agency_id, subscription_id, incident_key, locale_scope) DO UPDATE SET
              alert_id = excluded.alert_id,
              phase = excluded.phase,
              owner_token = excluded.owner_token,
              claimed_at = excluded.claimed_at,
              expires_at = excluded.expires_at
            WHERE alert_delivery_claims.expires_at <= excluded.claimed_at
            RETURNING owner_token
          `;

          const baseline =
            claim.phase === "active"
              ? `NOT EXISTS (
                  SELECT 1 FROM alert_deliveries
                  WHERE agency_id = ? AND subscription_id = ? AND incident_key = ?
                    AND status = 'active_sent' AND (? = '*' OR locale = ?)
                )`
              : `EXISTS (
                  SELECT 1 FROM alert_deliveries
                  WHERE agency_id = ? AND subscription_id = ? AND incident_key = ?
                    AND alert_id = ? AND status = 'active_sent' AND locale = ?
                )`;
          const values =
            claim.phase === "active"
              ? [
                  claim.agencyId,
                  claim.subscriptionId,
                  claim.incidentKey,
                  claim.localeScope,
                  claim.alertId,
                  claim.phase,
                  claim.ownerToken,
                  claim.claimedAt,
                  claim.expiresAt,
                  claim.agencyId,
                  claim.subscriptionId,
                  claim.incidentKey,
                  claim.localeScope,
                  claim.locale,
                ]
              : [
                  claim.agencyId,
                  claim.subscriptionId,
                  claim.incidentKey,
                  claim.localeScope,
                  claim.alertId,
                  claim.phase,
                  claim.ownerToken,
                  claim.claimedAt,
                  claim.expiresAt,
                  claim.agencyId,
                  claim.subscriptionId,
                  claim.incidentKey,
                  claim.alertId,
                  claim.locale,
                ];
          const row = await db
            .prepare(`
              INSERT INTO alert_delivery_claims (${claimColumns})
              SELECT ${claimValues}
              WHERE (${baseline}) AND NOT EXISTS (
                SELECT 1 FROM push_subscription_retry_state
                WHERE subscription_id = ? AND retry_at > ?
              )
              ${conflict}
            `)
            .bind(...values, claim.subscriptionId, claim.claimedAt)
            .first<{ owner_token: string }>();
          return row?.owner_token === claim.ownerToken;
        },
        catch: (cause) =>
          new SubscriptionStorageError({
            message: "Failed to claim alert delivery",
            cause,
          }),
      }),

    completeDeliveryClaim: (claim, delivery) =>
      Effect.tryPromise({
        try: async () => {
          await ensureSchema();
          const result =
            delivery.status === "active_sent"
              ? await db
                  .prepare(`
                    INSERT INTO alert_deliveries (
                      id, agency_id, alert_id, incident_key, subscription_id,
                      line_id, route_id, status, delivered_at, locale, terminal_at
                    )
                    SELECT ?, ?, ?, ?, ?, ?, ?, 'active_sent', ?, ?, 0
                    WHERE EXISTS (
                      SELECT 1 FROM alert_delivery_claims
                      WHERE agency_id = ? AND subscription_id = ? AND incident_key = ?
                        AND locale_scope = ? AND owner_token = ? AND phase = 'active'
                    )
                    ON CONFLICT(agency_id, alert_id, subscription_id) DO UPDATE SET
                      incident_key = excluded.incident_key,
                      line_id = excluded.line_id,
                      route_id = excluded.route_id,
                      status = excluded.status,
                      delivered_at = excluded.delivered_at,
                      locale = excluded.locale,
                      terminal_at = 0
                    RETURNING id
                  `)
                  .bind(
                    delivery.id,
                    delivery.agencyId,
                    delivery.alertId,
                    delivery.incidentKey,
                    delivery.subscriptionId,
                    delivery.lineId ?? null,
                    delivery.routeId ?? null,
                    delivery.deliveredAt,
                    normalizeLocale(delivery.locale),
                    claim.agencyId,
                    claim.subscriptionId,
                    claim.incidentKey,
                    claim.localeScope,
                    claim.ownerToken,
                  )
                  .first<{ id: string }>()
              : await db
                  .prepare(`
                    UPDATE alert_deliveries
                    SET status = 'cleared_sent', delivered_at = ?, locale = ?, terminal_at = ?
                    WHERE agency_id = ? AND subscription_id = ? AND incident_key = ?
                      AND status = 'active_sent' AND locale = ?
                      AND EXISTS (
                        SELECT 1 FROM alert_delivery_claims
                        WHERE agency_id = ? AND subscription_id = ? AND incident_key = ?
                          AND locale_scope = ? AND owner_token = ? AND phase = 'recovery'
                      )
                    RETURNING alert_id
                  `)
                  .bind(
                    delivery.deliveredAt,
                    normalizeLocale(delivery.locale),
                    delivery.deliveredAt,
                    delivery.agencyId,
                    delivery.subscriptionId,
                    delivery.incidentKey,
                    normalizeLocale(delivery.locale),
                    claim.agencyId,
                    claim.subscriptionId,
                    claim.incidentKey,
                    claim.localeScope,
                    claim.ownerToken,
                  )
                  .first<{ alert_id: string }>();

          // Record the accepted outcome and clear retry state before releasing
          // the owner claim. If the process stops between them, the ledger
          // suppresses duplicate work after expiry.
          // An expired owner cannot mutate or remove a successor's claim.
          if (result !== null) {
            await db
              .prepare("DELETE FROM push_subscription_retry_state WHERE subscription_id = ?")
              .bind(claim.subscriptionId)
              .run();
          }
          await db
            .prepare(`
              DELETE FROM alert_delivery_claims
              WHERE agency_id = ? AND subscription_id = ? AND incident_key = ?
                AND locale_scope = ? AND owner_token = ?
            `)
            .bind(
              claim.agencyId,
              claim.subscriptionId,
              claim.incidentKey,
              claim.localeScope,
              claim.ownerToken,
            )
            .run();
          return result !== null;
        },
        catch: (cause) =>
          new SubscriptionStorageError({
            message: "Failed to complete alert delivery claim",
            cause,
          }),
      }),

    releaseDeliveryClaim: (claim) =>
      Effect.tryPromise({
        try: async () => {
          await ensureSchema();
          await db
            .prepare(`
              DELETE FROM alert_delivery_claims
              WHERE agency_id = ? AND subscription_id = ? AND incident_key = ?
                AND locale_scope = ? AND owner_token = ?
            `)
            .bind(
              claim.agencyId,
              claim.subscriptionId,
              claim.incidentKey,
              claim.localeScope,
              claim.ownerToken,
            )
            .run();
        },
        catch: (cause) =>
          new SubscriptionStorageError({
            message: "Failed to release alert delivery claim",
            cause,
          }),
      }),

    recordPushFailure: (claim, failure) =>
      Effect.tryPromise({
        try: async () => {
          await ensureSchema();
          const retryAfterAt = failure.retryAfterAt ?? 0;
          const row = await db
            .prepare(`
              INSERT INTO push_subscription_retry_state (
                subscription_id, retry_count, hard_failure_count, retry_at
              )
              SELECT ?, 1, ?, MAX(? + ?, ?)
              FROM push_subscriptions AS subscription
              WHERE subscription.id = ?
                AND EXISTS (
                  SELECT 1 FROM alert_delivery_claims
                  WHERE agency_id = ? AND subscription_id = ? AND incident_key = ?
                    AND locale_scope = ? AND owner_token = ?
                )
              ON CONFLICT(subscription_id) DO UPDATE SET
                retry_count = MIN(push_subscription_retry_state.retry_count + 1, ?),
                hard_failure_count = CASE WHEN excluded.hard_failure_count > 0
                  THEN MIN(push_subscription_retry_state.hard_failure_count + 1, ?)
                  ELSE 0 END,
                retry_at = MAX(
                  ? + MIN(?, ? * (1 << MIN(push_subscription_retry_state.retry_count + 1, 6))),
                  ?
                )
              RETURNING retry_at, hard_failure_count
            `)
            .bind(
              claim.subscriptionId,
              failure.hardFailure ? 1 : 0,
              failure.attemptedAt,
              pushRetryDelayMs(1),
              retryAfterAt,
              claim.subscriptionId,
              claim.agencyId,
              claim.subscriptionId,
              claim.incidentKey,
              claim.localeScope,
              claim.ownerToken,
              PUSH_RETRY_COUNT_LIMIT,
              PUSH_HARD_FAILURE_LIMIT,
              failure.attemptedAt,
              PUSH_RETRY_MAX_DELAY_MS,
              PUSH_RETRY_BASE_DELAY_MS,
              retryAfterAt,
            )
            .first<{ retry_at: number; hard_failure_count: number }>();
          return row ? { retryAt: row.retry_at, hardFailureCount: row.hard_failure_count } : null;
        },
        catch: (cause) =>
          new SubscriptionStorageError({
            message: "Failed to record rejected push attempt",
            cause,
          }),
      }),

    getDelivery: (agencyId, alertId, subscriptionId) =>
      Effect.tryPromise({
        try: async () => {
          await ensureSchema();
          const query = `
              SELECT id, agency_id, alert_id, incident_key, subscription_id, line_id, route_id, status, delivered_at, locale
              FROM alert_deliveries
              WHERE agency_id = ? AND alert_id = ? AND subscription_id = ?
              LIMIT 1
            `;
          const row = await db
            .prepare(query)
            .bind(agencyId, alertId, subscriptionId)
            .first<RawDeliveryRow>();

          if (!row) return null;

          return {
            id: row.id,
            agencyId: row.agency_id,
            alertId: row.alert_id,
            incidentKey: row.incident_key,
            subscriptionId: row.subscription_id,
            lineId: row.line_id ?? undefined,
            routeId: row.route_id ?? undefined,
            status: row.status,
            deliveredAt: row.delivered_at,
            locale: normalizeLocale(row.locale),
          };
        },
        catch: (err) =>
          new SubscriptionStorageError({
            message: "Failed to get alert delivery",
            cause: err,
          }),
      }),

    getDeliveriesForAlert: (agencyId, alertId) =>
      Effect.tryPromise({
        try: async () => {
          await ensureSchema();
          const query = `
              SELECT id, agency_id, alert_id, incident_key, subscription_id, line_id, route_id, status, delivered_at, locale
              FROM alert_deliveries
              WHERE agency_id = ? AND alert_id = ?
            `;
          const result = await db.prepare(query).bind(agencyId, alertId).all<RawDeliveryRow>();
          const rows = result.results ?? [];

          return rows.map((row) => ({
            id: row.id,
            agencyId: row.agency_id,
            alertId: row.alert_id,
            incidentKey: row.incident_key,
            subscriptionId: row.subscription_id,
            lineId: row.line_id ?? undefined,
            routeId: row.route_id ?? undefined,
            status: row.status,
            deliveredAt: row.delivered_at,
            locale: normalizeLocale(row.locale),
          }));
        },
        catch: (err) =>
          new SubscriptionStorageError({
            message: "Failed to get deliveries for alert",
            cause: err,
          }),
      }),

    getDeliveriesForSubscription: (agencyId, subId) =>
      Effect.tryPromise({
        try: async () => {
          await ensureSchema();
          const query = `
              SELECT id, agency_id, alert_id, incident_key, subscription_id, line_id, route_id, status, delivered_at, locale
              FROM alert_deliveries
              WHERE agency_id = ? AND subscription_id = ?
            `;
          const result = await db.prepare(query).bind(agencyId, subId).all<RawDeliveryRow>();
          const rows = result.results ?? [];

          return rows.map((row) => ({
            id: row.id,
            agencyId: row.agency_id,
            alertId: row.alert_id,
            incidentKey: row.incident_key,
            subscriptionId: row.subscription_id,
            lineId: row.line_id ?? undefined,
            routeId: row.route_id ?? undefined,
            status: row.status,
            deliveredAt: row.delivered_at,
            locale: normalizeLocale(row.locale),
          }));
        },
        catch: (err) =>
          new SubscriptionStorageError({
            message: "Failed to get deliveries for subscription",
            cause: err,
          }),
      }),

    getDeliveriesForSubscriptions: (agencyId, subscriptionIds) =>
      subscriptionIds.length === 0
        ? Effect.succeed([])
        : Effect.tryPromise({
            try: async () => {
              await ensureSchema();
              const result = await db
                .prepare(`
                  SELECT id, agency_id, alert_id, incident_key, subscription_id, line_id, route_id, status, delivered_at, locale
                  FROM alert_deliveries
                  WHERE agency_id = ? AND status = 'active_sent' AND subscription_id IN (
                    SELECT value FROM json_each(?)
                  )
                `)
                .bind(agencyId, JSON.stringify(subscriptionIds))
                .all<RawDeliveryRow>();
              return (result.results ?? []).map((row) => ({
                id: row.id,
                agencyId: row.agency_id,
                alertId: row.alert_id,
                incidentKey: row.incident_key,
                subscriptionId: row.subscription_id,
                lineId: row.line_id ?? undefined,
                routeId: row.route_id ?? undefined,
                status: row.status,
                deliveredAt: row.delivered_at,
                locale: normalizeLocale(row.locale),
              }));
            },
            catch: (err) =>
              new SubscriptionStorageError({
                message: "Failed to get deliveries for selected subscriptions",
                cause: err,
              }),
          }),
  });
}

/**
 * Creates a D1/SQLite-backed SubscriptionRepository layer. Explicit
 * construction only, tests and explicit compositions; production callers use
 * {@link createLiveNotificationsRepositoryLayer}. The caller names the
 * timezone fallback for blank stored `timezone` values, core never invents
 * one.
 */
export function createD1SubscriptionRepository(
  db: D1DatabaseBinding,
  opts: { fallbackTimezone: string },
): Layer.Layer<SubscriptionRepository> {
  return Layer.succeed(SubscriptionRepository, makeD1SubscriptionRepositoryService(db, opts));
}

/**
 * Dedicated notifications DB layer: push subscriptions are global and
 * must not be colocated with an agency's GTFS topology. Uses `DB_NOTIFICATIONS`
 * (`push-notifications-db`) with per-agency fallback handling in RuntimeBindings
 * (`DATA_DIR/push-notifications.db`).
 */
export function createLiveNotificationsRepositoryLayer(
  options: { readonly queryBudget?: InvocationBudget } = {},
): Layer.Layer<SubscriptionRepository> {
  return Layer.effect(
    SubscriptionRepository,
    Effect.gen(function* () {
      // Use the dedicated notifications binding directly, not an agency binding.
      const db = yield* Effect.promise(() => resolveRuntimeBinding(NOTIFICATIONS_BINDING_NAME));
      // Fallback timezone for blank stored values, derive from the active
      // agency at layer build, never a hardcoded literal.
      const fallbackTimezone = getActiveAgency().manifest.timezone ?? "America/Toronto";
      return makeD1SubscriptionRepositoryService(db, {
        fallbackTimezone,
        queryBudget: options.queryBudget,
      });
    }),
  );
}

/**
 * Production SQL-backed SubscriptionRepository layer for TTC. The background
 * evaluation cycle now constructs agency-scoped layers directly;
 * this TTC-named export remains for request-path consumers until pilot
 * agency routing lands.
 *
 * Now points to the dedicated notifications DB, not DB_TTC, so GTFS and push
 * are isolated per user request, agency DBs remain topology-only.
 *
 * The binding election happens lazily INSIDE the layer build
 * via the RuntimeBindings seam, never at module load, so static layer
 * compositions stay alive. There is NO in-memory fallback: a refused election
 * rejects the build loudly and the next attempt retries the ladder
 * (evict-on-failure in the seam). In-memory repositories remain explicit
 * test-tier constructions only.
 */
export const LiveSubscriptionRepositoryLayer: Layer.Layer<SubscriptionRepository> =
  createLiveNotificationsRepositoryLayer();
