import { describe, expect, it } from "vitest";
import {
  findUnprovisionedDatabases,
  isPlaceholderDatabaseId,
  parseWranglerConfig,
} from "../../scripts/check-deploy-readiness";

describe("deploy:check", () => {
  it.each([
    ["00000000-0000-0000-0000-000000000000", true],
    ["11111111-1111-1111-1111-111111111111", true],
    ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", true],
    ["", true],
    ["   ", true],
    [undefined, true],
    ["not-a-uuid", true],
    ["cf91ec5c-fa77-4d49-ad8e-e22921b996b2", false],
    ["9f3b2c1d-4e5a-6b7c-8d9e-0f1a2b3c4d5e", false],
  ])("classifies database_id %j as placeholder=%j", (id, expected) => {
    expect(isPlaceholderDatabaseId(id)).toBe(expected);
  });

  it("names the bindings still holding placeholders, ignoring provisioned ones", () => {
    expect(
      findUnprovisionedDatabases([
        {
          binding: "DB_TRANSIT",
          database_name: "transit-status-db",
          database_id: "11111111-1111-1111-1111-111111111111",
        },
        {
          binding: "DB_NOTIFICATIONS",
          database_name: "push-notifications-db",
          database_id: "cf91ec5c-fa77-4d49-ad8e-e22921b996b2",
        },
        { binding: "", database_name: "x-db", database_id: "cf91ec5c-fa77-4d49-ad8e-e22921b996b2" },
      ]),
    ).toEqual(["DB_TRANSIT", "(unnamed binding)"]);
  });

  it("parses the repo wrangler.jsonc comment style and flags its placeholders", () => {
    const source = `{
      // deliberate placeholder — replace before first deploy
      "d1_databases": [
        { "binding": "DB_TRANSIT", "database_name": "transit-status-db", "database_id": "11111111-1111-1111-1111-111111111111" },
      ],
    }`;
    expect(findUnprovisionedDatabases(parseWranglerConfig(source).d1_databases)).toEqual([
      "DB_TRANSIT",
    ]);
  });
});
