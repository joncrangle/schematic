use crate::{
    agencies::ScrapeOutcome,
    parsers::ghd_news::{self, GhdScrapeConfig},
    util::text::parse_standard_route_tokens,
};

const ADVISORIES_URL: &str =
    "https://www.milton.ca/Modules/News/en/rideralerts?CategoryNames=Rider%20Alerts";

/// One week, in minutes, matching the `maxAgeMinutes` Milton's manifest declares
/// for the same page. The news module is never pruned, so without an age the
/// archive stays live forever; a week covers a rider alert's own lifetime.
const MILTON_MAX_AGE_MINUTES: u64 = 10_080;

pub async fn scrape_feed(
    client: crate::upstream::Client,
) -> Result<ScrapeOutcome, Box<dyn std::error::Error + Send + Sync>> {
    ghd_news::scrape_ghd_feed(
        &client,
        GhdScrapeConfig {
            advisories_url: ADVISORIES_URL,
            route_extractor: parse_standard_route_tokens,
            max_age_minutes: Some(MILTON_MAX_AGE_MINUTES),
            time_zone: &chrono_tz::America::Toronto,
        },
    )
    .await
}
