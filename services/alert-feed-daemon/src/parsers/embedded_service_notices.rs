use super::{heading_notices::PublicationReference, strip_html::strip_html};
use chrono::{NaiveDate, TimeZone};
use chrono_tz::Tz;
use scraper::{ElementRef, Html, Selector};
use serde_json::{Value, json};
use std::{collections::BTreeMap, io};
fn plain(node: ElementRef<'_>) -> String {
    strip_html(&node.html())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn rx(pattern: &str) -> regex::Regex {
    regex::Regex::new(pattern).unwrap()
}
fn instant(date: NaiveDate, hour: u32, minute: u32, zone: &Tz) -> Result<i64, io::Error> {
    let local = date
        .and_hms_opt(hour, minute, 0)
        .ok_or_else(|| io::Error::other("Invalid notice time"))?;
    zone.from_local_datetime(&local)
        .earliest()
        .map(|v| v.timestamp_millis())
        .ok_or_else(|| io::Error::other("Invalid notice time"))
}
fn iso(value: i64) -> String {
    chrono::DateTime::from_timestamp_millis(value)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
pub fn decode(
    html: &str,
    source: &str,
    routes: &BTreeMap<String, Vec<String>>,
    zone: &Tz,
    now: i64,
    reference: Option<&PublicationReference>,
) -> Result<Option<Value>, io::Error> {
    let doc = Html::parse_document(html);
    let social_selector = Selector::parse(".fts-jal-single-fb-post").unwrap();
    let bulletin_selector = Selector::parse(".list-group-item").unwrap();
    let icon = Selector::parse(".fa-exclamation-triangle").unwrap();
    let social: Vec<_> = doc.select(&social_selector).collect();
    let is_social = !social.is_empty();
    let cards = if is_social {
        social
    } else {
        doc.select(&bulletin_selector)
            .filter(|c| {
                c.select(&icon).next().is_some()
                    && c.prev_siblings()
                        .filter_map(ElementRef::wrap)
                        .flat_map(|n| {
                            n.select(&Selector::parse("h3").unwrap())
                                .map(plain)
                                .collect::<Vec<_>>()
                        })
                        .next()
                        .is_some_and(|t| t.eq_ignore_ascii_case("Service Bulletins"))
            })
            .collect()
    };
    if cards.is_empty() {
        return Ok(None);
    }
    let message_selector = Selector::parse(".fts-jal-fb-message").unwrap();
    let heading_selector = Selector::parse("h1,h2,h3,h4,h5,h6").unwrap();
    let service = rx(
        r"(?i)\b(?:detour|construction|service reductions?|not be running|end service|suspend(?:ed|sion)?|cancel(?:led|ed|lations?)?|service schedule)\b",
    );
    let stamp = rx(r"(?i)last updated \d{1,2}/\d{1,2}/\d{4} \d{1,2}:\d{2}:\d{2} [AP]M");
    let publication = rx(r"(?i)last updated \d{1,2}/\d{1,2}/(\d{4})");
    let date_re = rx(
        r"(?i)\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b",
    );
    let clock = rx(r"(?i)end service\b.*?\bat (\d{1,2}):(\d{2})\s*([AP])\.?M");
    let open = rx(r"(?i)\b(?:starting|begin|beginning|until|through)\b");
    let one_day = rx(r"(?i)not be running|end service");
    let restored = rx(r"(?i)\b(?:detour ends|return to regular service|regular service.*resume)\b");
    let clauses = rx(
        r"(?i)\broutes?\s+(\d+[A-Za-z]?(?:-\d+)?(?:(?:\s*,\s*(?:and\s+)?|\s+(?:and|&)\s+|\s*/\s*)\d+[A-Za-z]?(?:-\d+)?)*)",
    );
    let closed = rx(
        r"(?i)\b(?:unable to service|not servic(?:e|ing)|not serv(?:e|ing)|closed)\s+stops?\b[^.!?]*",
    );
    let stop_re = rx(r"\b\d{3,}\b");
    let months = [
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
    let mut alerts = Vec::new();
    for card in cards {
        let message = if is_social {
            card.select(&message_selector)
                .next()
                .ok_or_else(|| io::Error::other("Incomplete embedded service notice"))?
        } else {
            card
        };
        let heading = card.select(&heading_selector).next();
        let original = plain(message);
        if original.is_empty() || (!is_social && heading.is_none()) {
            return Err(io::Error::other("Incomplete embedded service notice"));
        }
        let mut description = stamp.replace(&original, "").trim().to_owned();
        if is_social && !service.is_match(&description) {
            continue;
        }
        let mut title = if let Some(h) = heading {
            plain(h)
        } else {
            rx(r"[.!?]\s").find(&description).map_or_else(
                || description.clone(),
                |m| description[..m.start() + 1].to_owned(),
            )
        };
        if title.eq_ignore_ascii_case("No weather bulletins") {
            continue;
        }
        if rx(r"(?i)^Heads up[,!]").is_match(&title) {
            let remainder = description[title.len()..].trim();
            if !remainder.is_empty() {
                title = rx(r"[.!?]\s").find(remainder).map_or_else(
                    || remainder.to_owned(),
                    |m| remainder[..m.start() + 1].to_owned(),
                )
            }
        }
        if !is_social {
            description = description[title.len()..].trim().to_owned()
        }
        let full = format!("{title} {description}");
        let year = publication
            .captures(&plain(card))
            .and_then(|c| c[1].parse::<i32>().ok())
            .or(reference.map(|r| r.publication_year));
        if let Some(r) = reference {
            let today = chrono::DateTime::from_timestamp_millis(now)
                .unwrap()
                .format("%Y-%m-%d")
                .to_string();
            if today < r.valid_from || today > r.valid_through {
                return Err(io::Error::other(
                    "Embedded notice publication reference expired",
                ));
            }
        }
        let mut start = 0;
        let mut end = None;
        if let Some(d) = date_re.captures(&full)
            && let Some(year) = d
                .get(3)
                .and_then(|v| v.as_str().parse::<i32>().ok())
                .or(year)
        {
            let token = d[1].to_lowercase();
            let month = months.iter().position(|m| m.starts_with(&token)).unwrap() + 1;
            let day = d[2].parse().unwrap();
            let date = NaiveDate::from_ymd_opt(year, month as u32, day)
                .ok_or_else(|| io::Error::other("Invalid notice date"))?;
            start = instant(date, 0, 0, zone)?;
            if let Some(c) = clock.captures(&full) {
                start = instant(
                    date,
                    c[1].parse::<u32>().unwrap() % 12
                        + if c[3].eq_ignore_ascii_case("P") {
                            12
                        } else {
                            0
                        },
                    c[2].parse().unwrap(),
                    zone,
                )?
            }
            if !open.is_match(&full) || one_day.is_match(&full) {
                end = Some(instant(date.succ_opt().unwrap(), 0, 0, zone)?)
            }
            if restored.is_match(&full) && !rx(r"(?i)end service|not be running").is_match(&full) {
                end = Some(instant(date, 0, 0, zone)?);
                start = 0
            }
        }
        let token_pattern = rx(r"\d+[A-Za-z]?(?:-\d+)?");
        let tokens: Vec<String> = clauses
            .captures_iter(&full)
            .flat_map(|c| {
                token_pattern
                    .find_iter(&c[1])
                    .map(|m| m.as_str().to_lowercase())
                    .collect::<Vec<_>>()
            })
            .collect();
        let route_ids: Vec<_> = routes
            .iter()
            .filter(|(_, names)| names.iter().any(|n| tokens.contains(&n.to_lowercase())))
            .map(|(id, _)| id.clone())
            .collect();
        let scope_text = rx(r"(?i)\b(St|Dr|Ave|Rd|Blvd)\.").replace_all(&full, "$1");
        let mut stops: Vec<_> = closed
            .find(&scope_text)
            .map(|c| {
                stop_re
                    .find_iter(c.as_str())
                    .map(|s| s.as_str().to_owned())
                    .collect()
            })
            .unwrap_or_default();
        stops.dedup();
        let targets: Vec<_> = stops
            .iter()
            .flat_map(|stop| {
                if route_ids.is_empty() {
                    vec![json!({"stopId":stop})]
                } else {
                    route_ids
                        .iter()
                        .map(|route| json!({"stopId":stop,"routeId":route}))
                        .collect()
                }
            })
            .collect();
        let mut notice = json!({"id":format!("{source}#{title}"),"title":title,"description":description,"routes":route_ids,"start_time":iso(start)});
        if let Some(end) = end {
            notice["expires_at"] = json!(iso(end))
        }
        if !targets.is_empty() {
            notice["stops"] = json!(stops);
            notice["targets"] = json!(targets)
        }
        alerts.push(notice);
    }
    Ok(Some(json!(alerts)))
}
