vi.mock("../../src/agencies/agencyCatalog", async () => {
  const { makeTestManifest, makeTestSchematic } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: [{ manifest: makeTestManifest(), schematic: makeTestSchematic() }] };
});
import { describe, expect, it, vi } from "vitest";
import { getAgencyById } from "../../src/agencies/registry";
import type { AgencyProvider } from "../../src/agencies/types";
import {
  checkAgencyProvider,
  checkRegisteredAgencies,
  parseAgencyCheckArgs,
} from "../../scripts/check-agency";

describe("agency:check", () => {
  it("parses explicit ids, comma-separated ids, and the all-agencies default", () => {
    expect(parseAgencyCheckArgs(["--agency=REGIONAL,sample", "sample"])).toEqual({
      agencyIds: ["regional", "sample"],
      isHelp: false,
    });
    expect(parseAgencyCheckArgs(["--all"])).toEqual({ agencyIds: [], isHelp: false });
    expect(parseAgencyCheckArgs([])).toEqual({ agencyIds: [], isHelp: false });
  });

  it("checks one registered agency without contacting feeds or storage", () => {
    const result = checkRegisteredAgencies(["sample"]);

    expect(result.registryIssues).toEqual([]);
    expect(result.unknownAgencyIds).toEqual([]);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({
      agencyId: "sample",
      bindingName: "DB_TRANSIT",
      sqlitePath: "transit.db",
      issues: [],
    });
  });

  it("reports provider contract and schematic issues instead of silently passing", () => {
    const provider = getAgencyById("sample");
    expect(provider).toBeDefined();
    expect(provider?.schematic).toBeDefined();

    const broken: AgencyProvider = {
      ...provider!,
      manifest: { ...provider!.manifest, id: "broken-transit" },
      snapshot: undefined,
      schematic: {
        ...provider!.schematic!,
        stations: [
          ...provider!.schematic!.stations,
          {
            ...provider!.schematic!.stations[0]!,
            name: "Broken Station",
            lines: ["missing-line"],
          },
        ],
      },
    };

    const report = checkAgencyProvider(broken);
    const checks = report.issues.map((issue) => issue.check);

    expect(checks).toContain("snapshot-port");
    expect(checks).toContain("schematic-compiles");
  });

  it("rejects non-feed secret names in realtime and alert declarations", () => {
    const provider = getAgencyById("sample");
    expect(provider).toBeDefined();
    const invalid: AgencyProvider = {
      ...provider!,
      realtime: {
        feeds: (provider!.realtime?.feeds ?? []).map((feed) =>
          feed.kind === "trip_updates"
            ? {
                ...feed,
                auth: {
                  type: "header",
                  headerName: "X-API-Key",
                  secretName: "VAPID_PRIVATE_KEY",
                },
              }
            : feed,
        ),
      },
      alerts: [
        {
          type: "gtfs-rt",
          url: "https://example.test/alerts",
          baseUrlSecretName: "VAPID_PRIVATE_KEY",
        },
      ],
    };

    const report = checkAgencyProvider(invalid);

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        check: "feed-secret-name",
        detail: expect.stringContaining("realtime.feeds[1].auth.secretName"),
      }),
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        check: "feed-secret-name",
        detail: expect.stringContaining("alerts[0].baseUrlSecretName"),
      }),
    );
  });

  it("reports an unknown agency id", () => {
    const result = checkRegisteredAgencies(["not-registered"]);

    expect(result.unknownAgencyIds).toEqual(["not-registered"]);
    expect(result.reports).toEqual([]);
  });
});
