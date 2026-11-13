import { describe, expect, it } from "vitest";
import {
  createLocationLadder,
  STORAGE_KEY_COORDS,
  STORAGE_KEY_GRANTED,
} from "~/domain/location/locationLadder";
import { SPOOF_STORAGE_KEY } from "~/lib/location-source";

const NOW = 1_800_000_000_000;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function makeLadder(storage: ReturnType<typeof memoryStorage>) {
  return createLocationLadder({
    now: () => NOW,
    requestPosition: null,
    storage,
    spoofGateActive: true,
    isTrustedOrigin: () => true,
    permissions: null,
  });
}

describe("legacy nearby storage keys", () => {
  it("migrates the cached location and keeps the live fix", () => {
    const storage = memoryStorage();
    storage.setItem(
      "ttc_nearby_cached_coords",
      JSON.stringify({ latitude: 43.7, longitude: -79.4, timestamp: NOW }),
    );

    const ladder = makeLadder(storage);

    expect(ladder.effectiveFix().fix).toMatchObject({ latitude: 43.7, longitude: -79.4 });
    expect(storage.getItem(STORAGE_KEY_COORDS)).not.toBeNull();
    expect(storage.getItem("ttc_nearby_cached_coords")).toBeNull();
  });

  it("migrates the permission grant", () => {
    const storage = memoryStorage();
    storage.setItem("ttc_nearby_permission_granted", "true");

    const ladder = makeLadder(storage);

    expect(ladder.status()).toBe("granted");
    expect(storage.getItem(STORAGE_KEY_GRANTED)).toBe("true");
    expect(storage.getItem("ttc_nearby_permission_granted")).toBeNull();
  });

  it("migrates a persisted development position only after the dev gate opens", () => {
    const storage = memoryStorage();
    storage.setItem(
      "ttc_nearby_dev_spoof",
      JSON.stringify({ latitude: 44.1, longitude: -80.2, accuracyMeters: 5, appliedAt: NOW }),
    );

    const ladder = makeLadder(storage);
    ladder.restorePersistedSpoof();

    expect(ladder.effectiveFix().source).toBe("dev-spoof");
    expect(storage.getItem(SPOOF_STORAGE_KEY)).not.toBeNull();
    expect(storage.getItem("ttc_nearby_dev_spoof")).toBeNull();
  });

  it("keeps an existing generic location when both keys are present", () => {
    const storage = memoryStorage();
    storage.setItem(
      STORAGE_KEY_COORDS,
      JSON.stringify({ latitude: 44.2, longitude: -80.1, timestamp: NOW }),
    );
    storage.setItem(
      "ttc_nearby_cached_coords",
      JSON.stringify({ latitude: 43.7, longitude: -79.4, timestamp: NOW }),
    );

    const ladder = makeLadder(storage);

    expect(ladder.effectiveFix().fix).toMatchObject({ latitude: 44.2, longitude: -80.1 });
    expect(storage.getItem("ttc_nearby_cached_coords")).toBeNull();
  });
});
