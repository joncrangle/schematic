//! Reads one-column boards with labelled disruption dates and stop scope.
//! Twin of `disruptionDetailsTableParser.ts`.
use super::strip_html::strip_html;
use crate::agencies::ScrapeOutcome;
use bytes::Bytes;
use chrono::{NaiveDate, TimeZone};
use chrono_tz::Tz;
use regex::Regex;
use scraper::{ElementRef, Html, Selector};
use serde_json::{Value, json};
use std::{collections::BTreeMap, collections::BTreeSet, error::Error, io};

fn plain(element: ElementRef<'_>) -> String {
    strip_html(&element.html())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn timestamp(text: &str, field: &str, zone: Tz) -> Result<i64, io::Error> {
    let pattern = Regex::new(&format!(r"(?i){field} Date:\s*([0-9]{{1,2}}) ([A-Za-z]{{3}}), ([0-9]{{4}})(?:\s+Time:\s*([0-9]{{1,2}}):([0-9]{{2}}) ([ap]m))?")).unwrap();
    let captures = pattern
        .captures(text)
        .ok_or_else(|| io::Error::other("Missing disruption date"))?;
    if captures.get(4).is_none()
        && Regex::new(r"(?i)^\s+Time:")
            .unwrap()
            .is_match(&text[captures.get(0).unwrap().end()..])
    {
        return Err(io::Error::other("Unreadable disruption clock"));
    }
    let months = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let month = months
        .iter()
        .position(|name| *name == captures[2].to_lowercase())
        .ok_or_else(|| io::Error::other("Invalid month"))? as u32
        + 1;
    let hour = captures
        .get(4)
        .map(|value| value.as_str().parse::<u32>().unwrap());
    if hour.is_some_and(|value| !(1..=12).contains(&value)) {
        return Err(io::Error::other("Invalid hour"));
    }
    let clock_hour = hour
        .map(|value| {
            value % 12
                + if captures[6].eq_ignore_ascii_case("pm") {
                    12
                } else {
                    0
                }
        })
        .unwrap_or(0);
    let minute = captures
        .get(5)
        .map(|value| value.as_str().parse::<u32>().unwrap())
        .unwrap_or(0);
    let date = NaiveDate::from_ymd_opt(
        captures[3].parse().unwrap(),
        month,
        captures[1].parse().unwrap(),
    )
    .and_then(|date| date.and_hms_opt(clock_hour, minute, 0))
    .ok_or_else(|| io::Error::other("Invalid disruption date"))?;
    zone.from_local_datetime(&date)
        .earliest()
        .map(|time| time.timestamp_millis())
        .ok_or_else(|| io::Error::other("Nonexistent disruption date"))
}
pub fn decode(
    html: &str,
    source: &str,
    zone: Tz,
    route_names: &BTreeMap<String, Vec<String>>,
) -> Result<Value, io::Error> {
    let document = Html::parse_document(html);
    let table = Selector::parse("table").unwrap();
    let row = Selector::parse("tr").unwrap();
    let tables: Vec<Vec<Vec<String>>> = document
        .select(&table)
        .map(|table| {
            table
                .select(&row)
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
            rows.first()
                .is_some_and(|header| header == &["Disruption Details"])
        })
        .collect();
    if tables.len() != 1 || tables[0].len() < 2 {
        return Err(io::Error::other("Missing disruption details board"));
    }
    let rows = &tables[0][1..];
    let route_pattern =
        Regex::new(r"(?i)^(Routes?\s+[^.]*?)\s+(?:Bus|Cancellation|Detour|Stop|Service)\b")
            .unwrap();
    let stop_pattern = Regex::new(r"(?i)Stops affected are\s+([0-9\s,and]+)[.;]").unwrap();
    let digits = Regex::new(r"[0-9]+").unwrap();
    let unknown_end = Regex::new(r"(?i)Unknown end time").unwrap();
    let mut alerts = Vec::new();
    for cells in rows {
        if cells.len() != 1 || cells[0].is_empty() {
            return Err(io::Error::other("Incomplete disruption row"));
        }
        let text = &cells[0];
        if text == "There are no active transit disruptions." {
            if rows.len() != 1 {
                return Err(io::Error::other("Conflicting disruption board"));
            }
            continue;
        }
        let starts_at = timestamp(text, "Start", zone)?;
        let ends_at = if unknown_end.is_match(text) {
            None
        } else {
            Some(timestamp(text, "End", zone)?)
        };
        if ends_at.is_some_and(|end| end < starts_at) {
            return Err(io::Error::other("Reversed disruption period"));
        }
        let route = route_pattern
            .captures(text)
            .map(|capture| capture[1].to_lowercase());
        let routes: Vec<_> = route_names
            .iter()
            .filter(|(_, aliases)| {
                aliases
                    .iter()
                    .any(|alias| Some(alias.to_lowercase()) == route)
            })
            .map(|(id, _)| id.clone())
            .collect();
        let stops: BTreeSet<String> = stop_pattern
            .captures(text)
            .map(|capture| {
                digits
                    .find_iter(&capture[1])
                    .map(|value| value.as_str().to_owned())
                    .collect()
            })
            .unwrap_or_default();
        let mut alert = json!({"id":format!("{source}#{text}"), "title":text, "routes":routes, "stops":stops, "start_time":chrono::DateTime::from_timestamp_millis(starts_at).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)});
        if !stops.is_empty() {
            alert["targets"] = json!(
                stops
                    .iter()
                    .map(|stop| json!({"stopId":stop}))
                    .collect::<Vec<_>>()
            );
        }
        if let Some(end) = ends_at {
            alert["end_time"] = json!(
                chrono::DateTime::from_timestamp_millis(end)
                    .unwrap()
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            );
        }
        alerts.push(alert);
    }
    Ok(json!(alerts))
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
    let document =
        decode(&html, url, zone, route_names).map_err(|_| crate::upstream::Failure::Decode)?;
    Ok(ScrapeOutcome {
        bytes: Bytes::from(serde_json::to_vec(&document)?),
        partial: false,
        content_type: "application/json",
    })
}
#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    #[test]
    fn test_matches_the_shared_disruption_details_contract() {
        let contract: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/disruption-details-table/contract.json"
        ))
        .unwrap();
        for entry in contract["cases"].as_array().unwrap() {
            let names =
                serde_json::from_value(entry.get("routeNames").cloned().unwrap_or(json!({})))
                    .unwrap();
            let result = super::decode(
                entry["html"].as_str().unwrap(),
                "https://example.test/status",
                chrono_tz::America::Edmonton,
                &names,
            );
            if entry["error"] == true {
                assert!(result.is_err(), "{}", entry["name"]);
                continue;
            }
            let mut expected: Vec<_> = entry["notices"].as_array().unwrap().iter().map(|notice| json!({"id":format!("https://example.test/status#{}",notice["title"].as_str().unwrap()),"title":notice["title"],"routes":notice["routeIds"],"stops":notice["stationIds"],"start_time":chrono::DateTime::from_timestamp_millis(notice["startsAt"].as_i64().unwrap()).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Secs,true)})).collect();
            for alert in &mut expected {
                if let Some(stops) = alert["stops"].as_array().filter(|stops| !stops.is_empty()) {
                    let targets: Vec<_> = stops.iter().map(|stop| json!({"stopId":stop})).collect();
                    alert["targets"] = json!(targets);
                }
            }
            assert_eq!(result.unwrap(), json!(expected), "{}", entry["name"]);
        }
    }
}
