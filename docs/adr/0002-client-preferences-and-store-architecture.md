# ADR-0002: Client Preferences Store and Reactive Solid Context Architecture

## Status

Accepted

## Context

The app needs one reactive source of truth for user preferences:

1. Preferences must be validated by the Effect Schema domain codec.
2. Preferences must persist across sessions with a stable storage key and graceful fallback.
3. Browser persistence must be replaceable by an in-memory adapter for tests and SSR.
4. Solid components must consume preferences reactively without knowing persistence details.

There is one production caller and no need to compose storage backends at runtime, so an Effect service and layer stack would only add indirection and duplicate the domain codec boundary.

## Decision

### 1. Domain schema remains authoritative

UserPreferences remains a versioned domain model with defaults. The current schema version is defined by the domain module and must not be duplicated by the persistence adapter.

The domain codec is responsible for decoding and validating persisted values, applying defaults for missing or invalid fields, and encoding the current version. The schema is version 1. Persisted documents with any other version reset to browser-language defaults; there is no legacy migration.

The persistence adapter only reads and writes the raw string. It must never implement a second validation or migration policy.

### 2. Direct asynchronous persistence seam

Persistence is exposed through the narrow asynchronous interface PreferencesStorage:

    interface PreferencesStorage {
      load(): Promise<UserPreferences>;
      save(preferences: UserPreferences): Promise<void>;
    }

The canonical implementations are createLocalStoragePreferencesStorage(), which uses the browser local-storage key `schematic:preferences:v1`, and createMemoryPreferencesStorage(initialPreferences?), which stores typed preferences in memory for tests and SSR.

The browser adapter is safe when window or localStorage is unavailable. load resolves to DEFAULT_PREFERENCES when the key is absent, the value is malformed, schema decoding fails, or storage access throws. save resolves after a successful write and is a no-op when storage is unavailable or the write throws. Storage failures may be reported through the repository logger, but they must not reject the provider update path.

PREFERENCES_STORAGE_KEY remains exported from the persistence module so boundary tests use the same key as production.

### 3. Solid context remains the UI boundary

UserPreferencesProvider owns the reactive state and uses a PreferencesStorage instance:

- It initializes synchronously with DEFAULT_PREFERENCES.
- It loads persisted preferences after mount.
- It applies updates optimistically.
- It persists updates asynchronously.
- It projects reduced motion to the DOM.
- It mirrors preference changes to the push notification service.

### Push subscription reconciliation

Push health checks
wait for preference hydration so key rotation cannot provision default favourites
or commute windows over the saved policy. The provider reconciles an existing
browser subscription after hydration and when connectivity returns, without
requesting notification permission or creating a subscription. Its preference
mirrors and proactive/reactive healing share one queue. Healing reads the latest
preferences at registration, then the provider mirrors current policy after it
finishes. Failed mirrors receive up to three retries at five-second intervals.
Subscription write RPCs abort after ten seconds. Individual browser subscription
operations also have deadlines, stopping the caller before any later sync; worker
readiness waits at most six seconds, so a stalled request cannot retain the queue indefinitely. Each
write receives a browser revision, persisted separately from the preference
document, that prevents a late request from replacing newer policy.
[ADR-0009](0009-two-database-storage-topology.md#notification-delivery)
records the atomic storage guard. Reconnect repeats the key health check as well as the mirror, including after an
offline startup. Reconnect or another relevant preference edit starts a new retry opportunity. Disposal cancels queued
work and prevents a pending readiness check from submitting a request.

Consumers use useUserPreferences() and do not access storage directly. The provider's default storage is createLocalStoragePreferencesStorage(); tests may supply createMemoryPreferencesStorage() or a focused fake through the provider's storage prop.

### Agency selection and location

The `agency` preference stores either `"auto"` or a manual agency ID in the
existing LocalStorage preference record. A network selected in the unresolved
chooser follows the same update and persistence path as the agency picker;
no extra storage key or schema migration is needed. A valid manual selection
restores after preference hydration even when location is unavailable.

Automatic's current winner and session hold remain transient. Persisting
`"auto"` preserves the mode, not a guessed network. See
[ADR-0007's agency selection decision](0007-core-agency-module-app-shell-decomposition.md#agency-selection)
for resolution and presentation rules.

Effect remains the schema/codec dependency at the domain boundary; it is not required for the one asynchronous persistence seam.

### Regional display preferences

UI language and regional formatting are separate. UI dictionaries remain
`en-CA` and `fr-CA`; the loaded dictionary controls document language and
operator-content selection still uses the saved UI locale.

`formatLocale` combines the loaded UI language with the country of the
location-resolved Automatic agency. This uses the location resolver even when
the rider has manually selected or temporarily opened a network in another
country. Without a location-resolved country, use the displayed agency's
`jurisdiction.country`, then the first explicit browser-language region, then
`CA`. The shell supplies this country through a formatting context so i18n does
not resolve agencies itself. A browser's `en-US` language setting is a language
hint, not evidence that a rider using Canadian transit is in the United States.
Browser language still chooses the default UI language. Explicit date, time,
and unit preferences continue to override the regional defaults.

All date, time, number, relative-time, list, and plural formatters use this
regional locale. The v1 preferences add `dateOrder`, `timeFormat`, and
`unitSystem`, each defaulting to `locale`. Explicit date order preserves numeric
field widths or textual months. Canadian numeric dates use year-month-day
across ICU revisions; textual dates retain the locale's order. Explicit 12-hour
or 24-hour time overrides a surface's hour-cycle options. Commute summaries obey
these preferences; their stored `HH:mm` schedule values remain unchanged.

Default units map CLDR's US and UK systems to imperial in `US`, `LR`, `GB`, and
`MM`, using metric elsewhere. Riders can override this choice. The display uses
feet rounded to tens below 0.1 mile, miles with one decimal at and above that
threshold, and whole mph. Metric output remains metres below 1 km, kilometres
with one decimal at and above it, and whole km/h. Speeds at or below 0.5 m/s
still display as stopped. Distances and speeds remain metric internally.

English chrome spelling follows the same rule through a v1 `spelling`
preference that defaults to `locale`: American spelling in the United States
and its territories, Canadian spelling elsewhere. Riders can override it, and
other UI languages ignore it.

These display preferences do not enter push synchronization. Snapshot, RPC,
worker, and push-subscription locale contracts still use UI locales.

## Consequences

- The persistence interface is a deep, testable boundary with one responsibility.
- UI code remains independent of browser storage and schema details.
- SSR and storage failures retain safe defaults and do not crash the app.
- The context can be tested with an explicit in-memory dependency.
- Any future persistence backend must implement PreferencesStorage and preserve the same load/save failure semantics.
