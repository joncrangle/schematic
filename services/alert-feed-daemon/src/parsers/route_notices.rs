//! Reads a notice index grouped under `service-region` headings.
//! Twin of `routeNoticeIndexParser.ts`.
use crate::agencies::ScrapeOutcome;
use bytes::Bytes;
use scraper::{ElementRef, Html, Node};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    io,
};

const EMPTY_REGION: &str = "no service notices at this time";

enum Item<'a> {
    Text(String),
    Element(ElementRef<'a>),
}

struct Region<'a> {
    heading: String,
    nodes: Vec<Item<'a>>,
}

struct Notice {
    code: String,
    title: String,
    routes: Vec<String>,
    route_ids: BTreeSet<String>,
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn item_text(item: &Item<'_>) -> String {
    match item {
        Item::Text(text) => text.clone(),
        Item::Element(element) => element.text().collect(),
    }
}

fn walk<'a>(node: ElementRef<'a>, regions: &mut Vec<Region<'a>>) {
    for child in node.children() {
        if let Some(element) = ElementRef::wrap(child) {
            let name = element.value().name();
            if matches!(name, "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
                if element
                    .value()
                    .classes()
                    .any(|class| class == "service-region")
                {
                    regions.push(Region {
                        heading: collapse(&element.text().collect::<String>()),
                        nodes: Vec::new(),
                    });
                } else if !regions.is_empty() {
                    // Any other heading closes the current region.
                    regions.push(Region {
                        heading: String::new(),
                        nodes: Vec::new(),
                    });
                }
                continue;
            }
        }
        let open = regions
            .last()
            .is_some_and(|region| !region.heading.is_empty());
        match (ElementRef::wrap(child), child.value()) {
            (Some(element), _) if open && element.value().name() == "a" => {
                regions
                    .last_mut()
                    .unwrap()
                    .nodes
                    .push(Item::Element(element));
            }
            (Some(element), _) if open && element.value().name() == "hr" => {}
            (Some(element), _) => walk(element, regions),
            (None, Node::Text(text)) if open => {
                regions
                    .last_mut()
                    .unwrap()
                    .nodes
                    .push(Item::Text(text.to_string()));
            }
            (None, _) => {}
        }
    }
}

fn notice_link<'a>(item: &Item<'a>) -> Option<ElementRef<'a>> {
    match item {
        Item::Element(element)
            if element
                .value()
                .attr("href")
                .is_some_and(|href| href.contains("serviceNoticeCode=")) =>
        {
            Some(*element)
        }
        _ => None,
    }
}

/// Returns the notices and whether an unmapped route code withheld any of them.
pub fn decode(
    html: &str,
    source: &str,
    route_names: &BTreeMap<String, Vec<String>>,
) -> Result<(Value, bool), io::Error> {
    let document = Html::parse_document(html);
    let mut regions = Vec::new();
    walk(document.root_element(), &mut regions);
    regions.retain(|region| !region.heading.is_empty());
    if regions.is_empty() {
        return Err(io::Error::other("Missing service notice regions"));
    }
    let base = reqwest::Url::parse(source).map_err(io::Error::other)?;
    let mut notices: Vec<Notice> = Vec::new();
    let mut partial = false;
    for region in &regions {
        let links: Vec<_> = region.nodes.iter().filter_map(notice_link).collect();
        if links.is_empty() {
            let text = collapse(
                &region
                    .nodes
                    .iter()
                    .map(item_text)
                    .collect::<Vec<_>>()
                    .join(" "),
            )
            .to_lowercase();
            if text != EMPTY_REGION {
                return Err(io::Error::other(format!(
                    "Unrecognized service notice region: {}",
                    region.heading
                )));
            }
            continue;
        }
        for link in links {
            let href = link.value().attr("href").unwrap_or_default();
            let url = base.join(href).map_err(io::Error::other)?;
            let param = |name: &str| {
                url.query_pairs()
                    .find(|(key, _)| key == name)
                    .map(|(_, value)| value.trim().to_owned())
                    .filter(|value| !value.is_empty())
            };
            let (Some(code), Some(route_code)) =
                (param("serviceNoticeCode"), param("subscriptionRoute"))
            else {
                return Err(io::Error::other(format!(
                    "Service notice link lacks its codes: {href}"
                )));
            };
            let text: String = link.text().collect();
            let mut parts = text.split("\u{a0}-\u{a0}");
            let title = collapse(parts.next().unwrap_or_default());
            let route_name = collapse(&parts.collect::<Vec<_>>().join(" - "));
            if title.is_empty() {
                return Err(io::Error::other(format!(
                    "Service notice {code} has no title"
                )));
            }
            let route_ids: Vec<_> = route_names
                .iter()
                .filter(|(_, aliases)| aliases.contains(&route_code))
                .map(|(route_id, _)| route_id.clone())
                .collect();
            if route_ids.is_empty() {
                partial = true;
                continue;
            }
            let index = match notices.iter().position(|notice| notice.code == code) {
                Some(index) => index,
                None => {
                    notices.push(Notice {
                        code: code.clone(),
                        title,
                        routes: Vec::new(),
                        route_ids: BTreeSet::new(),
                    });
                    notices.len() - 1
                }
            };
            let notice = &mut notices[index];
            if !route_name.is_empty() && !notice.routes.contains(&route_name) {
                notice.routes.push(route_name);
            }
            notice.route_ids.extend(route_ids);
        }
    }
    let alerts: Vec<Value> = notices
        .into_iter()
        .map(|notice| {
            let mut link = base.clone();
            link.set_query(None);
            link.set_fragment(None);
            link.query_pairs_mut()
                .append_pair("serviceNoticeCode", &notice.code);
            let mut description = notice.routes;
            description.push(format!("[Service notice]({link})"));
            json!({
                "id": link.as_str(),
                "title": notice.title,
                "description": description.join("\n"),
                "routes": notice.route_ids,
                "start_time": "1970-01-01T00:00:00Z"
            })
        })
        .collect();
    Ok((json!(alerts), partial))
}

pub async fn scrape(
    client: &crate::upstream::Client,
    url: &str,
    route_names: &BTreeMap<String, Vec<String>>,
) -> Result<ScrapeOutcome, Box<dyn Error + Send + Sync>> {
    let html = client
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let (document, partial) =
        decode(&html, url, route_names).map_err(|_| crate::upstream::Failure::Decode)?;
    Ok(ScrapeOutcome {
        bytes: Bytes::from(serde_json::to_vec(&document)?),
        partial,
        content_type: "application/json",
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    #[test]
    fn test_matches_the_shared_route_notice_contract() {
        let contract: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/route-notice-index/contract.json"
        ))
        .unwrap();
        for entry in contract["cases"].as_array().unwrap() {
            let route_names =
                serde_json::from_value(entry.get("routeNames").cloned().unwrap_or(json!({})))
                    .unwrap();
            let result = super::decode(
                entry["html"].as_str().unwrap(),
                "https://example.test/notices",
                &route_names,
            );
            if entry["error"] == true {
                assert!(result.is_err(), "{}", entry["name"]);
                continue;
            }
            let (alerts, partial) = result.unwrap();
            let expected: Vec<_> = entry["notices"]
                .as_array()
                .unwrap()
                .iter()
                .map(|notice| {
                    json!({
                        "id": notice["url"],
                        "title": notice["title"],
                        "description": notice["description"],
                        "routes": notice["routeIds"],
                        "start_time": "1970-01-01T00:00:00Z"
                    })
                })
                .collect();
            assert_eq!(alerts, json!(expected), "{}", entry["name"]);
            assert_eq!(partial, entry["partial"] == true, "{}", entry["name"]);
        }
    }
}
