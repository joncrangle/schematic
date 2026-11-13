//! Twin of the Core Hubup advisory normalizer.
use serde::Deserialize;
use serde_json::{Value, json};
use std::io;
#[derive(Deserialize)]
struct Content {
    lang: String,
    header: String,
    description: String,
}
#[derive(Deserialize)]
struct Period {
    is_active: bool,
    start: String,
    end: String,
}
#[derive(Deserialize)]
struct Route {
    real_route_id: Value,
}
#[derive(Deserialize)]
struct Stop {
    real_stop_id: Value,
}
#[derive(Deserialize)]
struct Trip {
    real_trip_id: Value,
}
#[derive(Deserialize)]
struct Target {
    route: Option<Route>,
    stops: Option<Vec<Stop>>,
    trip: Option<Trip>,
}
#[derive(Deserialize)]
struct Alert {
    id: Value,
    effect: String,
    contents: Vec<Content>,
    periods: Vec<Period>,
    targets: Vec<Target>,
}
fn invalid() -> io::Error {
    io::Error::other("Invalid Hubup advisory")
}
fn token(v: &Value) -> Result<String, io::Error> {
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        _ => Err(invalid()),
    }
}
pub fn normalize(payload: Value) -> Result<Value, io::Error> {
    let rows: Vec<Alert> = serde_json::from_value(payload).map_err(|_| invalid())?;
    let mut alerts = Vec::new();
    for row in rows {
        let id = token(&row.id)?;
        let content = row
            .contents
            .iter()
            .find(|c| c.lang == "fr")
            .or(row.contents.first())
            .ok_or_else(invalid)?;
        if content.header.trim().is_empty() || row.periods.is_empty() {
            return Err(invalid());
        }
        let mut targets = Vec::new();
        for t in &row.targets {
            let mut base = serde_json::Map::new();
            if let Some(route) = &t.route {
                base.insert("routeId".into(), json!(token(&route.real_route_id)?));
            }
            if let Some(trip) = &t.trip {
                base.insert("tripId".into(), json!(token(&trip.real_trip_id)?));
            }
            if let Some(stops) = &t.stops.as_ref().filter(|s| !s.is_empty()) {
                for stop in *stops {
                    let mut target = base.clone();
                    target.insert("stopId".into(), json!(token(&stop.real_stop_id)?));
                    targets.push(Value::Object(target));
                }
            } else if !base.is_empty() {
                targets.push(Value::Object(base));
            }
        }
        if !row.targets.is_empty() && targets.is_empty() {
            return Err(invalid());
        }
        for (i, period) in row.periods.iter().enumerate() {
            if !period.is_active {
                continue;
            }
            if period.start.is_empty() || period.end.is_empty() || period.end <= period.start {
                return Err(invalid());
            }
            alerts.push(json!({"id":format!("{id}:{i}"),"title":content.header,"description":content.description,"effect":row.effect,"targets":targets,"activePeriod":{"start":period.start,"end":period.end}}));
        }
    }
    Ok(json!({"alerts":alerts,"partial":false}))
}
