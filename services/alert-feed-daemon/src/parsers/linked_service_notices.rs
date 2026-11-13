use super::strip_html::strip_html;
use chrono::{NaiveDate, TimeZone};
use chrono_tz::Tz;
use scraper::{ElementRef, Html, Selector};
use serde_json::{Value, json};
use std::io;
fn sel(s: &str) -> Selector {
    Selector::parse(s).unwrap()
}
fn rx(s: &str) -> regex::Regex {
    regex::Regex::new(s).unwrap()
}
fn plain(n: ElementRef<'_>) -> String {
    strip_html(&n.html())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn invalid() -> io::Error {
    io::Error::other("Incomplete linked service notice")
}
pub fn index_urls(html: &str, source: &str) -> Result<Option<Vec<String>>, io::Error> {
    let doc = Html::parse_document(html);
    let cards: Vec<_> = doc.select(&sel("a[data-alerts-type]")).collect();
    if cards.is_empty() {
        return Ok(None);
    }
    let origin = reqwest::Url::parse(source).map_err(|_| invalid())?;
    let mut urls = Vec::new();
    for card in cards {
        let title = card.select(&sel("h3")).next().ok_or_else(invalid)?;
        if plain(title).is_empty() || card.value().attr("data-alerts-line").is_none() {
            return Err(invalid());
        }
        let url = origin
            .join(card.value().attr("href").ok_or_else(invalid)?)
            .map_err(|_| invalid())?;
        if url.origin() != origin.origin() {
            return Err(invalid());
        }
        let url = url.to_string();
        if !urls.contains(&url) {
            urls.push(url)
        }
    }
    Ok(Some(urls))
}
fn service_time(text: &str, year: i32, zone: &Tz) -> Result<Option<i64>, io::Error> {
    if rx("(?i)indéterminée?|nouvel ordre").is_match(text) {
        return Ok(None);
    }
    let re = rx(
        r"(?i)^(\d{1,2})\s+(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)(?:\s+(20\d{2}))?\s*,?\s*(?:(\d{1,2})\s*h\s*(\d{2})?)?$",
    );
    let cleaned = rx(r"(?i)^(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+")
        .replace(text.trim(), "");
    let c = re.captures(&cleaned).ok_or_else(invalid)?;
    let months = [
        "janvier",
        "février",
        "mars",
        "avril",
        "mai",
        "juin",
        "juillet",
        "août",
        "septembre",
        "octobre",
        "novembre",
        "décembre",
    ];
    let month = months
        .iter()
        .position(|m| *m == c[2].to_lowercase())
        .unwrap()
        + 1;
    let number = |index: usize, default: u32| {
        c.get(index)
            .and_then(|v| v.as_str().parse().ok())
            .unwrap_or(default)
    };
    let date = NaiveDate::from_ymd_opt(number(3, year as u32) as i32, month as u32, number(1, 0))
        .and_then(|d| d.and_hms_opt(number(4, 0), number(5, 0), 0))
        .ok_or_else(invalid)?;
    Ok(Some(
        zone.from_local_datetime(&date)
            .earliest()
            .ok_or_else(invalid)?
            .timestamp_millis(),
    ))
}
fn iso(n: i64) -> String {
    chrono::DateTime::from_timestamp_millis(n)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
pub fn decode_detail(
    html: &str,
    source: &str,
    zone: &Tz,
    route_names: &std::collections::BTreeMap<String, Vec<String>>,
    stop_names: &std::collections::BTreeMap<String, Vec<String>>,
) -> Result<Option<Value>, io::Error> {
    let doc = Html::parse_document(html);
    if let Some(update) = doc
        .select(&sel(".node--type-update.node--view-mode-full"))
        .next()
    {
        let title = update.select(&sel("h1")).next().ok_or_else(invalid)?;
        let body = update.select(&sel(".prose")).next().ok_or_else(invalid)?;
        let title = plain(title);
        let description = super::heading_notices::notice_text(body, source)
            .trim()
            .to_owned();
        if title.is_empty() || description.is_empty() {
            return Err(invalid());
        }
        let date = |label: &str| -> Result<i64, io::Error> {
            let field = update
                .select(&sel("div"))
                .find(|n| plain(*n) == label)
                .ok_or_else(invalid)?;
            let parent = field
                .parent()
                .and_then(ElementRef::wrap)
                .ok_or_else(invalid)?;
            let text = plain(parent).replacen(label, "", 1).trim().to_owned();
            let re = rx(r"^(?:\w+,\s*)?(\w+ \d{1,2}), (20\d{2}) - (\d{1,2}:\d{2} [AP]M)$");
            let c = re.captures(&text).ok_or_else(invalid)?;
            let year: i32 = c[2].parse().map_err(|_| invalid())?;
            super::ghd_news::parse_posted_at(&format!("{} {} {}", &c[1], year, &c[3]), zone, year)
                .map(|s| s * 1000)
                .ok_or_else(invalid)
        };
        let start = date("Start Date")?;
        let end = date("End Date")?;
        if end < start {
            return Err(invalid());
        }
        let text = format!("{title} {description}");
        let routes: Vec<_> = route_names
            .iter()
            .filter(|(_, names)| {
                names
                    .iter()
                    .any(|name| super::heading_notices::has_whole_token(&text, name))
            })
            .map(|(id, _)| id.clone())
            .collect();
        let stops: Vec<_> = stop_names
            .iter()
            .filter(|(_, names)| names.iter().any(|name| text.contains(name)))
            .map(|(id, _)| id.clone())
            .collect();
        let mut notice = json!({"id":source,"title":title,"description":description,"routes":routes,"start_time":iso(start),"expires_at":iso(end)});
        if !stops.is_empty() {
            let mut targets = Vec::new();
            for stop in &stops {
                if routes.is_empty() {
                    targets.push(json!({"stopId":stop}));
                } else {
                    for route in &routes {
                        targets.push(json!({"routeId":route,"stopId":stop}));
                    }
                }
            }
            notice["stopScoped"] = json!(true);
            notice["stops"] = json!(stops);
            notice["targets"] = json!(targets);
        }
        return Ok(Some(json!([notice])));
    }
    let Some(body) = doc.select(&sel(".body-blocks")).next() else {
        return Ok(None);
    };
    let route_list = doc.select(&sel(".affected-lines")).next();
    let title = doc.select(&sel("h1")).next().ok_or_else(invalid)?;
    let publication = doc
        .select(&sel(".date-published"))
        .next()
        .ok_or_else(invalid)?;
    let description = super::heading_notices::notice_text(body, source)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let text = plain(body);
    let year = rx(r"\b20\d{2}\b")
        .find(&plain(publication))
        .and_then(|m| m.as_str().parse().ok())
        .ok_or_else(invalid)?;
    if description.is_empty() {
        return Err(invalid());
    }
    let mut routes: Vec<_> = route_list
        .into_iter()
        .flat_map(|list| {
            list.select(&sel(".chip-large"))
                .map(plain)
                .collect::<Vec<_>>()
        })
        .collect();
    routes.sort();
    routes.dedup();
    let closed = rx(r"(?i)Arrêts? non desservis?\s*:\s*(.*)")
        .captures(&text)
        .map(|c| {
            let tail = c[1].to_owned();
            rx(r"(?i)Arrêts? (?:recommandés?|temporaires?)\s*:|Informations importantes\s*:")
                .find(&tail)
                .map_or_else(|| tail.clone(), |m| tail[..m.start()].to_owned())
        });
    let title = plain(title);
    let stop_scoped = closed.is_some() || rx("(?i)arrêts?.*non desservis?").is_match(&title);
    let stop_re = rx(r"#\s*\d+(?:\s*[-–,]\s*#?\s*\d+)*");
    let digits = rx(r"\d+");
    let mut stops = Vec::new();
    for group in stop_re.find_iter(closed.as_deref().unwrap_or(&title)) {
        for number in digits.find_iter(group.as_str()) {
            let id = number.as_str().to_owned();
            if !stops.contains(&id) {
                stops.push(id)
            }
        }
    }
    let targets: Vec<_> = stops
        .iter()
        .flat_map(|stop| {
            if routes.is_empty() {
                vec![json!({"stopId":stop})]
            } else {
                routes
                    .iter()
                    .map(|route| json!({"stopId":stop,"routeId":route}))
                    .collect()
            }
        })
        .collect();
    let extract = |label: &str, following: &str| {
        let r = rx(&format!(r"(?i){label}\s*:\s*(.*)"));
        r.captures(&text).map(|c| {
            let tail = c[1].to_owned();
            rx(following)
                .find(&tail)
                .map_or_else(|| tail.clone(), |m| tail[..m.start()].to_owned())
        })
    };
    let mut start = extract("Début", r"(?i)\s+(?:Fin|Raison)\s*:|\s+Arrêts")
        .map(|v| service_time(&v, year, zone))
        .transpose()?
        .flatten()
        .unwrap_or(0);
    let mut end = extract("Fin", r"(?i)\s+Raison\s*:|\s+Arrêts")
        .map(|v| service_time(&v, year, zone))
        .transpose()?
        .flatten();
    if start == 0
        && end.is_none()
        && let Some(section) = doc.select(&sel(".date-section")).next()
        && let Some(range) = rx(r"(?i)\bDu\s+(\d{1,2})\s+au\s+(\d{1,2})\s+(\p{L}+)\s+(20\d{2})\b")
            .captures(&plain(section))
    {
        start = service_time(
            &format!("{} {} {}", &range[1], &range[3], &range[4]),
            year,
            zone,
        )?
        .ok_or_else(invalid)?;
        let last = service_time(
            &format!("{} {} {}", &range[2], &range[3], &range[4]),
            year,
            zone,
        )?
        .ok_or_else(invalid)?;
        let next = chrono::DateTime::from_timestamp_millis(last)
            .unwrap()
            .with_timezone(zone)
            .date_naive()
            .succ_opt()
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        end = Some(
            zone.from_local_datetime(&next)
                .earliest()
                .ok_or_else(invalid)?
                .timestamp_millis(),
        );
    }
    if end.is_some_and(|end| end < start) {
        return Err(invalid());
    }
    let mut notice = json!({"id":source,"title":title,"description":description,"routes":routes,"start_time":iso(start)});
    if let Some(end) = end {
        notice["expires_at"] = json!(iso(end))
    }
    if stop_scoped {
        notice["stopScoped"] = json!(true);
        notice["stops"] = json!(stops);
        notice["targets"] = json!(targets)
    }
    Ok(Some(json!([notice])))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_matches_the_shared_parity_contract() {
        let contract: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/linked-service-notices/contract.json"
        ))
        .unwrap();
        for entry in contract["cases"].as_array().unwrap() {
            let result = index_urls(
                entry["html"].as_str().unwrap(),
                "https://example.test/board",
            );
            if entry["error"].as_bool().unwrap_or(false) {
                assert!(result.is_err(), "{}", entry["name"])
            } else {
                assert_eq!(
                    serde_json::to_value(result.unwrap().unwrap()).unwrap(),
                    entry["urls"],
                    "{}",
                    entry["name"]
                )
            }
        }
    }
}
