import type { Point } from "~/core/map";
import type { InterchangeStationReference } from "~/domain/map/Interchange";
import type { SchematicStationId } from "~/agencies/types";

export interface InterchangeFocus {
  readonly agencyId: string;
  readonly stationId: SchematicStationId;
  readonly stationName: string;
  readonly origin: InterchangeStationReference;
  /** Rendered scale, independent of either agency's schematic viewBox. */
  readonly screenScale: number;
  /** Current container position of the source interchange station. */
  readonly screenPosition?: Point;
}

export interface InterchangeNavigationOptions {
  readonly setTemporaryAgency: (focus: InterchangeFocus) => void;
  readonly setFocus: (focus: InterchangeFocus) => void;
}

/** Coordinates destination focus with a temporary agency view. */
export function createInterchangeNavigation(options: InterchangeNavigationOptions) {
  return (focus: InterchangeFocus): void => {
    options.setFocus(focus);
    options.setTemporaryAgency(focus);
  };
}
