import { expect, it } from "vitest";
import { agencyStoragePath } from "~/domain/agencyStoragePath";
import { makeTestManifest } from "../helpers/agency-fixtures";

it.each([
  ["a regional agency under its region", "regional", { country: "ca", region: "on" }, "ca/on/fixture"],
  ["a nationwide agency under its country", "national", { country: "ca" }, "ca/nat/fixture"],
  ["a non-local agency confined to one region under that region", "national", { country: "ca", region: "on" }, "ca/on/fixture"],
  ["an international agency outside every country", "international", { country: "ca", region: "on" }, "intl/fixture"],
] as const)("places %s", (_, scope, jurisdiction, path) => {
  expect(agencyStoragePath({ ...makeTestManifest({ id: "fixture" }), scope, jurisdiction })).toBe(path);
});
