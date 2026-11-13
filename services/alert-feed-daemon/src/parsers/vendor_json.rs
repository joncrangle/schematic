//! Vendor envelopes are normalized here for validation, then forwarded intact.
//! Core applies the same normalization and the agency's timezone/interpretation.
use chrono::{Datelike, Duration, NaiveDate};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io;

fn invalid() -> io::Error {
    io::Error::other("Invalid vendor JSON alert feed")
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Broadcast {
    id: Value,
    message: String,
    route_num: Value,
    stop_num: Value,
    is_for_detour: bool,
    r#type: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Search {
    total_count: u64,
    value: Vec<SearchItem>,
}
#[derive(Deserialize)]
struct SearchItem {
    document: Document,
}
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Document {
    title: String,
    route_title: String,
    detour: String,
    routes_affected: String,
    #[serde(rename = "Approx_x002e_StartDate")]
    start: Option<String>,
    #[serde(rename = "Approx_x002e_EndDate")]
    end: Option<String>,
    notes: Option<String>,
    revised: Option<String>,
}
fn token(value: &Value) -> Result<Option<String>, io::Error> {
    let text = match value {
        Value::String(s) => s.trim().to_owned(),
        Value::Number(n) => n.to_string(),
        _ => return Err(invalid()),
    };
    Ok((!text.is_empty() && text != "0").then_some(text))
}
const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
// These scanners mirror the TypeScript regexes, including their ASCII `\b`.
fn is_word(c: Option<&char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_')
}
fn boundary(s: &[char], i: usize) -> bool {
    is_word(i.checked_sub(1).and_then(|j| s.get(j))) != is_word(s.get(i))
}
fn starts(s: &[char], i: usize, word: &str, ignore_case: bool) -> bool {
    word.chars().enumerate().all(|(k, c)| {
        s.get(i + k)
            .is_some_and(|&x| x == c || (ignore_case && x.eq_ignore_ascii_case(&c)))
    })
}
/// Up to `max` ASCII digits at `i`, as (value, count).
fn digits(s: &[char], i: usize, max: usize) -> (u32, usize) {
    let mut value = 0;
    let mut count = 0;
    while count < max
        && let Some(d) = s.get(i + count).and_then(|c| c.to_digit(10))
    {
        value = value * 10 + d;
        count += 1;
    }
    (value, count)
}
/// ECMAScript `\s`.
fn is_space(c: Option<&char>) -> bool {
    c.is_some_and(|&c| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}
fn find<T>(s: &[char], mut at: impl FnMut(usize) -> Option<T>) -> Option<T> {
    (0..s.len()).filter(|&i| boundary(s, i)).find_map(&mut at)
}
fn wall_time(value: Option<&str>, end: bool) -> Option<String> {
    let s: Vec<char> = value?.chars().collect();
    let year = find(&s, |i| {
        let (year, n) = digits(&s, i, 4);
        (n == 4 && !is_word(s.get(i + 4))).then_some(year as i32)
    })?;
    // `Date.UTC` reads years below 100 as 19xx, so TypeScript rejects them.
    if year < 100 {
        return None;
    }
    let (month, day) = if starts(&s, 0, "End of ", true) {
        // Whole words only, so "Mayor" never names May.
        let month = find(&s, |i| {
            MONTHS
                .iter()
                .position(|m| starts(&s, i, m, false) && !is_word(s.get(i + m.chars().count())))
        })
        .map_or(12, |m| m as u32 + 1);
        let next = if month == 12 {
            NaiveDate::from_ymd_opt(year + 1, 1, 1)?
        } else {
            NaiveDate::from_ymd_opt(year, month + 1, 1)?
        };
        (month, (next - Duration::days(1)).day())
    } else {
        find(&s, |i| {
            MONTHS.iter().enumerate().find_map(|(m, name)| {
                let j = i + name.chars().count();
                if !starts(&s, i, name, false) || s.get(j) != Some(&' ') {
                    return None;
                }
                let (day, n) = digits(&s, j + 1, 2);
                (n > 0 && s.get(j + 1 + n) == Some(&',')).then_some((m as u32 + 1, day))
            })
        })?
    };
    let clock = find(&s, |i| {
        let (hour, n) = digits(&s, i, 2);
        if n == 0 || s.get(i + n) != Some(&':') {
            return None;
        }
        let (minute, m) = digits(&s, i + n + 1, 2);
        if m != 2 {
            return None;
        }
        let mut j = i + n + 3;
        while is_space(s.get(j)) {
            j += 1;
        }
        let pm = starts(&s, j, "PM", true);
        ((pm || starts(&s, j, "AM", true)) && !is_word(s.get(j + 2))).then_some((hour, minute, pm))
    });
    let (hour, minute) = match clock {
        Some((hour, minute, _)) if !(1..=12).contains(&hour) || minute > 59 => return None,
        Some((hour, minute, pm)) => (hour % 12 + if pm { 12 } else { 0 }, minute),
        None => (0, 0),
    };
    // Date-only expiry includes that service day. The end is exclusive.
    let mut date = NaiveDate::from_ymd_opt(year, month, day)?.and_hms_opt(hour, minute, 0)?;
    if end && clock.is_none() {
        date += Duration::days(1);
    }
    Some(date.format("%Y-%m-%dT%H:%M:%S.000Z").to_string())
}
#[derive(Deserialize)]
struct AttributeFeed {
    data: Vec<AttributeItem>,
    meta: AttributeMeta,
}
#[derive(Deserialize)]
struct AttributeMeta {
    pagination: AttributePagination,
}
#[derive(Deserialize)]
struct AttributePagination {
    total: u64,
}
#[derive(Deserialize)]
struct AttributeItem {
    id: Value,
    attributes: AttributeContent,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttributeContent {
    title: String,
    description: String,
    start_date: String,
    end_date: String,
}
fn numeric_wall_date(value: &str, end: bool) -> Result<String, io::Error> {
    let date = NaiveDate::parse_from_str(value, "%d-%m-%Y").map_err(|_| invalid())?;
    if date.format("%d-%m-%Y").to_string() != value {
        return Err(invalid());
    }
    let date = if end {
        date.checked_add_signed(Duration::days(1))
            .ok_or_else(invalid)?
    } else {
        date
    };
    Ok(format!("{}T00:00:00.000Z", date.format("%Y-%m-%d")))
}
pub fn normalize(payload: Value, parser: &str) -> Result<Value, io::Error> {
    if parser == "bucketed-transit-alerts" {
        return super::transit_notices::bucketed(&payload);
    }
    if parser == "jsonapi-transit-notices" {
        return super::transit_notices::jsonapi(&payload);
    }
    if parser == "keyed-service-notices" {
        let feed = payload.as_object().ok_or_else(invalid)?;
        let clock = regex::Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$")
            .map_err(|_| invalid())?;
        if !feed
            .get("queryTime")
            .and_then(Value::as_str)
            .is_some_and(|v| clock.is_match(v))
            || (!feed.contains_key("serviceAdvisories") && !feed.contains_key("systemMessages"))
        {
            return Err(invalid());
        }
        let route_pattern =
            regex::Regex::new(r"(?-u:\b)(?i-u:route)[\t\n\x0B\x0C\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]+([a-zA-Z0-9]+)(?-u:\b)").map_err(|_| invalid())?;
        let stop_pattern = regex::Regex::new(r"(?m)^\*[\t\n\x0B\x0C\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]+([0-9]+)[\t\n\x0B\x0C\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]+-[\t\n\x0B\x0C\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]+[^\t\n\x0B\x0C\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]").map_err(|_| invalid())?;
        let mut alerts = Vec::new();
        for (field, prefix) in [
            ("serviceAdvisories", "advisory"),
            ("systemMessages", "message"),
        ] {
            let Some(items) = feed.get(field) else {
                continue;
            };
            for item in items.as_array().ok_or_else(invalid)? {
                let key = item
                    .get("key")
                    .filter(|v| v.is_string() || v.is_number())
                    .ok_or_else(invalid)?;
                for field in ["title", "body", "type", "message", "category", "updatedAt"] {
                    if item.get(field).is_some_and(|v| !v.is_string()) {
                        return Err(invalid());
                    }
                }
                let title = item
                    .get("title")
                    .or_else(|| item.get("type"))
                    .and_then(Value::as_str)
                    .filter(|v| !v.chars().all(|c| is_space(Some(&c))))
                    .ok_or_else(invalid)?;
                let description = item
                    .get("body")
                    .or_else(|| item.get("message"))
                    .and_then(Value::as_str)
                    .filter(|v| !v.chars().all(|c| is_space(Some(&c))))
                    .ok_or_else(invalid)?;
                let mut routes = Vec::<String>::new();
                for found in route_pattern.captures_iter(description) {
                    let id = found[1].to_string();
                    if !routes.contains(&id) {
                        routes.push(id);
                    }
                }
                let mut stops = Vec::<String>::new();
                for found in stop_pattern.captures_iter(description) {
                    let id = found[1].to_string();
                    if !stops.contains(&id) {
                        stops.push(id);
                    }
                }
                let id = super::generic_json::token(key);
                let targets: Vec<Value> = stops.iter().map(|id| json!({"stopId":id})).collect();
                let mut alert = json!({"id":format!("{prefix}-{id}"),"title":title,"description":description,"routes":routes,"stops":stops,"targets":targets});
                if let Some(category) = item.get("category").or_else(|| item.get("type")) {
                    alert["category"] = category.clone();
                }
                if let Some(updated) = item.get("updatedAt").and_then(Value::as_str) {
                    if !clock.is_match(updated) {
                        return Err(invalid());
                    }
                    alert["posted_at"] = json!(format!("{updated}Z"));
                }
                alerts.push(alert);
            }
        }
        return Ok(json!({"alerts":alerts,"partial":false}));
    }
    if parser == "attribute-advisories" {
        let feed: AttributeFeed = serde_json::from_value(payload).map_err(|_| invalid())?;
        let partial = feed.meta.pagination.total != feed.data.len() as u64;
        let mut alerts = Vec::new();
        for item in feed.data {
            if !item.id.is_string() && !item.id.is_number() {
                return Err(invalid());
            }
            let content = item.attributes;
            if content.title.trim().is_empty() || content.description.trim().is_empty() {
                return Err(invalid());
            }
            let start = numeric_wall_date(&content.start_date, false)?;
            let end = numeric_wall_date(&content.end_date, true)?;
            if end <= start {
                return Err(invalid());
            }
            alerts.push(json!({"id":item.id,"title":content.title,"description":content.description,"effect":"UNKNOWN_EFFECT","activePeriod":{"start":start,"end":end}}));
        }
        return Ok(json!({"alerts":alerts,"partial":partial}));
    }
    if parser == "i3-service-status" {
        super::i3_service_status::normalize(payload)?;
        return Ok(json!({"alerts":[],"partial":false}));
    }
    if parser == "rendered-advisory-board" {
        return super::rendered_advisory_board::normalize(payload);
    }
    if parser == "hubup-service-alerts" {
        return super::hubup_alerts::normalize(payload);
    }
    if parser == "transloc-messages" {
        #[derive(Deserialize)]
        struct Message {
            id: Value,
            text: String,
            created_at: String,
            end_date: Option<String>,
        }
        fn date(value: &str) -> Result<String, io::Error> {
            let format = regex::Regex::new(
                r"^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{2}:\d{2}(:\d{2})? [+-]\d{2}:?\d{2} \d{4}$",
            )
            .map_err(|_| invalid())?;
            if !format.is_match(value) {
                return Err(invalid());
            }
            let captures = format.captures(value).ok_or_else(invalid)?;
            let offset = regex::Regex::new(r"([+-]\d{2}):(\d{2})").map_err(|_| invalid())?;
            let normalized = offset.replace(value, "${1}${2}");
            let pattern = if captures.get(1).is_some() {
                "%a %b %d %H:%M:%S %z %Y"
            } else {
                "%a %b %d %H:%M %z %Y"
            };
            let parsed =
                chrono::DateTime::parse_from_str(&normalized, pattern).map_err(|_| invalid())?;
            Ok(parsed
                .with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        }
        let records: Vec<Message> = serde_json::from_value(payload).map_err(|_| invalid())?;
        let mut alerts = Vec::new();
        let partial = false;
        for item in records {
            if item.text.trim().is_empty() {
                return Err(invalid());
            }
            let id = match item.id {
                Value::String(s) => s,
                Value::Number(n) => n.to_string(),
                _ => return Err(invalid()),
            };
            let start = date(&item.created_at)?;
            let mut period = json!({"start": start});
            if let Some(end) = item.end_date.filter(|s| !s.is_empty()) {
                let end = date(&end)?;
                if end <= start {
                    return Err(invalid());
                }
                period["end"] = json!(end);
            }
            alerts.push(
                json!({"id":id,"title":item.text,"effect":"UNKNOWN_EFFECT","activePeriod":period}),
            );
        }
        return Ok(json!({"alerts":alerts,"partial":partial}));
    }
    if parser == "mapstrat-broadcast" {
        let records: Vec<Broadcast> = serde_json::from_value(payload).map_err(|_| invalid())?;
        let alerts: Result<Vec<_>, _> = records
            .into_iter()
            .map(|r| {
                token(&r.id)?;
                if r.message.trim().is_empty() {
                    return Err(invalid());
                }
                let mut item = json!({"title":r.message,"category":r.r#type});
                if let Some(route) = token(&r.route_num)? {
                    item["route"] = json!(route);
                }
                if let Some(stop) = token(&r.stop_num)? {
                    item["closed_stops"] = json!([{"id":stop}]);
                }
                if r.is_for_detour {
                    item["effect"] = json!("DETOUR");
                }
                Ok(item)
            })
            .collect();
        // Mapstrat lists only live broadcasts, so an empty array is a quiet board.
        return Ok(json!({"alerts":alerts?,"partial":false}));
    }
    if parser != "eum-search-advisories" {
        return Err(invalid());
    }
    let search: Search = serde_json::from_value(payload).map_err(|_| invalid())?;
    let mut partial = search.total_count != search.value.len() as u64;
    let alerts: Result<Vec<_>, _> = search.value.into_iter().map(|entry| {
        let d = entry.document;
        if d.detour.trim().is_empty() || d.route_title.trim().is_empty() || d.routes_affected.trim().is_empty() { return Err(invalid()); }
        let start = wall_time(d.start.as_deref(), false);
        let end = wall_time(d.end.as_deref(), true);
        if (d.start.as_ref().is_some_and(|s| !s.is_empty()) && start.is_none()) || (d.end.as_ref().is_some_and(|s| !s.is_empty()) && end.is_none()) { partial = true; }
        let mut period = json!({});
        if let Some(start) = start { period["start"] = json!(start); }
        if let Some(end) = end { period["end"] = json!(end); }
        let description = [d.start.as_deref(), d.end.as_deref(), d.notes.as_deref(), Some(&d.routes_affected)].into_iter().flatten().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n");
        let _ = d.revised;
        Ok(json!({"id":d.routes_affected,"title":format!("{}: {}",d.title.trim(),d.detour.trim()),"description":description,"route":d.route_title.trim(),"effect":"DETOUR","activePeriod":period}))
    }).collect();
    Ok(json!({"alerts":alerts?,"partial":partial}))
}

pub async fn scrape(
    client: &crate::upstream::Client,
    url: &str,
    parser: &str,
    body: Option<&Value>,
) -> Result<crate::agencies::ScrapeOutcome, Box<dyn std::error::Error + Send + Sync>> {
    let instant = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let encoded =
        percent_encoding::utf8_percent_encode(&instant, percent_encoding::NON_ALPHANUMERIC)
            .to_string();
    let resolved_url = url.replace("{now}", &encoded);
    let url = resolved_url.as_str();
    let request = if let Some(body) = body {
        client
            .post(url)
            .header("Content-Type", "application/json")
            .body(serde_json::to_vec(body)?)
    } else {
        client.get(url)
    };
    let response = request.send().await?.error_for_status()?;
    let bytes = response.bytes().await?;
    let normalized = normalize(serde_json::from_slice(&bytes)?, parser)?;
    Ok(crate::agencies::ScrapeOutcome {
        bytes,
        partial: normalized["partial"] == true,
        content_type: "application/json",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn substitutes_publication_instant_before_fetching() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            let size = socket.read(&mut buffer).await.unwrap();
            let request = String::from_utf8_lossy(&buffer[..size]);
            let path = request.split_whitespace().nth(1).unwrap();
            let value = path.split("at=").nth(1).unwrap();
            let decoded = percent_encoding::percent_decode_str(value)
                .decode_utf8()
                .unwrap();
            let instant = chrono::DateTime::parse_from_rfc3339(&decoded).unwrap();
            assert!((chrono::Utc::now().timestamp() - instant.timestamp()).abs() < 5);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]")
                .await
                .unwrap();
        });
        let outcome = scrape(
            &crate::upstream::Client::new(),
            &format!("http://{address}/notices?at={{now}}"),
            "mapstrat-broadcast",
            None,
        )
        .await
        .unwrap();
        assert!(!outcome.partial);
        server.await.unwrap();
    }
    #[tokio::test]
    async fn only_a_well_formed_empty_broadcast_is_a_quiet_board() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (status, body, quiet) in [
            ("200 OK", "[]", true),
            ("200 OK", "[{\"id\":0,\"message\":\"Detour\"", false),
            ("500 Internal Server Error", "[]", false),
            ("404 Not Found", "[]", false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 4096];
                assert!(socket.read(&mut buffer).await.unwrap() > 0);
                let _ = socket.write_all(response.as_bytes()).await;
            });
            let outcome = scrape(
                &crate::upstream::Client::new(),
                &format!("http://{address}/api/Broadcast"),
                "mapstrat-broadcast",
                None,
            )
            .await;
            match outcome {
                Ok(outcome) => assert!(quiet && !outcome.partial, "{status} {body}"),
                Err(_) => assert!(!quiet, "{status} {body}"),
            }
            server.await.unwrap();
        }
    }
    #[test]
    fn matches_shared_vendor_contract() {
        let contract: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/vendor-json/contract.json"
        ))
        .unwrap();
        for case in contract["valid"].as_array().unwrap() {
            assert_eq!(
                normalize(case["payload"].clone(), case["parser"].as_str().unwrap()).unwrap(),
                case["expected"],
                "{}",
                case["name"]
            );
        }
        for case in contract["invalid"].as_array().unwrap() {
            assert!(
                normalize(case["payload"].clone(), case["parser"].as_str().unwrap()).is_err(),
                "{}",
                case["name"]
            );
        }
    }
}
