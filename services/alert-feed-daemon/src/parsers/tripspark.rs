//! Twin of the TripSpark advisory decoder; it never evaluates provider script.
use super::strip_html::strip_html;
use crate::agencies::ScrapeOutcome;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use regex::Regex;
use scraper::{Html, Selector};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    io,
};
fn bad() -> io::Error {
    io::Error::other("Invalid TripSpark advisory document")
}
fn rows(v: &Value) -> Result<&Vec<Value>, io::Error> {
    v.as_array().ok_or_else(bad)
}
fn text(v: &Value) -> String {
    v.as_str().unwrap_or_default().trim().to_owned()
}
fn id(v: &Value) -> String {
    if v.is_null() {
        String::new()
    } else {
        v.as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| v.to_string())
    }
}
fn plain(html: &str) -> String {
    strip_html(
        &Regex::new(r"(?i)<(ul|ol)\b")
            .unwrap()
            .replace_all(html, "<br><$1"),
    )
}
fn instant(v: &Value) -> Result<String, io::Error> {
    let s = text(v);
    chrono::DateTime::parse_from_rfc3339(&s).map_err(|_| bad())?;
    Ok(s)
}
fn unique(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    items
        .into_iter()
        .filter(|s| seen.insert(s.clone()))
        .collect()
}
fn subjects(title: &str) -> Vec<String> {
    let pattern =
        Regex::new(r"(?i)\broutes?\s*#?\s*([0-9]+[A-Z]?(?:\s*(?:&|,|and)\s*#?\s*[0-9]+[A-Z]?)*)")
            .unwrap();
    pattern
        .captures(title)
        .map(|m| {
            Regex::new(r"(?i)[0-9]+[A-Z]?")
                .unwrap()
                .find_iter(&m[1])
                .map(|m| m.as_str().to_owned())
                .collect()
        })
        .unwrap_or_default()
}
fn detail(html: &str, title: &str) -> Result<(String, Vec<String>), io::Error> {
    let document = Html::parse_document(html);
    let heading = Selector::parse(".form-title").unwrap();
    let body = Selector::parse(".note-editable").unwrap();
    let headings: Vec<_> = document.select(&heading).collect();
    let bodies: Vec<_> = document.select(&body).collect();
    let normalized = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    if headings.len() != 1
        || bodies.len() != 1
        || normalized(&strip_html(&headings[0].html())) != normalized(title)
    {
        return Err(bad());
    }
    let boilerplate = Regex::new(r"(?i)^Please download (?:the )?MyRide app").unwrap();
    let lines: Vec<_> = plain(&bodies[0].html())
        .lines()
        .map(normalized)
        .filter(|s| !s.is_empty() && !boilerplate.is_match(s))
        .collect();
    if lines.is_empty() {
        return Err(bad());
    }
    Ok((lines.join("\n"), lines))
}
fn section(label: &str, allowed: &[String]) -> Vec<String> {
    allowed
        .iter()
        .filter(|route| {
            if Regex::new(&format!(r"(?i)\b{}\b", regex::escape(route)))
                .unwrap()
                .is_match(label)
            {
                return true;
            }
            let p = Regex::new(r"^([0-9]+)([A-Z])$").unwrap();
            let Some(m) = p.captures(route) else {
                return false;
            };
            Regex::new(&format!(r"(?i)\b{}\s*([A-Z]{{2,}})\b", &m[1]))
                .unwrap()
                .captures(label)
                .is_some_and(|g| g[1].to_uppercase().contains(&m[2]))
        })
        .cloned()
        .collect()
}
pub fn decode(
    base: &Value,
    news: &Value,
    details: &BTreeMap<String, String>,
    excluded: &[String],
) -> Result<Value, io::Error> {
    let routes = rows(&base["routes"])?;
    let interruptions: Vec<_> = rows(&base["serviceInterruptions"])?
        .iter()
        .chain(rows(&base["upcomingServiceInterruptions"])?)
        .collect();
    let mut selectors: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for route in routes {
        let route_id = text(&route["shortName"]);
        if route_id.is_empty() {
            return Err(bad());
        }
        for direction in rows(&route["directionList"])? {
            let name = text(&direction["direction"]["name"]);
            for key in rows(&direction["serviceInterruptionKeys"])?
                .iter()
                .chain(rows(&direction["upcomingServiceInterruptionKeys"])?)
            {
                let mut target = json!({"routeId":route_id});
                if !name.is_empty() {
                    target["directionText"] = json!(name)
                }
                selectors.entry(id(key)).or_default().push(target);
            }
        }
    }
    let keys: BTreeSet<_> = interruptions.iter().map(|r| id(&r["key"])).collect();
    if selectors.keys().any(|k| !keys.contains(k)) {
        return Err(bad());
    }
    let mut result = Vec::new();
    let codes_pattern = Regex::new(r"\bID:\s*([A-Za-z0-9]+)\b").unwrap();
    let closed = Regex::new(
        r"(?i)(?:bus stops will be closed|arrêts d.autobus suivants seront hors service)",
    )
    .unwrap();
    for row in interruptions {
        let key = id(&row["key"]);
        let title = text(&row["name"]);
        let description = plain(&text(&row["description"]));
        if key.is_empty() || title.is_empty() || description.is_empty() {
            return Err(bad());
        }
        if row["dailyStartTime"] != "00:00:00" || row["dailyEndTime"] != "23:59:59" {
            return Err(bad());
        }
        let start = instant(&row["startDateUtc"])?;
        let end = instant(&row["endDateUtc"])?;
        if chrono::DateTime::parse_from_rfc3339(&end).unwrap()
            < chrono::DateTime::parse_from_rfc3339(&start).unwrap()
        {
            return Err(bad());
        }
        let selected = selectors.get(&key).cloned().unwrap_or_default();
        let codes: Vec<_> = if closed.is_match(&description) {
            codes_pattern
                .captures_iter(&description)
                .map(|m| m[1].to_owned())
                .collect()
        } else {
            Vec::new()
        };
        let mut targets = Vec::new();
        for code in &codes {
            if selected.is_empty() {
                targets.push(json!({"stopId":format!("Stop {code}"),"stopCode":code}))
            } else {
                for selected in &selected {
                    let mut t = selected.clone();
                    t["stopId"] = json!(format!("Stop {code}"));
                    t["stopCode"] = json!(code);
                    targets.push(t);
                }
            }
        }
        let mut notice = json!({"id":format!("interruption:{key}"),"title":title,"description":description,"start_time":start,"expires_at":end,"routes":unique(selected.iter().map(|s|text(&s["routeId"]))) });
        if codes.is_empty() {
            notice["effect"] = json!("DETOUR");
            if !selected.is_empty() {
                notice["targets"] = json!(selected);
            }
        } else {
            notice["effect"] = json!("NO_SERVICE");
            notice["stops"] = json!(
                codes
                    .iter()
                    .map(|c| format!("Stop {c}"))
                    .collect::<Vec<_>>()
            );
            notice["targets"] = json!(targets);
            notice["stopScoped"] = json!(true)
        }
        result.push(notice);
    }
    let closure = Regex::new(r"(?i)\b(?:closure|closed|detour|fermeture|fermés?|fermées?|détour|modifications? de trajet)\b").unwrap();
    let heading =
        Regex::new(r"(?i)^(?:Bus stops? Closures?|Fermetures? (?:des? )?arrêts?)\s*:?(.*)$")
            .unwrap();
    let stop_pattern =
        Regex::new(r"(?i)^(?:(?:Bus\s+)?Stop|Arrêt(?: d.autobus)?)\s*#?\s*([A-Za-z]?[0-9]{3,8})\b")
            .unwrap();
    let list_heading = Regex::new(
        r"(?i)(?:following routes will be operating|circuits suivants seront en service)",
    )
    .unwrap();
    let numeric = Regex::new(r"\b[0-9]{1,3}[A-Z]?\b").unwrap();
    let detour =
        Regex::new(r"(?i)(?:\bdetour\b|détour|modifications? de trajet|déviation)").unwrap();
    for news in rows(news)? {
        let key = id(&news["newsId"]);
        if excluded.contains(&key) {
            continue;
        }
        let title = text(&news["title"]);
        if key.is_empty() || title.is_empty() {
            return Err(bad());
        }
        let (description, lines) = detail(
            details.get(&key).map(String::as_str).unwrap_or_default(),
            &title,
        )?;
        let mut route_ids: Vec<String> = if news["routes"].is_null() {
            subjects(&title)
        } else {
            rows(&news["routes"])?.iter().map(id).collect()
        };
        if route_ids.is_empty() && list_heading.is_match(&description) {
            let from = lines
                .iter()
                .position(|line| list_heading.is_match(line))
                .unwrap()
                + 1;
            route_ids = unique(
                lines[from..]
                    .iter()
                    .filter(|line| {
                        line.chars()
                            .find(char::is_ascii_alphanumeric)
                            .is_some_and(|c| c.is_ascii_digit())
                    })
                    .flat_map(|line| numeric.find_iter(line).map(|m| m.as_str().to_owned())),
            );
        }
        let mut active = route_ids.clone();
        let mut targets = Vec::new();
        if closure.is_match(&format!("{title} {description}")) {
            for line in &lines {
                if let Some(m) = heading.captures(line)
                    && !m[1].trim().is_empty()
                {
                    active = section(&m[1], &route_ids);
                    if active.is_empty() {
                        return Err(bad());
                    }
                }
                if let Some(m) = stop_pattern.captures(line) {
                    let code = &m[1];
                    if active.is_empty() {
                        targets.push(json!({"stopId":format!("Stop {code}"),"stopCode":code}))
                    } else {
                        for route in &active {
                            targets.push(json!({"routeId":route,"stopId":format!("Stop {code}"),"stopCode":code}));
                        }
                    }
                }
            }
        }
        let mut notice = json!({"id":format!("news:{key}"),"title":title,"description":description,"publishDateUtc":instant(&news["publishDateUtc"])?,"routes":route_ids,"affectsAllRoutes":news["affectsAllRoutes"]==true});
        if targets.is_empty() {
            notice["effect"] = json!(if detour.is_match(&title) {
                "DETOUR"
            } else {
                "OTHER_EFFECT"
            });
        } else {
            notice["effect"] = json!("NO_SERVICE");
            notice["stops"] = json!(unique(targets.iter().map(|t| text(&t["stopId"]))));
            notice["targets"] = json!(targets);
            notice["stopScoped"] = json!(true);
        }
        result.push(notice);
    }
    Ok(json!(result))
}
pub fn session_token(html: &str, argument: usize) -> Result<String, io::Error> {
    let marker = "new Home.HomeViewModel(";
    let from = html.find(marker).ok_or_else(bad)? + marker.len();
    let rest = &html[from..];
    let mut depth = 0i32;
    let mut quote = None;
    let mut escaped = false;
    let mut start = 0;
    let mut args = Vec::new();
    for (i, c) in rest.char_indices() {
        if let Some(q) = quote {
            if escaped {
                escaped = false
            } else if c == '\\' {
                escaped = true
            } else if c == q {
                quote = None
            }
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            continue;
        }
        if "([{ ".trim().contains(c) {
            depth += 1
        } else if ")]}".contains(c) {
            depth -= 1
        } else if c == ',' && depth == 0 {
            args.push(rest[start..i].trim());
            start = i + 1;
            if args.len() > argument {
                break;
            }
        }
    }
    let raw = args.get(argument).ok_or_else(bad)?;
    let encoded = Regex::new(r#"^["']([A-Za-z0-9+/=]+)["']$"#)
        .unwrap()
        .captures(raw)
        .ok_or_else(bad)?;
    let token =
        String::from_utf8(STANDARD.decode(&encoded[1]).map_err(|_| bad())?).map_err(|_| bad())?;
    if token.is_empty() || token.contains(['\r', '\n']) {
        return Err(bad());
    }
    Ok(token)
}
async fn read(mut response: reqwest::Response) -> Result<Vec<u8>, Box<dyn Error + Send + Sync>> {
    if !response.status().is_success() {
        return Err(crate::upstream::Failure::Http.into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > 8 * 1024 * 1024 {
            return Err(crate::upstream::Failure::TooLarge.into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
pub async fn scrape(
    client: &crate::upstream::Client,
    base: &str,
    argument: Option<usize>,
    excluded: &[String],
) -> Result<ScrapeOutcome, Box<dyn Error + Send + Sync>> {
    let origin = reqwest::Url::parse(base)?.origin().ascii_serialization();
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        "x-requested-with",
        reqwest::header::HeaderValue::from_static("XMLHttpRequest"),
    );
    if let Some(argument) = argument {
        let response = client.get(format!("{origin}/")).send().await?;
        let cookie = response
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|h| h.to_str().ok())
            .filter_map(|s| s.split(';').next())
            .collect::<Vec<_>>()
            .join("; ");
        let html = String::from_utf8(read(response).await?)?;
        let token = session_token(&html, argument)?;
        if cookie.is_empty() {
            return Err(bad().into());
        }
        headers.insert("requestverificationtoken", token.parse()?);
        headers.insert("cookie", cookie.parse()?);
    }
    let base_response = client
        .post(format!("{origin}/RouteMap/GetBaseData/"))
        .headers(headers.clone())
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await?;
    let base: Value = serde_json::from_slice(&read(base_response).await?)?;
    let news: Value = serde_json::from_slice(
        &read(
            client
                .get(format!("{origin}/News/GetAllNews"))
                .headers(headers.clone())
                .send()
                .await?,
        )
        .await?,
    )?;
    let items = rows(&news)?;
    if items
        .iter()
        .filter(|row| !excluded.contains(&id(&row["newsId"])))
        .count()
        > 30
    {
        return Err(bad().into());
    }
    let mut details = BTreeMap::new();
    for row in items {
        let key = id(&row["newsId"]);
        if excluded.contains(&key) {
            continue;
        }
        let slug = text(&row["friendlyUrl"]);
        if key.is_empty() || slug.is_empty() {
            return Err(bad().into());
        }
        let mut url = reqwest::Url::parse(&origin)?;
        url.path_segments_mut()
            .map_err(|_| bad())?
            .extend(["News", &key, &slug, ""]);
        let html = read(
            client
                .get(url.as_str())
                .headers(headers.clone())
                .send()
                .await?,
        )
        .await?;
        details.insert(key, String::from_utf8(html)?);
    }
    let data = decode(&base, &news, &details, excluded)?;
    Ok(ScrapeOutcome {
        bytes: serde_json::to_vec(&data)?.into(),
        partial: false,
        content_type: "application/json",
    })
}
#[cfg(test)]
mod tests {
    #[test]
    fn shared_contract() {
        let data: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/tripspark-advisories/contract.json"
        ))
        .unwrap();
        for c in data["cases"].as_array().unwrap() {
            let details = serde_json::from_value(c["details"].clone()).unwrap();
            let result = super::decode(&c["base"], &c["news"], &details, &[]);
            if c["error"] == true {
                assert!(result.is_err(), "{}", c["name"])
            } else {
                assert_eq!(result.unwrap(), c["expected"], "{}", c["name"])
            }
        }
    }
}
