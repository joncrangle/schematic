//! Twin of `stopClosureTableParser.ts` for dated, stop-scoped closure tables.
use super::strip_html::strip_html;
use crate::agencies::ScrapeOutcome;
use bytes::Bytes;
use chrono::{Duration, NaiveDate, TimeZone};
use chrono_tz::Tz;
use regex::Regex;
use scraper::{ElementRef, Html, Selector};
use serde_json::{Value, json};
use std::{collections::BTreeMap, error::Error, io};
fn plain(element: ElementRef<'_>) -> String {
    strip_html(&element.html())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn day(value: &str, zone: Tz, after: bool) -> Result<i64, io::Error> {
    let pattern = Regex::new(r"^([A-Za-z]{3,9})\s+([0-9]{1,2}),\s*([0-9]{4})$").unwrap();
    let m = pattern
        .captures(value)
        .ok_or_else(|| io::Error::other("Unreadable closure date"))?;
    let months = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let full_months = [
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
    let word = m[1].to_lowercase();
    let month = full_months
        .iter()
        .position(|name| *name == word)
        .or_else(|| months.iter().position(|name| *name == word))
        .ok_or_else(|| io::Error::other("Invalid closure month"))? as u32
        + 1;
    let mut date = NaiveDate::from_ymd_opt(m[3].parse().unwrap(), month, m[2].parse().unwrap())
        .ok_or_else(|| io::Error::other("Invalid closure date"))?;
    if after {
        date = date
            .checked_add_signed(Duration::days(1))
            .ok_or_else(|| io::Error::other("Invalid closure end"))?;
    }
    zone.from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .map(|date| date.timestamp_millis())
        .ok_or_else(|| io::Error::other("Nonexistent closure date"))
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
    let expected = [
        "Route",
        "Closed Stop",
        "Alternate Stop",
        "Start Date",
        "End Date",
    ];
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
        .filter(|rows| rows.first().is_some_and(|header| header == &expected))
        .collect();
    if tables.len() != 1 || tables[0].len() < 2 {
        return Err(io::Error::other("Missing stop closure table"));
    }
    let code = Regex::new(r"(?i)\bStop\s*#?\s*([0-9]+)\b").unwrap();
    let label_split = Regex::new(r"(?i)\s*(?:,|\band\b)\s*").unwrap();
    let mut alerts = Vec::new();
    for row in &tables[0][1..] {
        if row.len() != 5 || row.iter().any(String::is_empty) {
            return Err(io::Error::other("Incomplete closure row"));
        }
        let code = code
            .captures(&row[1])
            .ok_or_else(|| io::Error::other("Missing closed stop code"))?[1]
            .to_owned();
        let labels: Vec<_> = label_split.split(&row[0]).map(str::to_lowercase).collect();
        let routes: Vec<_> = route_names
            .iter()
            .filter(|(_, aliases)| {
                aliases
                    .iter()
                    .any(|alias| labels.contains(&alias.to_lowercase()))
            })
            .map(|(id, _)| id.clone())
            .collect();
        let start = day(&row[3], zone, false)?;
        let end = if matches!(
            row[4].to_lowercase().as_str(),
            "until further notice" | "permanent closure"
        ) {
            None
        } else {
            Some(day(&row[4], zone, true)?)
        };
        if end.is_some_and(|end| end <= start) {
            return Err(io::Error::other("Reversed closure dates"));
        }
        let stop = format!("Stop {code}");
        let targets = if routes.is_empty() {
            vec![json!({"stopId":stop,"stopCode":code})]
        } else {
            routes
                .iter()
                .map(|route| json!({"routeId":route,"stopId":stop,"stopCode":code}))
                .collect()
        };
        let mut alert = json!({"id":format!("{source}#{}-{code}",row[0]),"title":format!("{stop} closed"),"description":format!("Closed stop: {}\nAlternate stop: {}",row[1],row[2]),"start_time":chrono::DateTime::from_timestamp_millis(start).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Secs,true),"routes":routes,"stops":[stop],"targets":targets,"stopScoped":true,"effect":"NO_SERVICE"});
        if let Some(end) = end {
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
    names: &BTreeMap<String, Vec<String>>,
) -> Result<ScrapeOutcome, Box<dyn Error + Send + Sync>> {
    let html = String::from_utf8(client.download(url, 8 * 1024 * 1024).await?.to_vec())?;
    let data = decode(&html, url, zone, names).map_err(|_| crate::upstream::Failure::Decode)?;
    Ok(ScrapeOutcome {
        bytes: Bytes::from(serde_json::to_vec(&data)?),
        partial: false,
        content_type: "application/json",
    })
}
#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    #[test]
    fn test_matches_the_shared_stop_closure_contract() {
        let contract: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/stop-closure-table/contract.json"
        ))
        .unwrap();
        for entry in contract["cases"].as_array().unwrap() {
            let names =
                serde_json::from_value(entry.get("routeNames").cloned().unwrap_or(json!({})))
                    .unwrap();
            let result = super::decode(
                entry["html"].as_str().unwrap(),
                "https://example.test/status",
                chrono_tz::America::Regina,
                &names,
            );
            if entry["error"] == true {
                assert!(result.is_err(), "{}", entry["name"]);
                continue;
            }
            let expected:Vec<_>=entry["notices"].as_array().unwrap().iter().map(|notice|json!({"id":notice["id"],"title":notice["title"],"description":notice["description"],"start_time":chrono::DateTime::from_timestamp_millis(notice["startsAt"].as_i64().unwrap()).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Secs,true),"routes":notice["routeIds"],"stops":notice["affectedStations"],"targets":notice["targets"],"stopScoped":true,"effect":"NO_SERVICE"})).collect();
            let expected: Vec<_> = expected
                .into_iter()
                .zip(entry["notices"].as_array().unwrap())
                .map(|(mut wire, notice)| {
                    if let Some(end) = notice["endsAt"].as_i64() {
                        wire["end_time"] = json!(
                            chrono::DateTime::from_timestamp_millis(end)
                                .unwrap()
                                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
                        );
                    }
                    wire
                })
                .collect();
            assert_eq!(result.unwrap(), json!(expected), "{}", entry["name"]);
        }
    }
}
