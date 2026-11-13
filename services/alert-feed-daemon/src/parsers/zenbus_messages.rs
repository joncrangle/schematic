use prost::Message;
use serde_json::{Value, json};
use std::{error::Error, io};

#[derive(Clone, PartialEq, Message)]
struct Selector {
    #[prost(int64, optional, tag = "2")]
    line_id: Option<i64>,
}
#[derive(Clone, PartialEq, Message)]
struct WallMessage {
    #[prost(int64, optional, tag = "2")]
    id: Option<i64>,
    #[prost(int32, optional, tag = "3")]
    target: Option<i32>,
    #[prost(int64, optional, tag = "101")]
    about: Option<i64>,
    #[prost(message, repeated, tag = "102")]
    entities: Vec<Selector>,
    #[prost(int64, optional, tag = "4")]
    notify_start: Option<i64>,
    #[prost(int64, optional, tag = "5")]
    notify_end: Option<i64>,
    #[prost(int64, optional, tag = "6")]
    event_start: Option<i64>,
    #[prost(int64, optional, tag = "7")]
    event_end: Option<i64>,
    #[prost(int64, optional, tag = "9")]
    modified: Option<i64>,
    #[prost(int64, optional, tag = "10")]
    deleted: Option<i64>,
    #[prost(int32, optional, tag = "11")]
    cause: Option<i32>,
    #[prost(int32, optional, tag = "12")]
    effect: Option<i32>,
    #[prost(int32, optional, tag = "13")]
    priority: Option<i32>,
    #[prost(string, optional, tag = "14")]
    message: Option<String>,
    #[prost(string, optional, tag = "15")]
    short_message: Option<String>,
}
#[derive(Clone, PartialEq, Message)]
struct WallMessages {
    #[prost(message, repeated, tag = "1")]
    messages: Vec<WallMessage>,
    #[prost(int64, optional, tag = "3")]
    version: Option<i64>,
}
fn invalid() -> io::Error {
    io::Error::other("Invalid Zenbus message board")
}
fn date(value: Option<i64>, zone: &chrono_tz::Tz) -> Result<Option<i64>, io::Error> {
    use chrono::TimeZone;
    let Some(value) = value.filter(|v| *v != 0) else {
        return Ok(None);
    };
    let text = value.to_string();
    if text.len() == 8 && text.starts_with("20") {
        let day = chrono::NaiveDate::parse_from_str(&text, "%Y%m%d").map_err(|_| invalid())?;
        return zone
            .from_local_datetime(&day.and_hms_opt(0, 0, 0).ok_or_else(invalid)?)
            .single()
            .map(|d| Some(d.timestamp_millis()))
            .ok_or_else(invalid);
    }
    if value < 100000000000 {
        return Err(invalid());
    }
    Ok(Some(value))
}
pub fn decode(
    bytes: &[u8],
    now: i64,
    zone: &chrono_tz::Tz,
    stop_codes: &std::collections::BTreeMap<String, String>,
) -> Result<Value, io::Error> {
    let board = WallMessages::decode(bytes).map_err(|_| invalid())?;
    if !bytes.is_empty() && board.messages.is_empty() && board.version.is_none() {
        return Err(invalid());
    }
    let mut alerts = Vec::new();
    let stop_pattern = regex::Regex::new(
        r"(?i)arr[êe]ts?\s*\(?\s*#?\s*(\d+(?:\s*[,/]\s*#?\s*\d+|\s+et\s+#?\s*\d+)*)",
    )
    .unwrap();
    let alternative = regex::Regex::new(
        r"(?i)\b(?:utilisez|utiliser|reportez-vous|vers|remplacement|recommandés?|temporaires?)\b",
    )
    .unwrap();
    let digits = regex::Regex::new(r"\d+").unwrap();
    for message in board.messages {
        if message.deleted.is_some_and(|v| v != 0) {
            continue;
        }
        let title = message.short_message.as_deref().unwrap_or("").trim();
        let description = message.message.as_deref().unwrap_or("").trim();
        let title = if title.is_empty() { description } else { title };
        let id = message.id.ok_or_else(invalid)?;
        if id <= 0 || title.is_empty() {
            return Err(invalid());
        }
        let start = date(message.notify_start, zone)?.unwrap_or(0);
        let end = date(message.notify_end, zone)?;
        let event_start = date(message.event_start, zone)?;
        let event_end = date(message.event_end, zone)?;
        if end.is_some_and(|e| e < start) || event_start.zip(event_end).is_some_and(|(s, e)| e < s)
        {
            return Err(invalid());
        }
        let mut stop_ids = Vec::new();
        let text = format!("{} {}", title, description);
        let text = alternative.split(&text).next().unwrap_or("");
        for capture in stop_pattern.captures_iter(text) {
            for code in digits.find_iter(&capture[1]) {
                let id = stop_codes
                    .get(code.as_str())
                    .cloned()
                    .unwrap_or_else(|| code.as_str().to_string());
                if !stop_ids.contains(&id) {
                    stop_ids.push(id);
                }
            }
        }
        let mut routes: Vec<String> = message
            .entities
            .iter()
            .filter_map(|e| e.line_id.map(|id| id.to_string()))
            .collect();
        if message.target == Some(2)
            && let Some(about) = message.about
        {
            routes.push(about.to_string());
        }
        let mut unique = Vec::new();
        for route in routes {
            if !unique.contains(&route) {
                unique.push(route);
            }
        }
        let mut alert = json!({ "id": id.to_string(), "title": title, "startsAt": start, "routeIds": unique, "targets": unique.iter().map(|id| json!({"routeId":id})).collect::<Vec<_>>(), "sourceFields": {"priority":message.priority.unwrap_or(0),"cause":message.cause.unwrap_or(0)}, "updatedAt": message.modified.filter(|v| *v != 0).unwrap_or(now) });
        if !description.is_empty() {
            alert["description"] = json!(description);
        }
        if !stop_ids.is_empty() {
            alert["targets"] = json!(
                stop_ids
                    .iter()
                    .flat_map(|stop| {
                        if unique.is_empty() {
                            vec![json!({"stopId":stop})]
                        } else {
                            unique
                                .iter()
                                .map(|route| json!({"routeId":route,"stopId":stop}))
                                .collect()
                        }
                    })
                    .collect::<Vec<_>>()
            );
            alert["stopScoped"] = json!(true);
            alert["sourceFields"]["stopScoped"] = json!(true);
            alert["affectedStations"] = json!(stop_ids);
        }
        if let Some(end) = end {
            alert["endsAt"] = json!(end);
        }
        if let Some(effect) = message.effect.filter(|v| *v != 0) {
            alert["effect"] = json!(effect);
        }
        if event_start.is_some() || event_end.is_some() {
            let mut period = json!({"startsAt":event_start.unwrap_or(0)});
            if let Some(end) = event_end {
                period["endsAt"] = json!(end);
            }
            alert["impactPeriods"] = json!([period]);
        }
        alerts.push(alert);
    }
    Ok(
        json!({"header":{"version":"zenbus-messages","timestamp":now},"tripUpdates":[],"vehiclePositions":[],"alerts":alerts}),
    )
}
pub async fn scrape(
    client: &crate::upstream::Client,
    url: &str,
    zone: &chrono_tz::Tz,
    stop_codes: &std::collections::BTreeMap<String, String>,
) -> Result<crate::agencies::ScrapeOutcome, Box<dyn Error + Send + Sync>> {
    let bytes = client
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    let document = decode(
        &bytes,
        chrono::Utc::now().timestamp_millis(),
        zone,
        stop_codes,
    )?;
    Ok(crate::agencies::ScrapeOutcome {
        bytes: bytes::Bytes::from(serde_json::to_vec(&document)?),
        partial: false,
        content_type: "application/json",
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn shared_contract() {
        let contract: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/zenbus/messages.contract.json"
        ))
        .unwrap();
        let now = contract["now"].as_i64().unwrap();
        for case in contract["cases"].as_array().unwrap() {
            let hex = case["hex"].as_str().unwrap().as_bytes();
            let bytes: Vec<_> = hex
                .chunks(2)
                .map(|c| u8::from_str_radix(std::str::from_utf8(c).unwrap(), 16).unwrap())
                .collect();
            let result = super::decode(
                &bytes,
                now,
                &"America/Toronto".parse().unwrap(),
                &case["stopCodeMap"]
                    .as_object()
                    .map(|m| {
                        m.iter()
                            .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
                            .collect()
                    })
                    .unwrap_or_default(),
            );
            if case["error"] == true {
                assert!(result.is_err(), "{}", case["name"]);
            } else {
                assert_eq!(
                    result.unwrap()["alerts"],
                    case["alerts"],
                    "{}",
                    case["name"]
                );
            }
        }
    }
}
