import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { makeTestManifest } from "../helpers/agency-fixtures";
import { createAgencyProvider } from "~/agencies/createAgencyProvider";
import { deriveGtfsProjectionConfig } from "~/infrastructure/gtfs/config";
import { parseNextBusRouteConfigJson } from "~/domain/nextbus/parseRouteConfig";
import type { TopologySource } from "~/domain/surface/topologySource";

const topologyFactory = vi.hoisted(() => vi.fn());

vi.mock("~/infrastructure/storage/surfaceStore/topology", () => ({
  createD1TopologySource: topologyFactory,
}));

const fallbackBounds = { minLat: 43, maxLat: 44, minLon: -80, maxLon: -79 };

const nextBusPayload = {
  route: {
    tag: "R1",
    title: "R1 - Sample",
    stop: [{ tag: "s1", title: "Sample Stop", lat: "43.7", lon: "-79.4" }],
    direction: [
      {
        tag: "R1_0",
        title: "Northbound",
        useForUI: "true",
        stop: [{ tag: "s1" }],
      },
    ],
  },
};

describe("route color defaults", () => {
  it("uses a neutral NextBus color unless the manifest declares a route color", () => {
    const core = parseNextBusRouteConfigJson(nextBusPayload, {
      routeId: "R1",
      fallbackBounds,
    });
    const configured = parseNextBusRouteConfigJson(nextBusPayload, {
      routeId: "R1",
      fallbackBounds,
      defaultRouteColor: "#C32D38",
    });

    expect(core.detailsByDir.get(0)?.route.color).toBe("#64748B");
    expect(configured.detailsByDir.get(0)?.route.color).toBe("#C32D38");
  });

  it("uses the neutral GTFS fallback when the manifest omits its default", () => {
    const config = deriveGtfsProjectionConfig(makeTestManifest(), {
      defaultColor: "",
      defaultTextColor: "",
    });

    expect(config.defaultColor).toBe("#64748B");
  });

  it("threads a manifest color to the NextBus topology adapter", async () => {
    const source: TopologySource = {
      fetchTopology: () => Effect.succeed({ agencyId: "sample", generatedAt: 1, routes: [] }),
      shouldRefreshTopology: () => Effect.succeed(false),
      syncTopology: () => Effect.succeed(undefined),
    };
    topologyFactory.mockReturnValue(source);
    const manifest = makeTestManifest({
      staticTopology: {
        source: "nextbus",
        agencySlug: "sample",
        defaultColor: "#C32D38",
        feeds: [
          {
            name: "Sample Transit",
            url: "https://example.test/gtfs.zip",
            cacheFileName: "sample.zip",
          },
        ],
      },
    });
    const provider = createAgencyProvider({ manifest });

    await Effect.runPromise(
      provider.createTopologySource!({ d1: {}, fetch, now: () => 123 }).syncTopology(),
    );

    expect(topologyFactory).toHaveBeenCalledOnce();
    expect(topologyFactory.mock.calls[0]?.[0]).toMatchObject({
      agencyId: "sample",
      defaultRouteColor: "#C32D38",
    });
  });
});
