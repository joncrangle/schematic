use serde_json::{Value, json};
use std::{collections::BTreeMap, io};
fn invalid() -> io::Error {
    io::Error::other("Invalid incident board")
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, io::Error> {
    v[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(invalid)
}
pub fn messages(payload: Value) -> Result<Value, io::Error> {
    let rows = payload.as_array().ok_or_else(invalid)?;
    let date = regex::Regex::new(r"^/Date\((\d+)\)/$").unwrap();
    let equipment = regex::Regex::new(r"(?i)\b(elevator|escalator)\b").unwrap();
    let station = regex::Regex::new(r"\b([A-Z]{2,3})\s*-\s*To(NY|NJ)\b").unwrap();
    let route = regex::Regex::new(r"\b[A-Z]{2,}-[A-Z0-9]{2,}\b").unwrap();
    let mut latest: BTreeMap<String, (usize, i64, &Value)> = BTreeMap::new();
    for (index, row) in rows.iter().enumerate() {
        let template = text(row, "TemplateName")?;
        let stamp: i64 = date
            .captures(text(row, "sentdate2")?)
            .and_then(|c| c[1].parse().ok())
            .ok_or_else(invalid)?;
        chrono::DateTime::from_timestamp_millis(stamp).ok_or_else(invalid)?;
        text(row, "Subject")?;
        text(row, "SentMessage")?;
        if !matches!(row["state"].as_str(), Some("Open" | "Closed"))
            || (!row["ebid"].is_number() && !row["ebid"].is_string())
            || (!row["messageid"].is_number() && !row["messageid"].is_string())
        {
            return Err(invalid());
        }
        let id = row["ebid"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| row["ebid"].to_string());
        let key = if equipment.is_match(template) {
            format!("equipment:{template}")
        } else {
            format!("incident:{id}")
        };
        match latest.get_mut(&key) {
            Some(entry) if stamp > entry.1 => {
                entry.1 = stamp;
                entry.2 = row;
            }
            None => {
                latest.insert(key, (index, stamp, row));
            }
            _ => {}
        }
    }
    let mut values: Vec<_> = latest.values().collect();
    values.sort_by_key(|v| v.0);
    let mut alerts = Vec::new();
    let pattern = regex::Regex::new(
        r"\b([A-Z]{2,}-[A-Z0-9]{2,}(?:,\s*[A-Z]{2,}-[A-Z0-9]{2,})*)\s+([^.!?]+[.!?]?)",
    )
    .unwrap();
    let status = regex::Regex::new(
        r"(?i)\b(resuming normal service|delays continue|delayed|suspended|no service)\b",
    )
    .unwrap();
    let restore = regex::Regex::new(r"(?i)\b(resuming normal service|back in service)\b").unwrap();
    let active =
        regex::Regex::new(r"(?i)\b(delays continue|delayed|suspended|no service)\b").unwrap();
    for (_, stamp, row) in values {
        let template = text(row, "TemplateName")?;
        let is_equipment = equipment.is_match(template);
        let description = text(row, "SentMessage")?;
        let mut routes = Vec::new();
        if !is_equipment {
            for m in route.find_iter(description) {
                if !routes.contains(&m.as_str()) {
                    routes.push(m.as_str());
                }
            }
        }
        let id = row["messageid"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| row["messageid"].to_string());
        let mut item = json!({"id":id,"title":row["Subject"],"description":description,"posted_at":chrono::DateTime::from_timestamp_millis(*stamp).ok_or_else(invalid)?.to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"routes":routes,"category":row["state"],"effect":"UNKNOWN_EFFECT"});
        if is_equipment && let Some(c) = station.captures(template) {
            item["stops"] = json!([&c[1]]);
            item["stopScoped"] = json!(true);
        }
        let clauses: Vec<_> = if is_equipment {
            Vec::new()
        } else {
            pattern
                .captures_iter(description)
                .filter(|c| status.is_match(&c[2]))
                .collect()
        };
        let mut sections = Vec::new();
        if clauses.len() < 2 {
            sections.push(item);
        } else {
            let mut context = description.to_owned();
            for clause in &clauses {
                context = context.replacen(&clause[0], "", 1);
            }
            for clause in &clauses {
                let mut part = item.clone();
                let mut routes = Vec::new();
                for m in route.find_iter(&clause[1]) {
                    if !routes.contains(&m.as_str()) {
                        routes.push(m.as_str());
                    }
                }
                part["id"] = json!(format!("{id}:{}", routes.join(",")));
                part["title"] = json!(clause[0].trim());
                part["description"] =
                    json!(format!("{} {}", clause[0].trim(), context.trim()).trim());
                part["routes"] = json!(routes);
                sections.push(part);
            }
        }
        for mut section in sections {
            let body = section["description"].as_str().unwrap_or("");
            if restore.is_match(body) && !active.is_match(body) {
                section["reason"] = json!("restoration");
            }
            alerts.push(section);
        }
    }
    Ok(json!({"alerts":alerts,"partial":false}))
}
pub fn components(payload: Value) -> Result<Value, io::Error> {
    fn body(node: &Value, parts: &mut Vec<String>) {
        if let Some(s) = node["text"].as_str() {
            parts.push(s.to_owned());
        }
        if let Some(children) = node[":items"].as_object() {
            for child in children.values() {
                body(child, parts);
            }
        }
    }
    fn walk(node: &Value, alerts: &mut Vec<Value>) -> Result<(), io::Error> {
        if !node.is_object() {
            return Err(invalid());
        }
        if let Some(label) = node["accordionLabel"].as_str() {
            let id = text(node, "id")?;
            let children = node[":items"].as_object().ok_or_else(invalid)?;
            let mut parts = Vec::new();
            for child in children.values() {
                body(child, &mut parts);
            }
            let description = super::strip_html::strip_html(&parts.join(" "));
            let title = super::strip_html::strip_html(
                parts
                    .first()
                    .and_then(|p| p.split("</p>").next())
                    .unwrap_or(""),
            );
            let label = super::strip_html::strip_html(label);
            if description.is_empty() || title.is_empty() || label.is_empty() {
                return Err(invalid());
            }
            let mut item =
                json!({"id":id,"title":title,"description":description,"effect":"UNKNOWN_EFFECT"});
            if label != "All Stations" {
                item["stopName"] = json!(label);
                item["stopScoped"] = json!(true);
            }
            alerts.push(item);
        } else if let Some(children) = node[":items"].as_object() {
            for child in children.values() {
                walk(child, alerts)?;
            }
        }
        Ok(())
    }
    let mut alerts = Vec::new();
    walk(&payload, &mut alerts)?;
    if alerts.is_empty() {
        return Err(invalid());
    }
    Ok(json!({"alerts":alerts,"partial":false}))
}

pub fn fragments(payload: Value) -> Result<Value, io::Error> {
    let entities = payload["entities"].as_array().ok_or_else(invalid)?;
    let paging = &payload["properties"]["srn:paging"];
    let total = paging["total"].as_u64().ok_or_else(invalid)?;
    let offset = paging["offset"].as_u64().ok_or_else(invalid)?;
    let mut alerts = Vec::new();
    for entity in entities {
        let p = &entity["properties"];
        let id = text(p, "name")?;
        let title = super::strip_html::strip_html(text(&p["elements"]["title"], "value")?);
        let description =
            super::strip_html::strip_html(text(&p["elements"]["description"], "value")?);
        if title.is_empty() || description.is_empty() {
            return Err(invalid());
        }
        if p["publicationStatus"].as_str().is_some_and(|v| {
            matches!(
                v.to_lowercase().as_str(),
                "deactivate" | "deactivated" | "unpublish" | "unpublished" | "not_published"
            )
        }) {
            continue;
        }
        alerts.push(
            json!({"id":id,"title":title,"description":description,"effect":"UNKNOWN_EFFECT"}),
        );
    }
    Ok(json!({"alerts":alerts,"partial":offset!=0 || total!=entities.len() as u64}))
}
