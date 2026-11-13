import { describe, expect, it } from "vitest";
import {
  classifySurfaceAlert,
  formatDirectionalChip,
  matchAlertsForRoute,
  matchAlertsForSubscribedRoute,
  parseDirectionalScope,
  sortSurfaceAlerts,
  toggleAlertId,
} from "~/domain/surface/surfaceAlerts";
import { makeAgencyAlert as makeAlert } from "../helpers/fixtures";

const now = Date.now();

describe("classifySurfaceAlert", () => {
  it.each([
    {
      label: "maps severe severity to severe presentation",
      overrides: { severity: "severe" as const },
      severity: "severe" as const,
      labelText: "Delay",
    },
    {
      label: "maps suspension kind to severe even when severity is degraded",
      overrides: { kind: "suspension" as const, severity: "degraded" as const },
      severity: "severe" as const,
      labelText: "Delay",
    },
    {
      label: "classifies a delay as degraded",
      overrides: {},
      severity: "degraded" as const,
      labelText: "Delay",
    },
    {
      label: "labels a detour",
      overrides: {
        serviceChange: "detour" as const,
      },
      severity: "degraded" as const,
      labelText: "Detour",
    },
    {
      label: "keeps severe severity on a detour",
      overrides: {
        severity: "severe" as const,
        serviceChange: "detour" as const,
      },
      severity: "severe" as const,
      labelText: "Detour",
    },
  ] as const)("$label", ({ overrides, severity, labelText }) => {
    const presentation = classifySurfaceAlert(makeAlert(overrides));

    expect(presentation).toMatchObject({
      severity,
      label: labelText,
    });
  });

  it("does not reclassify severe-looking prose without interpreted semantics", () => {
    const presentation = classifySurfaceAlert(
      makeAlert({
        title: "Service suspended and detoured",
        kind: "delay",
        severity: "degraded",
      }),
    );

    expect(presentation.severity).toBe("degraded");
    expect(presentation.label).toBe("Delay");
  });
});

describe("parseDirectionalScope", () => {
  it("parses explicit eastbound bound form", () => {
    expect(parseDirectionalScope(makeAlert({ title: "97 Yonge: Eastbound delays" }))).toBe(
      "eastbound",
    );
  });

  it("parses the EB abbreviation", () => {
    expect(parseDirectionalScope(makeAlert({ description: "EB service disruption" }))).toBe(
      "eastbound",
    );
  });

  it("parses a direction word when it explicitly modifies bound", () => {
    expect(parseDirectionalScope(makeAlert({ title: "Westbound delays on 504 King" }))).toBe(
      "westbound",
    );
  });

  it("treats explicit both-directions text as both", () => {
    expect(
      parseDirectionalScope(makeAlert({ title: "510 Spadina: Delays in both directions" })),
    ).toBe("both");
  });

  it("treats an east-west pair as both", () => {
    expect(
      parseDirectionalScope(makeAlert({ title: "504 King: East and west delays reported" })),
    ).toBe("both");
  });

  it("defaults to both when no direction is mentioned", () => {
    expect(parseDirectionalScope(makeAlert({ title: "97 Yonge: General delays" }))).toBe("both");
  });

  it("does not treat bounded words like 'bus' as a compass hit", () => {
    expect(parseDirectionalScope(makeAlert({ title: "Bus detour on 97 Yonge" }))).toBe("both");
  });

  it("parses the WB abbreviation as westbound", () => {
    expect(parseDirectionalScope(makeAlert({ description: "WB disruption on 504" }))).toBe(
      "westbound",
    );
  });

  it("treats east/west slash form as both", () => {
    expect(
      parseDirectionalScope(makeAlert({ title: "504 King: east/west service affected" })),
    ).toBe("both");
  });

  it("parses 'North' from a NextBus-style headsign in the title", () => {
    expect(
      parseDirectionalScope(makeAlert({ title: "North - 510 Spadina towards Spadina Station" })),
    ).toBe("northbound");
  });

  it("parses NB abbreviation as northbound", () => {
    expect(parseDirectionalScope(makeAlert({ description: "NB delays on 97 Yonge" }))).toBe(
      "northbound",
    );
  });

  it("parses SB abbreviation as southbound", () => {
    expect(parseDirectionalScope(makeAlert({ description: "SB delays on 97 Yonge" }))).toBe(
      "southbound",
    );
  });

  it.each([
    ["French southbound phrase", "Retards en direction du sud sur la ligne 97", "southbound"],
    ["French abbreviated southbound phrase", "Service interrompu en direction sud", "southbound"],
    ["French abbreviated northbound phrase", "Service interrompu en direction nord", "northbound"],
    ["French abbreviated eastbound phrase", "Service interrompu en direction est", "eastbound"],
    ["French abbreviated westbound phrase", "Service interrompu en direction ouest", "westbound"],
    ["French eastbound phrase with straight apostrophe", "Détour vers l'est", "eastbound"],
    ["French eastbound phrase with curly apostrophe", "Détour vers l’est", "eastbound"],
    ["French westbound phrase", "Retards en direction de l'ouest", "westbound"],
    ["French northbound phrase", "Service dévié vers le nord", "northbound"],
    ["French explicit both-directions phrase", "Service touché dans les deux sens", "both"],
    ["French north-south pair", "Travaux sur l'axe nord-sud", "both"],
    ["English eastbound phrase remains supported", "Eastbound delays on route 97", "eastbound"],
  ] as const)("recognizes %s", (_label, title, expected) => {
    expect(parseDirectionalScope(makeAlert({ title }))).toBe(expected);
  });

  it.each([
    ["a station name containing a compass word", "Detour near Dundas West Station"],
    ["a place name containing north", "Delays at North York Centre"],
    ["an unqualified compass word", "West delays on 504 King"],
    ["French copula est", "Le service est interrompu près de la station centrale"],
    ["French intercardinal southwest", "Service interrompu vers le sud-ouest"],
    ["French intercardinal northeast", "Service interrompu en direction du nord-est"],
    ["a malformed French east phrase", "Le service est ralenti en direction estival"],
    ["a malformed French south phrase", "Travaux vers sud sur la ligne 97"],
    ["a southern location", "Travaux au sud de la station centrale"],
    ["a station name containing sud", "Détour près de Sudbury Station"],
    ["an English partial compass word", "Delay near Eastwood Station"],
  ] as const)("does not infer a directional scope from %s", (_label, title) => {
    expect(parseDirectionalScope(makeAlert({ title }))).toBe("both");
  });

  it.each([
    ["a heading phrase", "Route 97 heading west", "westbound"],
    ["a travel phrase", "Route 97 is travelling east", "eastbound"],
    ["a hyphenated bound word", "East-bound service on Route 97", "eastbound"],
    ["spacing within a bound phrase", "East  bound service on Route 97", "eastbound"],
    ["a NextBus direction title", "North - 510 Spadina towards Spadina Station", "northbound"],
  ] as const)("recognizes %s as directional", (_label, title, expected) => {
    expect(parseDirectionalScope(makeAlert({ title }))).toBe(expected);
  });
});

describe("formatDirectionalChip", () => {
  it("formats all supported scopes as bracket chips", () => {
    expect(formatDirectionalChip("eastbound")).toBe("[Eastbound]");
    expect(formatDirectionalChip("westbound")).toBe("[Westbound]");
    expect(formatDirectionalChip("northbound")).toBe("[Northbound]");
    expect(formatDirectionalChip("southbound")).toBe("[Southbound]");
    expect(formatDirectionalChip("both")).toBe("[Both Directions]");
  });
});

describe("sortSurfaceAlerts", () => {
  it("sorts severe alerts before degraded alerts", () => {
    const severe = makeAlert({ id: "severe_1", severity: "severe" });
    const degraded = makeAlert({ id: "degraded_1", severity: "degraded" });
    expect(sortSurfaceAlerts([degraded, severe]).map((a) => a.id)).toEqual([
      "severe_1",
      "degraded_1",
    ]);
  });

  it("breaks severity ties by most recently updated first", () => {
    const older = makeAlert({ id: "older_1", updatedAt: now - 10_000 });
    const newer = makeAlert({ id: "newer_1", updatedAt: now });
    expect(sortSurfaceAlerts([older, newer]).map((a) => a.id)).toEqual(["newer_1", "older_1"]);
  });

  it("does not mutate the input array", () => {
    const input = [makeAlert({ id: "a" }), makeAlert({ id: "b" })];
    const originalOrder = input.map((a) => a.id);
    sortSurfaceAlerts(input);
    expect(input.map((a) => a.id)).toEqual(originalOrder);
  });
});

describe("toggleAlertId", () => {
  it.each([
    ["adds an absent id", new Set(["a"]), "b", ["a", "b"]],
    ["removes a present id", new Set(["a", "b"]), "a", ["b"]],
    ["adds an id to an empty set", new Set(), "only", ["only"]],
  ])("%s", (_label, input, id, expected) => {
    const next = toggleAlertId(input as Set<string>, id);
    expect(next).toEqual(new Set(expected));
  });

  it("returns a fresh set, never mutating its input, and toggling twice round-trips", () => {
    const input = new Set(["x"]);
    const added = toggleAlertId(input, "y");
    expect(added).not.toBe(input);
    expect(input.has("y")).toBe(false);

    const removed = toggleAlertId(added, "y");
    expect([...removed]).toEqual(["x"]);
  });
});

describe("matchAlertsForRoute boundary matching and accessibility filtering", () => {
  it.each([
    ["start of title", "97 Yonge: Construction delays", "97", true],
    ["end of title/string", "Delay on the 25", "25", true],
    ["explicit 'route N' form", "Heavy traffic on route 97", "97", true],
    ["followed by mode suffix", "25 bus detour via Lawrence", "25", true],
    ["embedded inside larger number", "125 Don Mills Rd: Construction delays", "25", false],
    ["multi-route corridor substring", "506/106 Carlton: Signal issue", "6", false],
    ["3-digit prefix overlap", "141 Downview: Buses rerouted", "41", false],
    ["1510 vs 510", "1510 Don Mills: Bus rerouted", "510", false],
  ])("matches %s correctly: '%s' for route %s -> %s", (_case, text, routeId, shouldMatch) => {
    const alerts = [makeAlert({ title: text, description: text })];
    const matched = matchAlertsForRoute(routeId, alerts);
    expect(matched.length > 0).toBe(shouldMatch);
  });

  it("excludes alerts with kind accessibility even if route number matches", () => {
    const alerts = [
      makeAlert({
        id: "alert-service",
        title: "504 King: Streetcar detour via Queen",
        kind: "delay",
      }),
      makeAlert({
        id: "alert-elevator",
        title:
          "Elevator Alert: Broadview Station - Line 2 to 504 King platform elevator out of service",
        kind: "accessibility",
      }),
    ];
    const matched = matchAlertsForRoute("504", alerts);
    expect(matched).toHaveLength(1);
    expect(matched[0].id).toBe("alert-service");
  });

  it("requires resolved route attribution for trip-scoped cancellation notices", () => {
    const unresolved = makeAlert({
      id: "unresolved-trip-cancel",
      title: "7:45 PM County Park trips cancelled",
      scope: "trip",
      affectedRouteIds: undefined,
    });
    const resolved = makeAlert({
      id: "resolved-trip-cancel",
      title: "7:45 PM County Park trips cancelled",
      scope: "trip",
      affectedRouteIds: ["12"],
    });

    expect(matchAlertsForRoute("7", [unresolved, resolved])).toEqual([]);
    expect(matchAlertsForRoute("12", [unresolved, resolved]).map((alert) => alert.id)).toEqual([
      "resolved-trip-cancel",
    ]);
    expect(matchAlertsForSubscribedRoute("7", [unresolved, resolved])).toEqual([]);
    expect(
      matchAlertsForSubscribedRoute("12", [unresolved, resolved]).map((alert) => alert.id),
    ).toEqual(["resolved-trip-cancel"]);
  });

  it("does not put upcoming work into an active route banner", () => {
    const matched = matchAlertsForRoute("97", [
      makeAlert({
        id: "future-97",
        kind: "upcoming",
        lifecycle: "upcoming",
        affectedRouteIds: ["97"],
        title: "97 planned diversion",
      }),
    ]);

    expect(matched).toEqual([]);
  });

  it("does not match a route-shaped number in text when structured routeIds attribute the alert elsewhere", () => {
    // Route chips stay strict — a Line 1
    // alert whose text mentions "97" (the fixture's "97 Yonge" title) never
    // surfaces under route 97 via text. Text-rescue lives only on
    // matchAlertsForSubscribedRoute, the favourite/notification seam.
    const alerts = [makeAlert({ id: "subway-1", affectedRouteIds: ["1"] })];
    expect(matchAlertsForRoute("97", alerts)).toHaveLength(0);
  });

  it("matches an attributed alert whose text never mentions the queried route", () => {
    const alerts = [
      makeAlert({
        id: "surface-97",
        title: "Yonge St: Construction delays",
        description: "North of Eglinton",
        affectedRouteIds: ["97"],
      }),
    ];
    const matched = matchAlertsForRoute("97", alerts);
    expect(matched).toHaveLength(1);
    expect(matched[0].id).toBe("surface-97");
  });

  it("applies the declared route rule to query IDs and stored attribution tokens", () => {
    const normalization = {
      stripPrefix: "rapid",
      extractPattern: "\\b([78])\\b",
    };
    const alerts = [
      makeAlert({
        id: "rapid7-attributed",
        title: "Rapid 7 disruption",
        affectedRouteIds: ["7"],
      }),
      makeAlert({
        id: "rapid8-attributed",
        title: "Rapid 8 disruption",
        affectedRouteIds: ["8"],
      }),
    ];
    expect(matchAlertsForRoute("Rapid 7", alerts, normalization).map((a) => a.id)).toEqual([
      "rapid7-attributed",
    ]);
    expect(matchAlertsForRoute("Rapid 8", alerts, normalization).map((a) => a.id)).toEqual([
      "rapid8-attributed",
    ]);
  });

  it("still falls back to text matching when routeIds is present but empty", () => {
    const alerts = [makeAlert({ id: "unattributed", affectedRouteIds: [] })];
    expect(matchAlertsForRoute("97", alerts)).toHaveLength(1);
  });

  it("excludes an attributed alert via its accessibility kind even when affectedRouteIds match", () => {
    // Equipment outages (elevators, escalators) are always classified
    // kind:"accessibility" by ingest, so the kind check subsumes the old
    // structural equipmentOutages exclusion at the Agency contract boundary.
    const alerts = [
      makeAlert({
        id: "attributed-excluded",
        title: "Service advisory",
        kind: "accessibility",
        affectedRouteIds: ["97"],
      }),
    ];
    expect(matchAlertsForRoute("97", alerts)).toHaveLength(0);
  });
});

describe("matchAlertsForSubscribedRoute (notification-seam rescue)", () => {
  it("matches an attributed alert whose structured tokens cover the queried route", () => {
    const alerts = [
      makeAlert({ id: "surface-97", title: "Yonge St closure", affectedRouteIds: ["97"] }),
    ];
    const matched = matchAlertsForSubscribedRoute("97", alerts);
    expect(matched).toHaveLength(1);
    expect(matched[0].id).toBe("surface-97");
  });

  it("rescues a favourited route by title text when structured attribution misses", () => {
    // Notification recall: ingest attributed this severe suspension to route
    // 999 only; the subscriber's favourited 504 appears solely in its title.
    const alerts = [
      makeAlert({
        id: "misattributed-suspension",
        kind: "suspension",
        severity: "severe",
        affectedRouteIds: ["999"],
        title: "504 King: Service suspended both directions",
      }),
    ];
    const matched = matchAlertsForSubscribedRoute("504", alerts);
    expect(matched).toHaveLength(1);
    expect(matched[0].id).toBe("misattributed-suspension");
  });

  it("keeps chip strictness out of the rescue path: an attributed-miss alert naming the route via elevator text stays excluded", () => {
    // Attribution misses toward route 97 and the text names "97 Yonge", but
    // the accessibility secondary filter must hold on the notification path
    // too — elevator outages never page surface-route subscribers.
    const alerts = [
      makeAlert({
        id: "attributed-elevator",
        affectedRouteIds: ["1"],
        title: "97 Yonge station: Elevator outage on the concourse level",
      }),
    ];
    expect(matchAlertsForSubscribedRoute("97", alerts)).toHaveLength(0);
  });

  it("still text-matches unattributed alerts exactly like the strict matcher", () => {
    const alerts = [makeAlert({ id: "unattributed-delay", affectedRouteIds: [] })];
    expect(matchAlertsForSubscribedRoute("97", alerts)).toHaveLength(1);
  });
});
