use super::yrt;
use crate::parsers::anyride_messages::{
    AnyRideMessagesConfig, AnyRideProfile, MAX_POLLED_STOPS, MessageStop,
};
use crate::parsers::ghd_news::RouteExtractor;
use chrono::Datelike;
use chrono_tz::Tz;
use serde::Deserialize;
use std::{str::FromStr, time::Duration};

const DEFAULT_POLL_INTERVAL_SECS: u64 = 180;
const DEFAULT_MAX_STALENESS_SECS: u64 = 3_600;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryFile {
    #[serde(default)]
    defaults: RegistryDefaults,
    feeds: Vec<FeedFile>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryDefaults {
    poll_interval_secs: Option<u64>,
    max_staleness_secs: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FeedFile {
    id: String,
    parser: ParserKind,
    upstream_url: String,
    #[serde(default)]
    session_token_argument: PresentJsonValue,
    #[serde(default)]
    excluded_news_ids: PresentJsonValue,
    #[serde(default)]
    request_body: Option<serde_json::Value>,
    #[serde(default)]
    request: crate::upstream::RequestConfig,
    // Keep parser-specific keys as raw JSON values so RSS entries can reject
    // even explicit nulls for options that only make sense to GHD parsing.
    #[serde(default)]
    route_parser: PresentJsonValue,
    #[serde(default)]
    route_names: PresentJsonValue,
    #[serde(default)]
    stop_names: PresentJsonValue,
    #[serde(default)]
    stop_code_map: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default)]
    publication_reference: PresentJsonValue,
    #[serde(default)]
    clear_statement_names: PresentJsonValue,
    #[serde(default)]
    time_zone: PresentJsonValue,
    #[serde(default = "enabled_by_default")]
    enabled: bool,
    #[serde(default)]
    max_age_minutes: PresentJsonValue,
    // AnyRide message options, kept raw so other parsers can reject them.
    #[serde(default)]
    operator_prefix: PresentJsonValue,
    #[serde(default)]
    profile: PresentJsonValue,
    #[serde(default)]
    stops: PresentJsonValue,
    poll_interval_secs: Option<u64>,
    max_staleness_secs: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileFile {
    data: String,
    display: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StopFile {
    stop_id: String,
    route_ids: Vec<String>,
}

/// Distinguishes a missing key from a key explicitly set to JSON null.
#[derive(Debug, Default)]
struct PresentJsonValue(Option<serde_json::Value>);

impl<'de> Deserialize<'de> for PresentJsonValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        serde_json::Value::deserialize(deserializer).map(|value| Self(Some(value)))
    }
}

fn enabled_by_default() -> bool {
    true
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ParserKind {
    TripsparkAdvisories,
    ZenbusMessages,
    GtfsRtProtobuf,
    GtfsRtJson,
    GhdNewsServiceAdvisories,
    Rss,
    GenericAlertFeed,
    I3ServiceStatus,
    TranslocMessages,
    HubupServiceAlerts,
    MapstratBroadcast,
    RenderedAdvisoryBoard,
    AttributeAdvisories,
    BucketedTransitAlerts,
    JsonapiTransitNotices,
    KeyedServiceNotices,
    EumSearchAdvisories,
    AnyrideMessages,
    HeadingServiceNotices,
    ServiceAnnouncementBoard,
    RouteNoticeIndex,
    RouteStatusTable,
    DisruptionDetailsTable,
    StopClosureTable,
    RouteStationAdvisories,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum RouteParser {
    Standard,
    Yrt,
}

impl RouteParser {
    fn extractor(self) -> RouteExtractor {
        match self {
            Self::Standard => crate::util::text::parse_standard_route_tokens,
            Self::Yrt => yrt::parse_yrt_routes,
        }
    }
}

/// A validated feed ready for polling. Parser options stay data-driven while
/// the parser and route extractors remain the daemon's supported implementations.
#[derive(Clone, Debug)]
pub struct ConfiguredFeed {
    pub id: String,
    pub upstream_url: String,
    pub request: crate::upstream::ResolvedRequest,
    pub parser: ConfiguredParser,
    pub poll_interval_secs: u64,
    pub max_staleness_secs: u64,
}

#[derive(Clone, Debug)]
pub enum ConfiguredParser {
    TripSparkAdvisories {
        session_token_argument: Option<usize>,
        excluded_news_ids: Vec<String>,
    },
    ZenbusMessages {
        time_zone: Tz,
        stop_code_map: std::collections::BTreeMap<String, String>,
    },
    GtfsRtProtobuf,
    GtfsRtJson,
    GhdNewsServiceAdvisories {
        route_extractor: RouteExtractor,
        max_age_minutes: Option<u64>,
        time_zone: Tz,
    },
    Rss,
    GenericAlertFeed,
    HeadingServiceNotices {
        time_zone: Tz,
        route_names: std::collections::BTreeMap<String, Vec<String>>,
        stop_names: std::collections::BTreeMap<String, Vec<String>>,
        publication_reference: Option<crate::parsers::heading_notices::PublicationReference>,
        clear_statement_names: Vec<String>,
    },
    ServiceAnnouncementBoard {
        route_names: std::collections::BTreeMap<String, Vec<String>>,
    },
    RouteNoticeIndex {
        route_names: std::collections::BTreeMap<String, Vec<String>>,
    },
    RouteStatusTable {
        route_names: std::collections::BTreeMap<String, Vec<String>>,
    },
    StopClosureTable {
        time_zone: Tz,
        route_names: std::collections::BTreeMap<String, Vec<String>>,
    },
    DisruptionDetailsTable {
        time_zone: Tz,
        route_names: std::collections::BTreeMap<String, Vec<String>>,
    },
    RouteStationAdvisories {
        time_zone: Tz,
        route_names: std::collections::BTreeMap<String, Vec<String>>,
    },
    VendorJson {
        parser: String,
        body: Option<serde_json::Value>,
    },
    AnyRideMessages(AnyRideMessagesConfig),
}

/// A validated registry ready to start. The caller supplies legacy global env
/// overrides so tests and startup share the same precedence and validation.
#[derive(Debug)]
pub struct ConfiguredRegistry {
    pub feeds: Vec<ConfiguredFeed>,
}

/// Parses a JSON feed registry and resolves timing values using this order:
/// per-feed value, legacy environment override, file default, built-in default.
pub fn parse_registry_config(
    raw: &str,
    poll_interval_env: Option<&str>,
    max_staleness_env: Option<&str>,
) -> Result<ConfiguredRegistry, String> {
    parse_registry_config_with_secrets(raw, poll_interval_env, max_staleness_env, |name| {
        std::env::var(name).ok()
    })
}

pub fn parse_registry_config_with_secrets(
    raw: &str,
    poll_interval_env: Option<&str>,
    max_staleness_env: Option<&str>,
    secret: impl Fn(&str) -> Option<String>,
) -> Result<ConfiguredRegistry, String> {
    let file: RegistryFile = serde_json::from_str(raw).map_err(|error| {
        format!(
            "invalid alert feed registry JSON at line {} column {}",
            error.line(),
            error.column()
        )
    })?;

    let global_poll_interval = resolve_poll_interval(
        "POLL_INTERVAL_SECS",
        poll_interval_env,
        file.defaults.poll_interval_secs,
        DEFAULT_POLL_INTERVAL_SECS,
    )?;
    let global_max_staleness = resolve_max_staleness(
        "MAX_STALENESS_SECS",
        max_staleness_env,
        file.defaults.max_staleness_secs,
        DEFAULT_MAX_STALENESS_SECS,
    )?;

    let mut ids = std::collections::HashSet::with_capacity(file.feeds.len());
    let mut feeds = Vec::with_capacity(file.feeds.len());
    for (index, feed) in file.feeds.into_iter().enumerate() {
        validate_id(&feed.id).map_err(|reason| format!("feed entry {index}: {reason}"))?;
        if !ids.insert(feed.id.clone()) {
            return Err(format!(
                "feed entry {index}: duplicate feed id {:?}",
                feed.id
            ));
        }

        if (feed.session_token_argument.0.is_some() || feed.excluded_news_ids.0.is_some())
            && !matches!(feed.parser, ParserKind::TripsparkAdvisories)
        {
            return Err("TripSpark options require tripspark-advisories".into());
        }
        if feed.stop_code_map.is_some() && !matches!(feed.parser, ParserKind::ZenbusMessages) {
            return Err("stopCodeMap requires zenbus-messages".into());
        }
        validate_upstream_url(&feed.upstream_url)
            .map_err(|reason| format!("feed {:?}: {reason}", feed.id))?;
        if feed.request_body.is_some() && !matches!(feed.parser, ParserKind::EumSearchAdvisories) {
            return Err(format!(
                "feed {:?}: requestBody is only valid for eum-search-advisories",
                feed.id
            ));
        }
        if feed.stop_names.0.is_some() && !matches!(feed.parser, ParserKind::HeadingServiceNotices)
        {
            return Err("stopNames requires heading-service-notices".into());
        }
        if feed.publication_reference.0.is_some()
            && !matches!(feed.parser, ParserKind::HeadingServiceNotices)
        {
            return Err("publicationReference requires heading-service-notices".into());
        }
        if feed.clear_statement_names.0.is_some()
            && !matches!(feed.parser, ParserKind::HeadingServiceNotices)
        {
            return Err("clearStatementNames requires heading-service-notices".into());
        }
        if feed.route_names.0.is_some()
            && !matches!(
                feed.parser,
                ParserKind::HeadingServiceNotices
                    | ParserKind::ServiceAnnouncementBoard
                    | ParserKind::RouteNoticeIndex
                    | ParserKind::StopClosureTable
                    | ParserKind::DisruptionDetailsTable
                    | ParserKind::RouteStatusTable
                    | ParserKind::RouteStationAdvisories
            )
        {
            return Err(
                "routeNames is only valid for heading-service-notices, service-announcement-board, route-notice-index, route-status-table, disruption-details-table, and route-station-advisories"
                    .into(),
            );
        }
        let parser = match feed.parser {
            ParserKind::TripsparkAdvisories => {
                if feed.route_parser.0.is_some()
                    || feed.route_names.0.is_some()
                    || feed.time_zone.0.is_some()
                    || feed.max_age_minutes.0.is_some()
                    || feed.operator_prefix.0.is_some()
                    || feed.profile.0.is_some()
                    || feed.stops.0.is_some()
                {
                    return Err("Unsupported TripSpark parser options".into());
                }
                let argument = feed
                    .session_token_argument
                    .0
                    .as_ref()
                    .map(|v| {
                        serde_json::from_value::<usize>(v.clone())
                            .map_err(|_| "Invalid sessionTokenArgument")
                    })
                    .transpose()?;
                if argument.is_some_and(|n| n > 8) {
                    return Err("Invalid sessionTokenArgument".into());
                }
                let excluded = feed
                    .excluded_news_ids
                    .0
                    .as_ref()
                    .map(|v| {
                        serde_json::from_value::<Vec<String>>(v.clone())
                            .map_err(|_| "Invalid excludedNewsIds")
                    })
                    .transpose()?
                    .unwrap_or_default();
                if excluded.iter().any(|s| s.trim().is_empty()) {
                    return Err("Invalid excludedNewsIds".into());
                }
                ConfiguredParser::TripSparkAdvisories {
                    session_token_argument: argument,
                    excluded_news_ids: excluded,
                }
            }

            ParserKind::GhdNewsServiceAdvisories => {
                let route_parser = decode_required_option::<RouteParser>(
                    feed.route_parser.0.as_ref(),
                    "routeParser",
                    &feed.id,
                )?;
                let time_zone_name = decode_required_option::<String>(
                    feed.time_zone.0.as_ref(),
                    "timeZone",
                    &feed.id,
                )?;
                let time_zone = Tz::from_str(&time_zone_name)
                    .map_err(|_| format!("feed {:?}: invalid timeZone", feed.id))?;
                let max_age_minutes = match feed.max_age_minutes.0.as_ref() {
                    None | Some(serde_json::Value::Null) => None,
                    Some(value) => {
                        Some(serde_json::from_value::<u64>(value.clone()).map_err(|_| {
                            format!(
                                "feed {:?}: maxAgeMinutes must be a nonnegative integer or null",
                                feed.id
                            )
                        })?)
                    }
                };
                // The parser converts minutes to signed Unix seconds. A u32
                // minute limit makes that multiplication representable without
                // an arbitrary publication-policy ceiling such as one year.
                if max_age_minutes.is_some_and(|age| age > u64::from(u32::MAX)) {
                    return Err(format!(
                        "feed {:?}: maxAgeMinutes must fit an unsigned 32-bit minute count",
                        feed.id
                    ));
                }
                ConfiguredParser::GhdNewsServiceAdvisories {
                    route_extractor: route_parser.extractor(),
                    max_age_minutes,
                    time_zone,
                }
            }
            ParserKind::ZenbusMessages
            | ParserKind::GtfsRtProtobuf
            | ParserKind::GtfsRtJson
            | ParserKind::Rss
            | ParserKind::GenericAlertFeed
            | ParserKind::I3ServiceStatus
            | ParserKind::HeadingServiceNotices
            | ParserKind::ServiceAnnouncementBoard
            | ParserKind::RouteNoticeIndex
            | ParserKind::StopClosureTable
            | ParserKind::DisruptionDetailsTable
            | ParserKind::RouteStatusTable
            | ParserKind::RouteStationAdvisories
            | ParserKind::AnyrideMessages
            | ParserKind::KeyedServiceNotices
            | ParserKind::BucketedTransitAlerts
            | ParserKind::JsonapiTransitNotices
            | ParserKind::AttributeAdvisories
            | ParserKind::RenderedAdvisoryBoard
            | ParserKind::HubupServiceAlerts
            | ParserKind::TranslocMessages
            | ParserKind::MapstratBroadcast
            | ParserKind::EumSearchAdvisories => {
                for (field_name, value) in [
                    ("routeParser", feed.route_parser.0.as_ref()),
                    ("timeZone", feed.time_zone.0.as_ref()),
                    ("maxAgeMinutes", feed.max_age_minutes.0.as_ref()),
                ] {
                    if value.is_some()
                        && !(field_name == "timeZone"
                            && matches!(
                                feed.parser,
                                ParserKind::HeadingServiceNotices
                                    | ParserKind::ZenbusMessages
                                    | ParserKind::RouteStationAdvisories
                                    | ParserKind::StopClosureTable
                                    | ParserKind::DisruptionDetailsTable
                            ))
                    {
                        return Err(format!(
                            "feed {:?}: {field_name} is only valid for ghd-news-service-advisories",
                            feed.id
                        ));
                    }
                }
                if matches!(feed.parser, ParserKind::AnyrideMessages) {
                    ConfiguredParser::AnyRideMessages(anyride_config(&feed)?)
                } else {
                    for (field_name, value) in [
                        ("operatorPrefix", feed.operator_prefix.0.as_ref()),
                        ("profile", feed.profile.0.as_ref()),
                        ("stops", feed.stops.0.as_ref()),
                    ] {
                        if value.is_some() {
                            return Err(format!(
                                "feed {:?}: {field_name} is only valid for anyride-messages",
                                feed.id
                            ));
                        }
                    }
                    match feed.parser {
                        ParserKind::HeadingServiceNotices => {
                            let names: std::collections::BTreeMap<String, Vec<String>> =
                                match feed.route_names.0.as_ref() {
                                    Some(value) => serde_json::from_value(value.clone())
                                        .map_err(|e| e.to_string())?,
                                    None => Default::default(),
                                };
                            if names.iter().any(|(id, names)| {
                                id.trim().is_empty()
                                    || names.is_empty()
                                    || names.iter().any(|n| n.trim().is_empty())
                            }) {
                                return Err(
                                    "routeNames must contain nonblank route IDs and names".into()
                                );
                            }
                            {
                                let stop_names: std::collections::BTreeMap<String, Vec<String>> =
                                    match feed.stop_names.0.as_ref() {
                                        Some(value) => serde_json::from_value(value.clone())
                                            .map_err(|e| e.to_string())?,
                                        None => Default::default(),
                                    };
                                if stop_names.iter().any(|(id, names)| {
                                    id.trim().is_empty()
                                        || names.is_empty()
                                        || names.iter().any(|n| n.trim().is_empty())
                                }) {
                                    return Err(
                                        "stopNames must contain nonblank stop IDs and names".into(),
                                    );
                                }
                                let time_zone = match feed.time_zone.0.as_ref() {
                                    Some(value) => serde_json::from_value::<String>(value.clone())
                                        .map_err(|e| e.to_string())?
                                        .parse::<Tz>()
                                        .map_err(|e| e.to_string())?,
                                    None => chrono_tz::UTC,
                                };
                                let publication_reference = match feed
                                    .publication_reference
                                    .0
                                    .as_ref()
                                {
                                    None | Some(serde_json::Value::Null) => None,
                                    Some(value) => {
                                        let reference: crate::parsers::heading_notices::PublicationReference =
                                            serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
                                        let start = chrono::NaiveDate::parse_from_str(&reference.valid_from, "%Y-%m-%d")
                                            .map_err(|_| "publicationReference.validFrom must be a valid YYYY-MM-DD date")?;
                                        let end = chrono::NaiveDate::parse_from_str(&reference.valid_through, "%Y-%m-%d")
                                            .map_err(|_| "publicationReference.validThrough must be a valid YYYY-MM-DD date")?;
                                        if !(2020..=2050).contains(&reference.publication_year)
                                            || start > end
                                            || start.year() != reference.publication_year
                                            || end.year() != reference.publication_year
                                        {
                                            return Err("publicationReference has an invalid year or date range".into());
                                        }
                                        Some(reference)
                                    }
                                };
                                let clear_statement_names: Vec<String> =
                                    match feed.clear_statement_names.0.as_ref() {
                                        None => Vec::new(),
                                        Some(value) => serde_json::from_value(value.clone())
                                            .map_err(|e| e.to_string())?,
                                    };
                                if feed.clear_statement_names.0.is_some()
                                    && (clear_statement_names.is_empty()
                                        || clear_statement_names
                                            .iter()
                                            .any(|name| name.trim().is_empty()))
                                {
                                    return Err(
                                        "clearStatementNames must be a nonempty array of names"
                                            .into(),
                                    );
                                }
                                ConfiguredParser::HeadingServiceNotices {
                                    time_zone,
                                    route_names: names,
                                    stop_names,
                                    publication_reference,
                                    clear_statement_names,
                                }
                            }
                        }
                        ParserKind::ServiceAnnouncementBoard
                        | ParserKind::RouteNoticeIndex
                        | ParserKind::StopClosureTable
                        | ParserKind::DisruptionDetailsTable
                        | ParserKind::RouteStatusTable
                        | ParserKind::RouteStationAdvisories => {
                            let route_names: std::collections::BTreeMap<String, Vec<String>> =
                                match feed.route_names.0.as_ref() {
                                    Some(value) => serde_json::from_value(value.clone())
                                        .map_err(|e| e.to_string())?,
                                    None => Default::default(),
                                };
                            if route_names.iter().any(|(id, names)| {
                                id.trim().is_empty()
                                    || names.is_empty()
                                    || names.iter().any(|name| name.trim().is_empty())
                            }) {
                                return Err(
                                    "routeNames must contain nonblank route IDs and names".into()
                                );
                            }
                            match feed.parser {
                                ParserKind::RouteNoticeIndex => {
                                    ConfiguredParser::RouteNoticeIndex { route_names }
                                }
                                ParserKind::RouteStatusTable => {
                                    ConfiguredParser::RouteStatusTable { route_names }
                                }
                                ParserKind::StopClosureTable => {
                                    let zone = decode_required_option::<String>(
                                        feed.time_zone.0.as_ref(),
                                        "timeZone",
                                        &feed.id,
                                    )?;
                                    ConfiguredParser::StopClosureTable {
                                        time_zone: Tz::from_str(&zone)
                                            .map_err(|_| "invalid timeZone")?,
                                        route_names,
                                    }
                                }
                                ParserKind::DisruptionDetailsTable => {
                                    let zone = decode_required_option::<String>(
                                        feed.time_zone.0.as_ref(),
                                        "timeZone",
                                        &feed.id,
                                    )?;
                                    ConfiguredParser::DisruptionDetailsTable {
                                        time_zone: Tz::from_str(&zone)
                                            .map_err(|_| "invalid timeZone")?,
                                        route_names,
                                    }
                                }
                                ParserKind::RouteStationAdvisories => {
                                    // Effective dates are calendar days in the source's zone.
                                    let time_zone_name = decode_required_option::<String>(
                                        feed.time_zone.0.as_ref(),
                                        "timeZone",
                                        &feed.id,
                                    )?;
                                    ConfiguredParser::RouteStationAdvisories {
                                        time_zone: Tz::from_str(&time_zone_name).map_err(|_| {
                                            format!("feed {:?}: invalid timeZone", feed.id)
                                        })?,
                                        route_names,
                                    }
                                }
                                _ => ConfiguredParser::ServiceAnnouncementBoard { route_names },
                            }
                        }
                        ParserKind::ZenbusMessages => ConfiguredParser::ZenbusMessages {
                            time_zone: feed
                                .time_zone
                                .0
                                .as_ref()
                                .and_then(|v| v.as_str())
                                .unwrap_or("UTC")
                                .parse()
                                .map_err(|_| "Invalid Zenbus timeZone")?,
                            stop_code_map: feed.stop_code_map.clone().unwrap_or_default(),
                        },
                        ParserKind::GtfsRtProtobuf => ConfiguredParser::GtfsRtProtobuf,
                        ParserKind::GtfsRtJson => ConfiguredParser::GtfsRtJson,
                        ParserKind::GenericAlertFeed => ConfiguredParser::GenericAlertFeed,
                        ParserKind::I3ServiceStatus => ConfiguredParser::VendorJson {
                            parser: "i3-service-status".into(),
                            body: None,
                        },
                        ParserKind::KeyedServiceNotices => ConfiguredParser::VendorJson {
                            parser: "keyed-service-notices".into(),
                            body: None,
                        },
                        ParserKind::BucketedTransitAlerts => ConfiguredParser::VendorJson {
                            parser: "bucketed-transit-alerts".into(),
                            body: None,
                        },
                        ParserKind::JsonapiTransitNotices => ConfiguredParser::VendorJson {
                            parser: "jsonapi-transit-notices".into(),
                            body: None,
                        },
                        ParserKind::AttributeAdvisories => ConfiguredParser::VendorJson {
                            parser: "attribute-advisories".into(),
                            body: None,
                        },
                        ParserKind::RenderedAdvisoryBoard => ConfiguredParser::VendorJson {
                            parser: "rendered-advisory-board".into(),
                            body: None,
                        },
                        ParserKind::HubupServiceAlerts => ConfiguredParser::VendorJson {
                            parser: "hubup-service-alerts".into(),
                            body: None,
                        },
                        ParserKind::TranslocMessages => ConfiguredParser::VendorJson {
                            parser: "transloc-messages".into(),
                            body: None,
                        },
                        ParserKind::MapstratBroadcast => ConfiguredParser::VendorJson {
                            parser: "mapstrat-broadcast".into(),
                            body: None,
                        },
                        ParserKind::EumSearchAdvisories => ConfiguredParser::VendorJson {
                            parser: "eum-search-advisories".into(),
                            body: Some(
                                feed.request_body
                                    .clone()
                                    .ok_or("eum-search-advisories requires requestBody")?,
                            ),
                        },
                        _ => ConfiguredParser::Rss,
                    }
                }
            }
        };
        let poll_interval_secs = resolve_poll_interval(
            &format!("feed {:?} pollIntervalSecs", feed.id),
            feed.poll_interval_secs
                .map(|value| value.to_string())
                .as_deref(),
            Some(global_poll_interval),
            DEFAULT_POLL_INTERVAL_SECS,
        )?;
        let max_staleness_secs = resolve_max_staleness(
            &format!("feed {:?} maxStalenessSecs", feed.id),
            feed.max_staleness_secs
                .map(|value| value.to_string())
                .as_deref(),
            Some(global_max_staleness),
            DEFAULT_MAX_STALENESS_SECS,
        )?;

        if !feed.enabled {
            continue;
        }

        let request = feed.request.resolve(&feed.upstream_url, &secret)?;
        feeds.push(ConfiguredFeed {
            request,
            id: feed.id,
            upstream_url: feed.upstream_url,
            parser,
            poll_interval_secs,
            max_staleness_secs,
        });
    }

    Ok(ConfiguredRegistry { feeds })
}

fn header_safe(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

/// `anyride-messages` polls `upstreamUrl` (the AnyRide API base) for each stop.
fn anyride_config(feed: &FeedFile) -> Result<AnyRideMessagesConfig, String> {
    let operator_prefix = decode_required_option::<String>(
        feed.operator_prefix.0.as_ref(),
        "operatorPrefix",
        &feed.id,
    )?;
    if operator_prefix.trim().is_empty() {
        return Err(format!("feed {:?}: invalid operatorPrefix", feed.id));
    }
    let profile = match feed.profile.0.as_ref() {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => {
            let profile: ProfileFile = serde_json::from_value(value.clone())
                .map_err(|_| format!("feed {:?}: invalid profile", feed.id))?;
            if !header_safe(&profile.data)
                || profile.display.as_deref().is_some_and(|v| !header_safe(v))
            {
                return Err(format!(
                    "feed {:?}: profile values must be header-safe tokens",
                    feed.id
                ));
            }
            Some(AnyRideProfile {
                data: profile.data,
                display: profile.display,
            })
        }
    };
    let stops = decode_required_option::<Vec<StopFile>>(feed.stops.0.as_ref(), "stops", &feed.id)?;
    if stops.is_empty()
        || stops.len() > MAX_POLLED_STOPS
        || stops.iter().any(|stop| {
            stop.stop_id.trim().is_empty()
                || stop.route_ids.is_empty()
                || stop.route_ids.iter().any(|route| route.trim().is_empty())
        })
    {
        return Err(format!(
            "feed {:?}: stops must list 1 to {MAX_POLLED_STOPS} stops, each with a stopId and routeIds",
            feed.id
        ));
    }
    Ok(AnyRideMessagesConfig {
        base_url: feed.upstream_url.clone(),
        operator_prefix,
        profile,
        stops: stops
            .into_iter()
            .map(|stop| MessageStop {
                stop_id: stop.stop_id,
                route_ids: stop.route_ids,
            })
            .collect(),
    })
}

fn decode_required_option<T: for<'de> Deserialize<'de>>(
    value: Option<&serde_json::Value>,
    name: &str,
    feed_id: &str,
) -> Result<T, String> {
    let value = value.ok_or_else(|| format!("feed {feed_id:?}: {name} is required"))?;
    serde_json::from_value(value.clone()).map_err(|_| format!("feed {feed_id:?}: invalid {name}"))
}

fn resolve_value(
    name: &str,
    env_value: Option<&str>,
    file_value: Option<u64>,
    fallback: u64,
) -> Result<u64, String> {
    let value = match env_value {
        Some(value) => value
            .parse::<u64>()
            .map_err(|_| format!("{name} must be an integer number of seconds"))?,
        None => file_value.unwrap_or(fallback),
    };
    Ok(value)
}

fn resolve_poll_interval(
    name: &str,
    env_value: Option<&str>,
    file_value: Option<u64>,
    fallback: u64,
) -> Result<u64, String> {
    let value = resolve_value(name, env_value, file_value, fallback)?;
    if value == 0
        || std::time::Instant::now()
            .checked_add(Duration::from_secs(value))
            .is_none()
    {
        return Err(format!(
            "{name} must be a positive interval supported by the runtime timer"
        ));
    }
    Ok(value)
}

fn resolve_max_staleness(
    name: &str,
    env_value: Option<&str>,
    file_value: Option<u64>,
    fallback: u64,
) -> Result<u64, String> {
    resolve_value(name, env_value, file_value, fallback)
}

fn validate_id(id: &str) -> Result<(), &'static str> {
    let valid = !id.is_empty()
        && !matches!(id, "health" | "status")
        && id
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if valid {
        Ok(())
    } else {
        Err(
            "id must be a lowercase path-safe token (letters, digits, hyphens), not 'health' or 'status'",
        )
    }
}

fn validate_upstream_url(value: &str) -> Result<(), &'static str> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| "upstreamUrl must be an absolute HTTP or HTTPS URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "upstreamUrl must be an absolute HTTP or HTTPS URL without credentials or fragment",
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEED: &str = r#"{
      "id": "sample",
      "parser": "ghd-news-service-advisories",
      "upstreamUrl": "https://example.test/alerts",
      "routeParser": "standard",
      "timeZone": "America/Toronto"
    }"#;

    fn config(feed: &str) -> String {
        format!(
            r#"{{"defaults":{{"pollIntervalSecs":90,"maxStalenessSecs":7200}},"feeds":[{feed}]}}"#
        )
    }

    #[test]
    fn parser_defaults_and_per_feed_timing_overrides_resolve() {
        let inherited = parse_registry_config(&config(FEED), Some("120"), Some("5400"))
            .expect("valid registry");
        assert_eq!(inherited.feeds[0].poll_interval_secs, 120);
        assert_eq!(inherited.feeds[0].max_staleness_secs, 5_400);

        let overridden = FEED.replace(
            "\"timeZone\": \"America/Toronto\"",
            "\"timeZone\": \"America/Toronto\", \"pollIntervalSecs\": 45, \"maxStalenessSecs\": 900",
        );
        let registry = parse_registry_config(&config(&overridden), Some("120"), Some("5400"))
            .expect("valid per-feed overrides");
        assert_eq!(registry.feeds[0].poll_interval_secs, 45);
        assert_eq!(registry.feeds[0].max_staleness_secs, 900);
    }

    #[test]
    fn zero_max_staleness_is_valid_at_each_configuration_level() {
        let env_override = parse_registry_config(&config(FEED), None, Some("0"))
            .expect("zero staleness env override is valid");
        assert_eq!(env_override.feeds[0].max_staleness_secs, 0);

        let max_staleness =
            parse_registry_config(&config(FEED), None, Some("18446744073709551615"))
                .expect("the full unsigned staleness range is valid");
        assert_eq!(max_staleness.feeds[0].max_staleness_secs, u64::MAX);

        let file_default = format!(r#"{{"defaults":{{"maxStalenessSecs":0}},"feeds":[{FEED}]}}"#);
        let registry = parse_registry_config(&file_default, None, None)
            .expect("zero staleness file default is valid");
        assert_eq!(registry.feeds[0].max_staleness_secs, 0);

        let per_feed = FEED.replace(
            "\"timeZone\": \"America/Toronto\"",
            "\"timeZone\": \"America/Toronto\", \"maxStalenessSecs\": 0",
        );
        let registry = parse_registry_config(&config(&per_feed), None, Some("5400"))
            .expect("zero per-feed staleness is valid");
        assert_eq!(registry.feeds[0].max_staleness_secs, 0);
    }

    #[test]
    fn empty_registry_is_valid_and_starts_no_feed_pollers() {
        let registry =
            parse_registry_config(r#"{"feeds":[]}"#, None, None).expect("empty registry is valid");
        assert!(registry.feeds.is_empty());
    }

    #[test]
    fn yrt_route_extractor_is_selected_by_config() {
        let feed = FEED.replace("\"standard\"", "\"yrt\"");
        let registry = parse_registry_config(&config(&feed), None, None).expect("valid registry");
        let ConfiguredParser::GhdNewsServiceAdvisories {
            route_extractor: extract,
            ..
        } = registry.feeds[0].parser
        else {
            panic!("GHD parser configured");
        };
        assert_eq!(
            extract("Viva Purple and route 83A"),
            vec!["Viva Purple", "83A"]
        );
    }

    #[test]
    fn registry_rejects_duplicate_or_unsafe_feed_ids() {
        let duplicate = format!(r#"{{"feeds":[{FEED},{FEED}]}}"#);
        assert!(
            parse_registry_config(&duplicate, None, None)
                .unwrap_err()
                .contains("duplicate feed id")
        );

        for id in ["../sample", "UPPER", "health", "with/slash"] {
            let feed = FEED.replace("sample", id);
            let error = parse_registry_config(&config(&feed), None, None).unwrap_err();
            assert!(error.contains("path-safe token"), "{id}: {error}");
        }
    }

    #[test]
    fn registry_rejects_invalid_parser_url_timezone_and_timing() {
        let invalid_parser = FEED.replace("ghd-news-service-advisories", "unknown");
        assert!(
            parse_registry_config(&config(&invalid_parser), None, None)
                .unwrap_err()
                .contains("invalid alert feed registry JSON")
        );

        for url in [
            "relative/path",
            "file:///tmp/feed",
            "https://user:pass@example.test/feed",
            "https://example.test/feed#frag",
        ] {
            let feed = FEED.replace("https://example.test/alerts", url);
            assert!(
                parse_registry_config(&config(&feed), None, None)
                    .unwrap_err()
                    .contains("upstreamUrl")
            );
        }

        let invalid_zone = FEED.replace("America/Toronto", "Not/A_Timezone");
        assert!(
            parse_registry_config(&config(&invalid_zone), None, None)
                .unwrap_err()
                .contains("invalid timeZone")
        );

        let invalid_age = FEED.replace(
            "\"timeZone\": \"America/Toronto\"",
            "\"timeZone\": \"America/Toronto\", \"maxAgeMinutes\": 4294967296",
        );
        assert!(
            parse_registry_config(&config(&invalid_age), None, None)
                .unwrap_err()
                .contains("maxAgeMinutes")
        );

        let largest_supported_age = FEED.replace(
            "\"timeZone\": \"America/Toronto\"",
            "\"timeZone\": \"America/Toronto\", \"maxAgeMinutes\": 4294967295",
        );
        let registry = parse_registry_config(&config(&largest_supported_age), None, None)
            .expect("maxAgeMinutes has no one-year business limit");
        assert!(matches!(
            &registry.feeds[0].parser,
            ConfiguredParser::GhdNewsServiceAdvisories {
                max_age_minutes: Some(age),
                ..
            } if *age == u64::from(u32::MAX)
        ));

        for interval in ["0", "18446744073709551615", "abc"] {
            assert!(parse_registry_config(&config(FEED), Some(interval), None).is_err());
        }

        assert!(parse_registry_config(&config(FEED), Some("31536001"), None).is_ok());
    }

    #[test]
    fn disabled_standby_feeds_are_validated_but_not_returned_for_polling() {
        let disabled = FEED.replace(
            "\"timeZone\": \"America/Toronto\"",
            "\"timeZone\": \"America/Toronto\", \"enabled\": false",
        );
        let registry =
            parse_registry_config(&config(&disabled), None, None).expect("valid registry");
        assert!(registry.feeds.is_empty());

        let invalid_disabled = disabled.replace("sample", "../bad");
        assert!(parse_registry_config(&config(&invalid_disabled), None, None).is_err());
    }

    #[test]
    fn bundled_registry_matches_the_supported_config_schema() {
        // Parsing validates every entry, including disabled standby feeds,
        // without making the production feed roster a behavioral contract.
        let _registry = parse_registry_config(include_str!("../../feeds.json"), None, None)
            .expect("bundled registry entries match the supported schema");
    }

    #[test]
    fn generic_json_config_selects_the_json_parser() {
        let config = r#"{"feeds":[{"id":"sample","parser":"generic-alert-feed","upstreamUrl":"https://example.test/alerts"}]}"#;
        let registry = parse_registry_config(config, None, None).unwrap();
        assert!(matches!(
            registry.feeds[0].parser,
            ConfiguredParser::GenericAlertFeed
        ));
    }

    #[test]
    fn heading_service_notices_accepts_a_fixed_publication_reference() {
        let valid = r#"{"feeds":[{"id":"sample","parser":"heading-service-notices","upstreamUrl":"https://example.test/updates","publicationReference":{"publicationYear":2026,"validFrom":"2026-09-30","validThrough":"2026-11-30"}}]}"#;
        let registry = parse_registry_config(valid, None, None).expect("valid year evidence");
        assert!(matches!(
            &registry.feeds[0].parser,
            ConfiguredParser::HeadingServiceNotices { publication_reference: Some(reference), .. }
                if reference.publication_year == 2026
        ));
        let invalid = valid.replace("2026-11-30", "2026-02-30");
        assert!(parse_registry_config(&invalid, None, None).is_err());
    }

    #[test]
    fn heading_service_notices_accepts_declared_clear_statement_names() {
        let valid = r#"{"feeds":[{"id":"sample","parser":"heading-service-notices","upstreamUrl":"https://example.test/updates","clearStatementNames":["CTrain"]}]}"#;
        let registry = parse_registry_config(valid, None, None).expect("valid clear names");
        assert!(matches!(
            &registry.feeds[0].parser,
            ConfiguredParser::HeadingServiceNotices { clear_statement_names, .. }
                if clear_statement_names == &vec!["CTrain".to_owned()]
        ));
        for invalid in [
            valid.replace(r#"["CTrain"]"#, "[]"),
            valid.replace(r#"["CTrain"]"#, r#"[" "]"#),
            valid.replace(r#"["CTrain"]"#, r#""CTrain""#),
            r#"{"feeds":[{"id":"sample","parser":"rss","upstreamUrl":"https://example.test/feed.xml","clearStatementNames":["CTrain"]}]}"#.to_owned(),
        ] {
            assert!(
                parse_registry_config(&invalid, None, None).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn test_route_station_advisories_require_the_source_time_zone() {
        let valid = r#"{"feeds":[{"id":"sample","parser":"route-station-advisories","upstreamUrl":"https://example.test/alerts","timeZone":"America/New_York","routeNames":{"coastal":["Coastal Limited"]}}]}"#;
        let registry = parse_registry_config(valid, None, None).expect("valid advisories feed");
        assert!(matches!(
            &registry.feeds[0].parser,
            ConfiguredParser::RouteStationAdvisories { time_zone, route_names }
                if *time_zone == chrono_tz::America::New_York && route_names.contains_key("coastal")
        ));
        for invalid in [
            valid.replace(r#""timeZone":"America/New_York","#, ""),
            valid.replace("America/New_York", "Nowhere/Else"),
        ] {
            assert!(
                parse_registry_config(&invalid, None, None).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn service_announcement_board_config_requires_parser_specific_aliases() {
        let valid = r#"{"feeds":[{"id":"sample","parser":"service-announcement-board","upstreamUrl":"https://example.test/announcements","routeNames":{"R7":["7"]}}]}"#;
        let registry = parse_registry_config(valid, None, None).expect("valid board options");
        assert!(matches!(
            &registry.feeds[0].parser,
            ConfiguredParser::ServiceAnnouncementBoard { route_names }
                if route_names.get("R7").is_some_and(|names| names == &vec!["7".to_owned()])
        ));

        for invalid in [
            r#"{"feeds":[{"id":"sample","parser":"ghd-news-service-advisories","upstreamUrl":"https://example.test/announcements","routeNames":{"R7":["7"]},"routeParser":"standard","timeZone":"America/Toronto"}]}"#,
            r#"{"feeds":[{"id":"sample","parser":"service-announcement-board","upstreamUrl":"https://example.test/announcements","routeNames":{"R7":[]}}]}"#,
        ] {
            assert!(
                parse_registry_config(invalid, None, None).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn anyride_messages_config_requires_stops_and_a_prefix() {
        let valid = r#"{"feeds":[{"id":"sample","parser":"anyride-messages","upstreamUrl":"https://example.test/api","operatorPrefix":"70","profile":{"data":"tenant_data","display":"tenant"},"stops":[{"stopId":"S1","routeIds":["4"]}]}]}"#;
        let registry = parse_registry_config(valid, None, None).unwrap();
        assert!(matches!(
            &registry.feeds[0].parser,
            ConfiguredParser::AnyRideMessages(config) if config.stops.len() == 1
        ));

        for invalid in [
            r#"{"feeds":[{"id":"sample","parser":"anyride-messages","upstreamUrl":"https://example.test/api","stops":[{"stopId":"S1","routeIds":["4"]}]}]}"#,
            r#"{"feeds":[{"id":"sample","parser":"anyride-messages","upstreamUrl":"https://example.test/api","operatorPrefix":"70"}]}"#,
            r#"{"feeds":[{"id":"sample","parser":"anyride-messages","upstreamUrl":"https://example.test/api","operatorPrefix":"70","stops":[]}]}"#,
            r#"{"feeds":[{"id":"sample","parser":"anyride-messages","upstreamUrl":"https://example.test/api","operatorPrefix":"70","profile":{"data":"bad value"},"stops":[{"stopId":"S1","routeIds":["4"]}]}]}"#,
            r#"{"feeds":[{"id":"sample","parser":"rss","upstreamUrl":"https://example.test/feed.xml","operatorPrefix":"70"}]}"#,
        ] {
            assert!(
                parse_registry_config(invalid, None, None).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn rss_config_does_not_require_ghd_options_and_rejects_them_if_present() {
        let valid = r#"{"feeds":[{"id":"sample","parser":"rss","upstreamUrl":"https://example.test/feed.xml"}]}"#;
        let registry = parse_registry_config(valid, None, None).expect("RSS needs no GHD options");
        assert!(matches!(&registry.feeds[0].parser, ConfiguredParser::Rss));

        for invalid in [
            r#"{"feeds":[{"id":"sample","parser":"rss","upstreamUrl":"https://example.test/feed.xml","routeParser":"standard"}]}"#,
            r#"{"feeds":[{"id":"sample","parser":"rss","upstreamUrl":"https://example.test/feed.xml","timeZone":"America/Toronto"}]}"#,
            r#"{"feeds":[{"id":"sample","parser":"rss","upstreamUrl":"https://example.test/feed.xml","maxAgeMinutes":null}]}"#,
        ] {
            let error = parse_registry_config(invalid, None, None).unwrap_err();
            assert!(
                error.contains("only valid for ghd-news-service-advisories"),
                "{error}"
            );
        }
    }
}
