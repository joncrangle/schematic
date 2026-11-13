use crate::{
    agencies::ScrapeOutcome,
    parsers::ghd_news::{self, GhdScrapeConfig},
    util::text::{parse_standard_route_tokens, title_case},
};

const ADVISORIES_URL: &str = "https://www.yrt.ca/Modules/News/en/serviceadvisories";

pub async fn scrape_feed(
    client: crate::upstream::Client,
) -> Result<ScrapeOutcome, Box<dyn std::error::Error + Send + Sync>> {
    ghd_news::scrape_ghd_feed(
        &client,
        GhdScrapeConfig {
            advisories_url: ADVISORIES_URL,
            route_extractor: parse_yrt_routes,
            // Postings state their own period, so nothing needs ageing out.
            max_age_minutes: None,
            time_zone: &chrono_tz::America::Toronto,
        },
    )
    .await
}

pub fn parse_yrt_routes(text: &str) -> Vec<String> {
    let mut routes = Vec::new();
    let lower = text.to_lowercase();

    // 1. YRT-specific Viva Line colors
    for color in ["blue", "purple", "orange", "yellow"] {
        if lower.contains(&format!("viva {color}")) {
            routes.push(format!("Viva {}", title_case(color)));
        }
    }

    // 2. Standard numeric & alphanumeric routes (1, 83A, 522)
    for token in parse_standard_route_tokens(text) {
        if !token.eq_ignore_ascii_case("viva") && !routes.contains(&token) {
            routes.push(token);
        }
    }

    routes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_yrt_routes() {
        let text = "Routes affected: 1, 83A, 522, Viva Purple, and Viva Blue";
        let routes = parse_yrt_routes(text);
        assert!(routes.contains(&"Viva Purple".to_string()));
        assert!(routes.contains(&"Viva Blue".to_string()));
        assert!(routes.contains(&"1".to_string()));
        assert!(routes.contains(&"83A".to_string()));
        assert!(routes.contains(&"522".to_string()));
    }
}
