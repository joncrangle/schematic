use chrono::{Duration, NaiveDateTime};
use serde_json::{Value, json};
use std::{collections::BTreeMap, io};
fn invalid() -> io::Error {
    io::Error::other("Invalid transit notice envelope")
}
fn object(v: &Value) -> Result<&serde_json::Map<String, Value>, io::Error> {
    v.as_object().ok_or_else(invalid)
}
fn array(v: &Value) -> Result<&Vec<Value>, io::Error> {
    v.as_array().ok_or_else(invalid)
}
fn text(v: &Value) -> Result<&str, io::Error> {
    v.as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(invalid)
}
fn optional(v: &Value) -> Result<Option<&str>, io::Error> {
    if v.is_null() {
        Ok(None)
    } else {
        text(v).map(Some)
    }
}
fn relation<'a>(v: &'a Value, key: &str) -> Result<&'a Vec<Value>, io::Error> {
    array(&v["relationships"][key]["data"])
}
fn unique(values: impl Iterator<Item = Value>) -> Vec<Value> {
    let mut out = Vec::new();
    for v in values {
        if !out.contains(&v) {
            out.push(v);
        }
    }
    out
}
fn wall(v: &Value) -> Result<String, io::Error> {
    let date =
        NaiveDateTime::parse_from_str(text(v)?, "%Y-%m-%d %H:%M:%S").map_err(|_| invalid())?;
    Ok(date.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}
pub fn bucketed(payload: &Value) -> Result<Value, io::Error> {
    object(payload)?;
    let mut alerts = Vec::new();
    for bucket in [
        "cancelled_stops",
        "cancelled_trips",
        "significant_delays",
        "other",
    ] {
        for item in array(&payload[bucket])? {
            let mut targets = Vec::new();
            let mut trip_ids = Vec::new();
            for entity in array(&item["entities"])? {
                let route = optional(&entity["route_id"])?;
                let stop = optional(&entity["stop_id"])?;
                if let Some(trip) = optional(&entity["trip_id"])? {
                    trip_ids.push(json!(trip));
                }
                if route.is_none() && stop.is_none() && entity["trip_id"].is_null() {
                    return Err(invalid());
                }
                let mut target = json!({});
                if let Some(route) = route {
                    target["routeId"] = json!(route);
                }
                if let Some(stop) = stop {
                    target["stopId"] = json!(stop);
                }
                if !target.as_object().is_none_or(|v| v.is_empty()) {
                    targets.push(target);
                }
            }
            let periods = array(&item["periods"])?;
            if (targets.is_empty() && trip_ids.is_empty()) || periods.is_empty() {
                return Err(invalid());
            }
            for (index, period) in periods.iter().enumerate() {
                let start = wall(&period["start"])?;
                let mut end = if period["end"].is_null() {
                    None
                } else {
                    Some(wall(&period["end"])?)
                };
                if let Some(value) = &end
                    && value < &start
                    && value[..10] == start[..10]
                {
                    let date = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%SZ")
                        .map_err(|_| invalid())?
                        + Duration::days(1);
                    end = Some(date.format("%Y-%m-%dT%H:%M:%SZ").to_string());
                }
                if end.as_ref().is_some_and(|value| value < &start) {
                    return Err(invalid());
                }
                let mut period = json!({"start": start});
                if let Some(end) = end {
                    period["end"] = json!(end);
                }
                let mut alert = json!({
                    "id":format!("{}:{index}", text(&item["id"])?), "title":text(&item["headline"])?, "description":text(&item["description"])?,
                    "effect":text(&item["effect"])?, "routes":unique(targets.iter().filter_map(|t| t.get("routeId").cloned())),
                    "stops":unique(targets.iter().filter_map(|t| t.get("stopId").cloned())),
                    "stopScoped":!targets.is_empty() && targets.iter().all(|t| t.get("stopId").is_some()), "targets":targets, "activePeriod":period
                });
                if !trip_ids.is_empty() {
                    alert["tripIds"] = json!(unique(trip_ids.iter().cloned()));
                    alert["tripScoped"] = json!(true);
                }
                alerts.push(alert);
            }
        }
    }
    Ok(json!({"alerts":alerts,"partial":false}))
}
pub fn jsonapi(payload: &Value) -> Result<Value, io::Error> {
    let data = array(&payload["data"])?;
    let empty = Vec::new();
    let rows = if payload["included"].is_null() && data.is_empty() {
        &empty
    } else {
        array(&payload["included"])?
    };
    let mut included = BTreeMap::new();
    for item in rows {
        included.insert(
            format!("{}:{}", text(&item["type"])?, text(&item["id"])?),
            item,
        );
    }
    let resolve = |reference: &Value| -> Result<&Value, io::Error> {
        included
            .get(&format!(
                "{}:{}",
                text(&reference["type"])?,
                text(&reference["id"])?
            ))
            .copied()
            .ok_or_else(invalid)
    };
    let description_of = |item: &Value, descriptions: &mut Vec<String>| {
        let v = &item["attributes"]["description"];
        if let Some(s) = v
            .as_str()
            .or_else(|| v["value"].as_str())
            .filter(|s| !s.trim().is_empty())
        {
            descriptions.push(s.to_string());
        }
    };
    let pattern = regex::Regex::new(r"^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$").expect("timestamp pattern");
    let mut alerts = Vec::new();
    for item in data {
        let a = &item["attributes"];
        object(a)?;
        let title = text(&a["title"])?;
        let general = a["general"].as_bool().ok_or_else(invalid)?;
        let mut stops = Vec::new();
        let mut targets = Vec::new();
        let mut alternatives = Vec::new();
        let mut descriptions = Vec::new();
        for reference in relation(item, "parcours")? {
            let paragraph = resolve(reference)?;
            description_of(paragraph, &mut descriptions);
            let mut closed = Vec::new();
            for reference in relation(paragraph, "arrets")? {
                let block = resolve(reference)?;
                description_of(block, &mut descriptions);
                for reference in relation(block, "arrets_suggeres")? {
                    let a = &resolve(reference)?["attributes"];
                    let code = text(&a["name"])?;
                    alternatives
                        .push(json!({"id":code,"name":a["name_stop"].as_str().unwrap_or(code)}));
                }
                for reference in relation(block, "arrets_non_desservis")? {
                    let a = &resolve(reference)?["attributes"];
                    let code = text(&a["name"])?;
                    let name = a["name_stop"].as_str().unwrap_or(code);
                    closed.push((code.to_string(), name.to_string()));
                    let name = json!(name);
                    if !stops.contains(&name) {
                        stops.push(name);
                    }
                }
            }
            for reference in relation(paragraph, "routes")? {
                let route = &resolve(reference)?["attributes"];
                let route_id = text(&route["name"])?;
                let direction = match text(&route["code_direction"])? {
                    "0" => 0,
                    "1" => 1,
                    _ => return Err(invalid()),
                };
                let target = json!({"routeId":route_id,"directionId":direction});
                if closed.is_empty() {
                    targets.push(target);
                } else {
                    for (code, name) in &closed {
                        let mut t = target.clone();
                        t["stopCode"] = json!(code);
                        t["stopId"] = json!(name);
                        targets.push(t);
                    }
                }
            }
        }
        if !general && targets.is_empty() {
            return Err(invalid());
        }
        let start = optional(&a["date_notice_start"])?;
        let end = optional(&a["date_notice_end"])?;
        let parse = |s: &str| {
            if !pattern.is_match(s) {
                return Err(invalid());
            }
            chrono::DateTime::parse_from_rfc3339(s).map_err(|_| invalid())
        };
        if let Some(s) = start {
            parse(s)?;
        }
        if let Some(e) = end {
            parse(e)?;
        }
        if let (Some(s), Some(e)) = (start, end)
            && parse(e)? < parse(s)?
        {
            return Err(invalid());
        }
        let body = if a["body"].is_null() {
            None
        } else {
            optional(&a["body"]["value"])?
        };
        let subtitle = a["subtitle"].as_str().unwrap_or_default().trim();
        let mut content = [Some(subtitle).filter(|s| !s.is_empty()), body]
            .into_iter()
            .flatten()
            .map(str::to_string)
            .collect::<Vec<_>>();
        content.extend(descriptions);
        let description = content.join("\n\n");
        let routes = unique(targets.iter().filter_map(|t| t.get("routeId").cloned()));
        let mut period = json!({});
        if let Some(start) = start {
            period["start"] = json!(start);
        }
        if let Some(end) = end {
            period["end"] = json!(end);
        }
        let mut alert = json!({"id":text(&item["id"])?,"title":title,"description":if description.is_empty() {title} else {&description},"routes":routes,"stops":stops,"targets":targets,"stopScoped":!stops.is_empty(),"affectsAllRoutes":general,"activePeriod":period});
        if !alternatives.is_empty() {
            alert["alternate_stops"] = json!(alternatives);
        }
        alerts.push(alert);
    }
    let count = payload["meta"]["count"].as_u64().ok_or_else(invalid)?;
    Ok(
        json!({"alerts":alerts,"partial":count != data.len() as u64 || !payload["links"]["next"].is_null()}),
    )
}
