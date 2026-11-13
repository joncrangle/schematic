import type { BrowserAgency } from "~/agencies/types";
import { buildMapModel, type MapModel } from "~/core/map";
import { loadSchematic, peekSchematic } from "~/services/schematic/SchematicLoader";

export const DEFAULT_TOPOLOGY_CACHE_SIZE = 3;
export const MAX_WARMED_SCHEMATICS = DEFAULT_TOPOLOGY_CACHE_SIZE;

export interface MapModelCache {
  readonly getOrCreate: (id: string, create: () => MapModel) => MapModel;
}

function createMapModelCache(maxEntries: number): MapModelCache {
  const limit = Math.max(1, Math.floor(maxEntries));
  const entries = new Map<string, MapModel>();
  return {
    getOrCreate(id, create) {
      const cached = entries.get(id);
      if (cached) {
        entries.delete(id);
        entries.set(id, cached);
        return cached;
      }
      const model = create();
      entries.set(id, model);
      while (entries.size > limit) {
        const oldestId = entries.keys().next().value;
        if (oldestId === undefined) break;
        entries.delete(oldestId);
      }
      return model;
    },
  };
}

export interface TopologyCache {
  /**
   * Synchronous build or cache hit. The agency's schematic must already be
   * loaded (`ensureTopology`, `useAgencySchematic`); throws otherwise.
   */
  readonly topologyFor: (provider: BrowserAgency, supplied?: MapModel) => MapModel;
  /** Loads the agency's schematic if needed, then builds or reuses its model. */
  readonly ensureTopology: (provider: BrowserAgency) => Promise<MapModel | undefined>;
  readonly warmProviderIds: (
    activeAgencyId: string,
    favouriteAgencies?: readonly string[],
  ) => readonly string[];
  readonly topologyCache: MapModelCache;
}

export interface TopologyCacheOptions {
  readonly allProviders: readonly BrowserAgency[] | (() => readonly BrowserAgency[]);
  readonly maxEntries?: number;
}

function readProviders(
  providers: readonly BrowserAgency[] | (() => readonly BrowserAgency[]),
): readonly BrowserAgency[] {
  return typeof providers === "function" ? providers() : providers;
}

/**
 * App-shell cache for pure map models. Provider lookup and warming policy stay
 * here; Core Map only receives a schematic and returns a model.
 */
export function createTopologyCache(options: TopologyCacheOptions): TopologyCache {
  const limit = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_TOPOLOGY_CACHE_SIZE));
  const topologyCache = createMapModelCache(limit);
  const warmedIds: string[] = [];
  const remember = (id: string) => {
    const index = warmedIds.indexOf(id);
    if (index !== -1) warmedIds.splice(index, 1);
    warmedIds.unshift(id);
    warmedIds.splice(limit);
  };

  const topologyFor = (provider: BrowserAgency, supplied?: MapModel): MapModel => {
    if (!provider.light) {
      throw new Error(`Agency "${provider.manifest.id}" does not declare a schematic`);
    }
    const topology = topologyCache.getOrCreate(provider.manifest.id, () => {
      if (supplied) return supplied;
      const schematic = peekSchematic(provider.manifest.id);
      if (!schematic) {
        throw new Error(`Schematic for agency "${provider.manifest.id}" is not loaded yet`);
      }
      return buildMapModel(schematic);
    });
    remember(provider.manifest.id);
    return topology;
  };

  const ensureTopology = async (provider: BrowserAgency): Promise<MapModel | undefined> => {
    if (!provider.light) return undefined;
    await loadSchematic(provider.manifest.id);
    return topologyFor(provider);
  };

  return {
    topologyFor,
    ensureTopology,
    warmProviderIds(activeAgencyId, favouriteAgencies = []) {
      const providers = readProviders(options.allProviders);
      const available = new Set(
        providers.filter((provider) => provider.light).map((provider) => provider.manifest.id),
      );
      const ordered = [activeAgencyId, ...favouriteAgencies, ...warmedIds];
      for (const provider of providers) ordered.push(provider.manifest.id);
      return [...new Set(ordered)]
        .filter((id) => id === activeAgencyId || available.has(id))
        .slice(0, limit);
    },
    topologyCache,
  };
}
