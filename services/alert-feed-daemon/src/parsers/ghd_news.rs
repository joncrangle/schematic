use crate::{
    agencies::ScrapeOutcome,
    gtfs::{
        Alert, EntitySelector, FeedEntity, FeedHeader, FeedMessage, TimeRange, TranslatedString,
        alert::{Cause, Effect},
        feed_header::Incrementality,
        translated_string::Translation,
    },
    util::{
        text::{clean_cms_description, slug},
        time::{extract_dates, extract_times, make_zoned_timestamp, parse_period_lexical},
    },
};
use bytes::Bytes;
use chrono::Utc;
use chrono::{Datelike, TimeZone};
use chrono_tz::Tz;
use prost::Message;
use scraper::{ElementRef, Html, Selector};
// Re-exported by reqwest, which is already a dependency: a real URL parser, not a
// hand-rolled join, is what keeps relative pagination links resolving correctly.
use reqwest::Url;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::LazyLock,
};

/// How a template lays out an advisory's title and body.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GhdLayout {
    /// The body is nested inside the item that holds the title.
    Nested,
    /// The title and body are consecutive sibling elements: a `p.tab` holding the
    /// title link, then the `div.repeatable-content` holding the body.
    SiblingPair,
}

/// A card shape shipped by the GHD Digital News product, or the Umbraco
/// anchored-accordion board.
///
/// The same CMS renders two cards: the original `blogItem` module and the newer
/// `gs-feed-list` feed. Neither shape belongs to an agency, so the parser carries
/// every known shape and matches the one a page actually uses. A variant is
/// structure only: labels, dates, and route tokens are read identically
/// whichever shape supplied the text.
pub struct GhdTemplateVariant {
    pub name: &'static str,
    pub item: &'static str,
    pub title: &'static str,
    pub content: &'static str,
    /// Class of the element carrying the posting date when a template renders it
    /// outside the advisory body. `None` reads the body's `Posted on` line.
    pub posted_date: Option<&'static str>,
    /// Boards that paginate declare the block; the accordion board is one page.
    pub pagination: Option<&'static str>,
    pub layout: GhdLayout,
    /// Selector of the `section` that holds a sibling-pair board.
    pub container: Option<&'static str>,
    /// Selector, inside that section, of the element holding the board's items. A
    /// board is empty only when it is present and holds no content at all.
    pub board: Option<&'static str>,
    /// Heading that proves a sibling-pair board with zero items is the
    /// operator's own empty board rather than a changed or challenge page.
    pub empty_heading: Option<&'static str>,
}

pub const GHD_TEMPLATE_VARIANTS: &[GhdTemplateVariant] = &[
    GhdTemplateVariant {
        name: "news-blog",
        item: ".blogItem",
        title: "a.newsTitle",
        content: ".blogItem-contentContainer",
        posted_date: None,
        pagination: Some(".pagination-container"),
        layout: GhdLayout::Nested,
        container: None,
        board: None,
        empty_heading: None,
    },
    GhdTemplateVariant {
        name: "news-feed-list",
        item: ".gs-feed-list-item",
        title: "a.gs-feed-list-title",
        content: "span.gs-feed-list-description",
        posted_date: Some("span.gs-feed-list-date"),
        pagination: Some(".pagination"),
        layout: GhdLayout::Nested,
        container: None,
        board: None,
        empty_heading: None,
    },
    GhdTemplateVariant {
        name: "anchored-accordion",
        item: "p.tab",
        title: "a.anchored-accordion-item",
        content: "div.repeatable-content",
        posted_date: None,
        pagination: None,
        layout: GhdLayout::SiblingPair,
        container: Some("section.usn_cmp_anchoredaccordion"),
        board: Some(".anchored-accordion"),
        empty_heading: Some("Transit Detours and Service Alerts"),
    },
];

struct CompiledVariant {
    layout: GhdLayout,
    item: Selector,
    title: Selector,
    content: Selector,
    posted_date: Option<Selector>,
    pagination: Option<Selector>,
    /// Every item of a sibling-pair board: the item selector scoped to its section.
    board_item: Option<Selector>,
    /// Every heading of a sibling-pair board's section.
    board_headings: Option<Selector>,
    /// Every element of the section that holds the board's items.
    board_containers: Option<Selector>,
    empty_heading: Option<&'static str>,
}

static VARIANT_SELECTORS: LazyLock<Vec<CompiledVariant>> = LazyLock::new(|| {
    GHD_TEMPLATE_VARIANTS
        .iter()
        .map(|variant| CompiledVariant {
            layout: variant.layout,
            item: Selector::parse(variant.item).expect("valid GHD item selector"),
            title: Selector::parse(variant.title).expect("valid GHD title selector"),
            content: Selector::parse(variant.content).expect("valid GHD content selector"),
            posted_date: variant
                .posted_date
                .map(|selector| Selector::parse(selector).expect("valid GHD date selector")),
            pagination: variant
                .pagination
                .map(|selector| Selector::parse(selector).expect("valid GHD pagination selector")),
            board_item: variant.container.map(|container| {
                Selector::parse(&format!("{container} {}", variant.item))
                    .expect("valid GHD board item selector")
            }),
            board_headings: variant.container.map(|container| {
                let headings = ["h1", "h2", "h3", "h4", "h5", "h6"]
                    .map(|heading| format!("{container} {heading}"))
                    .join(", ");
                Selector::parse(&headings).expect("valid GHD board heading selector")
            }),
            board_containers: variant
                .container
                .zip(variant.board)
                .map(|(container, board)| {
                    Selector::parse(&format!("{container} {board}"))
                        .expect("valid GHD board container selector")
                }),
            empty_heading: variant.empty_heading,
        })
        .collect()
});

static A_SEL: LazyLock<Selector> = LazyLock::new(|| Selector::parse("a").unwrap());
static VERIFIED_EMPTY_NEWSFEED_MESSAGE_SEL: LazyLock<Selector> = LazyLock::new(|| {
    Selector::parse("section.content.component.listing-component.usn_cmp_newsfeed > p")
        .expect("valid verified GHD empty-board marker selector")
});

const VERIFIED_EMPTY_NEWSFEED_MESSAGE: &str = "No articles were found.";

pub type RouteExtractor = fn(&str) -> Vec<String>;

/// Ceiling on pages read for one advisory board, so the request cost of a
/// refresh is knowable in advance rather than a function of what upstream links.
pub const MAX_CRAWL_PAGES: usize = 10;

pub struct GhdScrapeConfig<'a> {
    pub advisories_url: &'a str,
    pub route_extractor: RouteExtractor,
    /// Minutes a posting stays live when the page states no end date.
    /// Unset means postings are never aged out.
    pub max_age_minutes: Option<u64>,
    /// Zone the published dates are written in. They carry no UTC offset.
    pub time_zone: &'a Tz,
}

/// Where the cross-language parity fixtures live, so an agency module's test can
/// read the same contract the parser's own parity test asserts against.
#[cfg(test)]
pub fn fixture_contract_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/ghd-news/contract.json")
}

/// The advisory labels both implementations recognise, mapped to canonical
/// fields. An operator's spelling (`Route`, `Routes:`, `Routes affected`) all
/// reach the same field, and the same vocabulary is compiled into the TypeScript
/// decoder in `ghdNewsServiceAdvisoriesParser.ts`, so an agency module never
/// describes its own labels. It is the parser's whole vocabulary, not a default
/// an agency narrows: `split_leading_label` reads a value from a value, so no
/// operator needs a private subset to keep its prose out of its own fields.
pub const GHD_LABELS: &[&str] = &[
    "when",
    "where",
    "reason",
    "why",
    "event",
    "routes affected",
    "route affected",
    "route(s)",
    "routes",
    "route",
    "detour",
    "alternative stops",
    "alternative stop",
    "stops missed",
    "stop missed",
    "stops",
    "stop",
];

/// The canonical field a recognised surface label names.
///
/// Every label in `GHD_LABELS` resolves here and nothing else does, which is what
/// makes that list the whole vocabulary: a label the map does not know is prose,
/// and both implementations agree on which is which.
pub fn canonical_field(label: &str) -> Option<&'static str> {
    match label {
        "when" => Some("when"),
        "where" => Some("where"),
        "reason" | "why" | "event" => Some("reason"),
        "routes affected" | "route affected" | "route(s)" | "routes" | "route" => Some("routes"),
        "detour" => Some("detour"),
        "alternative stops" | "alternative stop" | "stops missed" | "stop missed" | "stops"
        | "stop" => Some("stops"),
        _ => None,
    }
}

#[derive(Debug, Clone)]
pub struct GhdBlogItem {
    pub title: String,
    pub url: Option<String>,
    /// Canonical field values, keyed by `canonical_field`.
    pub fields: HashMap<String, String>,
    /// The advisory body as normalized lines, joined by newlines.
    pub raw_body: String,
    /// The posting date exactly as the matched template published it, with the
    /// news module's `Posted on` prefix already removed.
    pub posting_date: Option<String>,
    /// True for an item of a sibling-pair (accordion) board. Such an item has no
    /// link of its own, so `url` holds its `#slug` identity until the caller
    /// resolves it against the page with [`resolve_item_identity`], and its facts
    /// are read from free prose rather than labelled fields.
    pub accordion: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnsupportedGhdPageError;

impl std::fmt::Display for UnsupportedGhdPageError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(
            "unsupported GHD advisory page: no known card or verified empty-board marker",
        )
    }
}

impl std::error::Error for UnsupportedGhdPageError {}

/// Fetches all pages for a GHD Digital / iCreate advisories section and serializes to GTFS-RT Protobuf.
///
/// A page that will not load is a lost page, not a lost feed: the pages that did
/// read carry real advisories, so the crawl names the page it could not read,
/// skips it, and finishes. Only a first page that will not load fails the scrape,
/// because that leaves nothing at all to serve. A finished-but-incomplete crawl
/// comes back `partial`, which the poller serves as a stale feed rather than as a
/// complete one. The Core web adapter drops a failed subpage the same way, so the
/// two implementations agree on what a single bad page costs.
pub async fn scrape_ghd_feed(
    client: &crate::upstream::Client,
    config: GhdScrapeConfig<'_>,
) -> Result<ScrapeOutcome, Box<dyn std::error::Error + Send + Sync>> {
    let first_page = fetch_page(client, config.advisories_url).await?;
    let first_items = parse_ghd_page(&first_page).map_err(|_| crate::upstream::Failure::Decode)?;
    let first_details = linked_impact_articles(&first_items, config.advisories_url);
    let mut pages = vec![without_impact_summaries(first_items, config.advisories_url)];
    let mut article_entities = Vec::new();
    let first_page_key = canonical_crawl_page_url(config.advisories_url);
    let mut visited_urls = HashSet::from([first_page_key.clone()]);
    let mut queued_urls = HashSet::from([first_page_key]);

    let mut to_visit = VecDeque::new();
    enqueue_unseen(
        extract_pagination_links(&first_page, config.advisories_url)
            .into_iter()
            .chain(first_details)
            .collect(),
        &mut to_visit,
        &mut queued_urls,
        &visited_urls,
    );

    // The crawl is breadth-first over same-origin pagination links, and it stops
    // at a fixed page count. Following every reachable link with no ceiling makes
    // the request count of one cycle unknowable in advance, which is exactly the
    // property a platform subrequest budget needs to have. It also means a
    // `next`-only paginator, which advertises page 2 from page 1 and page 3 from
    // page 2, is read to the end rather than truncated after one hop.
    let mut partial = false;
    let mut attempted_pages = 1;
    while attempted_pages < MAX_CRAWL_PAGES {
        let Some(url) = to_visit.pop_front() else {
            break;
        };
        let key = canonical_crawl_page_url(&url);
        if !visited_urls.insert(key) {
            continue;
        }
        attempted_pages += 1;
        let text = match fetch_page(client, &url).await {
            Ok(text) => text,
            Err(error) => {
                eprintln!(
                    "[ghd] advisory subpage unreadable ({})",
                    read_failure(&error)
                );
                partial = true;
                continue;
            }
        };
        let page_items = match parse_ghd_page(&text) {
            Ok(items) => items,
            Err(_) => {
                match decode_impact_article(&text, &url, &config) {
                    Ok(entity) => article_entities.push(entity),
                    Err(_) => {
                        eprintln!("[ghd] advisory subpage unsupported");
                        partial = true;
                    }
                }
                continue;
            }
        };
        let details = linked_impact_articles(&page_items, &url);
        enqueue_unseen(
            extract_pagination_links(&text, &url)
                .into_iter()
                .chain(details)
                .collect(),
            &mut to_visit,
            &mut queued_urls,
            &visited_urls,
        );
        pages.push(without_impact_summaries(page_items, &url));
    }

    // URLs left after the attempt ceiling are unread, so the emitted cache entry
    // must carry stale warning semantics instead of claiming the board was read.
    if !to_visit.is_empty() {
        partial = true;
        eprintln!(
            "[ghd] advisory crawl stopped at the {MAX_CRAWL_PAGES}-page ceiling (read {attempted_pages}, {} unread)",
            to_visit.len()
        );
    }

    let mut entities = Vec::new();
    let mut seen_ids = HashSet::new();

    for items in pages {
        for mut item in items {
            resolve_item_identity(&mut item, config.advisories_url);
            let entity = build_gtfs_entity(
                item,
                entities.len(),
                config.route_extractor,
                config.max_age_minutes,
                config.time_zone,
            );
            if seen_ids.insert(entity.id.clone()) {
                entities.push(entity);
            }
        }
    }

    entities.extend(article_entities);
    let message = FeedMessage {
        header: FeedHeader {
            gtfs_realtime_version: "2.0".to_string(),
            incrementality: Some(Incrementality::FullDataset as i32),
            timestamp: Some(Utc::now().timestamp() as u64),
            ..Default::default()
        },
        entity: entities,
    };

    let mut buf = Vec::with_capacity(message.encoded_len());
    message.encode(&mut buf)?;
    Ok(ScrapeOutcome {
        bytes: Bytes::from(buf),
        partial,
        content_type: "application/x-protobuf",
    })
}

fn without_impact_summaries(items: Vec<GhdBlogItem>, page: &str) -> Vec<GhdBlogItem> {
    let details = linked_impact_articles(&items, page);
    items
        .into_iter()
        .filter(|item| {
            !item
                .url
                .as_ref()
                .and_then(|url| Url::parse(page).ok()?.join(url).ok())
                .is_some_and(|url| details.contains(&url.to_string()))
        })
        .collect()
}

/// Full articles supply service impacts omitted from municipal holiday summaries.
fn linked_impact_articles(items: &[GhdBlogItem], page: &str) -> Vec<String> {
    let Ok(base) = Url::parse(page) else {
        return vec![];
    };
    items
        .iter()
        .filter_map(|item| {
            let title = item.title.to_lowercase();
            let words: Vec<_> = title
                .split(|c: char| !c.is_alphanumeric() && c != '_')
                .filter(|s| !s.is_empty())
                .collect();
            if !words.windows(2).any(|w| w == ["affected", "services"]) {
                return None;
            }
            let target = base.join(item.url.as_ref()?).ok()?;
            (target.origin() == base.origin() && target.fragment().is_none() && target != base)
                .then(|| target.to_string())
        })
        .collect()
}

/// Reuse the bounded dated-article decoder instead of interpreting municipal footer prose.
fn decode_impact_article(
    html: &str,
    url: &str,
    config: &GhdScrapeConfig<'_>,
) -> Result<FeedEntity, Box<dyn std::error::Error + Send + Sync>> {
    if !html.contains("gs-news-details-meta") {
        return Err(crate::upstream::Failure::Decode.into());
    }
    let notices = super::heading_notices::decode(
        html,
        url,
        &Default::default(),
        &Default::default(),
        config.time_zone,
    )?;
    let notice = &notices[0];
    let title = notice["title"]
        .as_str()
        .ok_or(crate::upstream::Failure::Decode)?;
    let description = notice["description"]
        .as_str()
        .ok_or(crate::upstream::Failure::Decode)?;

    let start = chrono::DateTime::parse_from_rfc3339(
        notice["start_time"]
            .as_str()
            .ok_or(crate::upstream::Failure::Decode)?,
    )?
    .timestamp() as u64;
    let end = chrono::DateTime::parse_from_rfc3339(
        notice["expires_at"]
            .as_str()
            .ok_or(crate::upstream::Failure::Decode)?,
    )?
    .timestamp() as u64;
    let translated = |text: &str| {
        Some(TranslatedString {
            translation: vec![Translation {
                text: text.into(),
                language: Some("en".into()),
            }],
        })
    };
    Ok(FeedEntity {
        id: notice["id"]
            .as_str()
            .ok_or(crate::upstream::Failure::Decode)?
            .into(),
        alert: Some(Alert {
            communication_period: vec![TimeRange {
                start: Some(start),
                end: Some(end),
            }],
            header_text: translated(title),
            description_text: translated(description),
            ..Default::default()
        }),
        ..Default::default()
    })
}

fn enqueue_unseen(
    candidates: Vec<String>,
    frontier: &mut VecDeque<String>,
    queued: &mut HashSet<String>,
    visited: &HashSet<String>,
) {
    for candidate in candidates {
        let key = canonical_crawl_page_url(&candidate);
        if !visited.contains(&key) && queued.insert(key) {
            frontier.push_back(candidate);
        }
    }
}

/// URL identity for crawl bookkeeping matches Core: trailing slashes and
/// fragments do not name a new page, while a query remains part of page identity.
/// The request keeps the discovered URL verbatim; only visited and queued sets
/// use this canonical form.
fn canonical_crawl_page_url(value: &str) -> String {
    let Ok(page) = Url::parse(value) else {
        return value.to_string();
    };
    let path = page.path().trim_end_matches('/');
    let path = if path.is_empty() { "/" } else { path };
    let query = page
        .query()
        .map(|query| format!("?{query}"))
        .unwrap_or_default();
    format!("{}{path}{query}", page.origin().ascii_serialization())
}

async fn fetch_page(client: &crate::upstream::Client, url: &str) -> Result<String, reqwest::Error> {
    client
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await
}

/// Why a page read failed, in the one form that cannot leak a query string:
/// `reqwest::Error`'s own `Display` quotes the full request URL back at us.
fn read_failure(error: &reqwest::Error) -> String {
    match (error.status(), error.is_timeout()) {
        (Some(status), _) => format!("HTTP {status}"),
        (None, true) => "timed out".to_string(),
        (None, false) => "transport error".to_string(),
    }
}

/// Card-only compatibility helper for existing parser tests.
#[cfg(test)]
fn parse_ghd_blog_items(html: &str) -> Vec<GhdBlogItem> {
    parse_ghd_page(html).unwrap_or_default()
}

/// Parses a recognized GHD advisory page, including the verified server-rendered
/// no-results state shared by the current GRT, DRT, and Milton news-feed boards.
/// Unknown pages return an error so a challenge page or CMS redesign cannot
/// become a live all-clear.
pub fn parse_ghd_page(html: &str) -> Result<Vec<GhdBlogItem>, UnsupportedGhdPageError> {
    let doc = Html::parse_fragment(html);
    let mut has_card_containers = false;
    for variant in VARIANT_SELECTORS
        .iter()
        .filter(|variant| variant.layout == GhdLayout::Nested)
    {
        let card_count = doc.select(&variant.item).count();
        has_card_containers |= card_count > 0;
        if doc
            .select(&variant.item)
            .any(|card| card.select(&variant.title).next().is_some())
        {
            let items = collect_items(&doc, variant);
            // Silently omitting a malformed card could falsely clear its incident.
            return if items.len() == card_count {
                Ok(items)
            } else {
                Err(UnsupportedGhdPageError)
            };
        }
    }
    if !has_card_containers {
        if let Some(board) = VARIANT_SELECTORS
            .iter()
            .find(|variant| variant.layout == GhdLayout::SiblingPair)
            && let Some(items) = collect_sibling_pair_board(&doc, board)?
        {
            return Ok(items);
        }
        if has_verified_empty_newsfeed_marker(&doc) {
            return Ok(Vec::new());
        }
    }
    Err(UnsupportedGhdPageError)
}

/// Reads a sibling-pair board: each `p.tab` holds the title link and the very
/// next element sibling holds the body, as the TypeScript extractors do.
///
/// `None` when the page is not a board this parser can vouch for: no section
/// carrying tabs, and none carrying the operator's own empty-board heading, or
/// tabs of which none is readable. A board with some unreadable tab is an error,
/// because dropping the tab could clear an incident that is still posted. A
/// section with the heading and zero tabs is the operator's empty board.
fn collect_sibling_pair_board(
    doc: &Html,
    board: &CompiledVariant,
) -> Result<Option<Vec<GhdBlogItem>>, UnsupportedGhdPageError> {
    let (Some(board_item), Some(board_headings), Some(board_containers)) = (
        &board.board_item,
        &board.board_headings,
        &board.board_containers,
    ) else {
        return Ok(None);
    };
    let tab_count = doc.select(board_item).count();
    if tab_count == 0 {
        let has_empty_heading = doc
            .select(board_headings)
            .any(|heading| Some(element_text(&heading).as_str()) == board.empty_heading);
        // The heading also sits above a populated board, so it proves nothing
        // alone. The board must be present and hold no content at all: anything
        // else in it is markup this parser does not recognise, and that fails.
        let boards: Vec<_> = doc.select(board_containers).collect();
        let every_board_is_blank = boards.iter().all(|container| {
            container.children().all(|child| match child.value() {
                scraper::Node::Text(text) => text.trim().is_empty(),
                scraper::Node::Comment(_) => true,
                _ => false,
            })
        });
        return Ok(
            (has_empty_heading && !boards.is_empty() && every_board_is_blank).then(Vec::new),
        );
    }

    let mut items = Vec::new();
    for tab in doc.select(board_item) {
        let Some(title_element) = tab.select(&board.title).next() else {
            continue;
        };
        let Some(body) = tab.next_siblings().find_map(ElementRef::wrap) else {
            continue;
        };
        if !board.content.matches(&body) {
            continue;
        }
        let title = element_text(&title_element)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if title.is_empty() {
            continue;
        }
        items.push(GhdBlogItem {
            url: Some(format!("#{}", identity_slug(&strip_new_marker(&title)))),
            title,
            fields: HashMap::new(),
            raw_body: element_text(&body),
            posting_date: None,
            accordion: true,
        });
    }
    match items.len() {
        0 => Ok(None),
        count if count == tab_count => Ok(Some(items)),
        _ => Err(UnsupportedGhdPageError),
    }
}

/// Removes a trailing `- NEW` marker, which a notice carries only while it is
/// fresh, so an item keeps one identity across the marker's life.
fn strip_new_marker(title: &str) -> String {
    let trimmed = title.trim_end();
    let Some(split) = trimmed.len().checked_sub(3) else {
        return title.to_string();
    };
    if !trimmed.is_char_boundary(split) || !trimmed[split..].eq_ignore_ascii_case("new") {
        return title.to_string();
    }
    let rest = trimmed[..split].trim_end();
    match rest.chars().last() {
        Some('-' | '–' | '—') => {
            let dash_len = rest.chars().last().map_or(0, char::len_utf8);
            rest[..rest.len() - dash_len].trim_end().to_string()
        }
        _ => title.to_string(),
    }
}

/// Lowercase ASCII letters and digits with every other run collapsed to one
/// dash, the identity the TypeScript decoder derives with its `slug`.
fn identity_slug(value: &str) -> String {
    let mut slug = String::new();
    let mut pending_dash = false;
    for c in value.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            pending_dash = false;
            slug.push(c);
        } else {
            pending_dash = true;
        }
    }
    if slug.is_empty() {
        "advisory".to_string()
    } else {
        slug
    }
}

/// Resolves an accordion item's `#slug` identity against the page it was read
/// from. Items of other templates already carry their own link.
pub fn resolve_item_identity(item: &mut GhdBlogItem, page_url: &str) {
    if !item.accordion {
        return;
    }
    if let Some(fragment) = item.url.as_deref().filter(|url| url.starts_with('#')) {
        let page = page_url.split('#').next().unwrap_or_default();
        item.url = Some(format!("{page}{fragment}"));
    }
}

fn has_verified_empty_newsfeed_marker(doc: &Html) -> bool {
    doc.select(&VERIFIED_EMPTY_NEWSFEED_MESSAGE_SEL)
        .any(|paragraph| element_text(&paragraph) == VERIFIED_EMPTY_NEWSFEED_MESSAGE)
}

fn collect_items(doc: &Html, variant: &CompiledVariant) -> Vec<GhdBlogItem> {
    let mut items = Vec::new();

    for item in doc.select(&variant.item) {
        let Some(title_element) = item.select(&variant.title).next() else {
            continue;
        };

        let title = element_text(&title_element)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if title.is_empty() {
            continue;
        }

        let url = title_element.value().attr("href").map(String::from);
        let content_node = item.select(&variant.content).next().unwrap_or(item);
        let raw_body = element_text(&content_node);

        // The news module writes `Posted on <date>`; the feed-list template writes
        // a bare abbreviated date in its own element. Either way this resolves to
        // the same wall clock, which is what keeps the two templates comparable.
        let posting_date = match variant
            .posted_date
            .as_ref()
            .and_then(|selector| item.select(selector).next())
        {
            Some(element) => Some(element_text(&element)),
            None => posted_on_line(&raw_body).map(str::to_string),
        };

        let fields = parse_labeled_fields(&raw_body);

        items.push(GhdBlogItem {
            title,
            url,
            fields,
            raw_body,
            posting_date,
            accordion: false,
        });
    }

    items
}

/// Pagination links on this page, resolved and filtered to the page's own origin.
///
/// Resolution goes through a URL parser against the *page*, never by
/// concatenating strings onto the origin. The two disagree on the common
/// bare-query form: `?page=2` on `/news/service-alerts-and-detours/` is the next
/// page of that board, but string concatenation would resolve it against the
/// origin and request a different page entirely.
///
/// The origin filter is what keeps the crawl bounded in practice. A pagination
/// block is a link farm, and nothing in the markup says the farm stays on the
/// site; following an off-origin link hands an upstream page control over what
/// this process requests next.
pub fn extract_pagination_links(html: &str, current_url: &str) -> Vec<String> {
    let doc = Html::parse_fragment(html);
    let Ok(page) = Url::parse(current_url) else {
        return Vec::new();
    };

    for variant in VARIANT_SELECTORS.iter() {
        let Some(pagination_selector) = &variant.pagination else {
            continue;
        };
        let Some(pagination) = doc.select(pagination_selector).next() else {
            continue;
        };
        let mut urls = Vec::new();
        for link in pagination.select(&A_SEL) {
            let Some(href) = link.value().attr("href") else {
                continue;
            };
            let trimmed = href.trim();
            if trimmed.is_empty() || trimmed == "#" || trimmed.starts_with("javascript:") {
                continue;
            }
            let Ok(absolute) = page.join(trimmed) else {
                continue;
            };
            if absolute.origin() != page.origin() || absolute.as_str() == current_url {
                continue;
            }
            let absolute = absolute.into();
            if !urls.contains(&absolute) {
                urls.push(absolute);
            }
        }
        if !urls.is_empty() {
            return urls;
        }
    }
    Vec::new()
}

fn is_block_tag(tag: &str) -> bool {
    matches!(
        tag,
        "p" | "div" | "li" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
    )
}

/// An element's text as normalized lines.
///
/// Inline markup stays inside its line, so `<strong>When</strong>: …` keeps its
/// label and value together while each block element starts and ends a line. The
/// TypeScript decoder builds the same lines, which is what makes the two
/// implementations comparable line for line: once both feed the same lines to the
/// same label, date, and token rules, they cannot read the same page differently.
fn element_text(element: &ElementRef<'_>) -> String {
    let nodes: Vec<_> = element.descendants().collect();
    let mut out = String::new();
    // The currently open elements, each flagged for whether closing it ends a
    // line. A node whose parent is not on top closed every element above it, and
    // those are exactly the newlines a block element terminates its line with.
    let mut open: Vec<(bool, usize)> = vec![(is_block_tag(element.value().name()), 0)];

    for index in 1..nodes.len() {
        let node = nodes[index];
        if node.ancestors().any(|ancestor| {
            ancestor
                .value()
                .as_element()
                .is_some_and(|element| matches!(element.name(), "style" | "script"))
        }) {
            if node
                .value()
                .as_element()
                .is_some_and(|element| matches!(element.name(), "style" | "script"))
            {
                out.push(' ');
            }
            continue;
        }
        let parent = node.parent().expect("every descendant has a parent");
        while nodes[open.last().expect("the root stays open").1] != parent {
            if open.pop().expect("the root stays open").0 {
                out.push('\n');
            }
        }

        let value = node.value();
        if let Some(text) = value.as_text() {
            out.push_str(text);
            continue;
        }
        let Some(child) = value.as_element() else {
            continue;
        };

        let tag = child.name();
        if tag == "br" {
            out.push('\n');
            open.push((false, index));
            continue;
        }
        open.push((is_block_tag(tag), index));
    }
    while open.len() > 1 {
        if open.pop().expect("the root stays open").0 {
            out.push('\n');
        }
    }

    out.lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The text after a `Posted on` prefix, which the news module always writes.
fn posted_on_line(text: &str) -> Option<&str> {
    text.lines().find_map(|line| {
        line.strip_prefix("Posted on")
            .or_else(|| line.strip_prefix("posted on"))
            .map(str::trim)
    })
}

/// Reads the posting date from a template's date text.
///
/// The posting date is the only freshness signal on a page that states no
/// period, so it is resolved in the operator's zone: the published value is a
/// wall clock, and reading it as UTC would shift every period by that offset.
/// `default_year` covers a template that abbreviates the year away.
pub fn parse_posted_at(date_text: &str, time_zone: &Tz, default_year: i32) -> Option<i64> {
    if date_text.is_empty() {
        return None;
    }
    let date = *extract_dates(date_text, default_year).first()?;
    let times = extract_times(date_text);
    Some(make_zoned_timestamp(date, times.first(), false, time_zone) as i64)
}

/// The English auxiliaries and modals, a closed class, so a short list is the
/// whole of it. A field value never opens with one; a sentence does.
const AUXILIARY_VERBS: &[&str] = &[
    "am", "are", "be", "been", "being", "can", "could", "did", "do", "does", "had", "has", "have",
    "is", "may", "might", "must", "shall", "should", "was", "were", "will", "would",
];

/// Whether a bare label's value reads as a clause of prose rather than a value.
///
/// A value names what its label names and stops there: `50 –…`, `#1608 - Kingston
/// Rd Westbound`. A line whose first token is an identifier and whose second is an
/// auxiliary is a sentence with the identifier as its subject — "Route 91 will
/// detour on …" — and adopting it would put a whole detour sentence into a route
/// list. This is what lets the full label vocabulary apply to every agency: no
/// operator needs a private subset to keep its prose out of its own fields. The
/// TypeScript decoder in `ghdNewsServiceAdvisoriesParser.ts` reads the same rule.
/// Whether a token is an identifier as the shared rule means it: a run of digits
/// with at most one trailing letter, the way route and stop numbers are written.
/// The TypeScript decoder tests the same shape with `/^#?\d+[A-Za-z]?$/`.
fn is_identifier(token: &str) -> bool {
    let mut chars = token.chars();
    match chars.next() {
        Some('#') => {}
        Some(first) if first.is_ascii_digit() => {}
        _ => return false,
    }
    let rest: Vec<char> = chars.collect();
    let letters = rest.iter().filter(|c| c.is_ascii_alphabetic()).count();
    letters <= 1
        && rest
            .iter()
            .filter(|c| !c.is_ascii_alphabetic())
            .all(char::is_ascii_digit)
        && rest.iter().any(char::is_ascii_digit)
}

/// Whether a bare label's value reads as a clause of prose rather than a value.
///
/// A value names what its label names and stops there: `50 –…`, `#1608 - Kingston
/// Rd Westbound`. A line whose first token is an identifier and whose second is an
/// auxiliary is a sentence with the identifier as its subject — "Route 91 will
/// detour on …" — and adopting it would put a whole detour sentence into a route
/// list. This is what lets the full label vocabulary apply to every agency: no
/// operator needs a private subset to keep its prose out of its own fields. The
/// TypeScript decoder in `ghdNewsServiceAdvisoriesParser.ts` reads the same rule.
fn reads_as_clause(value: &str) -> bool {
    let mut words = value.split_whitespace();
    let (Some(identifier), Some(next)) = (words.next(), words.next()) else {
        return false;
    };
    is_identifier(identifier) && {
        let word: String = next.chars().filter(char::is_ascii_alphabetic).collect();
        AUXILIARY_VERBS.contains(&word.to_lowercase().as_str())
    }
}

/// Splits a leading label off an advisory line.
///
/// Most fields are written as `Label: value`, some as a bare label word with no
/// colon, and a prose line that happens to carry a colon is not a label at all.
/// Both implementations read a line the same way: the first colon settles it, and
/// a line without a colon opens a field on a leading single-word label whose value
/// is a value and not a clause. That keeps Milton's "Route 9A:" out of the route
/// list, reads DRT's bare "Stop #1608 …", and leaves YRT's "Route 91 will
/// detour …" as the prose it is.
///
/// The vocabulary is the parser's, so every agency reads the same labels rather
/// than a subset chosen by whoever wrote the agency. Multi-word labels are left
/// to the colon form, which is how they are always written.
fn split_leading_label(line: &str) -> Option<(&str, &str)> {
    if let Some(colon_split) = line.split_once(':') {
        return Some(colon_split);
    }

    let lowercase = line.to_lowercase();
    let mut longest: Option<&str> = None;
    for &label in GHD_LABELS {
        if label.contains(' ') || !lowercase.starts_with(label) {
            continue;
        }
        // The match must end on a word boundary, so "Stops" does not match "Stopsley".
        let ends_word = lowercase[label.len()..]
            .chars()
            .next()
            .is_none_or(|c| !c.is_alphanumeric());
        if ends_word && longest.is_none_or(|best: &str| label.len() > best.len()) {
            longest = Some(label);
        }
    }

    // The label is ASCII and matched at offset zero, so its byte length is also a
    // valid boundary in the original line.
    let label = longest?;
    let value = line[label.len()..].trim_start();
    (!reads_as_clause(value)).then_some((&line[..label.len()], value))
}

/// Reads the canonical fields out of an advisory body.
///
/// A label with nothing after it on its line — a bare `Detour:`, the way YRT
/// writes one — adopts the lines that follow it, which is where the operator put
/// the value. A label that already carries a value does not: a DRT advisory's
/// `Routes: 905, 920` is followed by a fresh paragraph of prose, and absorbing
/// that paragraph would read its dates and stop numbers as route ids.
pub fn parse_labeled_fields(raw_text: &str) -> HashMap<String, String> {
    let mut fields: HashMap<String, String> = HashMap::new();
    let mut open: Option<&'static str> = None;

    for line in raw_text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if let Some((label_candidate, value)) = split_leading_label(line) {
            let normalized = label_candidate.trim().to_lowercase();
            if let Some(field) = canonical_field(&normalized) {
                append_field(&mut fields, field, value.trim());
                open = if fields.get(field).is_some_and(String::is_empty) {
                    Some(field)
                } else {
                    None
                };
                continue;
            }
        }

        if let Some(field) = open {
            append_field(&mut fields, field, line);
        }
    }

    fields
}

fn append_field(fields: &mut HashMap<String, String>, field: &str, value: &str) {
    if value.is_empty() {
        fields.entry(field.to_string()).or_default();
        return;
    }
    let entry = fields.entry(field.to_string()).or_default();
    if !entry.is_empty() {
        entry.push(' ');
    }
    entry.push_str(value);
}

/// Titles indicating that an emergency detour, stop closure, or road disruption has ended.
/// Mirrors `ADVISORY_RESOLUTION_TITLE` in `ghdNewsServiceAdvisoriesParser.ts`.
fn is_advisory_resolution_title(title: &str) -> bool {
    const RESOLUTION_WORDS: &[&str] = &["ended", "cleared", "reopened", "resumed", "lifted"];
    title.split(|c: char| !c.is_alphanumeric()).any(|word| {
        RESOLUTION_WORDS
            .iter()
            .any(|target| word.eq_ignore_ascii_case(target))
    })
}

pub fn build_gtfs_entity(
    item: GhdBlogItem,
    index: usize,
    extract_routes: RouteExtractor,
    max_age_minutes: Option<u64>,
    time_zone: &Tz,
) -> FeedEntity {
    build_gtfs_entity_at(
        item,
        index,
        extract_routes,
        max_age_minutes,
        time_zone,
        Utc::now().timestamp(),
    )
}

/// [`build_gtfs_entity`] against an explicit clock, so a page that states no
/// posting date reads the same on every run. The shared parity contract fixes
/// the clock for exactly that reason.
pub fn build_gtfs_entity_at(
    item: GhdBlogItem,
    index: usize,
    extract_routes: RouteExtractor,
    max_age_minutes: Option<u64>,
    time_zone: &Tz,
    now: i64,
) -> FeedEntity {
    let id = item
        .url
        .clone()
        .unwrap_or_else(|| format!("advisory-{}-{}", slug(&item.title), index));

    let is_resolved = is_advisory_resolution_title(&item.title);
    let (route_ids, period) = if item.accordion {
        accordion_routes_and_period(&item, extract_routes, time_zone, now, is_resolved)
    } else {
        let inferred_routes =
            title_route_tokens(&item.title, &item.raw_body, extract_routes).join(" ");
        let field_routes = item.fields.get("routes").map(|field| {
            let phrase = format!("Routes {field}");
            let mut routes = parse_route_phrase_ids(&[&phrase]);
            routes.extend(
                extract_routes(field)
                    .into_iter()
                    .filter(|route| route.starts_with("Viva ")),
            );
            routes.join(" ")
        });
        let routes_str = field_routes.as_deref().unwrap_or(&inferred_routes);
        let route_ids = extract_routes(routes_str);

        // Mirrors the TypeScript decoder. A stated period wins; otherwise the posting
        // date anchors both ends, bounded by the caller's max age. Starting on the
        // current time instead would make an old posting look like it begins today.
        let stated_when = item
            .fields
            .get("when")
            .map(|s| s.as_str())
            .filter(|s| !s.trim().is_empty());
        let anchor = item
            .posting_date
            .as_deref()
            .and_then(|date| parse_posted_at(date, time_zone, year_in_zone(now, time_zone)))
            .unwrap_or(now);
        let default_year = year_in_zone(anchor, time_zone);
        let mut period = parse_period_lexical(stated_when, time_zone, default_year);
        let range = &mut period[0];
        if range.start.is_none() {
            range.start = Some(anchor.max(0) as u64);
        }
        if is_resolved {
            // An advisory announcing that a disruption has ended is retired at publication time.
            range.end = range.start;
        } else if range.end.is_none()
            && let Some(max_age) = max_age_minutes
        {
            range.end = Some((anchor + max_age as i64 * 60).max(0) as u64);
        }
        (route_ids, period)
    };

    let stop_ids = extract_stop_ids(&item.raw_body);

    let reason = item
        .fields
        .get("reason")
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    let cause = if reason.contains("construction")
        || reason.contains("work")
        || reason.contains("reconstruction")
    {
        Cause::Construction as i32
    } else if reason.contains("weather")
        || reason.contains("snow")
        || reason.contains("ice")
        || reason.contains("storm")
    {
        Cause::Weather as i32
    } else if reason.contains("police")
        || reason.contains("accident")
        || reason.contains("emergency")
        || reason.contains("collision")
    {
        Cause::PoliceActivity as i32
    } else {
        Cause::UnknownCause as i32
    };

    let effect = if is_resolved {
        Effect::UnknownEffect as i32
    } else if item.fields.contains_key("detour")
        || item.raw_body.to_lowercase().contains("detour")
        || (item.accordion && item.title.to_lowercase().contains("detour"))
    {
        Effect::Detour as i32
    } else if item.accordion {
        // Free prose states no effect beyond a detour, as the TypeScript decoder reads it.
        Effect::UnknownEffect as i32
    } else if reason.contains("delay")
        || reason.contains("slow")
        || item.title.to_lowercase().contains("delay")
    {
        Effect::SignificantDelays as i32
    } else if reason.contains("cancel")
        || reason.contains("suspension")
        || item.title.to_lowercase().contains("cancel")
    {
        Effect::NoService as i32
    } else {
        Effect::UnknownEffect as i32
    };

    let description = clean_cms_description(&item.raw_body, &item.title);

    let mut informed_entities = Vec::new();
    for r in route_ids {
        informed_entities.push(EntitySelector {
            route_id: Some(r),
            ..Default::default()
        });
    }
    for s in stop_ids {
        informed_entities.push(EntitySelector {
            stop_id: Some(s),
            ..Default::default()
        });
    }

    // `communication_period` is the spec's current field. `active_period` is
    // deprecated and every operator still sends it, so consumers read both and
    // prefer this one; emitting only it keeps the output off a deprecated field.
    let alert = Alert {
        communication_period: period,
        informed_entity: informed_entities,
        cause: Some(cause),
        effect: Some(effect),
        header_text: Some(TranslatedString {
            translation: vec![Translation {
                text: item.title,
                language: Some("en".to_string()),
            }],
        }),
        description_text: if description.is_empty() {
            None
        } else {
            Some(TranslatedString {
                translation: vec![Translation {
                    text: description,
                    language: Some("en".to_string()),
                }],
            })
        },
        ..Default::default()
    };

    FeedEntity {
        id,
        alert: Some(alert),
        ..Default::default()
    }
}

/// Reads the routes and period of an accordion item, mirroring the TypeScript
/// `decodeSiblingPairAdvisory`.
///
/// The board publishes free prose with no labelled fields and no posting date, so:
///
/// - Routes come from `Route N` and `Routes N … and M` phrases in the title and
///   body, never from stray numbers, and then pass through the agency's own route
///   extractor like every other template's routes.
/// - The period comes from the first line that states a date, the body before the
///   title, with a yearless date taking the year that puts it nearest now. A
///   period with no stated end stays open while the item is listed. The declared
///   max age has nothing to anchor to without a posting date, so it is not used.
fn accordion_routes_and_period(
    item: &GhdBlogItem,
    extract_routes: RouteExtractor,
    time_zone: &Tz,
    now: i64,
    is_resolved: bool,
) -> (Vec<String>, Vec<TimeRange>) {
    let mut texts: Vec<&str> = vec![item.title.as_str()];
    texts.extend(item.raw_body.lines());
    let route_ids = extract_routes(&parse_route_phrase_ids(&texts).join(" "));

    let stated = texts
        .iter()
        .skip(1)
        .chain(texts.first())
        .find(|line| !extract_dates(line, NEAREST_YEAR_PROBE).is_empty());
    let mut period = match stated.copied() {
        Some(line) => accordion_period(line, time_zone, now),
        None => parse_period_lexical(None, time_zone, year_in_zone(now, time_zone)),
    };
    let range = &mut period[0];
    if range.start.is_none() {
        range.start = Some(now.max(0) as u64);
    }
    if is_resolved {
        range.end = range.start;
    }
    (route_ids, period)
}

/// A year only used to read a date's month and day before its year is chosen.
const NEAREST_YEAR_PROBE: i32 = 2000;

/// The year of a yearless start date: the occurrence nearest now, narrowed to
/// years whose date matches a stated weekday when the prose supplies one. The
/// source has no posting date or year, so a date with neither weekday nor year
/// remains ambiguous. The TypeScript `startYearFor` reads the same rule.
fn start_year_for(line: &str, now: i64, time_zone: &Tz) -> i32 {
    let current = year_in_zone(now, time_zone);
    let Some(first) = extract_dates(line, NEAREST_YEAR_PROBE).first().copied() else {
        return current;
    };
    if first.year() != NEAREST_YEAR_PROBE {
        return first.year();
    }
    let weekday = weekday_before_first_date(line, first);
    let valid_candidates = (current - 7..=current + 7)
        .filter_map(|year| {
            let date = chrono::NaiveDate::from_ymd_opt(year, first.month(), first.day())?;
            Some((
                date,
                make_zoned_timestamp(date, None, false, time_zone) as i64,
            ))
        })
        .collect::<Vec<_>>();
    let matching_candidates = valid_candidates
        .iter()
        .filter(|(date, _)| weekday.is_none_or(|expected| date.weekday() == expected))
        .collect::<Vec<_>>();
    matching_candidates
        .into_iter()
        .min_by_key(|(_, timestamp)| timestamp.abs_diff(now))
        .or_else(|| {
            valid_candidates
                .iter()
                .min_by_key(|(_, timestamp)| timestamp.abs_diff(now))
        })
        .map_or(current, |(date, _)| date.year())
}

/// Reads a weekday only when it directly precedes the first date in the line.
fn weekday_before_first_date(line: &str, first: chrono::NaiveDate) -> Option<chrono::Weekday> {
    let tokens = line
        .split(|character: char| character.is_whitespace() || character == ',')
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    for index in 1..tokens.len().saturating_sub(1) {
        let Some(date) = extract_dates(&tokens[index..=index + 1].join(" "), first.year())
            .first()
            .copied()
        else {
            continue;
        };
        if date.month() != first.month() || date.day() != first.day() {
            continue;
        }
        let weekday = tokens[index - 1]
            .trim_matches(|character: char| !character.is_ascii_alphanumeric())
            .to_ascii_lowercase();
        return match weekday.as_str() {
            "sunday" | "sun" => Some(chrono::Weekday::Sun),
            "monday" | "mon" => Some(chrono::Weekday::Mon),
            "tuesday" | "tue" | "tues" => Some(chrono::Weekday::Tue),
            "wednesday" | "wed" => Some(chrono::Weekday::Wed),
            "thursday" | "thu" | "thur" | "thurs" => Some(chrono::Weekday::Thu),
            "friday" | "fri" => Some(chrono::Weekday::Fri),
            "saturday" | "sat" => Some(chrono::Weekday::Sat),
            _ => None,
        };
    }
    None
}

/// A period read with the start's year, whose yearless end is the first
/// occurrence on or after the start: "December 28 to January 4" ends next year.
fn accordion_period(line: &str, time_zone: &Tz, now: i64) -> Vec<TimeRange> {
    let year = start_year_for(line, now, time_zone);
    let mut period = parse_period_lexical(Some(line), time_zone, year);
    let range = &mut period[0];
    if let (Some(start), Some(end)) = (range.start, range.end)
        && end < start
    {
        range.end = parse_period_lexical(Some(line), time_zone, year + 1)[0].end;
    }
    period
}

/// Whether a token ends its sentence, which stops a plural route phrase from
/// running on.
fn ends_sentence(token: &str) -> bool {
    token.ends_with(['.', ':', ';'])
}

fn trim_non_alphanumeric_edges(token: &str) -> &str {
    token.trim_matches(|c: char| !c.is_alphanumeric())
}

/// 1-3 ASCII digits, or 2-4 characters of digits plus one trailing ASCII letter.
fn is_route_token(token: &str) -> bool {
    let chars: Vec<char> = token.chars().collect();
    match chars.len() {
        1 if chars[0].is_ascii_uppercase() => true,
        1..=3 if chars.iter().all(char::is_ascii_digit) => true,
        2..=4 => {
            chars[..chars.len() - 1].iter().all(char::is_ascii_digit)
                && chars.last().is_some_and(char::is_ascii_alphabetic)
        }
        _ => false,
    }
}

/// Reads route ids from `Route N` and `Routes N … and M` phrases. A plural phrase
/// keeps reading to the end of its sentence, adding a route number only when it
/// directly follows another route number or an `and` / `&`. That reads "Routes 12
/// East End and 16 Balmoral" and "Routes 1/2/11/13" as their routes while leaving
/// "Route Changes" and "Route 15 will not operate along 2nd Street" with only the
/// routes they name. The TypeScript `parseRoutePhraseIds` reads the same rule.
fn parse_route_phrase_ids(texts: &[&str]) -> Vec<String> {
    let mut route_ids: Vec<String> = Vec::new();
    let mut add = |token: &str| {
        let route_id = token.to_uppercase();
        if !route_ids.contains(&route_id) {
            route_ids.push(route_id);
        }
    };
    for text in texts {
        let tokens: Vec<&str> = text
            .split(|c: char| c == ',' || c == '/' || c.is_whitespace())
            .filter(|token| !token.is_empty())
            .collect();
        for (index, raw) in tokens.iter().enumerate() {
            let word = trim_non_alphanumeric_edges(raw).to_lowercase();
            if word != "route" && word != "routes" {
                continue;
            }
            let first_raw = tokens.get(index + 1).copied().unwrap_or_default();
            let first = trim_non_alphanumeric_edges(first_raw);
            if !is_route_token(first) {
                continue;
            }
            add(first);
            if ends_sentence(first_raw) {
                continue;
            }
            let mut follows_route = true;
            let mut follows_conjunction = false;
            for next_raw in tokens.iter().skip(index + 2).copied() {
                let next = trim_non_alphanumeric_edges(next_raw);
                if word == "route" && !is_route_token(next) {
                    break;
                }
                if is_route_token(next) && (follows_route || follows_conjunction) {
                    add(next);
                    follows_route = true;
                    follows_conjunction = false;
                } else {
                    follows_conjunction = next_raw == "&" || next.eq_ignore_ascii_case("and");
                    follows_route = false;
                }
                if ends_sentence(next_raw) {
                    break;
                }
            }
        }
    }
    route_ids
}

/// Prose headlines only establish route scope through phrases or a leading route label.
fn title_route_tokens(title: &str, body: &str, extract_routes: RouteExtractor) -> Vec<String> {
    let mut texts = vec![title];
    texts.extend(body.lines());
    let mut routes = parse_route_phrase_ids(&texts);
    let words: Vec<_> = title.split_whitespace().collect();
    if let [first, separator, ..] = words.as_slice()
        && is_route_token(first)
        && separator.starts_with(['-', '–', '—', ':'])
    {
        routes.insert(0, first.to_string());
    }
    routes.extend(
        extract_routes(title)
            .into_iter()
            .filter(|route| route.starts_with("Viva ")),
    );
    routes
}

/// The calendar year a timestamp falls on in the operator's zone.
fn year_in_zone(timestamp: i64, time_zone: &Tz) -> i32 {
    match Utc.timestamp_opt(timestamp, 0) {
        chrono::LocalResult::Single(dt) => dt.with_timezone(time_zone).year(),
        _ => Utc::now().with_timezone(time_zone).year(),
    }
}

/// Reads stop ids following the word `stop`/`stops`, tolerating the separators
/// these templates put between the word and the first id, including the `#` in
/// `Stop #1608`. Only a run that directly follows the word counts, so a stop
/// number named later in prose stays a stop and a route field stays a route.
pub fn extract_stop_ids(body: &str) -> Vec<String> {
    let mut stops = Vec::new();
    for line in body.lines() {
        let chars: Vec<char> = line.chars().collect();
        let mut index = 0usize;
        while index < chars.len() {
            let Some(word_end) = stop_word_end(&chars, index) else {
                index += 1;
                continue;
            };
            let mut cursor = skip_stop_separators(&chars, word_end);
            // `Stops missed: ...` finishes its label before the ids begin; prose
            // that merely continues a sentence ("Stop relocated to 12 metres")
            // does not, because it carries no colon.
            if let Some(tail) = label_tail(&chars, cursor) {
                cursor = skip_stop_separators(&chars, tail);
            }
            let run_start = cursor;
            while cursor < chars.len() && is_stop_id_char(chars[cursor]) {
                cursor += 1;
            }
            for id in digits(&chars[run_start..cursor]) {
                if !stops.contains(&id) {
                    stops.push(id);
                }
            }
            index = word_end;
        }
    }
    stops
}

/// The index just past a `stop`/`stops` word at `index`, or `None` when the
/// characters there are not that word. The bound mirrors the decoder's `\bstops?\b`.
fn stop_word_end(chars: &[char], index: usize) -> Option<usize> {
    if index > 0 && is_word_char(chars[index - 1]) {
        return None;
    }
    if !chars
        .get(index..index.saturating_add(4))
        .is_some_and(|word| {
            word.iter()
                .zip("stop".chars())
                .all(|(actual, expected)| actual.eq_ignore_ascii_case(&expected))
        })
    {
        return None;
    }
    match chars.get(index + 4).copied() {
        None => Some(index + 4),
        Some(next) if !is_word_char(next) => Some(index + 4),
        Some(next) if next.eq_ignore_ascii_case(&'s') => match chars.get(index + 5).copied() {
            None => Some(index + 5),
            Some(after) if !is_word_char(after) => Some(index + 5),
            _ => None,
        },
        _ => None,
    }
}

fn skip_stop_separators(chars: &[char], from: usize) -> usize {
    let mut cursor = from;
    while cursor < chars.len() && is_stop_separator(chars[cursor]) {
        cursor += 1;
    }
    cursor
}

/// The index just past a two-word stop label's tail (`missed:`), or `None` when
/// the text there is not `letters:`.
fn label_tail(chars: &[char], from: usize) -> Option<usize> {
    let mut cursor = from;
    while cursor < chars.len() && chars[cursor].is_ascii_alphabetic() {
        cursor += 1;
    }
    (cursor > from && chars.get(cursor) == Some(&':')).then_some(cursor + 1)
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn is_stop_separator(c: char) -> bool {
    c.is_whitespace() || matches!(c, ':' | ',' | '#' | '-')
}

fn is_stop_id_char(c: char) -> bool {
    c.is_ascii_digit()
        || c.is_whitespace()
        || matches!(c, ',' | '&' | 'a' | 'A' | 'n' | 'N' | 'd' | 'D')
}

fn digits(chars: &[char]) -> Vec<String> {
    let mut ids = Vec::new();
    let mut current = String::new();
    for c in chars {
        if c.is_ascii_digit() {
            current.push(*c);
        } else if !current.is_empty() {
            ids.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        ids.push(current);
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::text::parse_standard_route_tokens;
    use chrono::DateTime;
    use chrono_tz::America::Toronto;
    use serde::Deserialize;

    pub const FIXTURE_HTML: &str = r##"
        <div class="pagination-container">
            <a href="/Modules/News/en/serviceadvisories?page=2">2</a>
            <a href="https://example.com/Modules/News/en/serviceadvisories?page=3">3</a>
            <a href="#">#</a>
        </div>
        <div class="blogItem">
            <a class="newsTitle" href="/en/service-updates/route-detour.aspx">Route 101 and 77A detour</a>
            <div class="blogItem-contentContainer">
                <div class="blogPostDate"><p>Posted on March 15, 2026</p></div>
                <p>When: Monday, March 16, 2026 7:00 a.m. to Friday, March 20, 2026 6:00 p.m.</p>
                <p>Where: Between two cross streets</p>
                <p>Routes affected: 101, 77A</p>
                <p>Reason: Road construction</p>
                <p>Detour: Buses will detour via a local street</p>
                <p>Stops missed: 9001, 9002, and 9003</p>
                <p>Read more</p>
            </div>
        </div>
    "##;

    /// Stop list written as a bare label word. Ids must reach the alert as stop
    /// entities without leaking into the route list.
    const COLONLESS_STOPS_HTML: &str = r##"
        <div class="blogItem">
            <div class="blogItem-contentContainer">
                <h2><a class="newsTitle" href="https://example.test/en/news/route-detour.aspx">Route 101 detour</a></h2>
                <p><strong>When</strong>: Monday, August 31, 2026, to Friday, September 4, 2026, between 7 a.m. and 7 p.m.</p>
                <p><strong>Reason</strong>: Paving</p>
                <p><strong>Routes affected</strong>: 101</p>
                <p>Stops 9001, 9002 will not be serviced.</p>
            </div>
        </div>
    "##;

    /// Renders a timestamp back into the operator's zone, so assertions name the
    /// wall clock the page published rather than a magic epoch.
    fn local_wall_clock(ts: i64, tz: &Tz) -> String {
        DateTime::from_timestamp(ts, 0)
            .expect("timestamp")
            .with_timezone(tz)
            .format("%Y-%m-%d %H:%M")
            .to_string()
    }

    fn first_alert(html: &str) -> GhdBlogItem {
        parse_ghd_blog_items(html)
            .into_iter()
            .next()
            .expect("one advisory item")
    }

    #[test]
    fn test_omits_stylesheet_and_script_contents() {
        let html = r##"<li class="gs-feed-list-item">
          <a class="gs-feed-list-title" href="/news/posts/diversion.aspx">Detour - Route 407</a>
          <span class="gs-feed-list-description"><style>.detour { color: red; }</style><p>We&rsquo;ve moved the stop &ndash; use platform B.</p><script>track('read');</script></span>
          <span class="gs-feed-list-date">September 28, 2026</span>
        </li>"##;
        let item = first_alert(html);
        assert_eq!(item.raw_body, "We’ve moved the stop – use platform B.");
    }

    /// A one-card feed-list page stating `when`, posted on `posted`, decoded to
    /// the period the parser publishes for it. The period is where the two
    /// implementations have to agree, so it is what every `When` assertion here
    /// reads rather than a hand-computed timestamp.
    fn stated_period(when: &str, posted: &str, max_age_minutes: Option<u64>) -> TimeRange {
        let html = format!(
            r##"
            <li class="gs-feed-list-item">
                <a class="gs-feed-list-title" href="/news/posts/x.aspx">Detour - Route 407</a>
                <span class="gs-feed-list-description">
                    <p><strong>When</strong>: {when}</p>
                </span>
                <span class="gs-feed-list-date">{posted}</span>
            </li>
        "##
        );
        build_gtfs_entity(
            first_alert(&html),
            0,
            parse_standard_route_tokens,
            max_age_minutes,
            &Toronto,
        )
        .alert
        .expect("alert")
        .communication_period
        .first()
        .cloned()
        .expect("period")
    }

    /// The vocabulary is the parser's, not an agency's, so every label in it must
    /// resolve to a canonical field and every field must be reachable. That is
    /// what keeps the Rust list and the TypeScript decoder's copy from drifting
    /// apart one label at a time.
    #[test]
    fn test_the_shared_vocabulary_resolves_every_label_and_covers_every_field() {
        for label in GHD_LABELS {
            assert!(
                canonical_field(label).is_some(),
                "{label:?} is in the shared vocabulary but resolves to no field"
            );
        }
        for field in ["when", "where", "reason", "routes", "detour", "stops"] {
            assert!(
                GHD_LABELS
                    .iter()
                    .any(|label| canonical_field(label) == Some(field)),
                "no shared label resolves to {field}"
            );
        }
    }

    #[test]
    fn test_colonless_stop_list_reaches_the_alert() {
        let entity = build_gtfs_entity(
            first_alert(COLONLESS_STOPS_HTML),
            0,
            parse_standard_route_tokens,
            Some(10_080),
            &Toronto,
        );
        let alert = entity.alert.expect("Alert should be present");

        let stops: Vec<&str> = alert
            .informed_entity
            .iter()
            .filter_map(|e| e.stop_id.as_deref())
            .collect();
        assert_eq!(stops, vec!["9001", "9002"]);

        // The stop numbers must not be mistaken for routes.
        let routes: Vec<&str> = alert
            .informed_entity
            .iter()
            .filter_map(|e| e.route_id.as_deref())
            .collect();
        assert_eq!(routes, vec!["101"]);
    }

    #[test]
    fn test_posted_at_reads_both_cms_date_shapes() {
        // A published wall clock must survive as that wall clock in the zone, not
        // shift by it. Reading it as UTC would move 03:00 PM back four hours.
        let afternoon =
            parse_posted_at("Tuesday, August 25, 2026 03:00 PM", &Toronto, 2026).expect("parsed");
        assert_eq!(local_wall_clock(afternoon, &Toronto), "2026-08-25 15:00");

        let morning =
            parse_posted_at("Monday, March 16, 2026 7:00 a.m.", &Toronto, 2026).expect("parsed");
        assert_eq!(local_wall_clock(morning, &Toronto), "2026-03-16 07:00");

        // Date with no time resolves to local midnight.
        let dateless = parse_posted_at("March 15, 2026", &Toronto, 2026).expect("parsed");
        assert_eq!(local_wall_clock(dateless, &Toronto), "2026-03-15 00:00");

        // Weekday with a date but no time.
        assert!(
            parse_posted_at("Tuesday, August 25, 2026", &Toronto, 2026).is_some(),
            "weekday without a time should still parse"
        );
        assert_eq!(
            parse_posted_at("no posting date here", &Toronto, 2026),
            None
        );

        // The feed-list templates abbreviate the month and drop the `Posted on`
        // prefix. Reading that date is what keeps an old DRT posting from being
        // anchored to the current time and rendered as a live detour today.
        let bare = parse_posted_at("Sep 28, 2026", &Toronto, 2026).expect("parsed");
        assert_eq!(local_wall_clock(bare, &Toronto), "2026-09-28 00:00");
    }

    /// The zone is a parameter, so a different operator's dates resolve in their
    /// own zone rather than the host's.
    #[test]
    fn test_posted_at_resolves_in_the_declared_zone() {
        let ts = parse_posted_at("March 15, 2026", &chrono_tz::America::Vancouver, 2026)
            .expect("parsed");
        assert_eq!(
            local_wall_clock(ts, &chrono_tz::America::Vancouver),
            "2026-03-15 00:00"
        );
        // Same instant, a different wall clock in Toronto.
        assert_eq!(local_wall_clock(ts, &Toronto), "2026-03-15 03:00");
    }

    /// A page that states no period must still retire its postings, measured from
    /// the posting date. Without an end the whole archive stays live.
    #[test]
    fn test_unstated_period_is_bounded_by_max_age() {
        let html = r##"
            <div class="blogItem">
                <a class="newsTitle" href="/en/news/a.aspx">Route 101 detour</a>
                <div class="blogItem-contentContainer">
                    <div class="blogPostDate"><p>Posted on March 15, 2026</p></div>
                    <p>Routes affected: 101</p>
                </div>
            </div>
        "##;
        let posted = parse_posted_at("March 15, 2026", &Toronto, 2026).expect("posted date");

        let bounded = build_gtfs_entity(
            first_alert(html),
            0,
            parse_standard_route_tokens,
            Some(60),
            &Toronto,
        )
        .alert
        .expect("alert");
        let period = bounded.communication_period.first().expect("period");
        // Starts at the posting date, not the current time, and ends 60 minutes on.
        assert_eq!(period.start, Some(posted as u64));
        assert_eq!(period.end, Some((posted + 60 * 60) as u64));

        // A source that declares no max age is left alone.
        let unbounded = build_gtfs_entity(
            first_alert(html),
            0,
            parse_standard_route_tokens,
            None,
            &Toronto,
        )
        .alert
        .expect("alert");
        let period = unbounded.communication_period.first().expect("period");
        assert_eq!(period.start, Some(posted as u64));
        assert_eq!(period.end, None);
    }

    /// A stated period must survive the max age untouched, and a field stating
    /// only a retirement must retire on the date it names.
    #[test]
    fn test_stated_periods_override_max_age() {
        let html = r##"
            <div class="blogItem">
                <a class="newsTitle" href="/en/news/b.aspx">Route 101 detour</a>
                <div class="blogItem-contentContainer">
                    <div class="blogPostDate"><p>Posted on March 15, 2026</p></div>
                    <p>When: Monday, March 16, 2026 7:00 a.m. to Friday, March 20, 2026 6:00 p.m.</p>
                    <p>Routes affected: 101</p>
                </div>
            </div>
        "##;
        let alert = build_gtfs_entity(
            first_alert(html),
            0,
            parse_standard_route_tokens,
            Some(60),
            &Toronto,
        )
        .alert
        .expect("alert");
        let period = alert.communication_period.first().expect("period");
        assert!(period.end.is_some(), "stated end should survive");
        assert_ne!(period.start, Some(0));
        // The stated window is days long, so it cannot be the 60-minute fallback.
        assert!(period.end.unwrap() - period.start.unwrap() > 60 * 60);

        // A terminal preposition with nothing bounding a beginning ahead of it
        // terminates the only date the field names. The detour opened when it was
        // posted, so the posting date is its start and the named date is its end:
        // the max age never applies, and a 60-minute fallback would have retired
        // this advisory five months before the end it names.
        let posted = parse_posted_at("Aug 06, 2025", &Toronto, 2025).expect("posted date");
        for when in [
            // The live card, verbatim.
            "Extended until Thursday, December 31, 2026",
            "Extended through Thursday, December 31, 2026",
            "Extended up to Thursday, December 31, 2026",
            "Extended till Thursday, December 31, 2026",
        ] {
            let period = stated_period(when, "Aug 06, 2025", Some(60));
            assert_eq!(period.start, Some(posted as u64), "{when}");
            assert_eq!(
                local_wall_clock(period.end.expect("a stated end") as i64, &Toronto),
                "2026-12-31 23:59",
                "{when}"
            );
        }

        // The trap: the same preposition after a date states no end at all, so the
        // date is the start and the max age is what retires the advisory.
        let open_ended = stated_period(
            "Tuesday September 22, 2026 until further notice",
            "Sep 22, 2026",
            Some(20_160),
        );
        assert_eq!(
            local_wall_clock(open_ended.start.expect("a stated start") as i64, &Toronto),
            "2026-09-22 00:00"
        );
        let posted = parse_posted_at("Sep 22, 2026", &Toronto, 2026).expect("posted date");
        assert_eq!(
            open_ended.end,
            Some((posted + 20_160 * 60) as u64),
            "an unstated end is the max age, measured from the posting date"
        );
    }

    /// DRT states `When` with no year at all. Inheriting the posting date's year
    /// is what makes `September 9 to December 1, 2026` a real three-month window
    /// rather than a single December date, and what keeps the end after the start.
    #[test]
    fn test_yearless_period_dates_inherit_the_posting_year() {
        let html = r##"
            <li class="gs-feed-list-item">
                <a class="gs-feed-list-title" href="/news/posts/liberty-street/">Detour - Liberty Street</a>
                <span class="gs-feed-list-description">
                    <p><strong>When:</strong> Wednesday, September 9 to Tuesday, December 1, 2026</p>
                    <p><strong>Route:</strong> 502</p>
                </span>
                <span class="gs-feed-list-date">Sep 03, 2026</span>
            </li>
        "##;
        let alert = build_gtfs_entity(
            first_alert(html),
            0,
            parse_standard_route_tokens,
            Some(20_160),
            &Toronto,
        )
        .alert
        .expect("alert");
        let period = alert.communication_period.first().expect("period");
        let start = DateTime::from_timestamp(period.start.unwrap() as i64, 0).expect("start");
        let end = DateTime::from_timestamp(period.end.unwrap() as i64, 0).expect("end");
        assert_eq!(
            start.with_timezone(&Toronto).format("%Y-%m-%d").to_string(),
            "2026-09-09"
        );
        assert_eq!(
            end.with_timezone(&Toronto).format("%Y-%m-%d").to_string(),
            "2026-12-01"
        );
    }

    #[test]
    fn test_accordion_yearless_dates_use_nearest_year_and_stated_weekday() {
        let now = DateTime::parse_from_rfc3339("2027-06-15T16:00:00Z")
            .expect("fixed instant")
            .timestamp();
        assert_eq!(
            start_year_for("Beginning Monday, October 5", now, &Toronto),
            2026
        );
        assert_eq!(
            start_year_for("Beginning Tuesday, November 3", now, &Toronto),
            2026
        );
        assert_eq!(
            start_year_for("Beginning November 3", now, &Toronto),
            2027,
            "without a year or weekday, the nearest occurrence is the only available heuristic"
        );
    }

    /// The news module paginates through `.pagination-container`; the feed-list
    /// template paginates through a `ul.pagination` inside `nav#pagination`.
    /// One behaviour, both templates.
    #[test]
    fn test_pagination_extraction_covers_both_templates() {
        let urls = extract_pagination_links(
            FIXTURE_HTML,
            "https://example.com/Modules/News/en/serviceadvisories",
        );
        assert_eq!(
            urls,
            vec![
                "https://example.com/Modules/News/en/serviceadvisories?page=2",
                "https://example.com/Modules/News/en/serviceadvisories?page=3",
            ]
        );

        let feed_list = r##"
            <li class="gs-feed-list-item">
                <a class="gs-feed-list-title" href="/news/posts/a/">Detour - a</a>
            </li>
            <nav id="pagination" aria-label="Pagination">
                <ul class="pagination justify-content-center">
                    <li class="page-item active"><a href="/news/service-alerts-and-detours/?page=1">1</a></li>
                    <li class="page-item"><a href="/news/service-alerts-and-detours/?page=2">2</a></li>
                </ul>
            </nav>
        "##;
        assert_eq!(
            extract_pagination_links(
                feed_list,
                "https://www.durhamregiontransit.com/news/service-alerts-and-detours/",
            ),
            vec![
                "https://www.durhamregiontransit.com/news/service-alerts-and-detours/?page=1",
                "https://www.durhamregiontransit.com/news/service-alerts-and-detours/?page=2",
            ]
        );
    }

    /// Both templates' label spellings must reach the same canonical fields, so
    /// one shared vocabulary covers both.
    #[test]
    fn test_field_extraction_covers_both_templates() {
        let fields = parse_labeled_fields(
            "When: Tomorrow\nRoutes affected: 522\nDetour: Left on Main\nStop missed: 401",
        );
        assert_eq!(fields.get("when"), Some(&"Tomorrow".to_string()));
        assert_eq!(fields.get("routes"), Some(&"522".to_string()));
        assert_eq!(fields.get("detour"), Some(&"Left on Main".to_string()));
        assert_eq!(fields.get("stops"), Some(&"401".to_string()));

        let feed_list = parse_labeled_fields(
            "When: Tuesday September 22, 2026 until further notice\nRoutes: 905, 920\nReason: construction\nStop: 458 - Rossland Westbound @ Thickson",
        );
        assert_eq!(
            feed_list.get("when"),
            Some(&"Tuesday September 22, 2026 until further notice".to_string())
        );
        assert_eq!(feed_list.get("routes"), Some(&"905, 920".to_string()));
        assert_eq!(feed_list.get("reason"), Some(&"construction".to_string()));
        assert_eq!(
            feed_list.get("stops"),
            Some(&"458 - Rossland Westbound @ Thickson".to_string())
        );

        // `Route(s):` is a third spelling the feed list uses.
        let plural = parse_labeled_fields("Route(s): 421");
        assert_eq!(plural.get("routes"), Some(&"421".to_string()));
    }

    /// A label with no value adopts the lines after it, which is where YRT puts
    /// a detour's detail. A label that already has a value does not, which is
    /// what keeps a DRT route list from swallowing the prose beneath it and
    /// reading that prose's dates and stop numbers as route ids.
    #[test]
    fn test_an_empty_label_adopts_the_lines_after_it() {
        let empty_label = parse_labeled_fields(
            "Routes affected: 24 - Woodbine\nDetour:\nbuses detour via Highway 7",
        );
        assert_eq!(
            empty_label.get("routes"),
            Some(&"24 - Woodbine".to_string())
        );
        assert_eq!(
            empty_label.get("detour"),
            Some(&"buses detour via Highway 7".to_string())
        );

        let filled_label = parse_labeled_fields(
            "Routes: 905, 920\nEffective Tuesday September 22, 2026, bus stop #94191 is closed",
        );
        assert_eq!(filled_label.get("routes"), Some(&"905, 920".to_string()));
    }

    /// A bare label takes a value, not a sentence. `Route 91 will detour …` is a
    /// clause whose subject happens to be a route, and adopting it would put a
    /// whole detour sentence into the route list; `Route 50 –…` and
    /// `Stop #1608 - Kingston Rd Westbound` are values and are still read.
    ///
    /// This is what lets every agency read the whole shared vocabulary, so no
    /// operator needs a private subset of it. YRT publishes the bare `Route`
    /// spelling and this is the line that would otherwise be its phantom route.
    #[test]
    fn test_a_bare_label_reads_a_value_and_leaves_a_clause_alone() {
        for (line, expected) in [
            ("Route 91 will detour on westbound John Street", None),
            ("Route 50 – 24 - Woodbine", Some("50 – 24 - Woodbine")),
            ("Route 6/7 detour - Sept. 25", Some("6/7 detour - Sept. 25")),
            (
                "Stop #1608 - Kingston Rd Westbound",
                Some("#1608 - Kingston Rd Westbound"),
            ),
            (
                "Stops 2885, 2886 will be missed.",
                Some("2885, 2886 will be missed."),
            ),
        ] {
            let fields = parse_labeled_fields(line);
            let read = fields
                .get("routes")
                .or_else(|| fields.get("stops"))
                .map(String::as_str);
            assert_eq!(read, expected, "{line}");
        }
    }

    #[test]
    fn test_resolution_title_retires_advisory_at_start_and_clears_detour() {
        const HTML: &str = r##"
            <div class="blogItem">
                <a class="newsTitle" href="/alerts/route-58-ended">Emergency detour ended on Route 58</a>
                <div class="blogItem-contentContainer">
                    <p>Posted on September 28, 2026</p>
                    <p>The emergency detour on Route 58 has ended.</p>
                </div>
            </div>
        "##;
        let items = parse_ghd_blog_items(HTML);
        assert_eq!(items.len(), 1);
        let entity = build_gtfs_entity(
            items.into_iter().next().unwrap(),
            0,
            parse_standard_route_tokens,
            Some(20_160),
            &Toronto,
        );
        let alert = entity.alert.expect("alert exists");
        let period = alert.communication_period.first().expect("period exists");
        assert_eq!(period.end, period.start);
        assert_ne!(alert.effect(), Effect::Detour);
    }

    /// `N1` is outside the shared route-token vocabulary, so the daemon and the
    /// Core decoder both drop it rather than one inventing a route the other
    /// does not. `905C` and four-digit stop numbers stay on the right side.
    #[test]
    fn test_route_tokens_keep_prose_numbers_off_both_sides() {
        let routes = parse_standard_route_tokens("900, 920, N1 and 618, 905C");
        assert_eq!(routes, vec!["900", "920", "618", "905C"]);

        // A stop number reaches the alert only next to the word that names it,
        // so `Stop #1608` and the `stop #94191` in prose are picked up while the
        // four-digit numbers around them stay out of the route list.
        let stops = extract_stop_ids("Stop #1608 is relocated; stop #94191 is closed.");
        assert_eq!(stops, vec!["1608", "94191"]);
    }

    #[test]
    fn test_parse_ghd_blog_items_and_build_entity() {
        let items = parse_ghd_blog_items(FIXTURE_HTML);
        assert_eq!(items.len(), 1);
        let item = items.into_iter().next().unwrap();
        assert_eq!(item.title, "Route 101 and 77A detour");

        let entity =
            build_gtfs_entity(item, 0, parse_standard_route_tokens, Some(10_080), &Toronto);
        let alert = entity.alert.expect("Alert should be present");
        assert_eq!(alert.effect, Some(Effect::Detour as i32));
        assert_eq!(alert.cause, Some(Cause::Construction as i32));

        let routes: Vec<&str> = alert
            .informed_entity
            .iter()
            .filter_map(|e| e.route_id.as_deref())
            .collect();
        assert_eq!(routes, vec!["101", "77A"]);

        let stops: Vec<&str> = alert
            .informed_entity
            .iter()
            .filter_map(|e| e.stop_id.as_deref())
            .collect();
        assert_eq!(stops, vec!["9001", "9002", "9003"]);
    }

    fn accordion_board(title: &str, body_line: &str) -> String {
        format!(
            r##"<section class="usn_cmp_anchoredaccordion"><div class="anchored-accordion"><p class="tab"><a class="anchored-accordion-item" href="#collapse_1">{title}</a></p><div class="repeatable-content"><div class="text"><p>{body_line}</p></div></div></div></section>"##
        )
    }

    fn accordion_entity(title: &str, body_line: &str, now: i64) -> FeedEntity {
        let mut item = parse_ghd_page(&accordion_board(title, body_line))
            .expect("a recognized accordion board")
            .into_iter()
            .next()
            .expect("one item");
        resolve_item_identity(&mut item, "https://example.test/alerts/");
        build_gtfs_entity_at(item, 0, parse_standard_route_tokens, None, &Toronto, now)
    }

    #[test]
    fn test_accordion_items_keep_one_identity_across_the_new_marker() {
        let now = 1_790_611_200;
        let with_marker = accordion_entity(
            "Beverly detour (Route 15) - NEW",
            "Beginning Monday, October 5",
            now,
        );
        let without_marker = accordion_entity(
            "Beverly detour (Route 15)",
            "Beginning Monday, October 5",
            now,
        );
        assert_eq!(
            with_marker.id,
            "https://example.test/alerts/#beverly-detour-route-15"
        );
        assert_eq!(without_marker.id, with_marker.id);
    }

    #[test]
    fn test_accordion_dates_without_a_year_take_the_nearest_year() {
        let start = |line: &str, now: i64| {
            accordion_entity("Detour", line, now)
                .alert
                .expect("an alert")
                .communication_period[0]
                .start
                .expect("a start")
        };
        // 2027-01-03 12:00 EST and 2026-12-28 12:00 EST.
        let after_new_year = 1_799_000_400;
        let before_new_year = 1_798_473_600;
        // 2026-12-28 and 2027-01-04 at midnight in Toronto.
        assert_eq!(
            start("Beginning Monday, December 28", after_new_year),
            1_798_434_000
        );
        assert_eq!(
            start("Beginning Monday, January 4", before_new_year),
            1_799_038_800
        );
        assert_eq!(
            start("Beginning Monday, June 22, 2026", after_new_year),
            1_782_100_800
        );
    }

    #[test]
    fn test_accordion_route_phrases_name_only_the_routes_they_state() {
        for (line, expected) in [
            ("Route 12 and Route 5 detour", vec!["12", "5"]),
            ("Routes 1/2/11/13 will detour.", vec!["1", "2", "11", "13"]),
            (
                "Routes 12 East End and 16 Balmoral will operate on detour.",
                vec!["12", "16"],
            ),
            ("Route Changes", vec![]),
            (
                "Route 15 will not operate along 2nd Street, 12 times a day.",
                vec!["15"],
            ),
            (
                "Routes 12 and 16 run. Also see 20 and 22.",
                vec!["12", "16"],
            ),
            ("Stop 1869 on Highway 11 near 3 Bridge Street", vec![]),
        ] {
            let routes: Vec<String> = accordion_entity("Notice", line, 1_790_611_200)
                .alert
                .expect("an alert")
                .informed_entity
                .iter()
                .filter_map(|selector| selector.route_id.clone())
                .collect();
            assert_eq!(routes, expected, "{line}");
        }
    }

    #[test]
    fn test_accordion_prose_states_a_detour_or_no_effect_never_a_delay_or_cancellation() {
        let effect = |title: &str, line: &str| {
            accordion_entity(title, line, 1_790_611_200)
                .alert
                .expect("an alert")
                .effect
        };
        assert_eq!(
            effect("Route 5 detour", "Beginning Monday, October 5"),
            Some(Effect::Detour as i32)
        );
        for title in ["Route 5 delays", "Route 5 trips cancelled"] {
            assert_eq!(
                effect(title, "Beginning Monday, October 5"),
                Some(Effect::UnknownEffect as i32),
                "{title}"
            );
        }
    }

    #[test]
    fn test_an_accordion_board_is_missing_or_empty_never_silently_clear() {
        let page = include_str!(
            "../../../../tests/fixtures/ghd-news/thunderbay-anchored-accordion-empty.html"
        );
        assert_eq!(
            parse_ghd_page(page)
                .expect("the operator's empty board")
                .len(),
            0
        );

        let heading_removed = page.replace("Transit Detours and Service Alerts", "Something else");
        assert!(parse_ghd_page(&heading_removed).is_err());

        let section_renamed = page.replace("usn_cmp_anchoredaccordion", "usn_cmp_redesigned");
        assert!(parse_ghd_page(&section_renamed).is_err());
    }

    // ---------------------------------------------------------------------
    // Cross-language parity
    //
    // `tests/fixtures/ghd-news/contract.json` is one shared expectation read by
    // this test and by `tests/unit/ghd-news-parity.test.ts`. Both suites feed
    // their own parser the same recorded pages and must produce the same alerts,
    // so a template or rule change that lands in one language and not the other
    // fails CI instead of drifting silently.
    // ---------------------------------------------------------------------

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ParityContract {
        time_zone: String,
        /// The fixed clock both implementations decode against, in epoch
        /// milliseconds, so a page that states no posting date reads identically.
        now: i64,
        variants: Vec<ParityVariant>,
        /// The accordion board decoded at several clocks, pinning its yearless-date rule.
        accordion_clocks: AccordionClocks,
        recognized_empty_pages: Vec<String>,
        unsupported_pages: Vec<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ParityVariant {
        file: String,
        /// The age the agency that publishes this page actually ships, so the
        /// contract asserts each shipped policy rather than one shared fiction.
        max_age_minutes: Option<u64>,
        /// Names items that carry no link of their own, so it is part of their identity.
        page_url: Option<String>,
        alerts: Vec<ParityAlert>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AccordionClocks {
        file: String,
        page_url: String,
        clocks: Vec<AccordionClock>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AccordionClock {
        now: i64,
        alerts: Vec<ParityAlert>,
    }

    #[derive(Deserialize, Debug, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    struct ParityAlert {
        id: String,
        title: String,
        route_ids: Vec<String>,
        stop_ids: Vec<String>,
        /// The GTFS-RT effect name, or `None` when the decoder states none.
        effect: Option<String>,
        starts_at: u64,
        ends_at: u64,
    }

    /// Decodes a page the way the daemon serves it, projected onto what the
    /// shared contract compares.
    fn parity_alerts(
        html: &str,
        page_url: Option<&str>,
        max_age_minutes: Option<u64>,
        time_zone: &Tz,
        now_ms: i64,
        label: &str,
    ) -> Vec<ParityAlert> {
        parse_ghd_page(html)
            .expect("card fixture is a recognized GHD board")
            .into_iter()
            .enumerate()
            .map(|(index, mut item)| {
                resolve_item_identity(&mut item, page_url.unwrap_or("https://ghd.invalid/"));
                let entity = build_gtfs_entity_at(
                    item,
                    index,
                    parse_standard_route_tokens,
                    max_age_minutes,
                    time_zone,
                    now_ms / 1000,
                );
                let alert = entity.alert.expect("every card produces an alert");
                let period = alert
                    .communication_period
                    .first()
                    .cloned()
                    .unwrap_or_default();
                // A retirement earlier than the advisory's own start would make
                // the alert dead the moment it was published, which is what the
                // declared max age has to outlast.
                assert!(
                    period
                        .end
                        .is_none_or(|end| end >= period.start.unwrap_or(0)),
                    "{label} produced an end before its start"
                );
                ParityAlert {
                    id: entity.id,
                    title: alert
                        .header_text
                        .and_then(|header| header.translation.first().map(|t| t.text.clone()))
                        .unwrap_or_default(),
                    route_ids: alert
                        .informed_entity
                        .iter()
                        .filter_map(|selector| selector.route_id.clone())
                        .collect(),
                    stop_ids: alert
                        .informed_entity
                        .iter()
                        .filter_map(|selector| selector.stop_id.clone())
                        .collect(),
                    effect: alert
                        .effect
                        .and_then(|effect| Effect::try_from(effect).ok())
                        .filter(|effect| *effect != Effect::UnknownEffect)
                        .map(|effect| effect.as_str_name().to_string()),
                    // The contract is written in milliseconds, the unit both
                    // implementations share at the HTTP boundary.
                    starts_at: period.start.unwrap_or(0) * 1000,
                    ends_at: period.end.unwrap_or(0) * 1000,
                }
            })
            .collect()
    }

    #[test]
    fn test_matches_the_shared_parity_contract() {
        let contract_path = fixture_contract_path();
        let dir = contract_path
            .parent()
            .expect("contract has a directory")
            .to_path_buf();
        let contract: ParityContract =
            serde_json::from_str(&std::fs::read_to_string(contract_path).unwrap())
                .expect("parse the shared parity contract");
        let time_zone: Tz = contract.time_zone.parse().expect("a known time zone");

        assert!(
            contract.variants.len() >= 3,
            "the contract must cover all three live templates"
        );
        // Each agency ships its own policy, so the contract has to carry one per
        // variant: a single shared number would assert agreement on an age no
        // agency runs, and the whole point of a max age is that it is a policy.
        for variant in &contract.variants {
            assert!(
                !variant.alerts.is_empty(),
                "fixture {} decoded to nothing",
                variant.file
            );
        }

        for variant in &contract.variants {
            let html = std::fs::read_to_string(dir.join(&variant.file)).expect("read the fixture");
            let actual = parity_alerts(
                &html,
                variant.page_url.as_deref(),
                variant.max_age_minutes,
                &time_zone,
                contract.now,
                &variant.file,
            );

            assert_eq!(actual, variant.alerts, "fixture {}", variant.file);
        }

        let accordion_html = std::fs::read_to_string(dir.join(&contract.accordion_clocks.file))
            .expect("read the accordion fixture");
        for clock in &contract.accordion_clocks.clocks {
            assert_eq!(
                parity_alerts(
                    &accordion_html,
                    Some(&contract.accordion_clocks.page_url),
                    None,
                    &time_zone,
                    clock.now,
                    &contract.accordion_clocks.file,
                ),
                clock.alerts,
                "accordion board at clock {}",
                clock.now
            );
        }

        for file in &contract.recognized_empty_pages {
            let html = std::fs::read_to_string(dir.join(file)).expect("read empty-board fixture");
            assert!(
                parse_ghd_page(&html)
                    .expect("verified empty board is recognized")
                    .is_empty(),
                "recognized empty fixture {file} produced advisories"
            );
        }

        for file in &contract.unsupported_pages {
            let html = std::fs::read_to_string(dir.join(file)).expect("read unsupported fixture");
            assert!(
                parse_ghd_page(&html).is_err(),
                "unsupported fixture {file} must not decode as an empty board"
            );
        }
    }

    #[tokio::test]
    async fn test_linked_holiday_articles_share_the_bounded_crawl() {
        use axum::{Router, routing::get};
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/ghd-news/linked-article.json"
        ))
        .unwrap();
        for failed in [false, true] {
            let board = fixture["board"].as_str().unwrap().to_string();
            let article = fixture["article"].as_str().unwrap().to_string();
            let app = Router::new()
                .route(
                    "/",
                    get(move || {
                        let body = board.clone();
                        async move { body }
                    }),
                )
                .route(
                    "/holiday",
                    get(move || {
                        let body = article.clone();
                        async move {
                            (
                                if failed {
                                    axum::http::StatusCode::SERVICE_UNAVAILABLE
                                } else {
                                    axum::http::StatusCode::OK
                                },
                                body,
                            )
                        }
                    }),
                );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/", listener.local_addr().unwrap());
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let outcome = scrape_ghd_feed(
                &crate::upstream::Client::new(),
                GhdScrapeConfig {
                    advisories_url: &url,
                    route_extractor: parse_standard_route_tokens,
                    max_age_minutes: Some(1440),
                    time_zone: &Toronto,
                },
            )
            .await
            .unwrap();
            server.abort();
            assert_eq!(outcome.partial, failed);
            let feed = FeedMessage::decode(outcome.bytes).unwrap();
            if failed {
                assert!(feed.entity.is_empty());
                continue;
            }
            assert_eq!(feed.entity.len(), 1);
            let alert = feed.entity[0].alert.as_ref().unwrap();
            assert_eq!(
                alert.description_text.as_ref().unwrap().translation[0].text,
                "City Transit\nThere will be no City Transit service on Monday, October 12."
            );
            assert_eq!(
                alert.communication_period[0].start.unwrap() * 1000,
                fixture["startsAt"].as_u64().unwrap()
            );
            assert_eq!(
                alert.communication_period[0].end.unwrap() * 1000,
                fixture["endsAt"].as_u64().unwrap()
            );
        }
    }
    #[tokio::test]
    async fn test_an_unsupported_200_first_page_fails_instead_of_serving_an_empty_feed() {
        use axum::{Router, routing::get};

        const CHALLENGE: &str = r#"<!doctype html><html><head><title>Just a moment...</title></head><body><h1>Checking your browser</h1><script>challenge()</script></body></html>"#;
        let app = Router::new().route("/", get(|| async { CHALLENGE }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback");
        let base_url = format!("http://{}", listener.local_addr().expect("local address"));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let advisories_url = format!("{base_url}/");
        let outcome = scrape_ghd_feed(
            &crate::upstream::Client::new(),
            GhdScrapeConfig {
                advisories_url: &advisories_url,
                route_extractor: parse_standard_route_tokens,
                max_age_minutes: Some(20_160),
                time_zone: &Toronto,
            },
        )
        .await;

        assert!(
            outcome.is_err(),
            "an unrecognized successful HTTP response must not become a live empty feed"
        );
    }

    #[tokio::test]
    async fn test_an_unsupported_subpage_marks_partial_and_does_not_seed_its_links() {
        use axum::{Router, routing::get};
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        const PAGE_ONE: &str = r#"<div class="blogItem"><a class="newsTitle" href="/one">Route 101 detour</a><div class="blogItem-contentContainer">Routes affected: 101</div></div><div class="pagination-container"><a href="/challenge">2</a></div>"#;
        const CHALLENGE: &str = r#"<!doctype html><html><head><title>Just a moment...</title></head><body><h1>Checking your browser</h1><div class="pagination-container"><a href="/must-not-follow">3</a></div></body></html>"#;
        const PAGE_THREE: &str = r#"<div class="blogItem"><a class="newsTitle" href="/three">Route 303 detour</a><div class="blogItem-contentContainer">Routes affected: 303</div></div>"#;

        let requests = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&requests);
        let app = Router::new()
            .route("/", get(|| async { PAGE_ONE }))
            .route("/challenge", get(|| async { CHALLENGE }))
            .route(
                "/must-not-follow",
                get(move || {
                    observed.fetch_add(1, Ordering::SeqCst);
                    async { PAGE_THREE }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback");
        let base_url = format!("http://{}", listener.local_addr().expect("local address"));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let advisories_url = format!("{base_url}/");
        let outcome = scrape_ghd_feed(
            &crate::upstream::Client::new(),
            GhdScrapeConfig {
                advisories_url: &advisories_url,
                route_extractor: parse_standard_route_tokens,
                max_age_minutes: Some(20_160),
                time_zone: &Toronto,
            },
        )
        .await
        .expect("the supported first page remains available");

        assert!(
            outcome.partial,
            "an unsupported subpage makes the crawl incomplete"
        );
        assert_eq!(
            requests.load(Ordering::SeqCst),
            0,
            "challenge links are ignored"
        );
        let message = FeedMessage::decode(outcome.bytes).expect("a serialized feed");
        let ids: Vec<&str> = message
            .entity
            .iter()
            .map(|entity| entity.id.as_str())
            .collect();
        assert_eq!(ids, vec!["/one"]);
    }

    /// A page that will not load costs that page and nothing else. `scrape_ghd_feed`
    /// is a network function, so this drives it against a real listener on
    /// loopback: the failing page's advisory is gone, the pages that read — before
    /// and after it — are still served, and the outcome says `partial` so the
    /// poller hands it out stale rather than as a complete feed.
    #[tokio::test]
    async fn test_a_failed_subpage_costs_that_page_and_marks_the_crawl_partial() {
        use axum::{Router, http::StatusCode, routing::get};

        const PAGE_ONE: &str = r##"
            <div class="blogItem">
                <a class="newsTitle" href="/en/news/one.aspx">Route 101 detour</a>
                <div class="blogItem-contentContainer">
                    <p>Routes affected: 101</p>
                </div>
            </div>
            <div class="pagination-container">
                <a href="/page2">2</a>
                <a href="/page3">3</a>
            </div>
        "##;
        const PAGE_THREE: &str = r##"
            <div class="blogItem">
                <a class="newsTitle" href="/en/news/three.aspx">Route 303 detour</a>
                <div class="blogItem-contentContainer">
                    <p>Routes affected: 303</p>
                </div>
            </div>
        "##;

        let app = Router::new()
            .route("/", get(|| async { PAGE_ONE }))
            .route(
                "/page2",
                get(|| async { (StatusCode::INTERNAL_SERVER_ERROR, "boom") }),
            )
            .route("/page3", get(|| async { PAGE_THREE }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback");
        let base_url = format!("http://{}", listener.local_addr().expect("local address"));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let advisories_url = format!("{base_url}/");
        let outcome = scrape_ghd_feed(
            &crate::upstream::Client::new(),
            GhdScrapeConfig {
                advisories_url: &advisories_url,
                route_extractor: parse_standard_route_tokens,
                max_age_minutes: Some(20_160),
                time_zone: &Toronto,
            },
        )
        .await
        .expect("the first page read, so the crawl finishes");

        assert!(
            outcome.partial,
            "a page that returned 500 leaves the feed short and the poller has to say so"
        );
        let message = FeedMessage::decode(outcome.bytes).expect("a serialized feed");
        let mut ids: Vec<&str> = message
            .entity
            .iter()
            .map(|entity| entity.id.as_str())
            .collect();
        ids.sort_unstable();
        assert_eq!(ids, vec!["/en/news/one.aspx", "/en/news/three.aspx"]);
    }

    #[tokio::test]
    async fn test_trailing_slash_page_identity_prevents_a_second_fetch() {
        use axum::{Router, extract::Path, response::IntoResponse, routing::get};
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        let requests = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&requests);
        let app = Router::new().route(
            "/{*path}",
            get(move |Path(_path): Path<String>| {
                observed.fetch_add(1, Ordering::SeqCst);
                async move {
                    r#"<section class="content component listing-component usn_cmp_newsfeed"><p>No articles were found.</p></section><div class="pagination-container"><a href="/board/">same page</a></div>"#
                        .into_response()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback");
        let base_url = format!("http://{}", listener.local_addr().expect("local address"));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let advisories_url = format!("{base_url}/board");
        let outcome = scrape_ghd_feed(
            &crate::upstream::Client::new(),
            GhdScrapeConfig {
                advisories_url: &advisories_url,
                route_extractor: parse_standard_route_tokens,
                max_age_minutes: None,
                time_zone: &Toronto,
            },
        )
        .await
        .expect("the first page read");

        assert!(!outcome.partial);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn test_crawl_ceiling_counts_failed_page_attempts_and_marks_unread_pages_partial() {
        use axum::{Router, extract::Path, http::StatusCode, response::IntoResponse, routing::get};
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        let requests = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&requests);
        let links = (2..=12)
            .map(|page| format!("<a href=\"/{page}\">{page}</a>"))
            .collect::<String>();
        let first_page = format!(
            "<section class=\"content component listing-component usn_cmp_newsfeed\"><p>No articles were found.</p></section><div class=\"pagination-container\">{links}</div>"
        );
        let app = Router::new().route(
            "/{page}",
            get(move |Path(page): Path<String>| {
                observed.fetch_add(1, Ordering::SeqCst);
                let first_page = first_page.clone();
                async move {
                    if page == "1" {
                        first_page.into_response()
                    } else {
                        (StatusCode::INTERNAL_SERVER_ERROR, "unavailable").into_response()
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback");
        let base_url = format!("http://{}", listener.local_addr().expect("local address"));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let advisories_url = format!("{base_url}/1");
        let outcome = scrape_ghd_feed(
            &crate::upstream::Client::new(),
            GhdScrapeConfig {
                advisories_url: &advisories_url,
                route_extractor: parse_standard_route_tokens,
                max_age_minutes: None,
                time_zone: &Toronto,
            },
        )
        .await
        .expect("first page succeeds");

        assert!(outcome.partial, "queued pages past the cap were not read");
        assert_eq!(requests.load(Ordering::SeqCst), MAX_CRAWL_PAGES);
    }
}
