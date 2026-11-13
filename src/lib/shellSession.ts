import { createMemo, createSignal, flush, type Accessor } from "solid-js";
import type { Coordinates } from "~/domain/location/locationLadder";
import type { RouteDirection, RouteEnlargeRequest } from "~/lib/routeTrackingLifecycle";

export type SheetTab = "alerts" | "upcoming";

export interface TargetedRouteState extends RouteEnlargeRequest {
  readonly nearestAnchorCoords: Coordinates | null;
}

export interface ShellSessionFocus {
  captureTargetedInvoker(element: HTMLElement): void;
  restoreFocusAfterTargetedExit(expandedRouteId?: string | null): void;
}

export interface ShellSession {
  readonly activeSheet: Accessor<SheetTab | null>;
  readonly isSettingsOpen: Accessor<boolean>;
  readonly isAgencyPickerOpen: Accessor<boolean>;
  readonly targetedRoute: Accessor<TargetedRouteState | null>;
  readonly nearbyOpen: Accessor<boolean>;
  readonly expandedRouteId: Accessor<string | null>;
  readonly routeDirections: Accessor<ReadonlyMap<string, readonly RouteDirection[]>>;
  openSheet(tab: SheetTab): void;
  closeSheet(): void;
  openSettings(): void;
  closeSettings(): void;
  openAgencyPicker(): void;
  closeAgencyPicker(): void;
  toggleNearby(): void;
  setNearbyOpen(open: boolean): void;
  toggleExpandRoute(routeId: string): void;
  selectRouteDirection(routeId: string, directionId: number): void;
  enterTargetedRoute(request: RouteEnlargeRequest): void;
  exitTargetedRoute(): void;
  captureTargetedInvoker(element: HTMLElement): void;
  restoreFocusAfterTargetedExit(): void;
}

export interface ShellSessionOptions {
  readonly getNearestAnchorCoords?: () => Coordinates | null;
  readonly focus?: ShellSessionFocus;
  readonly networkId?: Accessor<string | undefined>;
}

const routeKey = (request: RouteEnlargeRequest): string => `${request.agencyId}:${request.routeId}`;

const sameTarget = (current: TargetedRouteState | null, request: RouteEnlargeRequest): boolean =>
  current !== null &&
  current.agencyId === request.agencyId &&
  current.routeId === request.routeId &&
  current.directionId === request.directionId &&
  current.stopId === request.stopId;

/**
 * The App Shell's single coordination state owner. It deliberately contains
 * no component imports: presentation adapters receive this seam and expose
 * the same accessors/commands to their children.
 */
export function createShellSession(options: ShellSessionOptions = {}): ShellSession {
  // ---- Signal definitions ----
  // Session signals accept writes from owned scopes (component setup).
  const [activeSheet, setActiveSheet] = createSignal<SheetTab | null>(null, { ownedWrite: true });
  const [isSettingsOpen, setSettingsOpen] = createSignal(false, { ownedWrite: true });
  const [isAgencyPickerOpen, setAgencyPickerOpen] = createSignal(false, { ownedWrite: true });
  // A changed or unresolved network ends targeted mode. Returning to a network
  // gets a fresh context so its old route intent cannot reappear.
  const targetedContext = createMemo<{ networkId: string | undefined } | null>(
    (previous = null) => {
      const networkId = options.networkId?.();
      if (options.networkId && !networkId) return null;
      if (previous && previous.networkId === networkId) return previous;
      return { networkId };
    },
  );
  const [targetedIntent, setTargetedIntent] = createSignal<{
    context: object;
    route: TargetedRouteState;
  } | null>(null, { ownedWrite: true });
  const targetedRoute = createMemo(() => {
    const intent = targetedIntent();
    return intent?.context === targetedContext() ? intent.route : null;
  });
  const [nearbyOpen, setNearbyOpenSignal] = createSignal(false, { ownedWrite: true });
  const [expandedRouteId, setExpandedRouteId] = createSignal<string | null>(null, {
    ownedWrite: true,
  });
  const [routeDirections, setRouteDirections] = createSignal<
    ReadonlyMap<string, readonly RouteDirection[]>
  >(new Map(), { ownedWrite: true });

  let returnNearbyOnTargetedExit = false;

  // ---- Overlay commands ----
  const closeOverlays = () => {
    setActiveSheet(null);
    setSettingsOpen(false);
    setAgencyPickerOpen(false);
  };

  const setNearbyOpen = (open: boolean) => {
    if (open && targetedRoute() !== null) return;
    if (open) closeOverlays();
    setNearbyOpenSignal(open);
  };

  const openSheet = (tab: SheetTab) => {
    closeOverlays();
    setNearbyOpenSignal(false);
    setActiveSheet(tab);
  };

  const closeSheet = () => setActiveSheet(null);

  const openSettings = () => {
    closeOverlays();
    setNearbyOpenSignal(false);
    setSettingsOpen(true);
  };

  const closeSettings = () => setSettingsOpen(false);

  const openAgencyPicker = () => {
    closeOverlays();
    setNearbyOpenSignal(false);
    setAgencyPickerOpen(true);
  };

  const closeAgencyPicker = () => setAgencyPickerOpen(false);

  const toggleNearby = () => setNearbyOpen(!nearbyOpen());

  // ---- Targeted-route commands ----
  const selectRouteDirection = (routeId: string, directionId: number) => {
    setRouteDirections((previous) => {
      const next = new Map(previous);
      next.set(routeId, [{ routeId, directionId }]);
      return next;
    });
  };

  const toggleExpandRoute = (routeId: string) => {
    if (targetedRoute() !== null) return;
    setExpandedRouteId((previous) => (previous === routeId ? null : routeId));
  };

  const enterTargetedRoute = (request: RouteEnlargeRequest) => {
    const context = targetedContext();
    if (!context) return;
    if (sameTarget(targetedRoute(), request)) return;

    const current = targetedRoute();
    returnNearbyOnTargetedExit = current ? returnNearbyOnTargetedExit : nearbyOpen();
    const key = routeKey(request);
    setExpandedRouteId(key);
    selectRouteDirection(key, request.directionId);
    setTargetedIntent({
      context,
      route: {
        ...request,
        nearestAnchorCoords: options.getNearestAnchorCoords?.() ?? null,
      },
    });
    closeOverlays();
    setNearbyOpenSignal(false);
  };

  const restoreFocusAfterTargetedExit = () =>
    options.focus?.restoreFocusAfterTargetedExit(expandedRouteId());

  const exitTargetedRoute = () => {
    const current = targetedRoute();
    if (!current) return;

    const returnNearby = returnNearbyOnTargetedExit;
    returnNearbyOnTargetedExit = false;

    // Imperative boundary: the focus handoff below must observe the
    // just-written route and expansion state, so commit synchronously
    // instead of leaving it staged for the microtask.
    flush(() => {
      setTargetedIntent(null);
      setExpandedRouteId(routeKey(current));
      if (returnNearby) {
        closeOverlays();
        setNearbyOpenSignal(true);
      } else {
        setNearbyOpenSignal(false);
      }
    });
    restoreFocusAfterTargetedExit();
  };

  const captureTargetedInvoker = (element: HTMLElement) =>
    options.focus?.captureTargetedInvoker(element);

  const session: ShellSession = {
    activeSheet,
    isSettingsOpen,
    isAgencyPickerOpen,
    targetedRoute,
    nearbyOpen,
    expandedRouteId,
    routeDirections,
    openSheet,
    closeSheet,
    openSettings,
    closeSettings,
    openAgencyPicker,
    closeAgencyPicker,
    toggleNearby,
    setNearbyOpen,
    toggleExpandRoute,
    selectRouteDirection,
    enterTargetedRoute,
    exitTargetedRoute,
    captureTargetedInvoker,
    restoreFocusAfterTargetedExit,
  };

  return session;
}
