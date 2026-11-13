//! Reads route- and station-scoped advisory lists with "Effective …" periods.
//! Twin of `routeStationAdvisoriesParser.ts`.
use super::strip_html::strip_html;
use crate::agencies::ScrapeOutcome;
use bytes::Bytes;
use chrono::{NaiveDate, TimeZone};
use chrono_tz::Tz;
use regex::Regex;
use scraper::{ElementRef, Html, Selector};
use serde_json::{Value, json};
use std::{collections::BTreeMap, collections::BTreeSet, error::Error, io, sync::LazyLock};

const MONTHS: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

static SEGMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^([A-Za-z]{3,9})\.?\s+([0-9]{1,2})(?:,\s*([0-9]{4}))?(?:\s*[-–]\s*(?:([A-Za-z]{3,9})\.?\s+)?([0-9]{1,2})(?:,\s*([0-9]{4}))?)?$",
    )
    .unwrap()
});
static EFFECTIVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^Effective\s*").unwrap());
static IMMEDIATELY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^immediately\.?$").unwrap());
static AND: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\s+and\s+").unwrap());
static STATION_CODE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\(([A-Z0-9]{2,5})\)\s*$").unwrap());

#[derive(Clone, Copy, Debug, PartialEq)]
struct Window {
    starts_at: i64,
    ends_at: Option<i64>,
}

struct Advisory {
    title: String,
    href: Option<String>,
    caption: Option<String>,
    route_names: Vec<String>,
    station_code: Option<String>,
}

fn selector(css: &str) -> Selector {
    Selector::parse(css).unwrap()
}

fn plain(element: ElementRef<'_>) -> String {
    strip_html(&element.html())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn link_target(element: ElementRef<'_>) -> Option<String> {
    ["data-href", "href"]
        .iter()
        .filter_map(|name| element.value().attr(name))
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(str::to_owned)
}

fn month(name: &str) -> Result<u32, io::Error> {
    let lower = name.to_lowercase();
    MONTHS
        .iter()
        .position(|candidate| lower.len() >= 3 && candidate.starts_with(&lower))
        .map(|index| index as u32 + 1)
        .ok_or_else(|| io::Error::other(format!("Unknown month: {name}")))
}

/// Local midnight of a calendar day; `day_after` turns a last day into an exclusive end.
fn midnight(year: i32, month: u32, day: u32, zone: Tz, day_after: bool) -> Result<i64, io::Error> {
    let stated = NaiveDate::from_ymd_opt(year, month, day)
        .ok_or_else(|| io::Error::other("Invalid advisory date"))?;
    let date = if day_after {
        stated
            .succ_opt()
            .ok_or_else(|| io::Error::other("Invalid advisory date"))?
    } else {
        stated
    };
    // Matches `parseWallClock`: a repeated local time resolves to its first instant.
    zone.from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .map(|instant| instant.timestamp_millis())
        .ok_or_else(|| io::Error::other("Nonexistent local time"))
}

/// Reads an "Effective …" caption. A range includes its last day; earlier
/// segments that omit the year share the last segment's. "Immediately" or no
/// caption means active while published. Anything else is an error.
fn advisory_windows(caption: &str, zone: Tz) -> Result<Vec<Window>, io::Error> {
    let collapsed = caption.split_whitespace().collect::<Vec<_>>().join(" ");
    let text = EFFECTIVE.replace(&collapsed, "").into_owned();
    if text.is_empty() || IMMEDIATELY.is_match(&text) {
        return Ok(vec![Window {
            starts_at: 0,
            ends_at: None,
        }]);
    }
    let segments = AND
        .split(&text)
        .map(|segment| {
            SEGMENT
                .captures(segment.trim())
                .ok_or_else(|| io::Error::other(format!("Unreadable advisory period: {caption}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let number =
        |value: Option<regex::Match<'_>>| value.map(|m| m.as_str().parse::<i32>().unwrap());
    let last = segments.last().unwrap();
    let last_year = number(last.get(6)).or(number(last.get(3)));
    segments
        .iter()
        .map(|segment| {
            let first_month = month(&segment[1])?;
            let last_month = match segment.get(4) {
                Some(name) => month(name.as_str())?,
                None => first_month,
            };
            let start_day = number(segment.get(2)).unwrap() as u32;
            let end_day = number(segment.get(5)).map(|day| day as u32);
            let start_year = number(segment.get(3));
            let closing = if end_day.is_some() {
                number(segment.get(6))
            } else {
                start_year
            }
            .or(last_year)
            .ok_or_else(|| io::Error::other(format!("Advisory period has no year: {caption}")))?;
            let opening = start_year.unwrap_or(if end_day.is_some() && first_month > last_month {
                closing - 1
            } else {
                closing
            });
            let starts_at = midnight(opening, first_month, start_day, zone, false)?;
            let Some(end_day) = end_day else {
                return Ok(Window {
                    starts_at,
                    ends_at: None,
                });
            };
            let ends_at = midnight(closing, last_month, end_day, zone, true)?;
            if ends_at <= starts_at {
                return Err(io::Error::other(format!(
                    "Advisory period ends before it starts: {caption}"
                )));
            }
            Ok(Window {
                starts_at,
                ends_at: Some(ends_at),
            })
        })
        .collect()
}

fn rfc3339(millis: i64) -> String {
    chrono::DateTime::from_timestamp_millis(millis)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Returns the notices and whether an unmapped route or unreadable period
/// left the read partial, so it never clears a route.
pub fn decode(
    html: &str,
    source: &str,
    zone: Tz,
    route_names: &BTreeMap<String, Vec<String>>,
) -> Result<(Value, bool), io::Error> {
    let document = Html::parse_document(html);
    let base = reqwest::Url::parse(source).map_err(io::Error::other)?;
    let mut advisories: Vec<Advisory> = Vec::new();
    for option in document.select(&selector(".na-service-alert__option")) {
        let tooltip: Vec<String> = option
            .select(&selector(".tooltip__text_content"))
            .map(plain)
            .filter(|name| !name.is_empty())
            .collect();
        let heading = option
            .select(&selector("h2, h3, h4, h5, h6"))
            .next()
            .map(plain)
            .filter(|name| !name.is_empty());
        let names = if !tooltip.is_empty() {
            tooltip
        } else {
            heading.into_iter().collect()
        };
        if names.is_empty() {
            return Err(io::Error::other("Route advisory has no route"));
        }
        let blocks: Vec<_> = option
            .select(&selector(".na-service-alert__option_block"))
            .collect();
        if blocks.is_empty() {
            return Err(io::Error::other("Route advisory has no notice"));
        }
        for block in blocks {
            let link = block
                .select(&selector(".na-service-alert__option_title"))
                .next()
                .filter(|link| !plain(*link).is_empty())
                .ok_or_else(|| io::Error::other("Route advisory has no title"))?;
            advisories.push(Advisory {
                title: plain(link),
                href: link_target(link),
                caption: block
                    .select(&selector(".na-service-alert__option_date"))
                    .next()
                    .map(plain),
                route_names: names.clone(),
                station_code: None,
            });
        }
    }
    for item in document.select(&selector(".na-service-alert__stations_ul_li")) {
        let code = item
            .select(&selector(".na-service-alert__stations_ul_li_header"))
            .next()
            .and_then(|header| {
                STATION_CODE
                    .captures(&plain(header))
                    .map(|found| found[1].to_owned())
            })
            .ok_or_else(|| io::Error::other("Station advisory has no station code"))?;
        let notices: Vec<_> = item
            .select(&selector(".na-service-alert__stations_ul_li_details_alert"))
            .collect();
        if notices.is_empty() {
            return Err(io::Error::other(format!(
                "Station advisory {code} has no notice"
            )));
        }
        for notice in notices {
            let link = notice
                .select(&selector(
                    ".na-service-alert__stations_ul_li_details_alert_link",
                ))
                .next()
                .filter(|link| !plain(*link).is_empty())
                .ok_or_else(|| io::Error::other(format!("Station advisory {code} has no title")))?;
            advisories.push(Advisory {
                title: plain(link),
                href: link_target(link),
                caption: notice
                    .select(&selector(
                        ".na-service-alert__stations_ul_li_details_alert_date",
                    ))
                    .next()
                    .map(plain),
                route_names: Vec::new(),
                station_code: Some(code.clone()),
            });
        }
    }
    if advisories.is_empty() {
        return Err(io::Error::other(
            "No recognizable advisories; recovery is unconfirmed",
        ));
    }

    let mut partial = false;
    let mut alerts: Vec<Value> = Vec::new();
    for advisory in advisories {
        let mut route_ids = BTreeSet::new();
        let mut unmapped = false;
        for name in &advisory.route_names {
            let lower = name.to_lowercase();
            let ids: Vec<&String> = route_names
                .iter()
                .filter(|(_, aliases)| aliases.iter().any(|alias| alias.to_lowercase() == lower))
                .map(|(route_id, _)| route_id)
                .collect();
            unmapped |= ids.is_empty();
            route_ids.extend(ids.into_iter().cloned());
        }
        if unmapped {
            partial = true;
            continue;
        }
        let caption = advisory.caption.clone().unwrap_or_default();
        let windows = advisory_windows(&caption, zone).unwrap_or_else(|_| {
            partial = true;
            vec![Window {
                starts_at: 0,
                ends_at: None,
            }]
        });
        let url = advisory
            .href
            .as_deref()
            .map(|href| base.join(href).map(|url| url.to_string()))
            .transpose()
            .map_err(io::Error::other)?;
        let description = [
            Some(caption).filter(|caption| !caption.is_empty()),
            url.as_ref().map(|url| format!("[Advisory details]({url})")),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("\n");
        let id = url.clone().unwrap_or_else(|| {
            format!(
                "{source}#{}{}",
                advisory.station_code.as_deref().unwrap_or_default(),
                advisory.title
            )
        });
        for window in &windows {
            let mut alert = json!({
                "id": if windows.len() > 1 { format!("{id}#{}", window.starts_at) } else { id.clone() },
                "title": advisory.title,
                "description": description,
                "routes": route_ids,
                "start_time": rfc3339(window.starts_at),
            });
            if let Some(ends_at) = window.ends_at {
                alert["expires_at"] = json!(rfc3339(ends_at));
            }
            if let Some(code) = &advisory.station_code {
                alert["stops"] = json!([code]);
                alert["targets"] = json!([{ "stopId": code }]);
            }
            alerts.push(alert);
        }
    }
    Ok((json!(alerts), partial))
}

pub async fn scrape(
    client: &crate::upstream::Client,
    url: &str,
    zone: Tz,
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
        decode(&html, url, zone, route_names).map_err(|_| crate::upstream::Failure::Decode)?;
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
    fn test_matches_the_shared_route_station_advisories_contract() {
        let contract: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/route-station-advisories/contract.json"
        ))
        .unwrap();
        let zone: chrono_tz::Tz = contract["timeZone"].as_str().unwrap().parse().unwrap();
        for entry in contract["cases"].as_array().unwrap() {
            let route_names =
                serde_json::from_value(entry.get("routeNames").cloned().unwrap_or(json!({})))
                    .unwrap();
            let result = super::decode(
                entry["html"].as_str().unwrap(),
                "https://example.test/alerts",
                zone,
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
                    let mut alert = json!({
                        "id": notice["id"],
                        "title": notice["title"],
                        "description": notice["description"],
                        "routes": notice["routeIds"],
                        "start_time": notice["startsAt"],
                    });
                    if let Some(ends_at) = notice.get("endsAt") {
                        alert["expires_at"] = ends_at.clone();
                    }
                    if let Some(stations) = notice.get("stations") {
                        alert["stops"] = stations.clone();
                        alert["targets"] = json!(
                            stations
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|code| json!({ "stopId": code }))
                                .collect::<Vec<_>>()
                        );
                    }
                    alert
                })
                .collect();
            assert_eq!(alerts, json!(expected), "{}", entry["name"]);
            assert_eq!(partial, entry["partial"] == true, "{}", entry["name"]);
        }
    }
}
