import { createCloudflareInvocationIo } from "~/infrastructure/http/InvocationIo";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import {
  createVapidClientLayer,
  createVapidJwt,
  encryptWebPushPayload,
  VapidClient,
  VapidConfigRefusedError,
} from "~/infrastructure/notifications/VapidClient";
import type { PushPayload, PushSubscriptionRecord, VapidKeys } from "~/domain/notifications/types";
import { captureServerEnvChannels, clearServerEnvChannels } from "../helpers/env-channels";

const encoder = new TextEncoder();

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes as Uint8Array).toString("base64url");
}

/** Generates a real P-256 keypair in the VAPID wire format (raw pub / JWK d priv). */
async function makeTestVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicKey = toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (!jwk.d) throw new Error("generated private key missing d component");
  return { publicKey, privateKey: jwk.d, subject: "mailto:test@example.com" };
}

describe("createVapidJwt", () => {
  it("produces a JWT whose ES256 signature verifies against the public key", async () => {
    const keys = await makeTestVapidKeys();
    const audience = "https://fcm.googleapis.com";

    const token = await createVapidJwt(audience, keys.subject, keys);
    const [headerB64, claimsB64, sigB64] = token.split(".");
    expect(headerB64).toBeTruthy();
    expect(claimsB64).toBeTruthy();
    expect(sigB64).toBeTruthy();

    const verifyKey = await crypto.subtle.importKey(
      "raw",
      Buffer.from(keys.publicKey, "base64url"),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifyKey,
      Buffer.from(sigB64!, "base64url") as unknown as BufferSource,
      encoder.encode(`${headerB64}.${claimsB64}`),
    );
    expect(valid).toBe(true);

    const header = JSON.parse(Buffer.from(headerB64!, "base64url").toString("utf8")) as {
      typ: string;
      alg: string;
    };
    const claims = JSON.parse(Buffer.from(claimsB64!, "base64url").toString("utf8")) as {
      aud: string;
      sub: string;
      exp: number;
    };
    expect(header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(claims.aud).toBe(audience);
    expect(claims.sub).toBe(keys.subject);
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

describe("encryptWebPushPayload", () => {
  async function makeClientKeys() {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]);
    const authBytes = crypto.getRandomValues(new Uint8Array(16));
    return {
      p256dh: toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey)),
      auth: toBase64Url(authBytes),
      authBytes,
      clientPrivate: pair.privateKey,
      clientRawPublic: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    };
  }

  const payload: PushPayload = {
    title: "🧪 Test notification",
    body: "hello from the unit suite",
    tag: `test-push-${Date.now()}`,
  };

  function parseAes128gcmHeader(body: Uint8Array) {
    return {
      salt: body.slice(0, 16),
      recordSize: body[16]! * 2 ** 24 + body[17]! * 2 ** 16 + body[18]! * 2 ** 8 + body[19]!,
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

  it.each([
    { label: "short payload", input: payload, shortened: false },
    {
      label: "large Unicode description",
      input: { ...payload, body: "🚊 disruption\n".repeat(1000) },
      shortened: true,
    },
    {
      label: "large escaped title and body",
      input: { ...payload, title: '\"'.repeat(5000), body: "\\".repeat(5000) },
      shortened: true,
    },
  ])(
    "encrypts a deliverable $label that decrypts to visible text",
    async ({ input, shortened }) => {
      const client = await makeClientKeys();
      const { body, headers } = await encryptWebPushPayload(input, client.p256dh, client.auth);

      expect(headers["Content-Encoding"]).toBe("aes128gcm");
      expect(headers["Content-Type"]).toBe("application/octet-stream");

      expect(body.byteLength).toBeLessThanOrEqual(4096);
      const parsed = parseAes128gcmHeader(body);
      expect(parsed.recordSize).toBe(4096);
      expect(parsed.keyIdLength).toBe(65); // uncompressed P-256 point
      // ciphertext + 16-byte GCM tag + at least the 0x02 padding delimiter
      expect(parsed.ciphertextAndTag.length).toBeGreaterThanOrEqual(16 + 1);

      // Full decrypt: replicate the RFC 8291 key chain from the client side.
      const clientImported = await crypto.subtle.importKey(
        "raw",
        client.clientRawPublic,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        [],
      );
      const serverImported = await crypto.subtle.importKey(
        "raw",
        parsed.serverPublicKey,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        [],
      );
      void clientImported;

      const sharedSecret = new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: "ECDH", public: serverImported },
          client.clientPrivate,
          256,
        ),
      );

      const keyInfo = new Uint8Array(
        Buffer.concat([
          Buffer.from("WebPush: info\0", "utf8"),
          client.clientRawPublic,
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

      // Trailing byte must be the RFC 8291 padding delimiter; rest is our JSON.
      expect(decoded[decoded.length - 1]).toBe(0x02);
      const json = Buffer.from(decoded.slice(0, -1)).toString("utf8");
      const decodedPayload: PushPayload = JSON.parse(json);
      expect(decodedPayload).toEqual({
        ...input,
        title: expect.any(String),
        body: expect.any(String),
      });
      const bodyIsValid = shortened
        ? decodedPayload.body.endsWith("…") &&
          input.body.startsWith(decodedPayload.body.slice(0, -1)) &&
          !decodedPayload.body.includes("�")
        : decodedPayload.body === input.body;
      expect(bodyIsValid).toBe(true);
      expect(decodedPayload.title.length).toBeGreaterThan(0);
      expect(
        shortened
          ? input.title.startsWith(decodedPayload.title.slice(0, -1))
          : decodedPayload.title === input.title,
      ).toBe(true);
    },
  );
});

describe("createVapidClientLayer construction refusal", () => {
  const envVarNames = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;
  const restoreEnvChannels = captureServerEnvChannels(envVarNames);

  afterEach(() => {
    restoreEnvChannels();
  });

  function clearEnvChannels() {
    clearServerEnvChannels(envVarNames);
  }

  function buildLayer(keys: VapidKeys | undefined): Layer.Layer<VapidClient> {
    return createVapidClientLayer(keys);
  }

  it.each([
    ["no keys argument and nothing configured", () => undefined],
    [
      "an explicitly empty public key",
      () => ({ publicKey: "", privateKey: "sk", subject: "mailto:t@example.com" }),
    ],
    [
      "a whitespace-only private key",
      () => ({ publicKey: "pk", privateKey: "   ", subject: "mailto:t@example.com" }),
    ],
    ["only a public key resolvable from env", () => undefined],
  ] as [string, () => VapidKeys | undefined][])(
    "refuses construction naming both variables and both remedies when given %s",
    (_name, makeKeys) => {
      clearEnvChannels();
      if (_name === "only a public key resolvable from env") {
        process.env.VAPID_PUBLIC_KEY = "pk-env-only";
      }

      let caught: unknown;
      try {
        buildLayer(makeKeys());
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(VapidConfigRefusedError);
      const refusal = caught as Error;
      expect(refusal.message).toContain("VAPID_PUBLIC_KEY");
      expect(refusal.message).toContain("VAPID_PRIVATE_KEY");
      expect(refusal.message).toContain(".env");
      expect(refusal.message).toContain("wrangler secret put");
    },
  );

  it("constructs from real generated keys", async () => {
    clearEnvChannels();
    const keys = await makeTestVapidKeys();
    expect(() => buildLayer(keys)).not.toThrow();
  });

  it("constructs without an argument when env provides non-empty keys", () => {
    clearEnvChannels();
    process.env.VAPID_PUBLIC_KEY = "pk-env";
    process.env.VAPID_PRIVATE_KEY = "sk-env";

    expect(() => buildLayer(undefined)).not.toThrow();
  });
});

describe("sendNotification signed-send contract", () => {
  const pushPayload: PushPayload = {
    title: "signed send",
    body: "contract check",
    tag: `ttc-signed-${Date.now()}`,
  };

  /** Real client-side ECDH material so the request passes subscription validation. */
  async function makeClientSubscriptionKeys() {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]);
    return {
      p256dh: toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey)),
      auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    };
  }

  function makeSubscription(clientKeys: { p256dh: string; auth: string }): PushSubscriptionRecord {
    return {
      id: "sub_signed",
      endpoint: "https://fcm.googleapis.com/fcm/send/sub_signed",
      p256dh: clientKeys.p256dh,
      auth: clientKeys.auth,
      favouriteLines: [],
      favouriteStations: [],
      favouriteSurfaceRoutes: [],
      commuteSchedules: [],
      timezone: "America/Toronto",
      createdAt: 1000,
      updatedAt: 1000,
    };
  }

  it("sends exactly one request carrying a VAPID Authorization header", async () => {
    const keys = await makeTestVapidKeys();
    const clientKeys = await makeClientSubscriptionKeys();
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* VapidClient;
          return yield* client.sendNotification(makeSubscription(clientKeys), pushPayload);
        }).pipe(Effect.provide(createVapidClientLayer(keys))),
      );

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(201);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      if (!requestInit) throw new Error("expected exactly one fetch call");
      expect(requestInit.redirect).toBe("error");
      const headers = requestInit.headers as Record<string, string>;
      expect(headers.TTL).toBe("60");
      expect(headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
      expect(headers.Authorization.endsWith(`k=${keys.publicKey}`)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    "https://attacker.example/push",
    "https://127.0.0.1/push",
    "https://fcm.googleapis.com:8443/push",
  ])("does not send to an endpoint outside the push-service allowlist: %s", async (endpoint) => {
    const keys = await makeTestVapidKeys();
    const clientKeys = await makeClientSubscriptionKeys();
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await Effect.runPromise(
        Effect.flatMap(VapidClient, (client) =>
          client.sendNotification({ ...makeSubscription(clientKeys), endpoint }, pushPayload),
        ).pipe(Effect.provide(createVapidClientLayer(keys))),
      );

      expect(result.success).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails the attempt instead of sending header-less when signing throws", async () => {
    const realKeys = await makeTestVapidKeys();
    const brokenKeys: VapidKeys = { ...realKeys, privateKey: "%invalid-base64url%" };
    const clientKeys = await makeClientSubscriptionKeys();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* VapidClient;
          return yield* client.sendNotification(makeSubscription(clientKeys), pushPayload);
        }).pipe(Effect.provide(createVapidClientLayer(brokenKeys))),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("signing failed");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("aborts a stalled push request instead of blocking the delivery batch", async () => {
    const keys = await makeTestVapidKeys();
    const clientKeys = await makeClientSubscriptionKeys();
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const outcome = Effect.runPromise(
        Effect.flatMap(VapidClient, (client) =>
          client.sendNotification(makeSubscription(clientKeys), pushPayload),
        ).pipe(Effect.provide(createVapidClientLayer(keys)), Effect.result),
      );
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      controller.abort();
      expect((await outcome)._tag).toBe("Failure");
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      timeout.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it.each([201, 503])(
    "releases the %s response body without retaining upstream secrets",
    async (status) => {
      const keys = await makeTestVapidKeys();
      const clientKeys = await makeClientSubscriptionKeys();
      const cancel = vi.fn();
      const body = new ReadableStream({
        start: (controller) => controller.enqueue(encoder.encode("private-upstream-body")),
        cancel,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { status })),
      );
      try {
        const result = await Effect.runPromise(
          Effect.flatMap(VapidClient, (client) =>
            client.sendNotification(makeSubscription(clientKeys), pushPayload),
          ).pipe(Effect.provide(createVapidClientLayer(keys))),
        );
        expect(result.success).toBe(status === 201);
        expect(cancel).toHaveBeenCalledOnce();
        expect(JSON.stringify(result)).not.toContain("private-upstream-body");
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([
    [401, '{"message":"Invalid VAPID token"}'],
    [403, "invalid JWT provided"],
    [403, "Invalid VAPID public key"],
  ])("invalidates cached credentials for an explicit %s VAPID error", async (status, body) => {
    const keys = await makeTestVapidKeys();
    const clientKeys = await makeClientSubscriptionKeys();
    const invalidate = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status })),
    );

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* VapidClient;
          return yield* client.sendNotification(makeSubscription(clientKeys), pushPayload);
        }).pipe(Effect.provide(createVapidClientLayer(keys, { onUnauthorized: invalidate }))),
      );

      expect(result.success).toBe(false);
      expect(invalidate).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not invalidate the global VAPID stack for a subscription key mismatch", async () => {
    const keys = await makeTestVapidKeys();
    const clientKeys = await makeClientSubscriptionKeys();
    const invalidate = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("VAPID credentials do not match the key used to create this subscription", {
            status: 403,
          }),
      ),
    );

    try {
      const result = await Effect.runPromise(
        Effect.flatMap(VapidClient, (client) =>
          client.sendNotification(makeSubscription(clientKeys), pushPayload),
        ).pipe(Effect.provide(createVapidClientLayer(keys, { onUnauthorized: invalidate }))),
      );

      expect(result).toMatchObject({ success: false, statusCode: 403, credentialFailure: false });
      expect(invalidate).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("do not match the key");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("refuses exhausted invocations before signing or encryption without expiring the subscription", async () => {
    const keys = await makeTestVapidKeys();
    const clientKeys = await makeClientSubscriptionKeys();
    const upstream = vi.fn(async () => new Response(null, { status: 201 }));
    const io = createCloudflareInvocationIo({ fetch: upstream as typeof fetch, limit: 0 });
    const sign = vi.spyOn(crypto.subtle, "sign");
    const generate = vi.spyOn(crypto.subtle, "generateKey");
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* VapidClient;
          return yield* client.sendNotification(
            makeSubscription(clientKeys),
            pushPayload,
            io.sendOptions,
          );
        }).pipe(Effect.provide(createVapidClientLayer(keys))),
      );
      expect(result).toMatchObject({ success: false, statusCode: 0, expired: false });
      expect(upstream).not.toHaveBeenCalled();
      expect(sign).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
    } finally {
      sign.mockRestore();
      generate.mockRestore();
    }
  });
});
