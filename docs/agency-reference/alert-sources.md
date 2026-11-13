# Alert sources

Part of the [agency guide](../add-an-agency.md). The top-level `alerts` array
lists every alert channel. Each entry picks a Core-owned adapter, and an agency
may declare several. There is no per-agency parser or normalizer file. A page
no registered parser covers needs a new generic parser in Core, built in that
agency's implementation issue.

## Source types

| `type`    | Required options                                                           | Core adapter                                                 |
| --------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `gtfs-rt` | `url`; `format` (`"protobuf"` default, or `"json"`); optional `accept`     | `decodeGtfsRealtimeFeed` / `decodeGtfsRealtimeJsonAlertFeed` |
| `json`    | `url`, `parser`; optional `timestampMode` or `maxHeaderAgeMinutes`         | `decodeGenericJsonAlertFeed` and the vendor parsers below    |
| `rss`     | `url`, plus `maxAgeMinutes` or `expiryPolicy: "feed-presence"`             | `decodeRssAlertFeed` (RSS and Atom)                          |
| `web`     | `url`, `parser` (a closed set of registered ids); optional `maxAgeMinutes` | The HTML parsers below                                       |

`parser` is a closed set, so a page whose markup no parser covers still
validates and decodes to nothing. Always [verify the count](#verify-a-source-before-you-wire-it).

## Options on every source

- **`enabled`** (default `true`). `false` disables the source everywhere.
- **`runtimes`** (`"cloudflare"` | `"self-hosted"`). `["self-hosted"]` keeps
  Workers away from an upstream whose WAF blocks cloud egress.
- **`disabledReason`** says why a source is off or restricted.
- **`requiredForCompleteness`** (default `false`). Set it on a proxy that
  supplies part of the coverage. If its base URL secret is missing, other
  sources still show alerts but the snapshot stays stale and can't prove
  recovery. Disabled sources and sources for the other runtime don't count.

## Agency-level coverage

Set `coverage: "partial"` when declared sources miss known current advisories
or a source is known to be read incompletely. The snapshot and header then stay
stale after every refresh, and recovery notifications are blocked. It is not a
label for web sources or for "the operator might post elsewhere". Reconcile
current notices first; a fully read source covering them should omit the flag.

## GTFS-RT sources

- `format: "json"` selects GTFS-RT's standard JSON mapping.
- **`emptyIsStale: true`** for an operator that always carries a standing alert.
  Zero alerts then means a stub or failure and reports stale.
- **`entityOnly: true`** for a source that publishes scope and effects without
  rider wording. Core enriches readable notices with the same stable entity ID.
  Unmatched entities keep their scope and effect with fallback wording saying
  the operator gave no details. Successful fetches stay live.
- **`descriptionField: "tts_description_text"`** when rider text lives there and
  `description_text` holds CMS markup. It falls back to the ordinary description
  when TTS text is absent. Works for protobuf and JSON.

The standard JSON decoder also retains scalar fields from fully qualified
protobuf extension objects as `sourceFields`, keyed `extension.name.field`.
Use those source fields for published categories instead of reclassifying
structured notices from prose. The daemon preserves the original JSON.

**Trip scope.** An alert whose every informed entity names a trip gets
`scope: "trip"`. A stop in the same entity limits the affected part of that
trip; it doesn't widen the notice to the whole stop. Core resolves each trip's
route from seeded trips, so the alert reaches only that route's chips and
subscribers. If the lookup fails, the alert stays in the list but can't attach to
a route by a number in its prose. Trip-scoped alerts cap at degraded, because a
cancelled trip isn't a suspended route.

**Merging.** A description-less `NO_SERVICE` twin of a placeholder-titled text
alert folds into it only when period and full scope match, and lends its effect.
Similar text across a feed and a page isn't enough; those stay separate unless a
stable incident identity proves they're the same event. A shared title is not
an identity either: publishers such as Zenbus title unrelated notices with one
category label (`Information`), so alerts whose descriptions differ stay
separate even when their title and route scope match.

## JSON parsers

**`generic-alert-feed`** reads the common title/description/startsAt/endsAt
shape. It also accepts news objects with `newsId`, `title`, `summary`,
`publishDateUtc`, nullable `routes`, and `affectsAllRoutes`. Items without an
expiry stay active while published, and an all-routes notice has no route list.
If the operator publishes local wall-clock times with a trailing `Z`, set
`timestampMode: "agency-local-wall-clock"` and Core resolves them in the
manifest `timezone`.

**`mapstrat-broadcast`** reads Mapstrat `/api/Broadcast` arrays. `routeNum` and
`stopNum` keep their feed identities, zero means unrestricted, and
`isForDetour` supplies `DETOUR`. Records share `id: 0`, so Core derives IDs from
message and scope. Mapstrat lists only live broadcasts, so an empty array is a
quiet board, not a stale one. Never substitute
Mapstrat's empty GTFS-RT service-alert stub for its broadcasts.

**`eum-search-advisories`** reads an EUM Portal search response's
`value[].document` notices and `totalCount`. Declare `method: "POST"` and a JSON
`body` with the board's search options, selection, and filter, sized for the
whole board; a count mismatch is stale. `RouteTitle` is the upstream route
token, so map it through `alertInterpretation.routeIdNormalization.aliases`.
English dates use the agency timezone, a date-only expiry includes the last
service day, and an unreadable date keeps the notice visible but marks the board
stale. The daemon entry takes the same object as `requestBody`.

**`rendered-advisory-board`** reads the public data behind a rendered advisory
app: route/stop groups with `alerts` arrays, and flat manual notices. It keeps
`gtfsentityId` for reconciliation, the rendered HTML wording, informed routes,
stops and trips, and each period. Its UTC instants have no offset, and the
publisher's epoch end sentinel means open-ended. Empty arrays are valid boards;
malformed groups, unreadable bodies, and bad periods fail. A scoped `NO_SERVICE`
notice without a body uses the publisher's effect caption, retaining its route,
stop, trip, and period; generic or unscoped textless notices still fail. Declare each route,
stop, information, and exchange board separately.

**`i3-service-status`** reads a timestamped i3 document with bilingual text,
a single `active_periods` object, and separately listed route, stop-code, and
direction selectors. Core resolves short names and stop codes against the seeded
catalog. Unknown tokens keep their route or stop scope without inventing records.
Cardinal words resolve to direction IDs from each route’s seeded headsigns.
Unresolved directions retain their published words. Missing effects become
`UNKNOWN_EFFECT`; declare an interpretation rule when these advisories should
degrade status. Headers older than ten minutes or more than a minute ahead of the
runtime clock make this source stale. Declare `maxHeaderAgeMinutes` when the
publisher republishes less often than ten minutes, so a quiet but current board
is not read as frozen. The daemon validates and forwards the original document
with the same wire contract.

`excludedDescriptionPrefixes` can omit standing stop-relocation notices already
represented by static GTFS. `redundantSummaryPrefixes` can omit summaries only
when their entire remaining body is a stop-code/name list and detailed notices
cover every listed stop, route, direction, and period. Every nonblank translation
must qualify. Matching ignores case. Unmatched summaries and additional
disruption prose remain visible. Filtering precedes seeded identity reads.

Mapstrat, EUM, and rendered-advisory-board each have a matching daemon parser
that validates and forwards the original JSON. Declare interpretation rules for
`DETOUR` when it should degrade status.

The `heading-service-notices` parser also reads server-rendered components whose
IDs end in `-service-status-content`. Every component must contain status rows or
an explicit normal-service marker. Image alternative text supplies route names;
station names in the copy resolve through `stopNames`. Responsive copies of the
same paragraph are deduplicated. Unmapped notices and unrecognized empty boards
fail the source. Equipment outages remain station-scoped.

## RSS sources

RSS entries expire by publication age and must declare `maxAgeMinutes`. A
curated board may use `expiryPolicy: "feed-presence"` instead, so entries stay
active while published. An item's own expiry date wins under either policy.

- **`routeCategoryPrefix`** (such as `"routes-"`) pulls route IDs from matching
  categories. The first ordinary category becomes `sourceFields.rssCategory`
  for interpretation rules.
- **`routeIdsFromTitle: true`** falls back to explicit numeric `Route`,
  `Routes`, `Line`, or `Lines` lists in the title, or a leading route number
  followed by a destination and colon. It never scans descriptions for road
  numbers, dates, or stop codes. Category routes win.
- **`incidentIdentityPattern`** links translated articles with a shared
  identifier. Declare it on every variant: a valid expression of at most 256
  characters with exactly one capture group. Core extracts the capture from the
  GUID or link and namespaces it by `languageGroup` and agency, for example
  `"/article/(\\d+)$"`. Entries that don't match keep content-based identity.

## Web parsers

On `web`, an unset `maxAgeMinutes` means postings never age out. Omit it for
notices that stay valid while published.

A web board reads three pages per Workers poll by default. When a verified
board needs more, set `cloudflareMaxCrawlPages` (1 to 10). The budget estimate
charges three subrequests per page, and `agency:check` rejects an agency whose
cold poll exceeds the Workers budget. Self-hosted readers and the daemon allow
ten pages. A truncated read is stale. Set this only after a complete read on
Workers.

Unlabelled headlines set route scope only through explicit route phrases or a
leading label such as `24 - Northern corridor`. Calendar and street numbers are
not routes. Labelled route lists keep their tokens, including single letters,
until the list turns into prose.

### `ghd-news-service-advisories`

`src/infrastructure/realtime/ghdNewsServiceAdvisoriesParser.ts` reads GHD
Digital News boards through a table of template variants:

| Template             | Card                                                                                                                       | Title                  | Posting date                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------- |
| `news-blog`          | `.blogItem`                                                                                                                | `a.newsTitle`          | a `Posted on <date>` line                      |
| `news-feed-list`     | `li.gs-feed-list-item`                                                                                                     | `a.gs-feed-list-title` | `span.gs-feed-list-date`, bare and abbreviated |
| `anchored-accordion` | sibling pair `p.tab > a.anchored-accordion-item` then `div.repeatable-content`, inside `section.usn_cmp_anchoredaccordion` | the tab link           | none; dates come from title and body prose     |

YRT ships `news-blog`. GRT, Milton, and Durham Region Transit ship
`news-feed-list`. The same CMS vendor doesn't mean the same template. Those
three boards mark an empty search with `<p>No articles were found.</p>` inside
`section.usn_cmp_newsfeed`, and any other unknown HTML is an error. Adding a
template is a Core change, never a new parser id.

**The accordion board** (Umbraco, used by Thunder Bay) has no pagination and no
labelled fields.

- Identity is the page URL plus the slug of the title without a trailing `- NEW`.
- Routes come from `Route N` and `Routes N … and M` phrases.
- The period comes from the first line that states a date. A yearless start
  takes the nearest occurrence to now, narrowed by a stated weekday; with
  neither, the occurrence is ambiguous. A yearless end takes the first
  occurrence on or after the start. No end means active while listed.
- The effect is `DETOUR` when the title or body says so.
- An empty accordion under the `Transit Detours and Service Alerts` heading is
  the operator's empty board. A missing section, unrecognized content such as
  renamed tabs, or an item with no readable body fails the page.

**Labels** come from one shared vocabulary: `When`, `Where`,
`Reason`/`Why`/`Event`, `Routes affected`/`Route affected`/`Routes`/`Route`/`Route(s)`,
`Detour`, `Alternative stops`/`Stops missed`/`Stops`/`Stop`. A colon alone
doesn't make a label (Milton's `Route 9A:` is prose). A label with nothing after
it adopts the lines beneath, which is where YRT puts a bare `Detour:`. Dates
accept abbreviated months and inherit the posting year when none is stated.

The GHD crawler also follows same-origin articles titled `affected services`
within its page ceiling and replaces their summaries with the dated article
body. Failed article reads and truncated crawls are partial.

The daemon carries the same parser and vocabulary. Both are pinned to recorded
pages in `tests/fixtures/ghd-news/`. After changing either side, run
`bun scripts/dump-ghd-parity-contract.ts` and both parity suites.

### `heading-service-notices`

Yearless update-card archives require a `publicationReference` with a fixed
`publicationYear`, `validFrom`, and `validThrough`. Set it only when a dated,
authoritative publication establishes the archive edition. The parser uses that
year for every card and rejects the board outside the declared validity window;
it never assigns the polling year. Refresh the reference when new dated evidence
establishes a new edition. This keeps old yearless incidents from returning in a
later year. Card dates and explicit date ranges use the agency timezone.

Reads heading-led sections inside a page's `main`, for operators mixing
schedules and advisories on one page. It keeps sections about a detour, closure,
service alert or disruption, service or schedule change, schedule or route
adjustment, a route-status board, an explicit "not in service", or a route
combination, including linked schedules. It reads only headings and paragraphs,
so link lists and booking steps don't become notices.

- Route-headed articles with a single `Ligne # 7` or `Route # 7` heading
  use an exact declared route name for scope. Alternatives mentioned in the
  body do not become affected routes. Nested articles have one owner. An
  empty body, unmapped route, or mixed article layout fails the read rather
  than silently dropping notices.
- Embedded TransitMaster service notices retain effective clocks, trip-cancellation
  windows, explicit unknown route tokens, stop scope and published directions.
  An unidentified stop remains station-scoped without colouring a drawn line.
- Labelled `Route(s)`, `Start Date`, `End Date`, `Date`, and `Time` boards keep
  their bodies across horizontal rules. Explicit years anchor service windows
  in the agency timezone; daily clock ranges become separate dated notices,
  preserving overnight gaps. Route captions constrain declared route aliases.
- Repeated responsive sections with the same heading merge into one notice.
- Ordinary notices stay active while published. Prose dates are kept but don't
  set a period, and the parser infers no effect or cancellation.
- Yearless `.service-update` cards use the fixed publication reference. Their
  posting date and clock become the publication timestamp; explicit `today`,
  date, and clock retirements set an end. `until further notice` stays open.
  A stop name keeps the alert at that stop, even when its text also names a
  route.
- `routeNames` maps canonical route IDs to the operator's names, such as
  `{"8": ["Community Bus"]}`. Whole-name matches set scope without mistaking
  street numbers for routes. Include legacy names only when verified.
- **Date-led boards.** Date paragraphs followed by `h4` headings, as on Ontario
  Northland's Service updates board, also work. The stated date is the start;
  date-only postings use UTC. List items and table rows are kept. A dated
  heading without a body fails.
- **`clearStatementNames`** lists the service names a page's "There are no
  <name> service changes planned at this time." paragraph may use to clear the
  board, such as `["CTrain"]`. The name must match whole, ignoring case, so a
  claim scoped to a window, mode, or line ("no weekend service changes") stays
  unconfirmed. The paragraph counts only in the page body, never in `nav`,
  `footer`, `aside`, or an AEM `alert-body` banner. Without this declaration an
  empty board fails.
- **`stopNames`** maps station aliases to station names or feed stop IDs.
  Titles match whole aliases; body matches need an explicit Station or Terminal
  name. These stay station scope even off the schematic.
- **Govstack news articles** use the meta section and the text component right
  after it as the body. These permanent articles need an explicit
  `from <date> to <date>` period or a `service on <date>` day; an article with
  neither fails. The publication year anchors yearless dates and the agency
  timezone sets boundaries.
- A dated article with a `blog-post__header` and route lists yields one notice
  per list item. Route aliases must match its label, and each item needs a
  readable start date. A stated end date includes its last day; an approximate
  date remains visible in the wording. An unrecognized item fails the article.
- **Disclosure accordions.** A `.accordion` whose `.accordSet` holds heading
  buttons, each controlling one `.accordCnt` panel by `aria-controls`, counts
  only when its immediately preceding sibling is an `h2`–`h4` naming detours,
  closures, or another advisory phrase this parser recognizes. Each button and
  its panel becomes a notice. An empty set under that heading is the operator's
  quiet board and reads as live with no notices. A set with text but no
  buttons, a button without its panel, or an empty title or panel fails.
- **Accordion groups.** An `.o-accordion-group` whose `.o-accordion-group__title`
  heading names impacts, detours, closures, or another advisory phrase lists
  one notice per `li` in its `.o-accordion-group__list`: the
  `button.m-accordion__trigger` is the title and the `.m-accordion__content`
  panel is the body. Every listed item is a notice, whatever its wording. A
  titled group with no item list and no item markup is the operator's quiet
  board and reads as live with no notices. Item markup outside a recognized
  list, an empty list, a non-`li` row, or an item missing its title or panel
  fails.
- A missing `main`, a notice without a body, or a page with no recognizable
  notices fails, since disappearance doesn't prove recovery.

Roam's current archive reference is year 2026 from its dated [Fall and Winter
schedule change](https://roamtransit.com/2026-fall-and-winter-schedule-changes/),
published September 30, 2026, which places the Route 7 change on October 5. The
declared reference ends November 30, matching the date range of the 2026 static
feed. It intentionally stops proving the archive year after that date; update
the reference only after a new dated publication establishes the next edition.

The daemon twin accepts the same `routeNames` and an optional `timeZone`
(default UTC).

### `service-announcement-board`

Reads notice paragraphs under a heading reading exactly `Service Announcement`
or `Service Announcements`. Each recognized closure, construction, detour, or
advisory paragraph becomes its own alert. The next heading, list, or
non-notice paragraph ends the board. No start time, effect, stop ID, or
suspension is inferred; an alert lasts while the notice is published. Optional
`routeNames` apply only inside an explicit `Route` or `Routes` phrase. A missing
heading or no recognized notices fails. The daemon accepts the same option.

### `route-notice-index`

Reads notice links grouped under `service-region` headings, each with
`serviceNoticeCode` and `subscriptionRoute` query parameters. Text before a
no-break-spaced `-` is the title. One notice under several routes becomes one
alert with every route. `routeNames` maps canonical IDs to subscription codes;
an unmapped code withholds that notice and marks the read partial rather than
going systemwide. Every region must list notices or say
`No service notices at this time`, otherwise the read fails. No period or effect
is inferred. The daemon accepts the same `routeNames`.

### `route-status-table`

Reads tables whose header row starts with a `Route` or `Routes` column; the
next column holds each route's status. A row whose status, ignoring case and a
trailing `.` or `!`, is normal-service wording clears that route: `No
disruption(s)`, `No detours`, `No closures`, or `No service changes`, each with
at most one qualifying word (`No anticipated disruptions`), `All stops are
(currently) open`, or `Normal service` / `Regular service`. Any other row is a notice titled with the header and route label,
such as `Route 401`, with the status as its body. An `All routes` row is
systemwide. `routeNames` maps canonical route IDs to the row labels; a notice
row whose label maps to no route is withheld and marks the read partial, so an
unread route never looks clear. No period or effect is inferred, and notices
stay active while published. A page without such a table, or a row missing its label
or its status, fails. Repeated rows for one label merge into one notice. The daemon accepts the same `routeNames`.

### `route-station-advisories`

Reads route advisory groups (`na-service-alert__option`) and station advisory
items (`na-service-alert__stations_ul_li`). A route group takes its routes from
its `tooltip__text_content` entries when it has any, such as under a
`Multiple Routes` heading, and otherwise from its heading. A station item takes the parenthesised station
code from its header, such as `Harbor Town, ST (HBT)`, as the alert's station
and stop target, so the code must be the feed's stop ID. Each linked notice becomes an alert identified by its
absolute link. Its `Effective …` caption gives the period in the agency time
zone, even for routes in other zones: a single date starts at local midnight with no end, a range ends at the
midnight after its last day, and `and`-joined ranges become separate windows.
Earlier ranges without a year share the last one's year. `Immediately` or no
caption means active while published. An unreadable or impossible period keeps
the notice active while published and marks the read partial. `routeNames` maps
canonical route IDs to published route names; a notice naming any unmapped route
is withheld and marks the read partial. A page with no recognizable advisory, or
an item missing its route, station code, or linked title, fails. The daemon
accepts the same `routeNames` and requires `timeZone`.

## Keyed service notice boards

The `keyed-service-notices` JSON parser reads `serviceAdvisories` and
`systemMessages` envelopes with a `queryTime`. Each notice preserves its `key`,
wording, category or message type, and optional `updatedAt` publication time.
Declare `timestampMode: "agency-local-wall-clock"` for local timestamps.
Explicit `Route X` clauses provide route identities; bullet rows such as
`* 901 - Stop name` provide stop targets. Classification remains in manifest
interpretation rules. No impact period is inferred from publication time.
A recognized empty array is a complete read. A missing board or unreadable
notice fails, so it cannot report all-clear. The daemon uses the same parser
name and shared fixtures.

## Translated sources

Translated copies of one board share a `languageGroup` and declare `language`:

```json
[
  {
    "type": "rss",
    "url": "https://operator.example/updates-en.xml",
    "expiryPolicy": "feed-presence",
    "languageGroup": "updates",
    "language": "en"
  },
  {
    "type": "rss",
    "url": "https://operator.example/updates-fr.xml",
    "expiryPolicy": "feed-presence",
    "languageGroup": "updates",
    "language": "fr"
  }
]
```

Core picks the rider's regional locale, then base language, then the agency's
regional locale and base language, then English, then untagged members. Sources
outside a group are always included, so an accessibility board never competes
with a service board. A multilingual GTFS-RT feed needs only one untagged source.

- **Runtime variants.** Give each direct/proxy pair the same `language` and
  `languageGroup`. Core filters by `runtimes` and provisioned secrets before
  picking a language. Register each RSS proxy variant in the daemon with its own
  ID and upstream URL.
- **Completeness** applies to the selected language and its same-language
  siblings. A missing translation doesn't make an available fallback stale, but
  a group with no available source still can't prove recovery.
- **Severity** uses every registered language vocabulary, even when a fallback
  feed differs from the rider's language. Check real category values rather
  than translating them. Parser date tokens keep the operator's language.

## Interpretation

Prefer a feed's structured `effect`. When meaning only exists in a labelled
field or prose, declare `alertInterpretation.rules`. Rules match on `effect`,
decoder `sourceFields`, and normalized title, description, and category text,
with `priority` settling overlaps. `titleIncludes` matches headlines only; with
`textIncludes`, both must match. Use `textIncludes` only for meaning the source
doesn't expose structurally.

```json
"alertInterpretation": {
  "rules": [
    {
      "priority": 100,
      "match": { "sourceField": "effectDescription", "sourceValue": "Reduced Speed Zone" },
      "result": { "kind": "slow-service", "severity": "degraded" }
    },
    {
      "priority": 50,
      "match": { "textIncludes": ["route diverted", "rerouted"] },
      "result": { "kind": "delay", "severity": "degraded", "serviceChange": "detour" }
    }
  ]
}
```

Rules can keep standing advisories in the panel as `information`/`normal` while
current cancellations and emergency detours still affect the map.

These run after decoding, for direct and daemon sources alike:

- **`routeIdNormalization.aliases`** maps raw route tokens to canonical IDs for
  alert route scope and stop targets. `routeLineMap` handles line attribution
  (see [the manifest page](manifest.md#mapping-feed-routes-to-schematic-lines)).
- **`routeNames`** maps canonical IDs to published names. Core matches whole
  name tokens only when the alert has no structured route scope. Parsers with
  their own `routeNames` keep them.
- **`stopIdPattern`** captures a feed stop ID from notices that lack a stop
  selector. Confirm the capture is the GTFS stop ID, not a public stop code, and
  bound it to the closure statement so replacement stops aren't marked closed.
  Structured selectors win.
- **`titleDateTimezone`** for feeds whose periods describe publication, not
  impact. Core reads a leading dated title, a full date caption after `|` or
  `:`, an explicit weekend title, a holiday's `which occurs on <date>`, or a
  `transit detour on <date>` clause. Single dates last the local service day;
  ranges include their last date. Operator impact periods win, unrelated prose
  dates are ignored, and contradictory captions fail the read.
- **`preserveFeedPeriods: true`** beside `titleDateTimezone` when the machine
  feed's periods are verified impact windows, so date-only web captions can't
  widen them.
- **`reconcileUntimedNotices: true`** merges an untimed web notice into one
  timed incident when headline, route and station scope, and opening paragraph
  agree. The timed record keeps its identity and periods; the web copy adds its
  description and links. Ambiguous matches stay separate.
- **`reconcilePublishedRestorations`** for boards that post separate
  restoration notices. Use it only when title stems, route scope, impact
  windows, and an explicit resolved cause establish the link. Core requires a
  strictly later publication and keeps ambiguous cancellations.

HTML text recovery drops tags, scripts, and stylesheets.

## Proxy-backed alert sources

Use the alert-feed daemon (`services/alert-feed-daemon/`) when the runtime can't
reach an upstream because a WAF blocks its egress, or when a large GHD board
exceeds the Worker's compute budget. The daemon polls outside Workers and serves
a cached feed; Workers still decode and interpret it.

| Upstream         | Daemon parser                        | Served at      | Manifest source                         |
| ---------------- | ------------------------------------ | -------------- | --------------------------------------- |
| GHD HTML board   | `ghd-news-service-advisories`        | `/<id>.pb`     | `type: "gtfs-rt"`, `format: "protobuf"` |
| Official GTFS-RT | `gtfs-rt-protobuf` or `gtfs-rt-json` | original bytes | `type: "gtfs-rt"` with matching format  |
| RSS/Atom         | `rss`                                | `/<id>.xml`    | `type: "rss"`                           |

Most other parsers on this page have daemon twins under the same name; each
section above says so. Relays preserve the original bytes or XML, so route metadata and expiry stay
Core-owned. See the [daemon README](../../services/alert-feed-daemon/README.md#blocked-official-gtfs-rt-feeds)
for upstream credentials, endpoint formats, and `/status`.

A Workers source declares the proxy origin secret and token auth, and is active
only when its runtime is selected and the base URL secret exists:

```json
{
  "type": "gtfs-rt",
  "url": "https://alerts.example.com/yrt.pb",
  "format": "protobuf",
  "runtimes": ["cloudflare"],
  "baseUrlSecretName": "FEED_ALERT_PROXY_BASE_URL",
  "auth": { "type": "header", "headerName": "x-feed-token", "secretName": "FEED_ALERT_PROXY_TOKEN" }
}
```

The daemon and manifest share the feed ID: `id: "yrt"` is served as `/yrt.pb`.
`FEED_ALERT_PROXY_BASE_URL` is the tunnel origin. `FEED_ALERT_PROXY_TOKEN` holds
the same value in the daemon environment and the Worker secret store.

Compose mounts `services/alert-feed-daemon/feeds.json` at startup. Adding a
supported board means editing that file and restarting the daemon, with no Rust
change or image rebuild. Today it serves YRT (its WAF blocks Workers), GRT, DRT,
and Milton (large boards kept off Workers), and OC Transpo (its gateway rejects
some Workers requests). Their direct sources stay active on self-hosted runtimes.

```json
{
  "id": "agency",
  "enabled": true,
  "parser": "ghd-news-service-advisories",
  "upstreamUrl": "https://www.example.ca/Modules/News/en/serviceadvisories",
  "routeParser": "standard",
  "timeZone": "America/Toronto",
  "maxAgeMinutes": 10080
}
```

`routeParser` is `standard` or the YRT-specific `yrt`. `timeZone` is IANA.
`maxAgeMinutes` runs from 0 to 4,294,967,295. Feed IDs use lowercase letters,
digits, and hyphens. RSS entries use `parser: "rss"` and omit the GHD-only
fields. Timing fields inherit global defaults and can be overridden per feed;
see the [proxy deployment guide](../deployment/deployment-guide.html#proxy).

Provision the daemon and Worker secrets before deploying a manifest that needs
them. Without `FEED_ALERT_PROXY_BASE_URL`, Cloudflare-only proxy sources are
inactive: YRT, DRT, Milton, and OC Transpo have no alerts on Workers, and GRT
stays stale because its required board is missing. An unreachable daemon or a
rejected token fails the source as stale. Core never falls back to parsing the
HTML on Workers.

## Verify a source before you wire it

A parser name that looks right is not evidence. Fetch the page, run the
registered decoder on the bytes, and read the count before writing the manifest.
The `web` runtime path is `alertFeedAdapters.web(...)` in
`src/infrastructure/realtime/alertFeedAdapters.ts`, and the decoder it wraps
imports directly. Bun resolves the `~` alias, so run this from the repo root:

```ts
// scratch/check-alert-source.ts: throwaway, delete it once you've read the count
import { readFileSync } from "node:fs";
import { decodeGhdNewsServiceAdvisories } from "~/infrastructure/realtime/ghdNewsServiceAdvisoriesParser";

const html = readFileSync("scratch/service-alerts.html", "utf8");
const feed = await decodeGhdNewsServiceAdvisories({
  html,
  timeZone: "America/Toronto",
  maxAgeMinutes: 10_080,
});
console.log(
  feed.alerts.length,
  feed.alerts.map((alert) => alert.title),
);
```

```sh
curl -sSL "https://www.example.ca/service-alerts" -o scratch/service-alerts.html
bun scratch/check-alert-source.ts
```

The same check works for `decodeRssAlertFeed(xml, { maxAgeMinutes })` and
`decodeGenericJsonAlertFeed(payload, now, { timestampMode, timeZone })`.

- **A non-zero count** proves only that the template matches. Check that the
  `endsAt` values are current, too. Advisories that ended years ago are marked
  `expired` and filtered out, leaving an empty list under a fresh snapshot.
- **A zero count** is acceptable only when the capture contains the source's
  recognized empty-state marker, such as GHD's `No articles were found.`. Add a
  fixture that exercises it. Without a marker, treat zero as an unsupported
  integration and keep the source unavailable.

## Verify interpreted alerts and rendered cards

Registration, a non-zero count, parser parity, and an HTTP 200 don't prove the
alerts riders see are right. Before finishing an agency or changing a source,
capture the current feed and advisories page, run them through the real provider
snapshot, and inspect the alert list and map popovers at desktop and mobile
sizes. Compare each current advisory with its card:

- **Wording.** Titles and descriptions say what the advisory is. A generic
  upstream title like "Transit Alert" needs a meaningful fallback. Schedule
  menus, navigation labels, and unrelated paragraphs are not advisory text. When
  the notice is a set of linked detour maps, keep those links and drop links to
  regular schedules.
- **Scope.** A stop-only closure never shows "Systemwide" or suspends a route.
  A route-wide notice never invents a station span from the schematic's end
  stations. Check unmapped stops, off-schematic routes, and multi-route alerts.
- **Duplicates.** A text record and a machine-effect record for one incident
  don't produce an empty duplicate card. Compare periods and full
  route/stop/trip selectors, including incidents split across records. Fold only
  on identity or an unambiguous full-scope match; keep overlapping incidents
  separate with their effects.
- **Periods.** Explicit periods match current operator information. A poll time
  is not a publication date. Keep uncertain prose dates without inventing an
  expiry, and check that old notices don't come back as current.
- **Failure.** A failed or unrecognized source makes the snapshot stale or
  unavailable. It can't show all-clear while another channel has current notices.

Record the check time, upstream incident IDs or headings, what rendered, and any
gaps. Add offline regressions at the responsible public seam for each new feed
shape, extraction rule, or presentation bug, using fictional configuration and
shared TypeScript/Rust fixtures when parsing changes. Fix generic Core gaps in
the agency change.

### Dated attribute advisories

The `attribute-advisories` JSON parser accepts a `data` array whose items have
`id` and `attributes` containing `title`, `description`, `startDate`, and
`endDate`. Dates use `DD-MM-YYYY`; declare
`timestampMode: "agency-local-wall-clock"` to interpret them in the agency's
timezone. End dates include that day. `meta.pagination.total` must be present;
a truncated page remains visible as stale. Missing fields and invalid periods
fail the source instead of declaring an all-clear. The parser preserves unknown
scope rather than extracting a route number from arbitrary prose.

GTFS-RT alert sources may declare `ignoredStopIds` for a documented route-wide
marker such as `all`. The marker is removed from stop scope while any published
route, trip, or other stop selectors remain. `idNamespace` applies the static
feed's namespace to JSON and protobuf alert identities equally.

## TransLoc messages

The `transloc-messages` JSON parser reads Ride Systems `GetTwitterJSON` arrays.
It preserves each message's ID, text, and explicit-offset `created_at` and
`end_date` periods. The vendor date format is `ddd MMM DD HH:mm[:ss] ZZ YYYY`, accepting offsets with or without a colon.
Missing or unreadable content fails the source. An empty array from an active
operator announcements board is a complete read with no posted notices. Verify
that the rider app enables and polls this board before declaring it; an unused
endpoint does not establish alert coverage.

## Disruption details tables

The `disruption-details-table` web parser reads a single-column table headed
`Disruption Details`. Only the exact sentence "There are no active transit
disruptions." clears an otherwise empty board. Missing boards, conflicting
empty markers, incomplete rows and unreadable dates fail the source.

Rows retain their labelled `Start Date` and `End Date` in the agency timezone.
`Unknown end time` leaves a notice open while published. Explicit `Stops affected
are …` lists remain stop-scoped; declared `routeNames` match the row's leading
route label. Cancellation severity belongs in manifest interpretation rules.
The daemon uses the same parser name and requires `timeZone`.

## Stop closure tables

The `stop-closure-table` web parser requires the five-column header `Route`,
`Closed Stop`, `Alternate Stop`, `Start Date`, `End Date`. It keeps replacement
stop instructions in the description and targets only the closed stop. Published
stop codes are retained separately from their readable names. Core joins a code
only when pinned static identities resolve it to one canonical platform; unknown
or ambiguous codes keep their readable names. Declare `routeNames` to
join the published route labels.

Dates use the agency timezone, with a dated end including that service day.
`Until further notice` and `Permanent Closure` leave the notice open while
published. Missing tables, empty boards without a verified clear marker,
incomplete rows, and unreadable dates fail instead of reporting all-clear.
The daemon uses the same parser name and requires `timeZone`.

### Legacy folded HTTP headers

A web source may opt into `allowLegacyResponseHeaders: true` when a live
capture proves its server sends obsolete folded response headers. Self-hosted
Core uses a direct Node/Bun HTTP transport with compatibility parsing; TLS
certificate verification stays enabled. The usual bounded-body reads, aborts,
timeouts, and source-failure policy still apply. Configure the final upstream
URL because this transport does not follow redirects.

For local Miniflare development, declare `devProxyPrefix` too. The existing
Vite feed transport applies the same explicit compatibility policy on the
residential machine. This development transport is separate from the alert-feed
daemon. Only route an agency through the daemon when Cloudflare access is blocked.
In that case, restrict the daemon source to `runtimes: ["cloudflare"]` and the
direct source to `runtimes: ["self-hosted"]`. Otherwise the direct source serves
both runtimes. Every parser still needs its Rust equivalent.

### Embedded posts and linked notices

`heading-service-notices` also reads Feed Them Social post cards and a
Service Bulletins section of warning cards. Non-service social posts do not
become advisories. Explicit closure dates use the notice's publication year,
or a bounded `publicationReference` for a yearless social post. Stop closure
sentences preserve street abbreviations and exclude replacement stops.
Direction-suffixed route tokens match aliases declared in `routeNames`.

A board with `data-alerts-type` cards links same-origin detail pages. The detail
page's `body-blocks`, `affected-lines`, and `date-published` fields preserve copy,
route chips, closed-stop IDs and labelled French service dates. General notices
can omit the route list. The crawl shares the ten-page ceiling and stale-on-
incomplete behavior of other web sources. Set `cloudflareMaxCrawlPages` when
the complete verified board needs more than the default three pages. Both the
index contract and detail fixtures run against TypeScript and Rust.

## Bucketed and JSON:API transit notices

The JSON parser `bucketed-transit-alerts` reads `cancelled_stops`,
`cancelled_trips`, `significant_delays`, and `other`. All four arrays must be
present. It preserves entity route/stop pairs, trip identities and individual
periods. Same-date periods whose end clock precedes the start clock end on the
next calendar day. Declare `timestampMode: "agency-local-wall-clock"` for local
periods without offsets.

`jsonapi-transit-notices` resolves Drupal `parcours.routes` and
`parcours.arrets` relationships. Include the nested `arrets_non_desservis` and
`arrets_suggeres` resources. Closed stops stay paired with their published route
and direction; suggested replacements remain rider guidance. Paragraph
instructions and notice bodies are retained. Missing relationships fail the
read, while pagination or a count mismatch marks it partial. The source URL may
substitute `{now}` with the encoded receipt instant for publication filters.
A stop-code source needs a seeded scope identity artifact; declaring its static
`sourceAgencyIds` makes the seeder publish that artifact.

## Zenbus publicapp messages

`type: "zenbus-messages"` decodes the publicapp `poll/msg` protobuf board.
The operator's enabled message poll can return an empty body. That verified
empty shape is accepted; unknown nonempty documents and incomplete messages
fail the read. Deleted messages are excluded. Source line selectors remain
route scope, and explicit numbered stop references remain stop scope, joined
through the seed-generated `stopCodeMap`.

Communication and impact windows stay separate. Calendar dates in `YYYYMMDD`
form resolve in the agency's time zone; epoch-millisecond fields remain exact.
The Rust daemon supports the same parser, with `timeZone` and optional
`stopCodeMap`, and shares the synthetic message contract.

The `heading-service-notices` adapter also follows municipal news templates
with `d-flex-comm` or `news-list__item` cards. It follows lazy monthly archives and reads candidate articles before
classifying transit content. A missing article or truncated crawl is stale.
Web sources may set `requestTimeoutMs` from 1 to 10,000 for an accessible but
slow publisher; the default remains two seconds per page. Rouyn-Noranda and
Saint-Hyacinthe use direct web sources, verified from deployed Cloudflare.
Explicit leading reopening updates supersede the archived incident prose.
Unresolved notices have no invented publication-age expiry. The daemon bounds
archive traversal at 512 pages with four concurrent reads; a truncated read
stays stale. Zenbus wall-message impact windows also keep their published bounds.

The `normalized-alert-feed` JSON parser validates the daemon's complete Core
feed document. It preserves route and stop targets, communication and impact
periods, source fields, and partial-read state. It does not reinterpret the
normalized document as a vendor alert array. Relay Warning headers still make
the snapshot stale, and a conditional successful read refreshes observation
time without changing the operator's periods.

## Hubup service alerts and featured update cards

The `hubup-service-alerts` JSON parser reads the enabled publicapp service-alert
board. It retains published French copy, active `periods`, and real route/stop/trip target
pairs. Each impact period remains distinct. Unknown or incomplete records fail
the read, while a verified empty array is complete. Offset-free periods need
`timestampMode: "agency-local-wall-clock"` and the agency timezone. The daemon
has the same parser and shares the vendor JSON contract fixtures.

`heading-service-notices` also follows active `featured-update-card` CMS
teasers. Completed cards with an `Ended:` caption prove only those cards have
ended; ordinary advisories elsewhere on the page remain in the snapshot.
Active cards require a same-origin detail read. Full update pages retain their
labelled start/end dates, prose and declared route/stop names. A missing or
unreadable detail makes the crawl incomplete, rather than returning an all-clear.
