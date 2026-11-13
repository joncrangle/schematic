use crate::{
    agencies::ScrapeOutcome,
    parsers::ghd_news::{self, GhdScrapeConfig},
    util::text::parse_standard_route_tokens,
};

const ADVISORIES_URL: &str = "https://www.durhamregiontransit.com/news/service-alerts-and-detours/";

/// Two weeks, in minutes.
///
/// DRT's published GTFS-RT alert file is a dead artifact (a single entity whose
/// active period ended in 2023), so this page is the only live channel, and DRT
/// never prunes it: postings sit on the list until an editor removes them. Most
/// of its stop notices say "until further notice" and state no end, so something
/// has to retire them or the archive renders as permanently live. Two weeks
/// covers the construction phase a detour actually runs for, and it is also long
/// enough that a posting whose stated start runs a few days past its posting date
/// (DRT posts the night before) still ends after it starts.
const DRT_MAX_AGE_MINUTES: u64 = 20_160;

pub async fn scrape_feed(
    client: crate::upstream::Client,
) -> Result<ScrapeOutcome, Box<dyn std::error::Error + Send + Sync>> {
    ghd_news::scrape_ghd_feed(
        &client,
        GhdScrapeConfig {
            advisories_url: ADVISORIES_URL,
            // DRT names routes numerically, with an occasional letter suffix
            // (`905C`); no Viva-style colour names.
            route_extractor: parse_standard_route_tokens,
            max_age_minutes: Some(DRT_MAX_AGE_MINUTES),
            time_zone: &chrono_tz::America::Toronto,
        },
    )
    .await
}
