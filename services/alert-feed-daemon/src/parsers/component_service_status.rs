use super::strip_html::strip_html;
use scraper::{Html, Selector};
use serde_json::{Value, json};
use std::io;
fn plain(html: &str) -> String {
    strip_html(html)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn invalid() -> io::Error {
    io::Error::other("Unrecognized service status component")
}
fn is_normal(text: &str) -> bool {
    [
        "normal métro service",
        "service normal du métro",
        "all elevators are in service",
        "tous les ascenseurs sont en service",
        "normal elevator service",
        "service normal des ascenseurs",
    ]
    .contains(
        &text
            .strip_suffix('.')
            .unwrap_or(text)
            .to_lowercase()
            .as_str(),
    )
}

pub fn decode(html: &str, routes: &Value, stops: &Value) -> Result<Option<Value>, io::Error> {
    let doc = Html::parse_document(html);
    let boards = Selector::parse("[id$='-service-status-content']").unwrap();
    let rows = Selector::parse("li").unwrap();
    let paragraphs = Selector::parse("p").unwrap();
    let images = Selector::parse("img[alt]").unwrap();
    let mut found = false;
    let mut keys = Vec::new();
    let mut alerts = Vec::new();
    for board in doc.select(&boards) {
        found = true;
        let entries = board.select(&rows).collect::<Vec<_>>();
        if entries.is_empty() {
            if is_normal(&plain(&board.html())) {
                continue;
            }
            return Err(invalid());
        }
        for row in entries {
            let mut ps = Vec::new();
            for p in row.select(&paragraphs) {
                let s = plain(&p.html());
                if !s.is_empty() && !ps.contains(&s) {
                    ps.push(s);
                }
            }
            let full = ps.join("\n");
            if full.is_empty() {
                return Err(invalid());
            }
            if is_normal(&full) {
                continue;
            }
            let labels = row
                .select(&images)
                .filter_map(|i| i.value().attr("alt"))
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase();
            let matching = |map: &Value, text: &str| {
                map.as_object()
                    .into_iter()
                    .flat_map(|m| m.iter())
                    .filter(|(_, ns)| {
                        ns.as_array().is_some_and(|ns| {
                            ns.iter().any(|n| {
                                n.as_str().is_some_and(|n| text.contains(&n.to_lowercase()))
                            })
                        })
                    })
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>()
            };
            let route_ids = matching(routes, &labels);
            let stop_ids = matching(stops, &full.to_lowercase());
            if route_ids.is_empty() && stop_ids.is_empty() {
                return Err(invalid());
            }
            if keys.contains(&full) {
                continue;
            }
            keys.push(full.clone());
            let mut alert = json!({"title":ps[0],"description":if ps.len()>1 {ps[1..].join("\n")} else {ps[0].clone()},"routes":route_ids,"stops":stop_ids});
            if full
                .split(|c: char| !c.is_alphanumeric())
                .any(|w| w.eq_ignore_ascii_case("elevator") || w.eq_ignore_ascii_case("ascenseur"))
            {
                alert["effect"] = json!("ACCESSIBILITY_ISSUE");
            }
            alerts.push(alert);
        }
    }
    Ok(found.then_some(json!(alerts)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_shared_contract() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/realtime/component-status.contract.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let result = decode(
                case["html"].as_str().unwrap(),
                &case["routes"],
                &case["stops"],
            );
            if case["invalid"] == true {
                assert!(result.is_err(), "{}", case["name"]);
            } else {
                assert_eq!(
                    result.unwrap().unwrap(),
                    case["expected"],
                    "{}",
                    case["name"]
                );
            }
        }
    }
}
