//! Validate generic JSON advisory shapes and forward their original bytes.
//! Like RSS forwarding, normalization and manifest interpretation stay in Core.
//! Keeping the original document preserves category evidence, routes, stop IDs,
//! HTML and offset-bearing periods without a lossy JSON -> protobuf conversion.
use super::strip_html::strip_html;
use crate::agencies::ScrapeOutcome;
use bytes::Bytes;
use serde_json::{Map, Value, json};
use std::{error::Error, io};

fn string_or_number(value: &Value) -> bool {
    value.is_string() || value.is_number()
}

fn optional(value: Option<&Value>, valid: impl FnOnce(&Value) -> bool) -> bool {
    value.is_none_or(|value| value.is_null() || valid(value))
}

fn alert_valid(value: &Value) -> bool {
    let Some(alert) = value.as_object() else {
        return false;
    };
    let strings = [
        "summary",
        "publishDateUtc",
        "title",
        "headerText",
        "description",
        "stopName",
        "stopStart",
        "stopEnd",
        "stopStartId",
        "stopEndId",
        "effectDesc",
        "accessibility",
        "alertType",
        "posted_at",
        "start_time",
        "expires_at",
        "category",
        "severity",
        "reason",
    ];
    strings
        .iter()
        .all(|key| optional(alert.get(*key), Value::is_string))
        && ["id", "newsId", "route", "effect"]
            .iter()
            .all(|key| optional(alert.get(*key), string_or_number))
        && optional(alert.get("routes"), |value| {
            value
                .as_array()
                .is_some_and(|items| items.iter().all(string_or_number))
        })
        && ["stops", "stopIDList", "stopNameList"].iter().all(|key| {
            optional(alert.get(*key), |value| {
                value
                    .as_array()
                    .is_some_and(|items| items.iter().all(Value::is_string))
            })
        })
        && alert.get("tripScoped").is_none_or(Value::is_boolean)
        && alert.get("stopScoped").is_none_or(Value::is_boolean)
        && alert.get("tripIds").is_none_or(|value| {
            value.as_array().is_some_and(|ids| {
                ids.iter()
                    .all(|v| v.as_str().is_some_and(|s| !s.trim().is_empty()))
            })
        })
        && optional(alert.get("targets"), |value| {
            value.as_array().is_some_and(|items| {
                items.iter().all(|target| {
                    target.as_object().is_some_and(|target| {
                        ["stopId", "routeId"].iter().all(|key| {
                            target
                                .get(*key)
                                .is_none_or(|v| v.as_str().is_some_and(|s| !s.trim().is_empty()))
                        }) && ["stopId", "routeId"]
                            .iter()
                            .any(|key| target.contains_key(*key))
                    })
                })
            })
        })
        && ["closed_stops", "alternate_stops"].iter().all(|key| {
            optional(alert.get(*key), |value| {
                value.as_array().is_some_and(|items| {
                    items.iter().all(|stop| {
                        stop.as_object().is_some_and(|stop| {
                            stop.get("id").is_some_and(string_or_number)
                                && optional(stop.get("name"), Value::is_string)
                                && optional(stop.get("code"), string_or_number)
                        })
                    })
                })
            })
        })
        && alert.get("affectsAllRoutes").is_none_or(Value::is_boolean)
        && optional(alert.get("activePeriod"), |value| {
            value.as_object().is_some_and(|period| {
                ["start", "end"]
                    .iter()
                    .all(|key| optional(period.get(*key), Value::is_string))
            })
        })
}

fn alert_array(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|alerts| alerts.iter().all(alert_valid))
}

pub fn validate_generic_json(bytes: &[u8]) -> Result<(), io::Error> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| io::Error::other("Invalid JSON alert feed"))?;
    let valid = if value.is_array() {
        alert_array(&value)
    } else if let Some(response) = value.as_object() {
        ["routes", "accessibility"]
            .iter()
            .all(|key| response.get(*key).is_none_or(alert_array))
            && response.get("alerts").is_none_or(|buckets| {
                buckets.as_object().is_some_and(|buckets| {
                    (buckets.contains_key("short_term") || buckets.contains_key("long_term"))
                        && ["short_term", "long_term"]
                            .iter()
                            .all(|key| buckets.get(*key).is_none_or(alert_array))
                })
            })
    } else {
        false
    };
    if valid {
        Ok(())
    } else {
        Err(io::Error::other("Invalid JSON alert feed"))
    }
}

pub(super) fn token(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_owned();
    }
    // JSON numbers cross Core's JavaScript boundary as doubles. Match String
    // there, including integral floats, negative zero and exponent thresholds.
    let number = value.as_f64().expect("validated numeric token");
    if number == 0.0 {
        return "0".into();
    }
    if number.abs() < 1e-6 || number.abs() >= 1e21 {
        let scientific = format!("{number:e}");
        let (mantissa, exponent) = scientific.split_once('e').unwrap();
        return format!(
            "{mantissa}e{}{exponent}",
            if exponent.starts_with('-') { "" } else { "+" }
        );
    }
    number.to_string()
}

const FALLBACK_CONTENT_KEYS: &[&str] = &[
    "stopScoped",
    "summary",
    "publishDateUtc",
    "posted_at",
    "start_time",
    "expires_at",
    "category",
    "severity",
    "reason",
    "closed_stops",
    "alternate_stops",
    "targets",
    "routes",
    "affectsAllRoutes",
    "title",
    "headerText",
    "description",
    "route",
    "stopName",
    "stopStart",
    "stopEnd",
    "stopStartId",
    "stopEndId",
    "stops",
    "stopIDList",
    "stopNameList",
    "effectDesc",
    "effect",
    "accessibility",
    "alertType",
    "activePeriod",
];

fn normalize_fallback_content(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), normalize_fallback_content(value)))
                .collect(),
        ),
        Value::Array(values) => {
            Value::Array(values.iter().map(normalize_fallback_content).collect())
        }
        Value::Number(_) => json!(token(value)),
        _ => value.clone(),
    }
}

fn fallback_alert_id(source_scope: &str, raw: &Value) -> String {
    let content: Map<String, Value> = FALLBACK_CONTENT_KEYS
        .iter()
        .filter_map(|key| {
            raw.get(*key)
                .map(|value| ((*key).to_owned(), value.clone()))
        })
        .collect();
    let content = normalize_fallback_content(&Value::Object(content));
    let serialized = serde_json::to_string(&content).expect("alert content serializes");
    let mut hash = 0xcbf29ce484222325u64;
    for byte in format!("{source_scope}\0{serialized}").bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("json-alert-{hash:016x}")
}

/// A string field recovered to plain text; blank results are absent.
fn plain_text(raw: &Value, key: &str) -> Option<String> {
    raw.get(key)
        .and_then(Value::as_str)
        .map(strip_html)
        .filter(|s| !s.is_empty())
}

fn text(raw: &Value, key: &str) -> Option<String> {
    raw.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn timestamp(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(Value::as_str)
        .and_then(|s| {
            chrono::DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|date| date.timestamp_millis())
                .or_else(|| {
                    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                        .ok()
                        .map(|date| {
                            date.and_hms_opt(0, 0, 0)
                                .unwrap()
                                .and_utc()
                                .timestamp_millis()
                        })
                })
        })
        .filter(|t| *t >= 0)
}

fn stop_guidance(raw: &Value, key: &str, label: &str) -> Option<String> {
    let stops = raw.get(key)?.as_array()?;
    let names: Vec<String> = stops
        .iter()
        .map(|stop| {
            let name = text(stop, "name").unwrap_or_else(|| token(&stop["id"]).trim().to_owned());
            let code = stop
                .get("code")
                .filter(|v| !v.is_null())
                .map(token)
                .unwrap_or_default();
            if code.trim().is_empty() {
                name
            } else {
                format!("{} ({})", name, code.trim())
            }
        })
        .filter(|s| !s.is_empty())
        .collect();
    (!names.is_empty()).then(|| format!("{}: {}.", label, names.join("; ")))
}

/// Default ISO-time normalization twin. Proxy bytes stay unchanged so Core can
/// still apply the source's language and local-wall-clock options downstream.
pub fn decode_generic_json_alert_feed(bytes: &[u8], now: i64) -> Result<Value, io::Error> {
    decode_generic_json_alert_feed_for_source(bytes, now, "generic-json")
}

pub fn decode_generic_json_alert_feed_for_source(
    bytes: &[u8],
    now: i64,
    source_scope: &str,
) -> Result<Value, io::Error> {
    validate_generic_json(bytes)?;
    let response: Value = serde_json::from_slice(bytes)?;
    let mut records = Vec::new();
    if let Some(alerts) = response.as_array() {
        records.extend(alerts.iter().map(|raw| (raw, false)));
    } else {
        for (key, accessibility) in [("routes", false), ("accessibility", true)] {
            if let Some(alerts) = response.get(key).and_then(Value::as_array) {
                records.extend(alerts.iter().map(|raw| (raw, accessibility)));
            }
        }
        if let Some(buckets) = response.get("alerts") {
            for key in ["short_term", "long_term"] {
                if let Some(alerts) = buckets.get(key).and_then(Value::as_array) {
                    records.extend(alerts.iter().map(|raw| (raw, false)));
                }
            }
        }
    }
    let alerts: Result<Vec<Value>, io::Error> = records
        .iter()
        .map(|(raw, accessibility)| {
            let mut alert = serde_json::Map::new();
            let id = raw
                .get("id")
                .filter(|v| !v.is_null())
                .or_else(|| raw.get("newsId").filter(|v| !v.is_null()))
                .map(token)
                .unwrap_or_default();
            let header_text = plain_text(raw, "headerText");
            alert.insert(
                "title".into(),
                json!(
                    header_text
                        .clone()
                        .or_else(|| plain_text(raw, "title"))
                        .unwrap_or_else(|| "Transit advisory".into())
                ),
            );
            let description = [
                plain_text(raw, "description").or_else(|| plain_text(raw, "summary")),
                stop_guidance(raw, "closed_stops", "Closed stops"),
                stop_guidance(raw, "alternate_stops", "Alternate stops"),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n\n");
            if !description.is_empty() {
                if description.trim().is_empty() {
                    return Err(io::Error::other("Invalid normalized JSON alert feed"));
                }
                alert.insert("description".into(), json!(description));
            }
            let category = ["category", "effectDesc", "accessibility"]
                .iter()
                .filter_map(|key| text(raw, key))
                .collect::<Vec<_>>()
                .join(" ");
            if !category.is_empty() {
                alert.insert("category".into(), json!(category));
            }
            let fields: serde_json::Map<String, Value> = [
                ("effectDescription", "effectDesc"),
                ("accessibility", "accessibility"),
                ("category", "category"),
                ("severity", "severity"),
                ("reason", "reason"),
            ]
            .iter()
            .filter_map(|(target, source)| {
                text(raw, source).map(|v| (target.to_string(), json!(v)))
            })
            .collect();
            if !fields.is_empty() {
                alert.insert("sourceFields".into(), Value::Object(fields));
            }
            if !accessibility && raw.get("affectsAllRoutes") != Some(&Value::Bool(true)) {
                let ids = raw
                    .get("routes")
                    .and_then(Value::as_array)
                    .map(|ids| {
                        ids.iter()
                            .map(token)
                            .map(|v| v.trim().to_owned())
                            .filter(|v| !v.is_empty())
                            .collect::<Vec<_>>()
                    })
                    .or_else(|| {
                        raw.get("route")
                            .filter(|v| !v.is_null())
                            .map(token)
                            .map(|v| v.trim().to_owned())
                            .filter(|v| !v.is_empty())
                            .map(|id| vec![id])
                    });
                if let Some(ids) = ids {
                    alert.insert("routeIds".into(), json!(ids));
                }
            }
            let header_station = header_text
                .as_deref()
                .and_then(|s| s.split(':').next())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            if let Some(from) = text(raw, "stopStart")
                .or_else(|| text(raw, "stopStartId"))
                .or_else(|| header_station.clone())
            {
                alert.insert("fromStationId".into(), json!(from));
            }
            if let Some(to) = text(raw, "stopEnd")
                .or_else(|| text(raw, "stopEndId"))
                .or_else(|| {
                    raw.get("accessibility")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .and(header_station)
                })
            {
                alert.insert("toStationId".into(), json!(to));
            }
            let closed = raw.get("closed_stops").and_then(Value::as_array);
            let listed = ["stopIDList", "stopNameList", "stops"]
                .iter()
                .find_map(|key| {
                    raw.get(*key)
                        .and_then(Value::as_array)
                        .filter(|s| !s.is_empty())
                })
                .map(|ids| {
                    ids.iter()
                        .map(token)
                        .map(|v| v.trim().to_owned())
                        .filter(|v| !v.is_empty())
                        .collect::<Vec<_>>()
                });
            let bucket_stops = closed
                .map(|stops| {
                    let mut names = Vec::new();
                    for stop in stops {
                        let name = text(stop, "name")
                            .unwrap_or_else(|| token(&stop["id"]).trim().to_owned());
                        if !name.is_empty() && !names.contains(&name) {
                            names.push(name);
                        }
                    }
                    names
                })
                .filter(|s| !s.is_empty());
            if let Some(stations) = listed
                .or(bucket_stops)
                .or_else(|| text(raw, "stopName").map(|name| vec![name]))
            {
                alert.insert("affectedStations".into(), json!(stations));
            }
            if let Some(stops) = closed.filter(|s| !s.is_empty()) {
                alert.insert(
                    "targets".into(),
                    json!(
                        stops
                            .iter()
                            .map(|s| token(&s["id"]).trim().to_owned())
                            .filter(|id| !id.is_empty())
                            .map(|id| json!({"stopId":id}))
                            .collect::<Vec<_>>()
                    ),
                );
            }
            if let Some(trips) = raw.get("tripIds") {
                alert.insert("tripIds".into(), trips.clone());
            }
            if raw.get("tripScoped") == Some(&Value::Bool(true)) {
                alert.insert("tripScoped".into(), json!(true));
            }
            if raw.get("stopScoped") == Some(&Value::Bool(true)) {
                alert.insert("stopScoped".into(), json!(true));
            }
            if let Some(targets) = raw.get("targets").filter(|v| !v.is_null()) {
                alert.insert("targets".into(), targets.clone());
            }
            if let Some(effect) = raw.get("effect").filter(|v| !v.is_null()) {
                if effect.is_number() {
                    alert.insert("effect".into(), effect.clone());
                } else if let Some(effect) = text(raw, "effect") {
                    alert.insert("effect".into(), json!(effect));
                }
            }
            let explicit_start = raw
                .get("activePeriod")
                .and_then(|period| period.get("start"))
                .filter(|value| !value.is_null())
                .or_else(|| raw.get("start_time").filter(|value| !value.is_null()))
                .and_then(|value| timestamp(Some(value)));
            let published_start = raw
                .get("posted_at")
                .filter(|value| !value.is_null())
                .or_else(|| raw.get("publishDateUtc").filter(|value| !value.is_null()))
                .and_then(|value| timestamp(Some(value)));
            let inferred_start = explicit_start.or(published_start).unwrap_or(now);
            let end = raw
                .get("activePeriod")
                .and_then(|period| period.get("end"))
                .filter(|value| !value.is_null())
                .or_else(|| raw.get("expires_at"));
            let explicit_end =
                timestamp(end).filter(|end| explicit_start.is_none_or(|start| *end >= start));
            let starts_at = explicit_start
                .or_else(|| explicit_end.map(|end| end.min(inferred_start)))
                .unwrap_or(inferred_start);
            if let Some(end) = explicit_end {
                alert.insert("endsAt".into(), json!(end));
            }
            alert.insert("startsAt".into(), json!(starts_at));
            alert.insert("updatedAt".into(), json!(now));
            alert.insert(
                "id".into(),
                json!(if id.trim().is_empty() {
                    fallback_alert_id(source_scope, raw)
                } else {
                    id.trim().to_owned()
                }),
            );
            Ok(Value::Object(alert))
        })
        .collect();
    Ok(
        json!({"header":{"version":"json","timestamp":now},"tripUpdates":[],"vehiclePositions":[],"alerts":alerts?}),
    )
}

pub async fn scrape_generic_json_feed(
    client: &crate::upstream::Client,
    url: &str,
) -> Result<ScrapeOutcome, Box<dyn Error + Send + Sync>> {
    let response = client.get(url).send().await?;
    if !response.status().is_success() {
        return Err(crate::upstream::Failure::Http.into());
    }
    let bytes: Bytes = response.bytes().await?;
    decode_generic_json_alert_feed_for_source(&bytes, chrono::Utc::now().timestamp_millis(), url)
        .map_err(|_| crate::upstream::Failure::Decode)?;
    Ok(ScrapeOutcome {
        bytes,
        partial: false,
        content_type: "application/json",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_shared_shape_contract() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/generic-json/contract.json"
        ))
        .unwrap();
        for case in cases {
            let bytes = serde_json::to_vec(&case["payload"]).unwrap();
            assert_eq!(
                validate_generic_json(&bytes).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            if let Some(expected) = case.get("expected") {
                assert_eq!(
                    decode_generic_json_alert_feed(&bytes, 1791993600000).unwrap(),
                    *expected,
                    "{}",
                    case["name"]
                );
            }
        }
    }

    #[test]
    fn fallback_alert_ids_are_stable_and_source_scoped() {
        let bytes = br#"[{"title":"Unnumbered closure","routes":["R7"]}]"#;
        let decode = |source_scope| {
            decode_generic_json_alert_feed_for_source(bytes, 1_799_000_000_000, source_scope)
                .unwrap()["alerts"][0]["id"]
                .as_str()
                .unwrap()
                .to_owned()
        };

        let first = decode("https://sample.test/alerts-a");
        assert_eq!(decode("https://sample.test/alerts-a"), first);
        assert_ne!(decode("https://sample.test/alerts-b"), first);
    }

    #[tokio::test]
    async fn preserves_successful_bytes_and_rejects_redirects_errors_and_malformed_payloads() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let client = crate::upstream::Client::builder().build().unwrap();
        for (status, body, valid) in [
            (
                "200 OK",
                "{\"alerts\":{\"short_term\":[],\"long_term\":[]}}",
                true,
            ),
            ("302 Found", "[]", false),
            ("503 Service Unavailable", "[]", false),
            ("200 OK", "{\"alerts\":{\"bad\":[]}}", false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let received = socket.read(&mut request).await.unwrap();
                assert!(received > 0);
                socket.write_all(response.as_bytes()).await.unwrap();
            });
            let result =
                scrape_generic_json_feed(&client, &format!("http://{address}/alerts")).await;
            assert_eq!(result.is_ok(), valid, "{status}: {body}");
            if valid {
                let result = result.unwrap();
                assert_eq!(result.bytes.as_ref(), body.as_bytes());
                assert!(!result.partial);
                assert_eq!(result.content_type, "application/json");
            }
            server.await.unwrap();
        }
    }
}
