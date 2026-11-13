import { describe, expect, it } from "vitest";
import { agencyCatalog } from "~/agencies/agencyCatalog";
import { markBrowserManifest, trimBrowserManifest } from "~/agencies/browserManifest";
import {
  allProviders as browserProviders,
  projectAgencyCatalogEntry,
} from "~/agencies/browserRegistry";
import {
  dangerouslyRegisterProvider,
  dangerouslyResetProviders,
  allProviders,
} from "~/agencies/registry";
import { makeTestProvider } from "../helpers/agency-fixtures";

describe("agency registry adapters", () => {
  it("keeps catalog order and dynamically registered providers aligned", () => {
    const catalogIds = agencyCatalog.map(({ manifest }) => manifest.id);
    expect(allProviders().map(({ manifest }) => manifest.id)).toEqual(catalogIds);
    expect(browserProviders().map(({ manifest }) => manifest.id)).toEqual(catalogIds);

    const dynamic = makeTestProvider({ id: "registry-smoke" });

    dangerouslyRegisterProvider(dynamic);
    expect(allProviders().at(-1)?.manifest.id).toBe("registry-smoke");
    expect(browserProviders().map(({ manifest }) => manifest.id)).toEqual(catalogIds);

    dangerouslyResetProviders();
    expect(allProviders().map(({ manifest }) => manifest.id)).toEqual(catalogIds);
    expect(browserProviders().map(({ manifest }) => manifest.id)).toEqual(catalogIds);
  });

  it("projects build-time trimmed manifests to the same browser agencies", () => {
    for (const entry of agencyCatalog) {
      const trimmed = markBrowserManifest(trimBrowserManifest(entry.manifest));
      expect(projectAgencyCatalogEntry({ ...entry, manifest: trimmed })).toEqual(
        projectAgencyCatalogEntry(entry),
      );
    }
  });
});
