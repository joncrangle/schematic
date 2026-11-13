import type { Accessor } from "solid-js";
import type { AgencySession } from "~/services/session/AgencySession";
import type { EffectiveAgencySnapshot } from "~/domain/location/EffectiveAgency";
import { makeTestProvider } from "./agency-fixtures";
import type { BrowserAgency } from "~/agencies/types";

function lookupAgency(id: string): BrowserAgency {
  return makeTestProvider({ id });
}

export interface MockAgencySessionOptions {
  agencyId?: string;
  snapshot?: Partial<EffectiveAgencySnapshot>;
}

export function createMockAgencySession(opts: MockAgencySessionOptions = {}): AgencySession {
  const agencyId = opts.snapshot?.agencyId ?? opts.agencyId ?? "sample";
  const snapshotBase: EffectiveAgencySnapshot = {
    fix: opts.snapshot?.fix ?? { latitude: 43.65, longitude: -79.38, timestamp: 0 },
    source: opts.snapshot?.source ?? "gps",
    status: opts.snapshot?.status ?? "granted",
    automaticAgencyId: opts.snapshot?.automaticAgencyId ?? agencyId,
    agencyId: opts.snapshot?.agencyId ?? agencyId,
    declaredCoveringIds: opts.snapshot?.declaredCoveringIds ?? [agencyId],
    coveringIds: opts.snapshot?.coveringIds ?? [agencyId],
    stationCoveringIds: opts.snapshot?.stationCoveringIds ?? [],
  };

  const snapshot: Accessor<EffectiveAgencySnapshot> = () => snapshotBase;

  const displayedAgencyId: Accessor<string> = () => agencyId;
  const baseAgency: Accessor<BrowserAgency> = () => lookupAgency(agencyId);
  const displayedAgency: Accessor<BrowserAgency> = () => lookupAgency(displayedAgencyId());

  return {
    displayedAgency,
    displayedAgencyId,
    baseAgency,
    isTemporary: () => false,
    temporaryOrigin: () => undefined,
    snapshot,
    selectAgency: () => {},
    navigateToInterchange: () => {},
    clearTemporaryView: () => {},
    dispose: () => {},
  };
}

export function createReactiveMockAgencySession(
  getAgencyId: Accessor<string>,
  opts: {
    getSnapshot?: Accessor<EffectiveAgencySnapshot>;
    isTemporary?: Accessor<boolean>;
    selectAgency?: AgencySession["selectAgency"];
    navigateToInterchange?: AgencySession["navigateToInterchange"];
    clearTemporaryView?: AgencySession["clearTemporaryView"];
  } = {},
): AgencySession {
  const snapshot: Accessor<EffectiveAgencySnapshot> =
    opts.getSnapshot ??
    (() =>
      ({
        fix: null,
        source: "default",
        status: "idle",
        automaticAgencyId: getAgencyId(),
        agencyId: getAgencyId(),
        declaredCoveringIds: [],
        coveringIds: [],
        stationCoveringIds: [],
      }) as EffectiveAgencySnapshot);

  return {
    displayedAgencyId: getAgencyId,
    displayedAgency: (() => lookupAgency(getAgencyId())) as Accessor<BrowserAgency>,
    baseAgency: (() => lookupAgency(getAgencyId())) as Accessor<BrowserAgency>,
    isTemporary: opts.isTemporary ?? (() => false),
    temporaryOrigin: () => undefined,
    snapshot,
    selectAgency: opts.selectAgency ?? (() => {}),
    navigateToInterchange: opts.navigateToInterchange ?? (() => {}),
    clearTemporaryView: opts.clearTemporaryView ?? (() => {}),
    dispose: () => {},
  };
}
