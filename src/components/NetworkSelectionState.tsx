import { DEFAULT_UI_LOCALE } from "~/domain/locale";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { BrowserAgency } from "~/agencies/types";
import type { GeolocationStatus } from "~/domain/location/locationLadder";
import { SearchInput } from "~/components/common/SearchInput";
import { useI18n } from "~/i18n/I18nContext";

export interface NetworkSelectionStateProps {
  readonly providers: readonly BrowserAgency[];
  readonly favouriteAgencyIds?: readonly string[];
  readonly hasLocation: boolean;
  readonly status: GeolocationStatus;
  readonly onSelectAgency: (id: string) => void;
  readonly onRequestLocation: () => void;
}

export function NetworkSelectionState(props: NetworkSelectionStateProps) {
  const { locale, t } = useI18n();
  const [search, setSearch] = createSignal("");
  const networks = createMemo(() => {
    const query = search().trim().toLowerCase();
    return props.providers
      .filter(({ manifest }) => `${manifest.name} ${manifest.id}`.toLowerCase().includes(query))
      .sort((a, b) => {
        const favourites = props.favouriteAgencyIds ?? [];
        return (
          Number(favourites.includes(b.manifest.id)) - Number(favourites.includes(a.manifest.id)) ||
          (locale() !== DEFAULT_UI_LOCALE
            ? a.manifest.name.localeCompare(b.manifest.name, locale())
            : a.manifest.name.localeCompare(b.manifest.name))
        );
      });
  });

  return (
    <section
      aria-labelledby="choose-network-heading"
      class="flex h-full items-center justify-center px-5 pt-26 pb-8"
    >
      <div class="flex max-h-full w-full max-w-md flex-col rounded-2xl border border-border bg-card/95 p-6 shadow-lg">
        <h1 id="choose-network-heading" class="text-xl font-semibold text-foreground">
          {t("Choose your transit network")}
        </h1>
        <p class="mt-2 text-sm leading-relaxed text-muted-foreground">
          {props.hasLocation
            ? t(
                "No supported network found near your estimated location. You can still choose a network to explore.",
              )
            : t("We couldn't determine your location. Choose a network to explore its map.")}
        </p>
        <button
          type="button"
          disabled={props.status === "prompting"}
          onClick={props.onRequestLocation}
          class="mt-4 cursor-pointer rounded-lg bg-foreground px-4 py-2.5 text-sm font-semibold text-background disabled:cursor-wait disabled:opacity-60"
        >
          {props.status === "prompting" ? t("Waiting for location…") : t("Use my location")}
        </button>
        <p class="mt-2 text-xs text-muted-foreground">
          {t("You can choose a network without sharing your location.")}
        </p>
        <SearchInput
          value={search()}
          onInput={setSearch}
          ariaLabel={t("Search transit networks")}
          placeholder={t("Search transit networks")}
          class="mt-5"
        />
        <ul
          aria-label={t("Transit networks")}
          class="mt-3 min-h-0 overflow-y-auto overscroll-contain"
        >
          <For each={networks()}>
            {(provider) => (
              <li>
                <button
                  type="button"
                  onClick={() => props.onSelectAgency(provider.manifest.id)}
                  class="w-full cursor-pointer rounded-lg px-3 py-3 text-left text-sm text-foreground transition-colors hover:bg-accent focus-visible:bg-accent"
                >
                  {provider.manifest.name}
                </button>
              </li>
            )}
          </For>
        </ul>
        <Show when={networks().length === 0}>
          <p class="py-4 text-sm text-muted-foreground">{t("No matching networks.")}</p>
        </Show>
      </div>
    </section>
  );
}
