use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, io};

#[derive(Deserialize)]
struct Header {
    timestamp: f64,
}
#[derive(Deserialize)]
struct Period {
    start: Option<f64>,
    end: Option<f64>,
}
#[derive(Deserialize)]
struct Text {
    language: String,
    text: Option<String>,
}
#[derive(Deserialize)]
struct Selector {
    route_short_name: Option<String>,
    stop_code: Option<String>,
    direction_id: Option<String>,
}
#[derive(Deserialize)]
struct Alert {
    active_periods: Period,
    informed_entities: Vec<Selector>,
    header_texts: Vec<Text>,
    description_texts: Vec<Text>,
    cause: Value,
    effect: Value,
}
#[derive(Deserialize)]
struct Document {
    header: Header,
    alerts: Vec<Alert>,
}
fn invalid() -> io::Error {
    io::Error::other("Invalid i3 service status")
}
fn number(n: f64) -> Value {
    if n.fract() == 0.0 {
        json!(n as u64)
    } else {
        json!(n)
    }
}
fn epoch(n: f64) -> bool {
    n.is_finite() && n >= 0.0
}
fn unique<T: PartialEq>(values: impl Iterator<Item = T>) -> Vec<T> {
    let mut result = Vec::new();
    for value in values {
        if !result.contains(&value) {
            result.push(value);
        }
    }
    result
}

fn selector_tokens(a: &Alert, directions: bool) -> Vec<String> {
    unique(a.informed_entities.iter().filter_map(|s| {
        let value = if directions {
            &s.direction_id
        } else {
            &s.route_short_name
        };
        let value = value.as_ref()?.trim();
        if value.is_empty() {
            return None;
        }
        if !directions {
            return Some(value.to_owned());
        }
        Some(match value.to_lowercase().as_str() {
            "e" | "east" | "est" => "east".into(),
            "n" | "north" | "nord" => "north".into(),
            "w" | "west" | "ouest" => "west".into(),
            "s" | "south" | "sud" => "south".into(),
            _ => value.to_lowercase(),
        })
    }))
}

fn covered_stop_summary(
    a: &Alert,
    remainder: &str,
    details: &HashMap<String, Vec<&Alert>>,
) -> bool {
    let mut codes = Vec::new();
    for line in remainder.trim().lines() {
        let Some((code, name)) = line.trim().split_once(" (") else {
            return false;
        };
        if code.is_empty()
            || code
                .chars()
                .any(|c| c.is_whitespace() || c == '(' || c == ')')
            || !name.ends_with(')')
            || name.len() < 2
        {
            return false;
        }
        codes.push(code);
    }
    if codes.is_empty() {
        return false;
    }
    if a.informed_entities.iter().any(|s| {
        s.stop_code
            .as_ref()
            .is_some_and(|code| !code.trim().is_empty() && !codes.contains(&code.trim()))
    }) {
        return false;
    }
    let mut routes = selector_tokens(a, false);
    let mut directions = selector_tokens(a, true);
    if routes.is_empty() {
        routes.push(String::new());
    }
    if directions.is_empty() {
        directions.push(String::new());
    }
    codes.iter().all(|code| {
        routes.iter().all(|route| {
            directions.iter().all(|direction| {
                details.get(*code).is_some_and(|entries| {
                    entries.iter().any(|detail| {
                        let dr = selector_tokens(detail, false);
                        let dd = selector_tokens(detail, true);
                        let p = &detail.active_periods;
                        let s = &a.active_periods;
                        (dr.is_empty() || dr.contains(route))
                            && (dd.is_empty() || dd.contains(direction))
                            && (p.start.is_none()
                                || matches!((p.start, s.start), (Some(p), Some(s)) if p <= s))
                            && (p.end.is_none()
                                || matches!((p.end, s.end), (Some(p), Some(s)) if p >= s))
                    })
                })
            })
        })
    })
}

/// Normalize the i3 wire envelope; seeded identities and rider locale are resolved in Core.
pub fn normalize(value: Value) -> Result<Value, io::Error> {
    normalize_with_exclusions(value, &[], &[])
}

pub fn normalize_with_exclusions(
    value: Value,
    excluded: &[String],
    summaries: &[String],
) -> Result<Value, io::Error> {
    let alerts = value
        .get("alerts")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    for a in alerts {
        let period = a
            .get("active_periods")
            .and_then(Value::as_object)
            .ok_or_else(invalid)?;
        if !period.contains_key("start")
            || !period.contains_key("end")
            || a.get("cause").is_none()
            || a.get("effect").is_none()
        {
            return Err(invalid());
        }
        for selector in a
            .get("informed_entities")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?
        {
            for key in ["route_short_name", "stop_code", "direction_id"] {
                if selector.get(key).is_some_and(|v| !v.is_string()) {
                    return Err(invalid());
                }
            }
        }
        for key in ["header_texts", "description_texts"] {
            for text in a.get(key).and_then(Value::as_array).ok_or_else(invalid)? {
                if text.get("text").is_none() {
                    return Err(invalid());
                }
            }
        }
    }
    let doc: Document = serde_json::from_value(value).map_err(|_| invalid())?;
    if !epoch(doc.header.timestamp) {
        return Err(invalid());
    }
    let mut details = HashMap::<String, Vec<&Alert>>::new();
    for a in &doc.alerts {
        if a.description_texts.iter().any(|t| {
            t.text.as_ref().is_some_and(|text| {
                summaries.iter().any(|prefix| {
                    text.trim()
                        .to_lowercase()
                        .starts_with(&prefix.trim().to_lowercase())
                })
            })
        }) {
            continue;
        }
        for s in &a.informed_entities {
            if let Some(code) = s
                .stop_code
                .as_ref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
            {
                details.entry(code.to_owned()).or_default().push(a);
            }
        }
    }
    let excluded_alerts = doc
        .alerts
        .iter()
        .map(|a| {
            let texts = a
                .description_texts
                .iter()
                .filter_map(|t| t.text.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()))
                .collect::<Vec<_>>();
            let has_stop = a
                .informed_entities
                .iter()
                .any(|s| s.stop_code.as_ref().is_some_and(|s| !s.trim().is_empty()));
            !texts.is_empty()
                && texts.iter().all(|text| {
                    (has_stop
                        && excluded.iter().any(|prefix| {
                            text.to_lowercase()
                                .starts_with(&prefix.trim().to_lowercase())
                        }))
                        || summaries.iter().any(|prefix| {
                            let prefix = prefix.trim().to_lowercase();
                            text.to_lowercase().starts_with(&prefix)
                                && text.get(prefix.len()..).is_some_and(|remainder| {
                                    covered_stop_summary(a, remainder, &details)
                                })
                        })
                })
        })
        .collect::<Vec<_>>();
    let mut entities = Vec::new();
    for (a, excluded_alert) in doc.alerts.into_iter().zip(excluded_alerts) {
        let p = &a.active_periods;
        if p.start.is_some_and(|n| !epoch(n))
            || p.end.is_some_and(|n| !epoch(n))
            || matches!((p.start,p.end),(Some(s),Some(e)) if e < s)
        {
            return Err(invalid());
        }
        if !a
            .header_texts
            .iter()
            .chain(&a.description_texts)
            .any(|t| t.text.as_ref().is_some_and(|s| !s.trim().is_empty()))
        {
            return Err(invalid());
        }
        if [&a.cause, &a.effect]
            .iter()
            .any(|v| !v.is_null() && !v.is_string() && !v.is_number())
        {
            return Err(invalid());
        }
        let mut routes = unique(
            a.informed_entities
                .iter()
                .filter_map(|s| s.route_short_name.as_ref())
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty()),
        )
        .into_iter()
        .map(Some)
        .collect::<Vec<_>>();
        let mut stops = unique(
            a.informed_entities
                .iter()
                .filter_map(|s| s.stop_code.as_ref())
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty()),
        )
        .into_iter()
        .map(Some)
        .collect::<Vec<_>>();
        if routes.is_empty() && stops.is_empty() {
            return Err(invalid());
        }
        let mut directions = Vec::new();
        for s in &a.informed_entities {
            if let Some(d) = &s.direction_id {
                let d = d.trim().to_lowercase();
                if d.is_empty() {
                    continue;
                }
                let n = match d.as_str() {
                    "e" | "east" | "est" => "east",
                    "n" | "north" | "nord" => "north",
                    "w" | "west" | "ouest" => "west",
                    "s" | "south" | "sud" => "south",
                    "0" => "0",
                    "1" => "1",
                    _ => return Err(invalid()),
                };
                if !directions.contains(&Some(n)) {
                    directions.push(Some(n));
                }
            }
        }
        if routes.is_empty() {
            routes.push(None);
        }
        if stops.is_empty() {
            stops.push(None);
        }
        if directions.is_empty() {
            directions.push(None);
        }
        let mut selectors = Vec::new();
        for r in &routes {
            for s in &stops {
                for d in &directions {
                    let mut selector = json!({});
                    if let Some(r) = r {
                        selector["route_id"] = json!(r);
                    }
                    if let Some(s) = s {
                        selector["stop_id"] = json!(s);
                    }
                    if let Some(d) = d {
                        selector["direction_id"] = json!(d);
                    }
                    selectors.push(selector);
                }
            }
        }
        if excluded_alert {
            continue;
        }
        let text = |ts: Vec<Text>| {
            ts.into_iter()
                .map(|t| json!({"language":t.language,"text":t.text}))
                .collect::<Vec<_>>()
        };
        entities.push(json!({"alert":{
            "active_period":[{"start":p.start.map(number),"end":p.end.map(number)}],
            "informed_entity":selectors,
            "header_text":{"translation":text(a.header_texts)},
            "description_text":{"translation":text(a.description_texts)},
            "cause":a.cause,"effect":a.effect
        }}));
    }
    Ok(
        json!({"header":{"gtfs_realtime_version":"2.0","timestamp":number(doc.header.timestamp)},"entity":entities}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_shared_contract() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/realtime/i3.contract.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let excluded: Vec<String> =
                serde_json::from_value(case["excludedDescriptionPrefixes"].clone())
                    .unwrap_or_default();
            let summaries: Vec<String> =
                serde_json::from_value(case["redundantSummaryPrefixes"].clone())
                    .unwrap_or_default();
            let result = normalize_with_exclusions(case["input"].clone(), &excluded, &summaries);
            if case["invalid"] == true {
                assert!(result.is_err(), "{}", case["name"]);
            } else {
                assert_eq!(result.unwrap(), case["expected"], "{}", case["name"]);
            }
        }
    }
}
