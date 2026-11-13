import * as Schema from "effect/Schema";
import { networkDocumentFeed } from "~/domain/realtimeFeedRouting";

import {
  AgencyManifestSchema,
  AlertSourceSchema,
  RealtimeFeedConfigSchema,
  SchematicSchema,
  StaticTopologySourceSchema,
  type AgencyProvider,
} from "./types";

/**
 * Fail-fast registration validation: every schema-backed
 * region of a provider is decoded through its Effect Schema when the provider
 * registers, dev, CI, and prod startup all fail loudly instead of shipping a
 * malformed agency to the wire.
 */
export function validateProvider(provider: AgencyProvider): void {
  const id = typeof provider.manifest?.id === "string" ? provider.manifest.id : "<unnamed>";

  const manifest = Schema.decodeUnknownSync(AgencyManifestSchema);
  assertRegion(id, "manifest", () => manifest(provider.manifest));

  const topology = Schema.decodeUnknownSync(StaticTopologySourceSchema);
  assertRegion(id, "staticTopology", () => topology(provider.staticTopology));

  const decodeFeedConfig = Schema.decodeUnknownSync(RealtimeFeedConfigSchema);

  const feeds = provider.realtime?.feeds ?? [];
  for (const [index, feedConfig] of feeds.entries()) {
    assertRegion(id, `realtime.feeds[${index}]`, () =>
      networkDocumentFeed(decodeFeedConfig(feedConfig)),
    );
  }

  const decodeAlertSource = Schema.decodeUnknownSync(AlertSourceSchema);
  for (const [index, source] of (provider.alerts ?? []).entries()) {
    assertRegion(id, `alerts[${index}]`, () => decodeAlertSource(source));
  }

  if (provider.schematic) {
    const schematic = Schema.decodeUnknownSync(SchematicSchema);
    assertRegion(id, "schematic", () => schematic(provider.schematic));
  }
}

function assertRegion(id: string, section: string, decode: () => unknown): void {
  try {
    decode();
  } catch (error) {
    throw new Error(`Agency provider "${id}" failed ${section} contract validation`, {
      cause: error,
    });
  }
}
