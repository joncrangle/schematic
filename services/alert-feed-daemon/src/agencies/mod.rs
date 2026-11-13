use arc_swap::ArcSwap;
use axum::{
    Router,
    extract::Path,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use bytes::Bytes;
use std::{collections::HashMap, env, fs, future::Future, pin::Pin, sync::Arc, time::Duration};

pub mod drt;
pub mod milton;
pub mod registry;
pub mod yrt;

#[derive(Clone, Default, Debug)]
pub struct FeedEntry {
    pub last_attempt_secs: Option<u64>,
    pub last_failure: Option<crate::upstream::Failure>,
    pub partial: bool,
    pub bytes: Bytes,
    pub etag: String,
    pub last_success_secs: u64,
    pub is_stale: bool,
    pub content_type: &'static str,
}

/// One poll's result. `partial` marks a crawl that finished but lost a page: the
/// entities that did decode are real, so they are still served, and the entry is
/// flagged stale so a short read is never handed out as a complete feed. This is
/// the same verdict Core reaches through a partially read web source.
#[derive(Debug)]
pub struct ScrapeOutcome {
    pub bytes: Bytes,
    pub partial: bool,
    pub content_type: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndpointFormat {
    Protobuf,
    Xml,
    Json,
}

#[derive(Clone)]
pub struct FeedHandle {
    pub buffer: Arc<ArcSwap<FeedEntry>>,
    pub max_staleness_secs: u64,
    pub format: EndpointFormat,
}

pub type SharedFeedMap = Arc<HashMap<String, FeedHandle>>;

pub type ScrapeFuture = Pin<
    Box<
        dyn Future<Output = Result<ScrapeOutcome, Box<dyn std::error::Error + Send + Sync>>> + Send,
    >,
>;

pub fn compute_etag(bytes: &[u8]) -> String {
    use std::hash::{DefaultHasher, Hasher};
    let mut hasher = DefaultHasher::new();
    hasher.write(bytes);
    format!("\"{:016x}\"", hasher.finish())
}

pub fn current_epoch_secs() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Loads a mounted JSON registry when `ALERT_FEED_CONFIG` is set. Native runs
/// without that override keep using the registry bundled with the binary.
pub fn load_registry_config() -> Result<registry::ConfiguredRegistry, String> {
    let raw = match env::var("ALERT_FEED_CONFIG") {
        Ok(path) => fs::read_to_string(&path)
            .map_err(|error| format!("could not read ALERT_FEED_CONFIG {path:?}: {error}"))?,
        Err(env::VarError::NotPresent) => include_str!("../../feeds.json").to_string(),
        Err(error) => return Err(format!("ALERT_FEED_CONFIG is not valid Unicode: {error}")),
    };
    let poll_interval = optional_env("POLL_INTERVAL_SECS")?;
    let max_staleness = optional_env("MAX_STALENESS_SECS")?;
    registry::parse_registry_config(&raw, poll_interval.as_deref(), max_staleness.as_deref())
}

fn optional_env(name: &str) -> Result<Option<String>, String> {
    match env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => Err(format!("{name} is not valid Unicode")),
    }
}

/// Spawns configured background pollers and returns the shared feed lookup map.
pub fn spawn_pollers(
    client: crate::upstream::Client,
    registry: registry::ConfiguredRegistry,
) -> Result<SharedFeedMap, reqwest::Error> {
    let mut feeds = HashMap::with_capacity(registry.feeds.len());

    for feed in registry.feeds {
        let buffer = Arc::new(ArcSwap::from_pointee(FeedEntry::default()));
        let format = match &feed.parser {
            registry::ConfiguredParser::GhdNewsServiceAdvisories { .. }
            | registry::ConfiguredParser::GtfsRtProtobuf => EndpointFormat::Protobuf,
            registry::ConfiguredParser::Rss => EndpointFormat::Xml,
            registry::ConfiguredParser::ZenbusMessages { .. }
            | registry::ConfiguredParser::TripSparkAdvisories { .. }
            | registry::ConfiguredParser::GtfsRtJson
            | registry::ConfiguredParser::GenericAlertFeed
            | registry::ConfiguredParser::HeadingServiceNotices { .. }
            | registry::ConfiguredParser::ServiceAnnouncementBoard { .. }
            | registry::ConfiguredParser::RouteNoticeIndex { .. }
            | registry::ConfiguredParser::StopClosureTable { .. }
            | registry::ConfiguredParser::DisruptionDetailsTable { .. }
            | registry::ConfiguredParser::RouteStatusTable { .. }
            | registry::ConfiguredParser::RouteStationAdvisories { .. }
            | registry::ConfiguredParser::VendorJson { .. }
            | registry::ConfiguredParser::AnyRideMessages(_) => EndpointFormat::Json,
        };
        let handle = FeedHandle {
            buffer: Arc::clone(&buffer),
            max_staleness_secs: feed.max_staleness_secs,
            format,
        };
        feeds.insert(feed.id.clone(), handle);
        spawn_poller(client.clone(), feed, buffer);
    }

    Ok(Arc::new(feeds))
}

/// Generic poll runner: keeps agency polling isolated without boilerplate
fn spawn_poller(
    client: crate::upstream::Client,
    feed: registry::ConfiguredFeed,
    buffer: Arc<ArcSwap<FeedEntry>>,
) {
    let id = feed.id.clone();
    let interval_secs = feed.poll_interval_secs;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(interval_secs));
        loop {
            interval.tick().await;
            let mut attempt = (**buffer.load()).clone();
            attempt.last_attempt_secs = Some(current_epoch_secs());
            buffer.store(Arc::new(attempt));
            match scrape_configured_feed(client.clone(), feed.clone()).await {
                Ok(outcome) => {
                    let etag = compute_etag(&outcome.bytes);
                    let now = current_epoch_secs();
                    buffer.store(Arc::new(FeedEntry {
                        last_attempt_secs: buffer.load().last_attempt_secs,
                        last_failure: None,
                        partial: outcome.partial,
                        bytes: outcome.bytes,
                        etag,
                        last_success_secs: now,
                        // A crawl that lost a page is served, because the pages it
                        // did read are real, but as stale: the board is missing
                        // advisories and the consumer has to be told.
                        is_stale: outcome.partial,
                        content_type: outcome.content_type,
                    }));
                    eprintln!(
                        "[{id}] Feed updated{}",
                        if outcome.partial {
                            " (partial: some pages unread)"
                        } else {
                            ""
                        }
                    );
                }
                Err(err) => {
                    let failure = classify_failure(err.as_ref());
                    let mut updated = (**buffer.load()).clone();
                    updated.is_stale = true;
                    updated.last_failure = Some(failure);
                    buffer.store(Arc::new(updated));
                    eprintln!("[{id}] Poll failed: {failure}");
                }
            }
        }
    });
}

/// Builds the agency router mountable by main
pub fn router(feeds: SharedFeedMap) -> Router {
    Router::new()
        .route("/status", get(serve_status))
        .route("/{*path}", get(serve_feed))
        .with_state(feeds)
}

fn classify_failure(error: &(dyn std::error::Error + 'static)) -> crate::upstream::Failure {
    use crate::upstream::Failure;
    if let Some(failure) = error.downcast_ref::<Failure>() {
        return *failure;
    }
    if let Some(error) = error.downcast_ref::<reqwest::Error>() {
        return if error.status().is_some() {
            Failure::Http
        } else {
            Failure::Transport
        };
    }
    Failure::Upstream
}

async fn serve_status(
    axum::extract::State(feeds): axum::extract::State<SharedFeedMap>,
) -> impl IntoResponse {
    let now = current_epoch_secs();
    let mut ids: Vec<_> = feeds.keys().collect();
    ids.sort();
    let status: Vec<_> = ids
        .into_iter()
        .map(|id| {
            let feed = &feeds[id];
            let entry = feed.buffer.load();
            let age =
                (!entry.bytes.is_empty()).then(|| now.saturating_sub(entry.last_success_secs));
            serde_json::json!({
                "id": id,
                "lastAttemptSecs": entry.last_attempt_secs,
                "lastSuccessSecs": age.map(|_| entry.last_success_secs),
                "cachedAgeSecs": age,
                "partial": entry.partial,
                "stale": entry.is_stale || age.is_none_or(|age| age > feed.max_staleness_secs),
                "lastFailure": entry.last_failure,
            })
        })
        .collect();
    (
        [(header::CACHE_CONTROL, "no-store")],
        axum::Json(serde_json::json!({ "feeds": status })),
    )
}

async fn serve_feed(
    Path(path): Path<String>,
    req_headers: axum::http::HeaderMap,
    axum::extract::State(feeds): axum::extract::State<SharedFeedMap>,
) -> Response {
    let clean_path = path.trim_matches('/');
    let file = clean_path.rsplit('/').next().unwrap_or(clean_path);
    let (agency, requested_format) = if let Some(agency) = file.strip_suffix(".pb") {
        (agency, Some(EndpointFormat::Protobuf))
    } else if let Some(agency) = file.strip_suffix(".xml") {
        (agency, Some(EndpointFormat::Xml))
    } else if let Some(agency) = file.strip_suffix(".json") {
        (agency, Some(EndpointFormat::Json))
    } else {
        (file, None)
    };

    let feed = match feeds.get(agency) {
        Some(feed) => feed,
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    if requested_format.is_some_and(|format| format != feed.format) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let entry = feed.buffer.load_full();

    if entry.bytes.is_empty() {
        return (StatusCode::SERVICE_UNAVAILABLE, "Feed initializing").into_response();
    }

    let now = current_epoch_secs();
    if now.saturating_sub(entry.last_success_secs) > feed.max_staleness_secs {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "Feed stale: upstream unreachable",
        )
            .into_response();
    }

    let mut response_headers = axum::http::HeaderMap::new();
    response_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=60"),
    );
    if let Ok(etag_val) = HeaderValue::from_str(&entry.etag) {
        response_headers.insert(header::ETAG, etag_val);
    }
    if entry.is_stale {
        response_headers.insert(
            header::WARNING,
            HeaderValue::from_static("110 - \"Response is Stale\""),
        );
    }

    // Check If-None-Match header for 304 Not Modified (supports exact, weak, wildcard, and comma-separated lists per RFC 7232 §3.2)
    if let Some(if_none_match) = req_headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
    {
        let weak_etag = format!("W/{}", entry.etag);
        let matches = if_none_match.split(',').any(|tag| {
            let t = tag.trim();
            t == "*" || t == entry.etag || t == weak_etag
        });
        if matches {
            return (StatusCode::NOT_MODIFIED, response_headers).into_response();
        }
    }

    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(entry.content_type),
    );

    (response_headers, entry.bytes.clone()).into_response()
}

fn scrape_configured_feed(
    client: crate::upstream::Client,
    feed: registry::ConfiguredFeed,
) -> ScrapeFuture {
    Box::pin(async move {
        let client = client.configured(feed.request.clone());
        match &feed.parser {
            registry::ConfiguredParser::ZenbusMessages {
                time_zone,
                stop_code_map,
            } => {
                crate::parsers::zenbus_messages::scrape(
                    &client,
                    &feed.upstream_url,
                    time_zone,
                    stop_code_map,
                )
                .await
            }
            registry::ConfiguredParser::TripSparkAdvisories {
                session_token_argument,
                excluded_news_ids,
            } => {
                crate::parsers::tripspark::scrape(
                    &client,
                    &feed.upstream_url,
                    *session_token_argument,
                    excluded_news_ids,
                )
                .await
            }
            registry::ConfiguredParser::GtfsRtProtobuf | registry::ConfiguredParser::GtfsRtJson => {
                crate::parsers::gtfs_relay::scrape(
                    &client,
                    &feed.upstream_url,
                    matches!(feed.parser, registry::ConfiguredParser::GtfsRtJson),
                )
                .await
            }
            registry::ConfiguredParser::GhdNewsServiceAdvisories {
                route_extractor,
                max_age_minutes,
                time_zone,
            } => {
                crate::parsers::ghd_news::scrape_ghd_feed(
                    &client,
                    crate::parsers::ghd_news::GhdScrapeConfig {
                        advisories_url: &feed.upstream_url,
                        route_extractor: *route_extractor,
                        max_age_minutes: *max_age_minutes,
                        time_zone,
                    },
                )
                .await
            }
            registry::ConfiguredParser::VendorJson { parser, body } => {
                crate::parsers::vendor_json::scrape(
                    &client,
                    &feed.upstream_url,
                    parser,
                    body.as_ref(),
                )
                .await
            }
            registry::ConfiguredParser::HeadingServiceNotices {
                time_zone,
                route_names,
                stop_names,
                publication_reference,
                clear_statement_names,
            } => {
                crate::parsers::heading_notices::scrape(
                    &client,
                    &feed.upstream_url,
                    route_names,
                    stop_names,
                    time_zone,
                    crate::parsers::heading_notices::SourceDeclarations {
                        publication_reference: publication_reference.as_ref(),
                        clear_statement_names,
                    },
                )
                .await
            }
            registry::ConfiguredParser::ServiceAnnouncementBoard { route_names } => {
                crate::parsers::service_announcements::scrape(
                    &client,
                    &feed.upstream_url,
                    route_names,
                )
                .await
            }
            registry::ConfiguredParser::RouteNoticeIndex { route_names } => {
                crate::parsers::route_notices::scrape(&client, &feed.upstream_url, route_names)
                    .await
            }
            registry::ConfiguredParser::StopClosureTable {
                time_zone,
                route_names,
            } => {
                crate::parsers::stop_closure_table::scrape(
                    &client,
                    &feed.upstream_url,
                    *time_zone,
                    route_names,
                )
                .await
            }
            registry::ConfiguredParser::DisruptionDetailsTable {
                time_zone,
                route_names,
            } => {
                crate::parsers::disruption_details_table::scrape(
                    &client,
                    &feed.upstream_url,
                    *time_zone,
                    route_names,
                )
                .await
            }
            registry::ConfiguredParser::RouteStatusTable { route_names } => {
                crate::parsers::route_status_table::scrape(&client, &feed.upstream_url, route_names)
                    .await
            }
            registry::ConfiguredParser::RouteStationAdvisories {
                time_zone,
                route_names,
            } => {
                crate::parsers::route_station_advisories::scrape(
                    &client,
                    &feed.upstream_url,
                    *time_zone,
                    route_names,
                )
                .await
            }
            registry::ConfiguredParser::GenericAlertFeed => {
                crate::parsers::generic_json::scrape_generic_json_feed(&client, &feed.upstream_url)
                    .await
            }
            registry::ConfiguredParser::AnyRideMessages(config) => {
                crate::parsers::anyride_messages::scrape_anyride_messages_feed(&client, config)
                    .await
            }
            registry::ConfiguredParser::Rss => {
                crate::parsers::rss::scrape_rss_feed(&client, &feed.upstream_url).await
            }
        }
    })
}
