import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createAlertIdentityPublisher } from "../../scripts/lib/alert-identity-publication";

it.each(["removed", "ineligible"])(
  "prunes catalog entries and files when an agency becomes %s",
  (change) => {
    const root = mkdtempSync(join(tmpdir(), "alert-identities-"));
    try {
      const needs = new Map([
        ["sample", { scope: true, trips: false }],
        ["retained", { scope: true, trips: false }],
      ]);
      const publicDir = join(root, "public");
      const publisher = createAlertIdentityPublisher({
        catalogFile: join(root, "catalog.json"),
        publicDir,
        needsForAgency: (id) => needs.get(id),
      });
      const topology = { routes: [{ id: "A", short_name: "A" }], stops: [] };
      publisher.generate("sample", topology, "source");
      publisher.generate("retained", topology, "source");
      const before = publisher.readCatalog().agencies.retained;
      if (change === "removed") needs.delete("sample");
      else needs.set("sample", { scope: false, trips: false });
      publisher.generate(change === "removed" ? "retained" : "sample", topology, "source");
      const catalog = publisher.readCatalog();
      expect(catalog.agencies.sample).toBeUndefined();
      expect(catalog.agencies.retained).toEqual(before);
      expect(readdirSync(join(publicDir, "generated/alert-identities/sample"))).toEqual([]);
      expect(readdirSync(join(publicDir, "generated/alert-identities/retained"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
