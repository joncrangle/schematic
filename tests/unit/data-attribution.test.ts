import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  renderDataAttribution,
  syncDataAttribution,
} from "../../scripts/generate-data-attribution";

const agency = {
  id: "sample",
  name: "Sample Transit",
  attribution: {
    name: "Sample Open Data",
    url: "https://example.com/data",
    license: "Contains information provided by Sample Transit under licence",
  },
};

describe("data attribution generation", () => {
  const directories: string[] = [];
  const outputPath = () => {
    const directory = mkdtempSync(join(tmpdir(), "data-attribution-"));
    directories.push(directory);
    return join(directory, "attribution.md");
  };
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
  });

  it("preserves acknowledgements and renders manifest text safely in a Markdown table", () => {
    const result = renderDataAttribution([
      {
        ...agency,
        name: "Sample | [Transit]",
        attribution: { ...agency.attribution, name: "Open [Data]\n& more" },
      },
      {
        ...agency,
        id: "other",
        name: "Other Transit",
        attribution: { ...agency.attribution, license: "https://example.com/licence.pdf" },
      },
    ]);
    expect(result).toContain(
      "| Sample \\| \\[Transit\\] | [Open \\[Data\\]<br>&amp; more](<https://example.com/data>) |",
    );
    expect(result).toContain(agency.attribution.license);
    expect(result).toContain("[Licence terms](<https://example.com/licence.pdf>)");
  });

  it.each(["missing", "outdated"])("rejects a %s document without changing it", (state) => {
    const path = outputPath();
    if (state === "outdated") writeFileSync(path, "old document");
    expect(syncDataAttribution(path, [agency], true)).toBe(false);
    expect(existsSync(path)).toBe(state === "outdated");
    expect(state === "outdated" ? readFileSync(path, "utf8") : null).toBe(
      state === "outdated" ? "old document" : null,
    );
  });

  it("detects added agencies and changed terms, then accepts the regenerated document", () => {
    const path = outputPath();
    syncDataAttribution(path, [agency], false);
    expect(syncDataAttribution(path, [agency], true)).toBe(true);
    const changed = { ...agency, attribution: { ...agency.attribution, license: "CC BY 4.0" } };
    const added = { ...agency, id: "new", name: "New Transit" };
    expect(syncDataAttribution(path, [changed], true)).toBe(false);
    expect(syncDataAttribution(path, [agency, added], true)).toBe(false);
    syncDataAttribution(path, [changed, added], false);
    expect(syncDataAttribution(path, [added, changed], true)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(
      "| Sample Transit | [Sample Open Data](<https://example.com/data>) | CC BY 4.0 |",
    );
  });
});
