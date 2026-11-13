import { createContext, useContext, type ParentProps } from "solid-js";
import type { ShellSession } from "~/lib/shellSession";
import type { RouteDirection } from "~/lib/routeTrackingLifecycle";
import type { NearbyFocusAdapter } from "~/components/nearby/nearbyFocus";

export interface NearbyCoordination {
  readonly nearbyOpen: () => boolean;
  readonly setNearbyOpen: (open: boolean) => void;
  readonly toggleNearby: () => void;
  readonly expandedRouteId: () => string | null;
  readonly toggleExpandRoute: (routeId: string) => void;
  readonly routeDirections: () => ReadonlyMap<string, readonly RouteDirection[]>;
  readonly selectRouteDirection: (routeId: string, directionId: number) => void;
  readonly captureTargetedInvoker: (element: HTMLElement) => void;
  readonly restoreFocusAfterTargetedExit: () => void;
  readonly registerTriggerElement: (element: HTMLButtonElement | undefined) => void;
  readonly registerCloseControl: (element: HTMLButtonElement | undefined) => void;
  readonly registerFirstActionable: (routeId: string, element: HTMLElement | undefined) => void;
}

export function createNearbyCoordination(
  session: ShellSession,
  focus: NearbyFocusAdapter,
): NearbyCoordination {
  return {
    nearbyOpen: session.nearbyOpen,
    setNearbyOpen: session.setNearbyOpen,
    toggleNearby: session.toggleNearby,
    expandedRouteId: session.expandedRouteId,
    toggleExpandRoute: session.toggleExpandRoute,
    routeDirections: session.routeDirections,
    selectRouteDirection: session.selectRouteDirection,
    captureTargetedInvoker: session.captureTargetedInvoker,
    restoreFocusAfterTargetedExit: session.restoreFocusAfterTargetedExit,
    registerTriggerElement: focus.registerTriggerElement,
    registerCloseControl: focus.registerCloseControl,
    registerFirstActionable: focus.registerFirstActionable,
  };
}

const NearbyCoordinationContext = createContext<NearbyCoordination | null>(null);

export function NearbyCoordinationProvider(props: ParentProps & { value: NearbyCoordination }) {
  return (
    <NearbyCoordinationContext value={props.value}>{props.children}</NearbyCoordinationContext>
  );
}

export function useNearbyCoordination(): NearbyCoordination {
  const context = useContext(NearbyCoordinationContext);
  if (!context) {
    throw new Error("useNearbyCoordination must be used within a NearbyCoordinationProvider");
  }
  return context;
}
