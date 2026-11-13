import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { agencyLightIndex, agencySchematicLoaders } from "virtual:agency-schematics";
import { agencyCatalog } from "~/agencies/agencyCatalog";
import { SchematicSchema } from "~/agencies/types";
import { deriveAgencyLight } from "~/agencies/lightIndex";
import { allProviders } from "~/agencies/browserRegistry";
import { loadSchematic, peekSchematic } from "~/services/schematic/SchematicLoader";

const mapped = agencyCatalog.filter((entry) => entry.schematic);

describe("agency light index", () => {
  it("covers exactly the agencies that declare a schematic", () => {
    const ids = mapped.map((entry) => entry.manifest.id).sort();
    expect(Object.keys(agencyLightIndex).sort()).toEqual(ids);
    expect(Object.keys(agencySchematicLoaders).sort()).toEqual(ids);
  });

  it.each(mapped.map((entry) => [entry.manifest.id, entry] as const))(
    "%s: the derived light index matches its full schematic",
    (id, entry) => {
      expect(agencyLightIndex[id]).toEqual(deriveAgencyLight(entry.schematic!));
    },
  );

  it("exposes the light index on every browser agency and none for mapless agencies", () => {
    for (const provider of allProviders()) {
      const entry = agencyCatalog.find(
        (candidate) => candidate.manifest.id === provider.manifest.id,
      );
      expect(provider.light).toEqual(
        entry?.schematic ? deriveAgencyLight(entry.schematic) : undefined,
      );
    }
  });
});

describe("loadSchematic", () => {
  it("lazy chunks decode to the catalog's schematic for every agency", async () => {
    for (const entry of mapped) {
      const raw = await agencySchematicLoaders[entry.manifest.id]!();
      expect(Schema.decodeUnknownSync(SchematicSchema)(raw)).toEqual(entry.schematic);
    }
  });

  it("caches the decoded schematic and de-duplicates concurrent loads", async () => {
    const id = mapped[0]!.manifest.id;
    const [first, second] = await Promise.all([loadSchematic(id), loadSchematic(id)]);
    expect(second).toBe(first);
    expect(peekSchematic(id)).toBe(first);
    expect(await loadSchematic(id)).toBe(first);
  });

  it("resolves undefined for an agency without a schematic", async () => {
    expect(await loadSchematic("no-such-agency")).toBeUndefined();
    expect(peekSchematic("no-such-agency")).toBeUndefined();
  });
});
