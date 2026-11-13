import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import type { AlertDeliveryRecord, PushSubscriptionRecord } from "~/domain/notifications/types";
import type { AgencySnapshot } from "~/agencies/types";
import type { VapidKeys } from "~/domain/notifications/types";
import {
  SubscriptionRepository,
  createD1SubscriptionRepository,
} from "~/infrastructure/storage/SubscriptionRepository";
import { createNodeSqliteBinding } from "~/infrastructure/storage/RuntimeBindings";
import { ENSURE_SUBSCRIPTION_SCHEMA_SQL } from "~/infrastructure/storage/subscriptionSchema";
import { createVapidClientLayer } from "~/infrastructure/notifications/VapidClient";
import {
  AlertEvaluatorService,
  createLiveAlertEvaluatorService,
} from "~/services/notifications/AlertEvaluatorService";
import { makeAgencyAlert } from "../helpers/fixtures";

/**
 * Executable proof of the invisible-failure root cause: a subscription row whose stored
 * p256dh/auth credentials cannot decrypt what the server encrypts is
 * *invisible* to the send loop. The push gateway validates only the VAPID JWT
 * and ciphertext syntax, so it replies 201 Created; VapidClient maps any
 * response.ok to success:true, the evaluator records an `active_sent`
 * delivery, and every later cycle dedupe-skips that alert for this device.
 *
 * These tests run the REAL AlertEvaluatorService over the REAL
 * createVapidClientLayer against a real SQLite database (node:sqlite), with
 * only the network boundary (globalThis.fetch) replaced by a capturing stub
 * that mimics FCM's success behaviour.
 */

const encoder = new TextEncoder();

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes as Uint8Array).toString("base64url");
}

/** Real P-256 VAPID signing keys in the wire format (raw pub / JWK d priv). */
async function makeTestVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicKey = toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (!jwk.d) throw new Error("generated private key missing d component");
  return { publicKey, privateKey: jwk.d, subject: "mailto:integration-test@example.com" };
}

interface ClientKeys {
  readonly p256dh: string;
  readonly auth: string;
  readonly privateKey: CryptoKey;
  readonly rawPublicKey: Uint8Array<ArrayBuffer>;
  readonly authBytes: Uint8Array<ArrayBuffer>;
}

/** Client-side ECDH keypair as a browser would generate during subscribe. */
async function makeClientKeys(): Promise<ClientKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const authBytes = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  return {
    p256dh: toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey)),
    auth: toBase64Url(authBytes),
    privateKey: pair.privateKey,
    rawPublicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    authBytes,
  };
}

// --- RFC 8291 aes128gcm client-side decrypt (lifted from vapid-client.test.ts) ---

function parseAes128gcmHeader(body: Uint8Array) {
  return {
    salt: body.slice(0, 16),
    keyIdLength: body[20],
    serverPublicKey: body.slice(21, 21 + body[20]!),
    ciphertextAndTag: body.slice(21 + body[20]!),
  };
}

async function hkdf(
  ikm: BufferSource,
  salt: BufferSource,
  info: BufferSource,
  bytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8),
  );
}

/** Decrypts a captured aes128gcm request body with the client's private key. */
async function decryptPushBody(
  body: Uint8Array<ArrayBuffer>,
  client: ClientKeys,
): Promise<{
  title: string;
  body: string;
}> {
  const parsed = parseAes128gcmHeader(body);
  const serverImported = await crypto.subtle.importKey(
    "raw",
    parsed.serverPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: serverImported },
      client.privateKey,
      256,
    ),
  );
  const keyInfo = new Uint8Array(
    Buffer.concat([
      Buffer.from("WebPush: info\0", "utf8"),
      client.rawPublicKey,
      parsed.serverPublicKey,
    ]),
  );
  const ikm = await hkdf(sharedSecret, client.authBytes, keyInfo, 32);
  const cek = await hkdf(ikm, parsed.salt, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, parsed.salt, encoder.encode("Content-Encoding: nonce\0"), 12);

  const cekKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce },
    cekKey,
    parsed.ciphertextAndTag,
  );
  const decoded = new Uint8Array(plaintext);
  // Trailing byte must be the RFC 8291 padding delimiter; the rest is JSON.
  expect(decoded[decoded.length - 1]).toBe(0x02);
  return JSON.parse(Buffer.from(decoded.slice(0, -1)).toString("utf8"));
}

// --- harness ---

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
});

async function loadDatabaseSync(): Promise<
  | (new (path: string) => import("~/infrastructure/storage/RuntimeBindings").SqliteDatabaseLike)
  | null
> {
  try {
    const mod = await import("node:sqlite");
    return mod.DatabaseSync;
  } catch {
    return null;
  }
}

function makeTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ttc-push-roundtrip-"));
  tempDirs.push(dir);
  return join(dir, "test.db");
}

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array<ArrayBuffer>;
}

let capturedRequests: CapturedRequest[] = [];

/** Replaces globalThis.fetch with an FCM-like endpoint replying `status`. */
function stubPushGateway(status: number): void {
  capturedRequests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const rawHeaders: Record<string, string> = {};
      if (init?.headers) {
        for (const [key, value] of Object.entries(init.headers)) {
          rawHeaders[key.toLowerCase()] = String(value);
        }
      }
      const rawBody = init?.body;
      const bytes =
        rawBody instanceof Uint8Array ? rawBody : new Uint8Array(rawBody as ArrayBuffer);
      const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
      copy.set(bytes);
      capturedRequests.push({ url, headers: rawHeaders, body: copy });
      return new Response(null, { status });
    }),
  );
}

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/test-integration-endpoint";

/** Always-on commute window so the schedule gate never skips the subscriber. */
const ALWAYS_ACTIVE_SCHEDULE = [
  {
    id: "sched-integration",
    label: "Integration window",
    enabled: true,
    days: [0, 1, 2, 3, 4, 5, 6],
    start: "00:00",
    end: "23:59",
  },
];

function makeSnapshot(): AgencySnapshot {
  const now = Date.now();
  return {
    agencyId: "ttc",
    generatedAt: now,
    freshness: "live",
    alerts: [
      makeAgencyAlert({
        id: "rt-alert-1",
        severity: "severe",
        lifecycle: "active",
        affectedLineIds: ["1"],
        title: "Signal problem at Lawrence West",
        description: "Trains are not stopping at Lawrence West station due to a signal problem.",
      }),
    ],
  };
}

interface RoundTripHarness {
  readonly repoLayer: Layer.Layer<SubscriptionRepository>;
  readonly client: ClientKeys;
  seedSubscription: () => Promise<void>;
  runEvaluationCycle: () => Promise<{
    activePushesSent: number;
    expiredSubscriptionsPruned: number;
  }>;
  deliveriesForSubscription: () => Promise<readonly AlertDeliveryRecord[]>;
  activeSubscriptions: () => Promise<readonly PushSubscriptionRecord[]>;
}

async function setupRoundTrip(client: ClientKeys): Promise<RoundTripHarness> {
  const DatabaseSync = await loadDatabaseSync();
  if (!DatabaseSync) throw new Error("node:sqlite unavailable in this runtime");

  const binding = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync);
  await binding.exec(ENSURE_SUBSCRIPTION_SCHEMA_SQL);
  const repoLayer = createD1SubscriptionRepository(binding, {
    fallbackTimezone: "America/Toronto",
  });

  const record: PushSubscriptionRecord = {
    id: "sub-roundtrip-1",
    endpoint: ENDPOINT,
    p256dh: client.p256dh,
    auth: client.auth,
    favouriteLines: [{ agencyId: "ttc", lineId: "1" }],
    favouriteStations: [],
    favouriteSurfaceRoutes: [],
    commuteSchedules: ALWAYS_ACTIVE_SCHEDULE,
    timezone: "America/Toronto",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const vapidLayer = createVapidClientLayer(await makeTestVapidKeys());
  const evaluatorLayer = createLiveAlertEvaluatorService().pipe(
    Layer.provide(Layer.merge(repoLayer, vapidLayer)),
  );

  const snapshot = makeSnapshot();

  return {
    repoLayer,
    client,
    async seedSubscription() {
      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* SubscriptionRepository;
          yield* repo.upsertSubscription(record);
        }).pipe(Effect.provide(repoLayer)),
      );
    },
    async runEvaluationCycle() {
      return Effect.runPromise(
        Effect.gen(function* () {
          const evaluator = yield* AlertEvaluatorService;
          const summary = yield* evaluator.evaluateAndDispatch(snapshot);
          return {
            activePushesSent: summary.activePushesSent,
            expiredSubscriptionsPruned: summary.expiredSubscriptionsPruned,
          };
        }).pipe(Effect.provide(evaluatorLayer)),
      );
    },
    async deliveriesForSubscription() {
      return Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* SubscriptionRepository;
          return yield* repo.getDeliveriesForSubscription("ttc", record.id);
        }).pipe(Effect.provide(repoLayer)),
      );
    },
    async activeSubscriptions() {
      return Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* SubscriptionRepository;
          return yield* repo.getActiveSubscriptions();
        }).pipe(Effect.provide(repoLayer)),
      );
    },
  };
}

// Probe once at collection time: without node:sqlite the whole suite reports
// as SKIPPED rather than silently passing with zero assertions.
const databaseSync = await loadDatabaseSync();

describe.skipIf(!databaseSync)("push delivery round trip", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers an encrypted payload the subscribed client can decrypt", async () => {
    const harness = await setupRoundTrip(await makeClientKeys());
    await harness.seedSubscription();
    stubPushGateway(201);

    const summary = await harness.runEvaluationCycle();

    expect(summary.activePushesSent).toBe(1);
    expect(summary.expiredSubscriptionsPruned).toBe(0);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]!.url).toBe(ENDPOINT);
    expect(capturedRequests[0]!.headers["content-encoding"]).toBe("aes128gcm");
    expect(capturedRequests[0]!.headers["ttl"]).toBe("60");
    expect(capturedRequests[0]!.headers.authorization).toMatch(/^vapid /);

    const decrypted = await decryptPushBody(capturedRequests[0]!.body, harness.client);
    expect(decrypted.title).toContain("🚨");
    expect(decrypted.title).toContain("Line 1");
    expect(decrypted.body.trim().length).toBeGreaterThan(0);

    const deliveries = await harness.deliveriesForSubscription();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("active_sent");
    expect(deliveries[0]?.alertId).toBe("rt-alert-1");
  });

  it("a corrupted ciphertext still reports success to the server (invisible-failure proof)", async () => {
    const harness = await setupRoundTrip(await makeClientKeys());
    await harness.seedSubscription();
    stubPushGateway(201); // gateway accepts syntactically-valid ciphertext

    const summary = await harness.runEvaluationCycle();

    expect(summary.activePushesSent).toBe(1);
    expect(capturedRequests).toHaveLength(1);

    // Flip one byte inside the ciphertext section (past the fixed header +
    // ephemeral server key): AES-GCM auth must now fail on the client.
    const original = capturedRequests[0]!.body;
    const corrupted = new Uint8Array(new ArrayBuffer(original.byteLength));
    corrupted.set(original);
    const headerLength = 21 + corrupted[20]!; // salt+rs+keyidlen + server pubkey
    const targetByte = headerLength + 2;
    expect(targetByte).toBeLessThan(corrupted.length - 16); // stay clear of the GCM tag
    corrupted[targetByte]! ^= 0xff;

    let decryptError: unknown;
    try {
      await decryptPushBody(corrupted, harness.client);
    } catch (err) {
      decryptError = err;
    }
    expect(decryptError).toBeDefined();

    // Yet the server saw 201 and treated the delivery as fully successful:
    // the delivery was recorded and the subscription was NOT pruned.
    const deliveries = await harness.deliveriesForSubscription();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("active_sent");

    const subs = await harness.activeSubscriptions();
    expect(subs).toHaveLength(1);
  });

  it("a rotated client key can no longer decrypt payloads the gateway accepted (stale-row simulation)", async () => {
    // The stored row holds the ORIGINAL credentials; the device later rotates
    // to a NEW keypair without re-syncing (the poisoning scenario).
    const originalClient = await makeClientKeys();
    const rotatedClient = await makeClientKeys();

    const harness = await setupRoundTrip(originalClient);
    await harness.seedSubscription();
    stubPushGateway(201);

    const summary = await harness.runEvaluationCycle();

    expect(summary.activePushesSent).toBe(1);
    expect(capturedRequests).toHaveLength(1);

    // The server encrypted for the stored (old) public key; the device's new
    // private key must fail decryption even though the gateway replied 201.
    let decryptError: unknown;
    try {
      await decryptPushBody(capturedRequests[0]!.body, rotatedClient);
    } catch (err) {
      decryptError = err;
    }
    expect(decryptError).toBeDefined();

    const subs = await harness.activeSubscriptions();
    expect(subs).toHaveLength(1);
    expect(summary.expiredSubscriptionsPruned).toBe(0);
  });
});
