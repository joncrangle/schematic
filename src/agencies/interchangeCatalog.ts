import newYork from "./us/ny/interchanges.jsonc";
import manitoba from "./ca/mb/interchanges.jsonc";
import "../types/jsonc.d.ts";
import newBrunswick from "./ca/nb/interchanges.jsonc";
import alberta from "./ca/ab/interchanges.jsonc";
import britishColumbia from "./ca/bc/interchanges.jsonc";
import novaScotia from "./ca/ns/interchanges.jsonc";
import national from "./ca/nat/interchanges.jsonc";
import quebec from "./ca/qc/interchanges.jsonc";
import ontario from "./ca/on/interchanges.jsonc";
import unitedStatesNational from "./us/nat/interchanges.jsonc";

/** Explicit generated artifacts only. Regions without hubs need no entry. */
export const interchangeCatalog: readonly {
  readonly regionPath: string;
  readonly hubs: unknown;
}[] = [
  { regionPath: "ca/on", hubs: ontario },
  { regionPath: "ca/qc", hubs: quebec },
  { regionPath: "ca/bc", hubs: britishColumbia },
  { regionPath: "ca/nat", hubs: national },
  { regionPath: "ca/ns", hubs: novaScotia },
  { regionPath: "ca/ab", hubs: alberta },
  { regionPath: "ca/nb", hubs: newBrunswick },
  { regionPath: "ca/mb", hubs: manitoba },
  { regionPath: "us/nat", hubs: unitedStatesNational },
  { regionPath: "us/ny", hubs: newYork },
];
