import { getAgencyById } from "~/agencies";

/**
 * Shared HTTP composition for agency-scoped GET endpoints.
 *
 * `SnapshotEndpoint` and `RoutesCatalogEndpoint` grew the same agency-id
 * parsing, no-store error JSON, and HEAD-mirror helpers independently; new
 * endpoints ride these instead of copying them. Per-endpoint cache TTLs,
 * diagnostics headers, and body shapes stay local. Only the transport
 * boilerplate is shared.
 */

export function endpointError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export function endpointErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Trims and requires the `:agencyId` path segment; throws a 400 on garbage. */
export function parseAgencyIdParam(raw: unknown): string {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) throw endpointError(400, "Missing or invalid agencyId parameter");
  return id;
}

/** Trims and requires the `:stationId` path segment; throws a 400 on garbage. */
export function parseStationIdParam(raw: unknown): string {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) throw endpointError(400, "Missing or invalid stationId parameter");
  return id;
}

export function noStoreJson(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Returns true for agency ids the registry declares. */
export function isKnownAgency(agencyId: string): boolean {
  return getAgencyById(agencyId) !== undefined;
}

/** True when the agency's station index lists the id as a schematic or index station. */
export function isKnownStation(agencyId: string, stationId: string): boolean {
  return (
    getAgencyById(agencyId)?.schematic?.stationIndex?.some(
      (station) => station.id === stationId || station.schematicId === stationId,
    ) ?? false
  );
}

/** HEAD mirrors GET status/headers with no response body. */
export function headFromGet(getResponse: Response): Response {
  const headers = new Headers(getResponse.headers);
  return new Response(null, { status: getResponse.status, headers });
}
