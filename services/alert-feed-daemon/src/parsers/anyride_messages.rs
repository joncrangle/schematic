//! Consat AnyRide service messages: the Rust twin of
//! `src/infrastructure/realtime/tmix/tmixMessageAlerts.ts`.
//!
//! AnyRide has no messages endpoint. A `GetCalls` response carries a `messages`
//! array, so a message is only visible at the stops polled and nothing on the
//! wire dates it. Both implementations apply the same rules and read
//! `tests/fixtures/realtime/tmix/messages.contract.json`:
//!
//! - one alert per message id, in first-sighting order; the first sighting keeps
//!   the text, priority and `isInfo`, and `isDisturbance` is true if any
//!   sighting says so; text is never edited;
//! - stop scope is the queried GTFS stop id, never the internal `stopPointId`;
//! - route attribution per sighting is the in-scope lines of the calls named by
//!   `affectedCalls`, else the routes the stop is declared to serve;
//! - an alert is active while its id appears and has no invented window;
//! - a stop that failed, answered with no content, or fell outside the
//!   subrequest budget makes the read incomplete (`partial`), never an
//!   all-clear. Nothing readable at all is a failed source.
use crate::agencies::ScrapeOutcome;
use bytes::Bytes;
use serde_json::{Map, Number, Value, json};
use std::{error::Error, io, time::Duration};

/// Mirrors `TMIX_MAX_SUBREQUESTS`: the most stops one read may poll.
pub const MAX_POLLED_STOPS: usize = 40;

#[derive(Clone, Debug, PartialEq)]
pub struct MessageStop {
    pub stop_id: String,
    pub route_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AnyRideProfile {
    pub data: String,
    pub display: Option<String>,
}

/// A poll's calls, reduced to what route attribution reads.
#[derive(Debug)]
struct Call {
    key: Option<String>,
    line: String,
    line_id: String,
}

#[derive(Debug)]
struct Message {
    id: String,
    text: String,
    priority: Option<Number>,
    is_disturbance: bool,
    is_info: bool,
    affected_calls: Vec<String>,
}

/// One decoded `GetCalls` response.
#[derive(Debug)]
pub struct StopResponse {
    calls: Vec<Call>,
    messages: Vec<Message>,
    /// The zero-byte answer for an unknown stop: nothing was observed.
    no_content: bool,
}

fn non_blank(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

/// `String(number)` as JavaScript renders the integer ids the wire uses.
fn js_number_string(number: f64) -> String {
    if number.fract() == 0.0 && number.abs() < 1e21 {
        format!("{}", number as i64)
    } else {
        number.to_string()
    }
}

fn parse_call(value: &Value) -> Option<Call> {
    let record = value.as_object()?;
    non_blank(record.get("id"))?;
    let line = non_blank(record.get("line"))?;
    let line_id = record.get("lineId")?.as_f64().filter(|n| n.is_finite())?;
    Some(Call {
        key: non_blank(record.get("key")),
        line,
        line_id: js_number_string(line_id),
    })
}

fn parse_message(value: &Value) -> Option<Message> {
    let record = value.as_object()?;
    let id = non_blank(record.get("id"))?;
    let text = record
        .get("text")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())?
        .to_owned();
    let priority = record
        .get("priority")
        .and_then(Value::as_number)
        .filter(|n| n.as_f64().is_some_and(f64::is_finite))
        .cloned();
    let affected_calls = record
        .get("affectedCalls")
        .and_then(Value::as_array)
        .map(|calls| {
            calls
                .iter()
                .filter_map(|call| match call {
                    Value::Number(n) => n.as_f64().map(js_number_string),
                    other => non_blank(Some(other)),
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Message {
        id,
        text,
        priority,
        is_disturbance: record.get("isDisturbance") == Some(&Value::Bool(true)),
        is_info: record.get("isInfo") == Some(&Value::Bool(true)),
        affected_calls,
    })
}

/// Alert-only twin of strict `parseTmixStopResponse`: groups `{id, calls: [...]}`
/// and bare calls both decode. An unexpected envelope or unreadable message
/// fails the poll, because dropping it could turn a challenge page into an
/// all-clear.
pub fn parse_stop_response(bytes: &[u8]) -> Result<StopResponse, io::Error> {
    if bytes.is_empty() {
        return Ok(StopResponse {
            calls: vec![],
            messages: vec![],
            no_content: true,
        });
    }
    let body: Value = serde_json::from_slice(bytes)
        .map_err(|error| io::Error::other(format!("Invalid AnyRide JSON: {error}")))?;
    let object = body
        .as_object()
        .ok_or_else(|| io::Error::other("AnyRide response was not an object"))?;
    let groups = object
        .get("calls")
        .and_then(Value::as_array)
        .ok_or_else(|| io::Error::other("AnyRide response did not contain a calls array"))?;
    let message_values = object
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| io::Error::other("AnyRide response did not contain a messages array"))?;
    let mut calls = Vec::new();
    for group in groups {
        match group.get("calls").and_then(Value::as_array) {
            Some(inner) => calls.extend(inner.iter().filter_map(parse_call)),
            None => calls.extend(parse_call(group)),
        }
    }
    let messages = message_values
        .iter()
        .map(|value| {
            parse_message(value)
                .ok_or_else(|| io::Error::other("AnyRide response contained an unreadable message"))
        })
        .collect::<Result<_, _>>()?;
    Ok(StopResponse {
        calls,
        messages,
        no_content: false,
    })
}

fn sighting_routes(
    stop: &MessageStop,
    response: &StopResponse,
    message: &Message,
    operator_prefix: &str,
) -> Vec<String> {
    let from_calls: Vec<&str> = response
        .calls
        .iter()
        .filter(|call| {
            call.key
                .as_ref()
                .is_some_and(|key| message.affected_calls.contains(key))
                && call.line_id.starts_with(operator_prefix)
        })
        .map(|call| call.line.as_str())
        .collect();
    let mut routes: Vec<String> = if from_calls.is_empty() {
        stop.route_ids.clone()
    } else {
        from_calls.into_iter().map(str::to_owned).collect()
    };
    routes.sort();
    routes.dedup();
    routes
}

struct Sighting {
    id: String,
    text: String,
    priority: Option<Number>,
    is_disturbance: bool,
    is_info: bool,
    targets: Vec<(String, String)>,
}

/// Twin of `buildTmixMessageFeed`. `outcomes` is aligned with `declared`; an
/// entry is `None` when its poll failed, and a list shorter than `declared`
/// leaves the trailing stops unpolled. Returns `None` when no stop was read.
pub fn build_message_feed(
    declared: &[MessageStop],
    outcomes: &[Option<StopResponse>],
    operator_prefix: &str,
    now: i64,
) -> Option<Value> {
    let read: Vec<(&MessageStop, &StopResponse)> = declared
        .iter()
        .enumerate()
        .filter_map(|(index, stop)| {
            let response = outcomes.get(index)?.as_ref()?;
            (!response.no_content).then_some((stop, response))
        })
        .collect();
    if read.is_empty() {
        return None;
    }
    let complete = read.len() == declared.len();

    let mut order: Vec<String> = Vec::new();
    let mut sightings: std::collections::HashMap<String, Sighting> = Default::default();
    for (stop, response) in &read {
        for message in &response.messages {
            let sighting = sightings.entry(message.id.clone()).or_insert_with(|| {
                order.push(message.id.clone());
                Sighting {
                    id: message.id.clone(),
                    text: message.text.clone(),
                    priority: message.priority.clone(),
                    is_disturbance: false,
                    is_info: message.is_info,
                    targets: Vec::new(),
                }
            });
            sighting.is_disturbance = sighting.is_disturbance || message.is_disturbance;
            for route_id in sighting_routes(stop, response, message, operator_prefix) {
                let target = (route_id, stop.stop_id.clone());
                if !sighting.targets.contains(&target) {
                    sighting.targets.push(target);
                }
            }
        }
    }

    let alerts: Vec<Value> = order
        .iter()
        .map(|id| {
            let sighting = &sightings[id];
            let mut source_fields = Map::new();
            source_fields.insert("isDisturbance".into(), json!(sighting.is_disturbance));
            source_fields.insert("isInfo".into(), json!(sighting.is_info));
            if let Some(priority) = &sighting.priority {
                source_fields.insert("priority".into(), Value::Number(priority.clone()));
            }
            let mut alert = Map::new();
            alert.insert("id".into(), json!(sighting.id));
            alert.insert("title".into(), json!(sighting.text));
            alert.insert("startsAt".into(), json!(0));
            alert.insert("updatedAt".into(), json!(now));
            if !sighting.targets.is_empty() {
                let mut route_ids: Vec<&str> = Vec::new();
                for (route_id, _) in &sighting.targets {
                    if !route_ids.contains(&route_id.as_str()) {
                        route_ids.push(route_id);
                    }
                }
                alert.insert("routeIds".into(), json!(route_ids));
                alert.insert(
                    "targets".into(),
                    Value::Array(
                        sighting
                            .targets
                            .iter()
                            .map(|(route_id, stop_id)| json!({"routeId": route_id, "stopId": stop_id}))
                            .collect(),
                    ),
                );
            }
            alert.insert("sourceFields".into(), Value::Object(source_fields));
            Value::Object(alert)
        })
        .collect();

    let mut feed = Map::new();
    feed.insert(
        "header".into(),
        json!({"version": "anyride-messages", "timestamp": now}),
    );
    feed.insert("tripUpdates".into(), json!([]));
    feed.insert("vehiclePositions".into(), json!([]));
    feed.insert("alerts".into(), Value::Array(alerts));
    if !complete {
        feed.insert("partial".into(), json!(true));
    }
    Some(Value::Object(feed))
}

/// Everything one poll cycle needs; built by the registry.
#[derive(Clone, Debug)]
pub struct AnyRideMessagesConfig {
    pub base_url: String,
    pub operator_prefix: String,
    pub profile: Option<AnyRideProfile>,
    pub stops: Vec<MessageStop>,
}

async fn poll_stop(
    client: crate::upstream::Client,
    config: &AnyRideMessagesConfig,
    stop_id: &str,
) -> Result<StopResponse, Box<dyn Error + Send + Sync>> {
    let url = format!("{}/GetCalls", config.base_url.trim_end_matches('/'));
    let mut request = client
        .post(url)
        .header("Content-Type", "application/json")
        .body(
            json!({
                "query": {"fromStopAreaQuery": stop_id},
                "configuration": {"grouping": []}
            })
            .to_string(),
        );
    if let Some(profile) = &config.profile {
        request = request.header("anyride-profile-data", &profile.data);
        if let Some(display) = &profile.display {
            request = request.header("anyride-profile-display", display);
        }
    }
    let response = request.send().await?;
    if !response.status().is_success() {
        return Err(io::Error::other(format!(
            "AnyRide returned HTTP {} for {stop_id}",
            response.status()
        ))
        .into());
    }
    Ok(parse_stop_response(&response.bytes().await?)?)
}

/// Polls every declared stop (up to the shared budget) and serves the decoded
/// feed as JSON. Redirects are refused by the caller's client.
pub async fn scrape_anyride_messages_feed(
    client: &crate::upstream::Client,
    config: &AnyRideMessagesConfig,
) -> Result<ScrapeOutcome, Box<dyn Error + Send + Sync>> {
    let polled = config.stops.len().min(MAX_POLLED_STOPS);
    let mut tasks = tokio::task::JoinSet::new();
    for (index, stop) in config.stops.iter().take(polled).enumerate() {
        let client = client.clone();
        let config = config.clone();
        let stop_id = stop.stop_id.clone();
        tasks.spawn(async move {
            let result = tokio::time::timeout(
                Duration::from_millis(8_000),
                poll_stop(client, &config, &stop_id),
            )
            .await;
            (index, result.ok().and_then(Result::ok))
        });
    }
    let mut outcomes: Vec<Option<StopResponse>> = (0..polled).map(|_| None).collect();
    while let Some(joined) = tasks.join_next().await {
        if let Ok((index, response)) = joined {
            outcomes[index] = response;
        }
    }
    let now = chrono::Utc::now().timestamp_millis();
    let feed = build_message_feed(&config.stops, &outcomes, &config.operator_prefix, now)
        .ok_or_else(|| io::Error::other("No AnyRide stop could be read"))?;
    let partial = feed.get("partial") == Some(&json!(true));
    Ok(ScrapeOutcome {
        bytes: Bytes::from(serde_json::to_vec(&feed)?),
        partial,
        content_type: "application/json",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        now: i64,
        #[serde(rename = "operatorPrefix")]
        operator_prefix: String,
        stops: Vec<CaseStop>,
        polls: Vec<CasePoll>,
        expected: Value,
    }

    #[derive(serde::Deserialize)]
    struct CaseStop {
        #[serde(rename = "stopId")]
        stop_id: String,
        #[serde(rename = "routeIds")]
        route_ids: Vec<String>,
    }

    #[derive(serde::Deserialize)]
    struct CasePoll {
        #[serde(default)]
        failed: bool,
        #[serde(default)]
        body: Value,
    }

    #[test]
    fn matches_the_shared_parity_contract() {
        let cases: Vec<Case> = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/realtime/tmix/messages.contract.json"
        ))
        .unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let declared: Vec<MessageStop> = case
                .stops
                .iter()
                .map(|stop| MessageStop {
                    stop_id: stop.stop_id.clone(),
                    route_ids: stop.route_ids.clone(),
                })
                .collect();
            let outcomes: Vec<Option<StopResponse>> = case
                .polls
                .iter()
                .map(|poll| {
                    if poll.failed {
                        return None;
                    }
                    // A string body is raw bytes, so "" is the zero-byte 204.
                    let bytes = match &poll.body {
                        Value::String(text) => text.as_bytes().to_vec(),
                        other => serde_json::to_vec(other).unwrap(),
                    };
                    Some(parse_stop_response(&bytes).unwrap())
                })
                .collect();
            let feed = build_message_feed(&declared, &outcomes, &case.operator_prefix, case.now);
            assert_eq!(feed.unwrap_or(Value::Null), case.expected, "{}", case.name);
        }
    }

    #[test]
    fn rejects_a_body_that_is_not_json() {
        assert!(parse_stop_response(b"<html>captive portal</html>").is_err());
    }

    #[test]
    fn rejects_unrecognized_envelopes_and_unreadable_messages() {
        for body in [
            br#"{}"#.as_slice(),
            br#"{"error":"challenge"}"#.as_slice(),
            br#"{"calls":[],"messages":[{}]}"#.as_slice(),
        ] {
            assert!(parse_stop_response(body).is_err());
        }
    }

    #[tokio::test]
    async fn polls_each_stop_with_the_profile_headers_and_serves_json() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = vec![0; 8192];
                let read = socket.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                let body = r#"{"calls":[],"messages":[{"id":"TX1","text":"Detour.","priority":100,"isDisturbance":false,"isInfo":true,"affectedCalls":[]}]}"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
                requests.push(request);
            }
            requests
        });
        let request: crate::upstream::RequestConfig = serde_json::from_value(json!({
            "headers": {"x-client": "daemon-test"},
            "headerSecrets": {"authorization": "TEST_KEY"},
            "querySecrets": {"key": "TEST_KEY"}
        }))
        .unwrap();
        let client = crate::upstream::Client::new().configured(
            request
                .resolve(&format!("http://{address}/api"), |_| {
                    Some("synthetic-key".into())
                })
                .unwrap(),
        );
        let config = AnyRideMessagesConfig {
            base_url: format!("http://{address}/api"),
            operator_prefix: "70".into(),
            profile: Some(AnyRideProfile {
                data: "tenant_data".into(),
                display: Some("tenant".into()),
            }),
            stops: vec![
                MessageStop {
                    stop_id: "S1".into(),
                    route_ids: vec!["4".into()],
                },
                MessageStop {
                    stop_id: "S2".into(),
                    route_ids: vec!["4".into()],
                },
            ],
        };
        let outcome = scrape_anyride_messages_feed(&client, &config)
            .await
            .unwrap();
        assert!(!outcome.partial);
        let feed: Value = serde_json::from_slice(&outcome.bytes).unwrap();
        assert_eq!(feed["alerts"].as_array().unwrap().len(), 1);
        for request in server.await.unwrap() {
            let lowered = request.to_lowercase();
            assert!(request.starts_with("POST /api/GetCalls"), "{request}");
            assert!(lowered.contains("anyride-profile-data: tenant_data"));
            assert!(lowered.contains("anyride-profile-display: tenant"));
            assert!(lowered.contains("authorization: synthetic-key"));
            assert!(lowered.contains("x-client: daemon-test"));
            assert!(request.starts_with("POST /api/GetCalls?key=synthetic-key "));
        }
    }

    #[tokio::test]
    async fn serves_nothing_when_no_stop_can_be_read() {
        let client = crate::upstream::Client::new();
        let config = AnyRideMessagesConfig {
            base_url: "http://127.0.0.1:1/api".into(),
            operator_prefix: "70".into(),
            profile: None,
            stops: vec![MessageStop {
                stop_id: "S1".into(),
                route_ids: vec!["4".into()],
            }],
        };
        assert!(
            scrape_anyride_messages_feed(&client, &config)
                .await
                .is_err()
        );
    }
}
