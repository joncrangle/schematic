//! Reads route-status tables whose header row starts with a `Route` column.
//! Twin of `routeStatusTableParser.ts`.
use super::strip_html::strip_html;
use crate::agencies::ScrapeOutcome;
use bytes::Bytes;
use regex::Regex;
use scraper::{ElementRef, Html, Selector};
use serde_json::{Value, json};
use std::{collections::BTreeMap, error::Error, io, sync::LazyLock};

/// Any one-word qualifier clears, so a misspelt "No anticipated disruptions" still reads clear.
static CLEAR_STATUS: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    [
        Regex::new(r"^no (?:[a-z-]+ )?(?:disruptions?|detours|closures|service changes)$").unwrap(),
        Regex::new(r"^all stops are (?:currently )?open$").unwrap(),
        Regex::new(r"^(?:normal|regular) service$").unwrap(),
    ]
});

struct Notice {
    id: String,
    title: String,
    description: String,
    routes: Vec<String>,
}

fn plain(element: ElementRef<'_>) -> String {
    strip_html(&element.html())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_clear(status: &str) -> bool {
    let lower = status.to_lowercase();
    let normalized = lower.trim_end_matches(['.', '!']).trim();
    CLEAR_STATUS
        .iter()
        .any(|pattern| pattern.is_match(normalized))
}

/// Returns the notices and whether an unmapped route label withheld any of them.
pub fn decode(
    html: &str,
    source: &str,
    route_names: &BTreeMap<String, Vec<String>>,
) -> Result<(Value, bool), io::Error> {
    let document = Html::parse_document(html);
    let table_selector = Selector::parse("table").unwrap();
    let row_selector = Selector::parse("tr").unwrap();
    let tables: Vec<Vec<Vec<String>>> = document
        .select(&table_selector)
        .map(|table| {
            table
                .select(&row_selector)
                .map(|row| {
                    row.children()
                        .filter_map(ElementRef::wrap)
                        .filter(|cell| matches!(cell.value().name(), "td" | "th"))
                        .map(plain)
                        .collect()
                })
                .collect::<Vec<Vec<String>>>()
        })
        .filter(|rows| {
            rows.first().is_some_and(|header| {
                header.len() >= 2 && matches!(header[0].to_lowercase().as_str(), "route" | "routes")
            })
        })
        .collect();
    if tables.is_empty() {
        return Err(io::Error::other("Missing route status table"));
    }
    let mut notices: Vec<Notice> = Vec::new();
    let mut partial = false;
    for rows in &tables {
        let column = &rows[0][0];
        for row in &rows[1..] {
            let label = row.first().map(String::as_str).unwrap_or_default();
            let status = row.get(1).map(String::as_str).unwrap_or_default();
            if label.is_empty() && status.is_empty() {
                continue;
            }
            if label.is_empty() || status.is_empty() {
                return Err(io::Error::other("Incomplete route status row"));
            }
            if is_clear(status) {
                continue;
            }
            let lower = label.to_lowercase();
            let systemwide = lower == "all routes";
            let route_ids: Vec<String> = if systemwide {
                Vec::new()
            } else {
                route_names
                    .iter()
                    .filter(|(_, aliases)| {
                        aliases.iter().any(|alias| alias.to_lowercase() == lower)
                    })
                    .map(|(route_id, _)| route_id.clone())
                    .collect()
            };
            if !systemwide && route_ids.is_empty() {
                partial = true;
                continue;
            }
            let id = format!("{source}#{label}");
            if let Some(prior) = notices.iter_mut().find(|notice| notice.id == id) {
                prior.description = format!("{}\n{status}", prior.description);
                continue;
            }
            let title = if systemwide {
                label.to_owned()
            } else {
                format!("{column} {label}")
            };
            notices.push(Notice {
                id,
                title,
                description: status.to_owned(),
                routes: route_ids,
            });
        }
    }
    let alerts: Vec<Value> = notices
        .into_iter()
        .map(|notice| {
            json!({
                "id": notice.id,
                "title": notice.title,
                "description": notice.description,
                "routes": notice.routes,
                "start_time": "1970-01-01T00:00:00Z"
            })
        })
        .collect();
    Ok((json!(alerts), partial))
}

pub async fn scrape(
    client: &crate::upstream::Client,
    url: &str,
    route_names: &BTreeMap<String, Vec<String>>,
) -> Result<ScrapeOutcome, Box<dyn Error + Send + Sync>> {
    let html = client
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let (document, partial) =
        decode(&html, url, route_names).map_err(|_| crate::upstream::Failure::Decode)?;
    Ok(ScrapeOutcome {
        bytes: Bytes::from(serde_json::to_vec(&document)?),
        partial,
        content_type: "application/json",
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    #[test]
    fn test_matches_the_shared_route_status_contract() {
        let contract: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/route-status-table/contract.json"
        ))
        .unwrap();
        for entry in contract["cases"].as_array().unwrap() {
            let route_names =
                serde_json::from_value(entry.get("routeNames").cloned().unwrap_or(json!({})))
                    .unwrap();
            let result = super::decode(
                entry["html"].as_str().unwrap(),
                "https://example.test/status",
                &route_names,
            );
            if entry["error"] == true {
                assert!(result.is_err(), "{}", entry["name"]);
                continue;
            }
            let (alerts, partial) = result.unwrap();
            let expected: Vec<_> = entry["notices"]
                .as_array()
                .unwrap()
                .iter()
                .map(|notice| {
                    json!({
                        "id": notice["id"],
                        "title": notice["title"],
                        "description": notice["description"],
                        "routes": notice["routeIds"],
                        "start_time": "1970-01-01T00:00:00Z"
                    })
                })
                .collect();
            assert_eq!(alerts, json!(expected), "{}", entry["name"]);
            assert_eq!(partial, entry["partial"] == true, "{}", entry["name"]);
        }
    }
}
