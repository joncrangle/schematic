# GHD Digital advisory fixtures

Recorded slices of the live GHD Digital advisory pages and one Umbraco
anchored-accordion board, shared by both implementations of the GHD parser:

- Core: `src/infrastructure/realtime/ghdNewsServiceAdvisoriesParser.ts`
- Alert-feed daemon: `services/alert-feed-daemon/src/parsers/ghd_news.rs`

The parser carries a variant table rather than one hardcoded selector set. These
files pin all of the shapes in production use, plus period phrasings that are easy to
misread.

| Fixture                              | Template                           | Source page                                                            | `maxAgeMinutes` |
| ------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------- | --------------- |
| `yrt-blog-item.html`                 | `blogItem` cards                   | <https://www.yrt.ca/Modules/News/en/serviceadvisories>                 | none (`null`)   |
| `milton-blog-item.html`              | `blogItem` cards                   | <https://www.milton.ca/Modules/News/en/rideralerts>                    | 7 days          |
| `drt-feed-list.html`                 | `gs-feed-list` cards               | <https://www.durhamregiontransit.com/news/service-alerts-and-detours/> | 14 days         |
| `drt-feed-list-page2.html`           | `gs-feed-list` cards               | the same DRT page, `?page=2`                                           | 14 days         |
| `thunderbay-anchored-accordion.html` | `anchored-accordion` sibling pairs | <https://www.thunderbay.ca/city-services/transit/service-alerts/>      | none (`null`)   |

The advisory fixtures are verbatim slices of pages the operators served: whole advisory
cards, unmodified, wrapped only in the container and the paginator the cards
already sat in. Card order, class names, `Posted on` versus bare dates, label
spellings, and the truncated teaser text (`Route 50 –...`) are all as served.
The first three were recorded on **2026-09-28**; the page-2 card was recorded
from a **2026-09-29** fetch, which served the same page-1 cards. Nothing is
hand-edited, so a template change shows up here as a failing parity test rather
than as silent drift.

## What the accordion fixture pins

`thunderbay-anchored-accordion.html` is the whole `section.usn_cmp_anchoredaccordion`
of the Thunder Bay Transit page, recorded **2026-10-15**, byte for byte. It is the
one shape where a title and its body are consecutive siblings (`p.tab` holding
`a.anchored-accordion-item`, then `div.repeatable-content`) instead of one nested
card, so both implementations pair them by position and the board has no
pagination and no posting date. The contract pins:

- **Identity** is the page URL plus the slug of the title with the transient
  `- NEW` marker removed. The anchor's `collapse_<guid>_<n>` ordinal shifts when
  an item is inserted, so it is never used. The contract's `pageUrl` names the
  page, because an item has no link of its own.
- **Routes** come from `Route N` and `Routes N … and M` phrases in the title and
  body. East End's `Routes 12 East End and 16 Balmoral` reads `12`, `16`;
  Cumberland's `Route 1 Mainline` list reads `1`, `2`, `11`, `13`. The bare
  heading `Route Changes`, stop numbers, and dates never become routes.
- **The period** comes from the first line that states a date, body before title.
  A yearless date uses the occurrence nearest the clock, narrowed to years that
  match a stated weekday. `Beginning Monday, October 5` therefore stays on 2026
  when read in June 2027. Without a year or weekday the intended occurrence is
  ambiguous, so nearest-year inference can mark a still-listed notice upcoming.
  A yearless end is the first occurrence after the start. `until approximately August 3, 2026` ends at the end of that
  day, which is before the contract's `now`, so Oliver Road decodes as expired.
  `approximately four weeks` and `through late Fall 2026` are not dates, so those
  items stay open while they are listed.
- **Stops** are read from `Stop 1869 – …` and `Stop #1189 – …` lines. East End
  lists streets only, so it carries routes and no stops.

The contract top level carries `now`, the fixed clock both suites decode
against, because this board has no posting date to anchor to, and
`accordionClocks`, the same board decoded at seven clocks (before, across and
long after New Year) so the year rule is pinned beyond the recording date. Each
alert also carries its `effect`, which both implementations compare. Five synthetic
files pin the empty and failure states:

- `thunderbay-anchored-accordion-empty.html` is the same section with its heading
  and zero tabs. That is the operator's own empty board and decodes as zero
  advisories.
- `thunderbay-accordion-missing-section.html` is the full page with the section's
  class renamed, as a redesign would. A missing section is a failure (stale), never
  an empty result.
- `thunderbay-accordion-renamed-tab.html` renames `p.tab`, as a redesign would.
  The heading is still there, but the board holds content this parser does not
  recognise, so it is never read as empty: only a board element that is present
  and holds nothing at all is the operator's empty board.
- `thunderbay-accordion-tab-without-body.html` drops the first body, so a tab is
  followed by another tab. A tab whose body cannot be read fails the page rather
  than dropping an incident.

`govstack-empty-newsfeed.html` is the captured empty state shared by current
GRT, DRT, and Milton news-feed pages: a search using the page's `search_field`
form parameter returns the exact paragraph `No articles were found.` as a
direct child of `section.content.component.listing-component.usn_cmp_newsfeed`.
The empty marker is scoped to that section so a challenge page or unrelated
prose cannot look like a clean board. `challenge-interstitial.html` is a
synthetic 200 HTML body with no recognized news-board markup; both parsers must reject it.

The other synthetic recognition cases are `blank-card-with-empty-marker.html`,
`missing-card-title.html`, and `nested-empty-marker.html`. A malformed card
cannot be dropped from a complete feed, even beside a valid card or an empty
marker. Empty-marker parentage must match the reference tree. The synthetic
`unclosed-empty-newsfeed.html` preserves that same recognition at end of input.

The page-2 slice carries the one card that pins a stated retirement, described
under [periods](#what-the-page-2-fixture-pins). It is a separate file rather than
an extra card in `drt-feed-list.html` because the adapter crawls page 2 as its
own page, with its own paginator, and the recording is only honest if each file
corresponds to one real request.

## `contract.json`

The one expectation both implementations must satisfy, read by
`tests/unit/ghd-news-parity.test.ts` and by
`test_matches_the_shared_parity_contract` in `ghd_news.rs`. Each alert is
normalised to what both sides can produce: `id`, `title`, `routeIds`, `stopIds`,
and `startsAt`/`endsAt` in epoch **milliseconds** (the daemon's protobuf carries
seconds, so its test scales on the way out).

The contract is generated, not hand-written. Regenerate it by running each
decoder over the fixtures and confirming the two agree before committing:

```sh
bun scripts/dump-ghd-parity-contract.ts   # rewrites contract.json
cargo test -p alert-feed-daemon test_matches_the_shared_parity_contract
bun run test tests/unit/ghd-news-parity.test.ts
```

The script re-derives every `alerts` array from the card fixtures and preserves
the `variants`, `recognizedEmptyPages`, and `unsupportedPages` file lists, so a
new card fixture has to be added to `variants` once, with an empty `alerts`
array, before the first regeneration fills it in. The expectations themselves
are never hand-written.

`timeZone` lives at the top of the contract so neither suite hardcodes it.

`maxAgeMinutes` is per variant, next to the alerts it produced, because the age is a
per-operator policy and the three differ: the agency that publishes the page
declares it in its manifest and the daemon registry, and a variant with no
declared age carries `null` rather than omitting the
field. A single shared number would have had the contract assert agreement on an
age no agency runs; carrying the real one is what makes a divergence in the
_policy_, not only in the parsing, fail CI. Both suites read the value from the
variant they are decoding, so a policy that changes on one side only surfaces as a
mismatched `endsAt`.

## What the feed-list fixture pins

DRT's shape is the hardest to parse correctly, so it is the load-bearing case:

- **The posting date is bare and abbreviated.** `<span class="gs-feed-list-date">Sep 28, 2026</span>`
  carries no `Posted on` prefix. A parser that requires that prefix and falls
  back to `now()` would anchor a September 15 detour to the current time and
  render it as live.
- **`When` states no year.** `Wednesday, September 9 to Tuesday, December 1, 2026`
  only names a year once. A year-required date pattern reads that as a single
  December date, which both starts the advisory in its future and ends it before
  it starts.
- **Labels differ.** `Routes:`, `Route:`, and `Route(s):` rather than
  `Routes affected`.
- **Prose is full of numbers.** `Stop #1608`, `#1595`, `#94191`, and dates in the
  paragraph under `Routes:` must not become route ids.
- **Pagination is different.** `<nav id="pagination">` wrapping a
  `ul.pagination`, not the news module's `.pagination-container`.

## What the page-2 fixture pins

The one card on DRT's second page states a retirement and no opening:

```
When: Extended until Thursday, December 31, 2026
```

Read as a single date with no time, that date is the advisory's **start**. The
posting was made on 6 August 2025, so a start of 31 December 2026 falls after the
max age retires it — an end five months _before_ the start, which fails feed
validation and, because DRT declares no other alert source, takes the whole
source down with it. The contract therefore pins the card's start at its posting
date and its end at the stated date.

It also pins the discrimination the rule turns on. The other fixture's
`Tuesday September 22, 2026 until further notice` carries the same preposition
with the date _before_ it, so it stays a start-only period: one date, no
terminal preposition ahead of it, end from the max age.

## What the YRT fixture pins

YRT is where the two implementations were allowed to disagree about the label
vocabulary: the daemon narrowed it to the spellings YRT publishes, while the Core
decoder read the whole list, so a prose line beginning with a bare label word
could become a field on one side and not the other. The narrowing is gone and both
read the same rule, which is pinned by this card's body:

```
Route 91 will detour on westbound John Street, …
```

The bare word `Route` there is a sentence's subject, not a label, so it is prose
and never reaches the route list. A value after a bare label still is read —
`Stops 2885, 2886, …` and `Stop 2884 on Bayview Avenue …` are the bare-label reads
this page depends on. `test_a_bare_label_reads_a_value_and_leaves_a_clause_alone`
in `ghd_news.rs` pins both halves of that rule.
