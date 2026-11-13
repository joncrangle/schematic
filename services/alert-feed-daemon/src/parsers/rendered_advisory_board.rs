use serde::Deserialize;
use serde_json::{Value, json};
use std::io;

fn invalid() -> io::Error {
    io::Error::other("Invalid rendered advisory board")
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Notice {
    unique_id: String,
    gtfsentity_id: Option<String>,
    subject: Option<String>,
    effect_text: Option<String>,
    alert_descriptions: Vec<Text>,
    alert_headers: Option<Vec<Text>>,
    alert_entity_affecteds: Vec<Entity>,
    alert_periods: Vec<Period>,
    rendered_alert: Option<Rendered>,
}
#[derive(Deserialize)]
struct Text {
    text: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entity {
    route_id: Option<String>,
    stop_id: Option<String>,
    trip_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Period {
    start_date_time: Option<String>,
    end_date_time: Option<String>,
}
#[derive(Deserialize)]
struct Rendered {
    message: Message,
    effect: Effect,
}
#[derive(Deserialize)]
struct Message {
    header: String,
    description: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Effect {
    token: String,
    display_text: String,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Group {
    Group { alerts: Vec<Notice> },
    Notice(Box<Notice>),
}
fn text(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}
fn timestamp(value: Option<&str>) -> Result<Option<String>, io::Error> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value == "1970-01-01T00:00:00" {
        return Ok(None);
    }
    let bare = value.strip_suffix('Z').unwrap_or(value);
    let bytes = bare.as_bytes();
    if bytes.len() < 19
        || !bytes[..19].iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b'T',
            13 | 16 => *c == b':',
            _ => c.is_ascii_digit(),
        })
        || (bytes.len() > 19
            && (bytes[19] != b'.'
                || bytes.len() < 21
                || !bytes[20..].iter().all(u8::is_ascii_digit)))
    {
        return Err(invalid());
    }
    chrono::NaiveDateTime::parse_from_str(bare, "%Y-%m-%dT%H:%M:%S%.f").map_err(|_| invalid())?;
    Ok(Some(format!("{bare}Z")))
}
fn unique(items: impl Iterator<Item = String>) -> Vec<String> {
    let mut out = Vec::new();
    for item in items {
        if !out.contains(&item) {
            out.push(item);
        }
    }
    out
}
pub fn normalize(payload: Value) -> Result<Value, io::Error> {
    let groups: Vec<Group> = serde_json::from_value(payload).map_err(|_| invalid())?;
    let mut alerts = Vec::new();
    for notice in groups.into_iter().flat_map(|g| match g {
        Group::Group { alerts } => alerts,
        Group::Notice(n) => vec![*n],
    }) {
        let rendered = notice.rendered_alert.as_ref();
        let mut description = rendered
            .and_then(|r| text(Some(&r.message.description)))
            .map(str::to_owned)
            .unwrap_or_else(|| {
                notice
                    .alert_descriptions
                    .iter()
                    .filter_map(|t| text(t.text.as_deref()))
                    .collect::<Vec<_>>()
                    .join("\n")
            });
        let headers = notice
            .alert_headers
            .as_ref()
            .map(|h| {
                h.iter()
                    .filter_map(|t| text(t.text.as_deref()))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        // These tokens are machine labels, and a notice shared by routes carries one route's subject.
        let generic_effect = rendered
            .is_some_and(|r| matches!(r.effect.token.as_str(), "OTHER_EFFECT" | "UNKNOWN_EFFECT"));
        let published_title = rendered
            .and_then(|r| text(Some(&r.message.header)))
            .or_else(|| text(Some(&headers)));
        let title = published_title.unwrap_or_else(|| {
            if generic_effect {
                "Transit Alert"
            } else {
                rendered
                    .and_then(|r| text(Some(&r.effect.display_text)))
                    .or_else(|| text(notice.subject.as_deref()))
                    .unwrap_or("Transit advisory")
            }
        });
        let entities = &notice.alert_entity_affecteds;
        // Scoped cancellations can publish only an effect caption, with no message body.
        if super::strip_html::strip_html(&description)
            .trim()
            .is_empty()
            && let Some(rendered) = rendered
            && rendered.effect.token == "NO_SERVICE"
            && entities.iter().any(|entity| {
                text(entity.route_id.as_deref()).is_some()
                    || text(entity.stop_id.as_deref()).is_some()
                    || text(entity.trip_id.as_deref()).is_some()
            })
        {
            description = rendered.effect.display_text.trim().to_string();
        }
        if super::strip_html::strip_html(&description)
            .trim()
            .is_empty()
            || notice.unique_id.trim().is_empty()
        {
            return Err(invalid());
        }
        let routes = unique(
            entities
                .iter()
                .filter_map(|e| text(e.route_id.as_deref()).map(str::to_owned)),
        );
        let trips = unique(
            entities
                .iter()
                .filter_map(|e| text(e.trip_id.as_deref()).map(str::to_owned)),
        );
        let targets: Vec<Value> = entities
            .iter()
            .filter_map(|e| {
                let mut target = json!({});
                if let Some(route) = text(e.route_id.as_deref()) {
                    target["routeId"] = json!(route);
                }
                if let Some(stop) = text(e.stop_id.as_deref()) {
                    target["stopId"] = json!(stop);
                }
                (!target.as_object().unwrap().is_empty()).then_some(target)
            })
            .collect();
        let trip_scoped = !entities.is_empty()
            && entities
                .iter()
                .all(|e| text(e.trip_id.as_deref()).is_some());
        let periods = if notice.alert_periods.is_empty() {
            vec![Period {
                start_date_time: None,
                end_date_time: None,
            }]
        } else {
            notice.alert_periods
        };
        for period in periods {
            let start = timestamp(period.start_date_time.as_deref())?;
            let end = timestamp(period.end_date_time.as_deref())?;
            if let (Some(start), Some(end)) = (&start, &end)
                && chrono::DateTime::parse_from_rfc3339(end).map_err(|_| invalid())?
                    < chrono::DateTime::parse_from_rfc3339(start).map_err(|_| invalid())?
            {
                return Err(invalid());
            }
            let mut window = json!({});
            if let Some(start) = start {
                window["start"] = json!(start);
            }
            if let Some(end) = end {
                window["end"] = json!(end);
            }
            let mut alert = json!({"id":text(notice.gtfsentity_id.as_deref()).unwrap_or(&notice.unique_id),"title":title,"description":description,"routes":routes,"targets":targets,"tripIds":trips,"tripScoped":trip_scoped,"activePeriod":window});
            if let Some(category) = &notice.effect_text {
                alert["category"] = json!(category);
            }
            if let Some(rendered) = rendered {
                alert["effect"] = json!(rendered.effect.token);
            }
            alerts.push(alert);
        }
    }
    Ok(json!({"alerts":alerts,"partial":false}))
}
