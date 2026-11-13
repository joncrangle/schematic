import { createMemo, createSignal, type Accessor } from "solid-js";
import type { BrowserAgency } from "~/agencies/types";
import {
  effectivePoint,
  resolveEffectiveAgency,
  type EffectiveAgencySnapshot,
} from "~/domain/location/EffectiveAgency";
import type { LocationLadder } from "~/domain/location/locationLadder";
import type { InterchangeFocus } from "~/components/map/interchange-navigation";
import type { InterchangeStationReference } from "~/domain/map/Interchange";
import type { AgencySelection } from "~/domain/preferences/UserPreferences";

export interface AgencySession {
  /** The agency currently displayed on screen (temporary interchange if active, else base). */
  readonly displayedAgency: Accessor<BrowserAgency | undefined>;
  /** The displayed agency's ID. */
  readonly displayedAgencyId: Accessor<string | undefined>;
  /** The base agency derived from location ladder or user preference. */
  readonly baseAgency: Accessor<BrowserAgency | undefined>;
  /** Whether the user is currently viewing an ephemeral interchange navigation. */
  readonly isTemporary: Accessor<boolean>;
  /** Origin station reference to return to when dismissing the temporary view. */
  readonly temporaryOrigin: Accessor<InterchangeStationReference | undefined>;
  /** Full location ladder snapshot (coordinates, fix source, covering IDs). */
  readonly snapshot: Accessor<EffectiveAgencySnapshot>;
  /** Actions */
  readonly selectAgency: (selection: AgencySelection) => void;
  readonly navigateToInterchange: (focus: InterchangeFocus) => void;
  readonly clearTemporaryView: () => void;
  readonly dispose: () => void;
}

export interface AgencySessionDeps {
  /** Providers seam, owned by the composition root. */
  readonly providers: () => readonly BrowserAgency[];
  /** Current user selection, owned by the composition root. */
  readonly selection: () => AgencySelection;
  /** Optional persistence callback for picker selections. */
  readonly setSelection?: (selection: AgencySelection) => void;
  /** Required location adapter; the ladder owns location state and expiry. */
  readonly locationLadder: LocationLadder;
  /** Optional capability seam for server/provider-specific station ports. */
  readonly hasStationsSource?: (id: string) => boolean;
}

export function createAgencySession(deps: AgencySessionDeps): AgencySession & { dispose(): void } {
  let previousAutomaticId: string | undefined;

  const [temporaryAgencyId, setTemporaryAgencyId] = createSignal<string | undefined>(undefined, {
    ownedWrite: true,
  });
  const [temporaryOrigin, setTemporaryOrigin] = createSignal<
    InterchangeStationReference | undefined
  >(undefined, { ownedWrite: true });

  const resolve = (selectionOverride?: AgencySelection): EffectiveAgencySnapshot => {
    const { fix, source } = deps.locationLadder.effectiveFix();
    const status = deps.locationLadder.status();
    const snap = resolveEffectiveAgency({
      point: effectivePoint(fix, source),
      fix,
      selection: selectionOverride ?? deps.selection(),
      previousAutomatic: previousAutomaticId,
      locationState: { status, source },
      providers: deps.providers(),
      hasStationsSource: deps.hasStationsSource,
    });
    previousAutomaticId = snap.automaticAgencyId;
    return snap;
  };

  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const [localSelection, setLocalSelection] = createSignal<AgencySelection | undefined>(undefined, {
    ownedWrite: true,
  });
  // Preferences load after hydration. Reading selection here restores a saved
  // manual network without waiting for a location event.
  const snapshot = createMemo(() => {
    revision();
    return resolve(localSelection() ?? deps.selection());
  });

  let disposed = false;
  const unsubscribeLocation = deps.locationLadder.subscribe(() => {
    if (disposed) return;
    setRevision((value) => value + 1);
  });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribeLocation();
  };

  const lookupAgency = (id: string | undefined): BrowserAgency | undefined =>
    deps.providers().find((p) => p.manifest.id === id);

  const baseAgency: Accessor<BrowserAgency | undefined> = createMemo(() => {
    const snap = snapshot();
    return lookupAgency(snap.agencyId);
  });

  const displayedAgencyId: Accessor<string | undefined> = createMemo(
    () => temporaryAgencyId() ?? snapshot().agencyId,
  );

  const displayedAgency: Accessor<BrowserAgency | undefined> = createMemo(() => {
    const tmp = temporaryAgencyId();
    if (tmp !== undefined) {
      return lookupAgency(tmp) ?? baseAgency();
    }
    return baseAgency();
  });

  const isTemporary: Accessor<boolean> = createMemo(() => temporaryAgencyId() !== undefined);

  const navigateToInterchange = (focus: InterchangeFocus): void => {
    if (disposed) return;
    const currentOrigin = temporaryOrigin();
    const origin = currentOrigin ?? focus.origin;
    const target: InterchangeStationReference = {
      agencyId: focus.agencyId,
      stationId: focus.stationId,
    };
    if (target.agencyId === origin.agencyId || target.agencyId === baseAgency()?.manifest.id) {
      setTemporaryAgencyId(undefined);
      setTemporaryOrigin(undefined);
      return;
    }
    setTemporaryAgencyId(target.agencyId);
    setTemporaryOrigin(origin);
  };

  const clearTemporaryView = (): void => {
    if (disposed) return;
    setTemporaryAgencyId(undefined);
    setTemporaryOrigin(undefined);
  };

  const selectAgency = (selection: AgencySelection): void => {
    if (disposed) return;
    clearTemporaryView();
    if (deps.setSelection) deps.setSelection(selection);
    else setLocalSelection(selection);
    setRevision((value) => value + 1);
  };

  return {
    displayedAgency,
    displayedAgencyId,
    baseAgency,
    isTemporary,
    temporaryOrigin,
    snapshot,
    selectAgency,
    navigateToInterchange,
    clearTemporaryView,
    dispose,
  };
}
