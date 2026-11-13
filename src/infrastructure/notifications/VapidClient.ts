import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PushPayload, PushSubscriptionRecord, VapidKeys } from "~/domain/notifications/types";
import { getVapidConfig } from "~/infrastructure/env/ServerEnv";
import { isAllowedPushEndpoint } from "~/infrastructure/notifications/PushEndpoint";
import { InvocationBudgetExceeded } from "~/infrastructure/http/InvocationIo";
import { logger } from "~/infrastructure/logging/logger";
import { parsePushRetryAfterAt } from "~/domain/notifications/pushRetryPolicy";

export class VapidError extends Data.TaggedError("VapidError")<{
  readonly message: string;
  readonly statusCode?: number;
  readonly cause?: unknown;
  readonly attempted?: boolean;
}> {}

/**
 * Thrown when the VAPID client layer is constructed without usable keys
 *. Mirrors StorageBindingRefusedError's voice: names the variables AND
 * both remedies, so the fix is never a guessing game.
 */
export class VapidConfigRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VapidConfigRefusedError";
  }
}

/**
 * Resolves VAPID keys for layer construction. An explicit `keys` argument is
 * a test-simulation channel and still gets validated; without one the keys
 * come from the ServerEnv seam. Either way, missing or blank keys refuse
 * loudly, an unsigned push request is unrepresentable.
 */
function resolveVapidKeys(keys?: VapidKeys): VapidKeys {
  const resolved = keys ?? getVapidConfig() ?? undefined;
  if (!resolved || !resolved.publicKey.trim() || !resolved.privateKey.trim()) {
    throw new VapidConfigRefusedError(
      "VAPID configuration refused: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must both be set to non-empty values before push notifications can be signed. Set them in .env (self-hosted/dev) or run `wrangler secret put VAPID_PUBLIC_KEY` / `wrangler secret put VAPID_PRIVATE_KEY` (Cloudflare Workers), then restart.",
    );
  }
  return resolved;
}

export interface SendPushResult {
  readonly success: boolean;
  readonly statusCode: number;
  readonly expired: boolean; // 404 or 410 from push service
  readonly error?: string;
  /** The current invocation has no request capacity; retry this recipient next turn. */
  readonly deferred?: boolean;
  /** Absolute provider Retry-After time, capped to the retry policy maximum. */
  readonly retryAfterAt?: number;
  /** The response body explicitly identifies a VAPID/JWT credential failure. */
  readonly credentialFailure?: boolean;
}

export interface VapidClientLayerOptions {
  /** Called only when a 401/403 body explicitly identifies a bad VAPID/JWT credential. */
  readonly onUnauthorized?: () => void;
}

const MAX_CREDENTIAL_ERROR_BODY_BYTES = 2048;

async function readCredentialErrorBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < MAX_CREDENTIAL_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const chunk = value.subarray(0, MAX_CREDENTIAL_ERROR_BODY_BYTES - length);
      chunks.push(chunk);
      length += chunk.length;
    }
  } catch {
    // Error bodies are classification evidence only. A failed read remains an
    // ordinary rejected send and must not leak provider text into diagnostics.
  } finally {
    await reader.cancel().catch(() => {});
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes).toLowerCase();
}

function isExplicitVapidCredentialFailure(body: string): boolean {
  return (
    /(?:invalid|bad|expired)\s+(?:vapid(?:\s+(?:jwt|token|public\s+key|signature))?|jwt)\b/.test(
      body,
    ) ||
    /badjwt(?:token)?|missing\s+(?:vapid\s+)?authorization\s+header|vapid\s+authentication\s+(?:failed|invalid)/.test(
      body,
    )
  );
}

/** Invocation-scoped transport dependencies, never retained by the cached client layer. */
export interface VapidSendOptions {
  readonly beforeSend?: () => void;
  readonly fetch?: typeof fetch;
}

export interface VapidClientService {
  readonly sendNotification: (
    subscription: PushSubscriptionRecord,
    payload: PushPayload,
    options?: VapidSendOptions,
  ) => Effect.Effect<SendPushResult, VapidError>;
}

export class VapidClient extends Context.Service<VapidClient, VapidClientService>()(
  "VapidClient",
) {}

/**
 * Creates an RFC 8292 compliant VAPID JWT token.
 *
 * Signed with WebCrypto instead of node:crypto: workerd's nodejs_compat does
 * not support createSign().sign(KeyObject) (ERR_INVALID_ARG_TYPE), while
 * crypto.subtle is first-class in every target runtime (Workers, Bun, Node).
 */
export async function createVapidJwt(
  audience: string,
  subject: string,
  vapidKeys: VapidKeys,
): Promise<string> {
  const encoder = new TextEncoder();
  const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claims = Buffer.from(
    JSON.stringify({
      aud: audience,
      exp: now + 12 * 3600, // 12 hours
      sub: subject,
    }),
  ).toString("base64url");

  const unsignedToken = `${header}.${claims}`;

  const pubBytes = Buffer.from(vapidKeys.publicKey, "base64url");
  const x =
    pubBytes.length === 65 && pubBytes[0] === 4
      ? pubBytes.subarray(1, 33).toString("base64url")
      : vapidKeys.publicKey.slice(0, 43);
  const y =
    pubBytes.length === 65 && pubBytes[0] === 4
      ? pubBytes.subarray(33, 65).toString("base64url")
      : vapidKeys.publicKey.slice(43);

  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", d: vapidKeys.privateKey, x, y };
  const signingKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  // subtle.sign returns the raw r||s signature (64 bytes), identical to
  // node's dsaEncoding: "ieee-p1363".
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signingKey,
    encoder.encode(unsignedToken),
  );

  return `${unsignedToken}.${Buffer.from(signature).toString("base64url")}`;
}

/**
 * RFC 5869 HKDF-SHA256 extract+expand via WebCrypto (portable across runtimes). */
async function hkdfDerive(
  ikm: BufferSource,
  salt: BufferSource,
  info: BufferSource,
  lengthBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      key,
      lengthBytes * 8,
    ),
  );
}

/** RFC 8291 §4: 4096 wire bytes minus header, delimiter, and GCM tag. */
const MAX_PUSH_PLAINTEXT_BYTES = 3993;

function serializeDeliverablePayload(payload: PushPayload): string {
  const encoder = new TextEncoder();
  const serialized = JSON.stringify(payload);
  if (encoder.encode(serialized).byteLength <= MAX_PUSH_PLAINTEXT_BYTES) return serialized;

  // Preserve routing metadata and truncate display text by Unicode code point.
  // Count the serialized UTF-8 bytes, including JSON escaping.
  const titlePoints = Array.from(payload.title);
  const title = titlePoints.slice(0, 160).join("") + (titlePoints.length > 160 ? "…" : "");
  const bodyPoints = Array.from(payload.body);
  const encodeCandidate = (length: number) =>
    JSON.stringify({
      ...payload,
      title,
      body: bodyPoints.slice(0, length).join("") + "…",
    });
  if (encoder.encode(encodeCandidate(0)).byteLength > MAX_PUSH_PLAINTEXT_BYTES) {
    throw new RangeError("Web Push routing metadata exceeds the payload limit");
  }
  let low = 0;
  let high = bodyPoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(encodeCandidate(middle)).byteLength <= MAX_PUSH_PLAINTEXT_BYTES)
      low = middle;
    else high = middle - 1;
  }
  return encodeCandidate(low);
}

/**
 * Encrypts a Web Push payload according to RFC 8291 (aes128gcm).
 *
 * Ported from node:crypto (createECDH/hkdfSync/createCipheriv) to WebCrypto:
 * workerd's nodejs_compat does not implement those APIs. Byte layout is
 * identical to the previous implementation.
 */
export async function encryptWebPushPayload(
  payload: PushPayload,
  p256dhBase64Url: string,
  authBase64Url: string,
): Promise<{ body: Uint8Array<ArrayBuffer>; headers: Record<string, string> }> {
  const encoder = new TextEncoder();
  const serializedPayload = serializeDeliverablePayload(payload);
  const clientPublicKey = new Uint8Array(Buffer.from(p256dhBase64Url, "base64url"));
  const clientAuth = new Uint8Array(Buffer.from(authBase64Url, "base64url"));

  // 1. Generate local ECDH ephemeral P-256 key pair
  const localKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  // 65 bytes uncompressed: 0x04 || X || Y
  const localPublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", localKeyPair.publicKey),
  );

  // 2. Compute shared secret (ECDH, 32 bytes)
  const clientKey = await crypto.subtle.importKey(
    "raw",
    clientPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: clientKey },
      localKeyPair.privateKey,
      256,
    ),
  );

  // 3. Salt (16 random bytes)
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // 4. RFC 8291 Section 3.2 HKDF Info:
  // key_info = "WebPush: info\0" || ua_public (65 bytes) || as_public (65 bytes)
  const keyInfo = new Uint8Array(
    Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), clientPublicKey, localPublicKey]),
  );

  // Derive PRK / IKM from auth secret and shared secret
  const ikm = await hkdfDerive(sharedSecret, clientAuth, keyInfo, 32);

  // Derive CEK (16 bytes)
  const cek = await hkdfDerive(ikm, salt, encoder.encode("Content-Encoding: aes128gcm\0"), 16);

  // Derive Nonce (12 bytes)
  const nonce = await hkdfDerive(ikm, salt, encoder.encode("Content-Encoding: nonce\0"), 12);

  // 5. Encrypt with AES-128-GCM
  // subtle.encrypt appends the 16-byte auth tag after the ciphertext —
  // exactly what node's update+final+getAuthTag produced.
  const plaintext = new Uint8Array(
    Buffer.concat([Buffer.from(serializedPayload, "utf8"), Buffer.from([0x02])]),
  );
  const cekKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cekKey, plaintext),
  );

  // 6. Format header block (RFC 8291 §2.1)
  const recordSize = 4096;
  const header = Buffer.alloc(16 + 4 + 1 + localPublicKey.length);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(localPublicKey.length, 20);
  Buffer.from(localPublicKey).copy(header, 21);

  return {
    body: new Uint8Array(Buffer.concat([header, ciphertext])),
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
    },
  };
}

/**
 * In-memory Mock VapidClient for tests.
 */
export function createMockVapidClient(
  customHandler?: (
    sub: PushSubscriptionRecord,
    payload: PushPayload,
    options?: VapidSendOptions,
  ) => Promise<SendPushResult>,
): Layer.Layer<VapidClient> {
  return Layer.succeed(
    VapidClient,
    VapidClient.of({
      sendNotification: (subscription, payload, sendOptions = {}) => {
        let attempted = false;
        return Effect.tryPromise({
          try: async () => {
            try {
              sendOptions.beforeSend?.();
            } catch (cause) {
              if (cause instanceof InvocationBudgetExceeded)
                return {
                  success: false,
                  statusCode: 0,
                  expired: false,
                  error: cause.message,
                  deferred: true,
                };
              throw cause;
            }
            if (customHandler) {
              attempted = true;
              return await customHandler(subscription, payload, sendOptions);
            }
            attempted = true;
            logger.info("MockVapidClient: sending notification", {
              subId: subscription.id,
              title: payload.title,
            });
            return {
              success: true,
              statusCode: 201,
              expired: false,
            };
          },
          catch: (err) =>
            new VapidError({
              message: "Mock VAPID dispatch failed",
              cause: err,
              attempted,
            }),
        });
      },
    }),
  );
}

/**
 * Production VAPID Client Layer.
 */
export function createVapidClientLayer(
  keys?: VapidKeys,
  options: VapidClientLayerOptions = {},
): Layer.Layer<VapidClient> {
  // Refuses loudly at construction: an unconfigured or half-configured
  // key set can no longer flow into header-less sends.
  const vapidKeys = resolveVapidKeys(keys);

  return Layer.succeed(
    VapidClient,
    VapidClient.of({
      sendNotification: (subscription, payload, sendOptions = {}) => {
        let attempted = false;
        return Effect.tryPromise({
          try: async (): Promise<SendPushResult> => {
            try {
              sendOptions.beforeSend?.();
            } catch (cause) {
              if (!(cause instanceof InvocationBudgetExceeded)) throw cause;
              return {
                success: false,
                statusCode: 0,
                expired: false,
                error: cause.message,
                deferred: true,
              };
            }
            if (!subscription.endpoint || !subscription.p256dh || !subscription.auth) {
              return {
                success: false,
                statusCode: 400,
                expired: false,
                error: "Invalid subscription credentials",
              };
            }

            if (!isAllowedPushEndpoint(subscription.endpoint)) {
              return {
                success: false,
                statusCode: 400,
                expired: false,
                error: "Push endpoint is not a trusted service",
              };
            }

            const url = new URL(subscription.endpoint);
            const audience = `${url.protocol}//${url.host}`;

            const headers: Record<string, string> = {
              TTL: "60",
              Urgency: "high",
            };

            // Construction guarantees non-empty keys; a signing failure fails
            // this attempt instead of degrading to an unsigned request.
            let token: string;
            try {
              token = await createVapidJwt(audience, vapidKeys.subject, vapidKeys);
            } catch (jwtErr) {
              logger.warn("VapidClient: signing failed — refusing to send unsigned push", {
                error: String(jwtErr),
              });
              return {
                success: false,
                statusCode: 0, // no HTTP exchange happened
                expired: false,
                error: `VAPID signing failed: ${String(jwtErr)}`,
              };
            }
            headers["Authorization"] = `vapid t=${token}, k=${vapidKeys.publicKey}`;

            const encrypted = await encryptWebPushPayload(
              payload,
              subscription.p256dh,
              subscription.auth,
            );
            Object.assign(headers, encrypted.headers);

            attempted = true;
            const response = await (sendOptions.fetch ?? fetch)(subscription.endpoint, {
              method: "POST",
              headers,
              body: encrypted.body,
              signal: AbortSignal.timeout(10_000),
              redirect: "error",
            });

            const statusCode = response.status;
            const expired = statusCode === 404 || statusCode === 410;
            let credentialFailure = false;
            if (statusCode === 401 || statusCode === 403) {
              const errorBody = await readCredentialErrorBody(response);
              credentialFailure = isExplicitVapidCredentialFailure(errorBody);
              if (credentialFailure) options.onUnauthorized?.();
            } else {
              // Bodies can contain endpoint credentials. Read none of them
              // unless a 401/403 needs bounded, in-memory classification.
              await response.body?.cancel().catch(() => {});
            }
            if (!response.ok) {
              return {
                success: false,
                statusCode,
                expired,
                error: `Push service rejected with status ${statusCode}`,
                retryAfterAt:
                  statusCode === 429
                    ? parsePushRetryAfterAt(response.headers.get("Retry-After"), Date.now())
                    : undefined,
                credentialFailure,
              };
            }

            return {
              success: true,
              statusCode,
              expired: false,
            };
          },
          catch: (err) =>
            new VapidError({
              message: "Failed to dispatch VAPID notification",
              cause: err,
              attempted,
            }),
        });
      },
    }),
  );
}
