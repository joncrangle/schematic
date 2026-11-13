# Add a language

Application locales and operator feed languages are configured separately.
An agency can publish in one or several languages, with its own default locale.
It does not need to offer English or any other application locale.

Adding a language involves registering its application messages, configuring
available operator feeds, and supplying terms for alert classification.

## Register the application locale

Add metadata to `SUPPORTED_UI_LOCALES` in
[locale.ts](../src/domain/locale.ts). Use a canonical BCP-47 tag, its base
language, the language's own name, and document direction. For example:

```ts
{ tag: "es-MX", language: "es", nativeName: "Español", direction: "ltr" }
```

The language picker and validation derive from this registry. Saved preferences
win over browser language preferences. Negotiation tries an exact configured
tag, then broader BCP-47 ranges, preserving script preferences before the base
language. When configuring several regions for one language, put the preferred
regional fallback first. Unsupported browser languages use `DEFAULT_UI_LOCALE`.

The application default must match its eager base dictionary. It is independent
of each agency's default locale. Right-to-left entries set the document's `dir`;
a full RTL layout audit has not been done.

## Validate request locales

HTTP snapshot and station-departure query strings return 400 for a supplied
invalid or unsupported locale. Supported tags are canonicalized before content
selection; locale remains part of the CDN cache key. RPC arguments and push
registration also reject supplied invalid or unsupported values and canonicalize
supported regional or base-language tags to a configured UI locale. Omitted
RPC and snapshot locales use the agency default; omitted push registration
locales use the application default.

Browser preference negotiation and persisted preference decoding are tolerant:
unsupported languages fall back through the configured defaults. The generic
worker validates canonical BCP-47 catalog tags independently of the UI registry
so a newly added page catalog works with an existing worker.

## Add application messages

Create a dictionary in `src/i18n`, using the shared
[TranslationKey and TranslationEntry types](../src/i18n/en.ts). Declare it as
`Record<TranslationKey, TranslationEntry>` so missing keys fail compilation.
Provide a faithful translation of the existing copy and preserve named
`{{parameters}}`.

The English dictionary uses Canadian spelling. English chrome switches to
American spelling like units: the rider's Spelling choice, else the formatting
region. When English copy uses a Canadian spelling, add its American form to
[usSpelling.ts](../src/i18n/usSpelling.ts). The catalog test flags common
Canadian spellings.

Plural entries require an `other` form and may supply `zero`, `one`, `two`,
`few`, and `many`. Supply the forms required by the language's `Intl.PluralRules`
categories. Register a lazy import in
[DICTIONARY_LOADERS](../src/i18n/catalog.ts), keyed by the locale tag.

Add notification messages to
[LOCALE_MESSAGES](../src/domain/localeMessages.ts), preserving their named
`{parameters}`. Add an offline and generic push catalog under
[src/domain/workerMessages](../src/domain/workerMessages/en.ts), satisfying
`WorkerMessages`, and register its lazy import in
[workerCatalog.ts](../src/i18n/workerCatalog.ts).

UI dictionaries use double braces, such as `{{name}}`, through
`interpolateMessage`. Notification and worker catalogs use single braces, such
as `{id}`, through `formatLocaleMessage`. Preserve each catalog's syntax when
adding or translating messages; the formatters have separate contracts.

The page loads the selected worker catalog and synchronizes it with the shared
service worker. Adding a language does not require a translated worker,
worker-code changes, or a shell-cache version change.

## Route operator content to the appropriate language

Follow [agency language authoring](agency-reference/manifest.md#language-and-operator-content)
to configure the languages an operator actually publishes. Set the agency's
`locale` to its default and declare each known source `language`. Group language
variants of the same source with `languageGroup`; keep independent boards as
separate sources.

The app selects operator-provided content. It does not translate agency alerts,
station names, headsigns, or direction termini. Selection tries the rider's
locale, the agency's locale, the application default, then untagged content,
using regional and script lookup at each step. If none matches, the first
configured source in the group remains available. Multilingual GTFS text
similarly retains the first nonblank operator translation when no preference
matches. An agency that publishes only Spanish can therefore supply Spanish
alerts regardless of the rider's interface language.

For RSS variants with a publisher-guaranteed shared incident identifier,
configure `incidentIdentityPattern` with one capture group and a shared
`languageGroup`. This prevents a language switch from repeating a notification
for the same incident. Entries without that identity retain content-based
identity.

## Add alert classification terms

Add a language-keyed entry to
[ALERT_LANGUAGE_CATALOGS](../src/domain/alerts/rules.ts) for the new operator
language. Use observed operator wording to supply:

- Baseline rules for service suspensions, delays, detours, recovery, and advisories.
- Equipment terms for elevators, escalators, and other supported equipment.
- Station-span connectors for phrases describing an affected section.
- Directional patterns where operator prose identifies a travel direction.

Use complete equipment terms that distinguish an escalator from ordinary
stairs. Add status words to `equipmentNonIdentifierWords` so descriptions such
as closed or out of service are not extracted as equipment identifiers.

Match terms to the existing alert kinds and severity semantics. Use bounded
phrases so ordinary words and place names do not imply a direction or
suspension. Keep operator-specific interpretation rules in the agency manifest.
Structured GTFS effects and agency rules retain their existing precedence.

Classification uses all registered vocabularies independently of the interface
language. Include terms needed by fallback feeds too. Unselected GTFS
translations may supply internal classification evidence; the rider still sees
only the selected operator text.

## Verify the addition

Use fictional agencies and offline fixtures to test locale negotiation,
dictionary loading and fallback, operator language selection, and classification
of the new terms. Include an agency with no feed in the application default
language. Verify that its available alerts remain visible and correctly
classified. Parser changes require matching fixtures and checks through any
Rust twin under the [parser parity standards](../CODING_STANDARDS.md#parser-parity).

Check first load, language switching, persistence after reload, document language
and direction, longer labels, plural forms, and notification/offline messages
in the browser.

Run `bun format`, `bun run lint`, `bun run typecheck`, `bun run test`,
`bun run docs:check`, `bun run agency:check`, `bun run attribution:check`, and
`bun run build`.
