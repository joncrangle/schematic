use chrono::{Datelike, NaiveDate, TimeZone};
use chrono_tz::Tz;
use scraper::{ElementRef, Html, Selector};
use serde_json::{Value, json};
use std::{collections::VecDeque, error::Error, io};
fn sel(s: &str) -> Selector {
    Selector::parse(s).unwrap()
}
fn rx(s: &str) -> regex::Regex {
    regex::Regex::new(s).unwrap()
}
fn plain(node: ElementRef<'_>) -> String {
    super::strip_html::strip_html(&node.html())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn invalid() -> io::Error {
    io::Error::other("Incomplete municipal news")
}
fn date_of(text: &str, zone: &Tz) -> Result<i64, io::Error> {
    let iso = rx(r"(?:^|/)(20\d\d-\d\d-\d\d)(?:/|$)");
    let date = if let Some(c) = iso.captures(text) {
        NaiveDate::parse_from_str(&c[1], "%Y-%m-%d").map_err(|_| invalid())?
    } else {
        let re = rx(r"\b(\d{1,2})\s+(\p{L}+)\s+(20\d{2})\b");
        let c = re.captures(text).ok_or_else(invalid)?;
        let months = [
            "janvier",
            "février",
            "mars",
            "avril",
            "mai",
            "juin",
            "juillet",
            "août",
            "septembre",
            "octobre",
            "novembre",
            "décembre",
        ];
        let month = months
            .iter()
            .position(|m| *m == c[2].to_lowercase())
            .ok_or_else(invalid)?;
        NaiveDate::from_ymd_opt(
            c[3].parse().map_err(|_| invalid())?,
            month as u32 + 1,
            c[1].parse().map_err(|_| invalid())?,
        )
        .ok_or_else(invalid)?
    };
    zone.from_local_datetime(&date.and_hms_opt(0, 0, 0).ok_or_else(invalid)?)
        .single()
        .map(|d| d.timestamp_millis())
        .ok_or_else(invalid)
}
fn published_end(title: &str, published: i64, zone: &Tz) -> Result<Option<i64>, io::Error> {
    let months = [
        "janvier",
        "février",
        "mars",
        "avril",
        "mai",
        "juin",
        "juillet",
        "août",
        "septembre",
        "octobre",
        "novembre",
        "décembre",
    ];
    let names = months.join("|");
    let pattern = rx(&format!(
        r"(?i)\bdu\s+(\d{{1,2}})(?:\s+({names}))?\s+au\s+(\d{{1,2}})\s+({names})(?:\s+(20\d{{2}}))?"
    ));
    let Some(range) = pattern.captures(title) else {
        return Ok(None);
    };
    let year = range
        .get(5)
        .map(|m| m.as_str().parse::<i32>())
        .transpose()
        .map_err(|_| invalid())?
        .unwrap_or(
            zone.timestamp_millis_opt(published)
                .single()
                .ok_or_else(invalid)?
                .year(),
        );
    let month = months
        .iter()
        .position(|m| *m == range[4].to_lowercase())
        .ok_or_else(invalid)? as u32
        + 1;
    let day = NaiveDate::from_ymd_opt(year, month, range[3].parse().map_err(|_| invalid())?)
        .ok_or_else(invalid)?
        .succ_opt()
        .ok_or_else(invalid)?;
    zone.from_local_datetime(&day.and_hms_opt(0, 0, 0).ok_or_else(invalid)?)
        .single()
        .map(|d| Some(d.timestamp_millis()))
        .ok_or_else(invalid)
}
pub struct Page {
    pub alerts: Vec<Value>,
    pub urls: Vec<String>,
}
pub fn decode(html: &str, source: &str, now: i64, zone: &Tz) -> Result<Option<Page>, io::Error> {
    let doc = Html::parse_document(html);
    let mut page = Page {
        alerts: Vec::new(),
        urls: Vec::new(),
    };
    let news_detail = doc
        .select(&sel(".page-top-no-image__title--news"))
        .next()
        .is_some();
    let body = doc.select(&sel(".CommuniquesWrap")).next().or_else(|| {
        if news_detail {
            doc.select(&sel(".main__dynamic")).next()
        } else {
            None
        }
    });
    if let Some(body) = body {
        let title = doc.select(&sel("h1")).next_back().ok_or_else(invalid)?;
        if plain(title).is_empty() || plain(body).is_empty() {
            return Err(invalid());
        }
        let url = reqwest::Url::parse(source).map_err(|_| invalid())?;
        let date = if source.contains("/communiques/") {
            url.path().to_string()
        } else {
            plain(
                doc.select(&sel(".page-top-no-image__metas"))
                    .next()
                    .unwrap_or(body),
            )
        };
        let start = date_of(&date, zone)?;
        let description = super::heading_notices::notice_text(body, source)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let transit =
            rx(r"(?i)autobus|transport en commun|transport collectif|minibus|circuits?\s+\d");
        let disruption = rx(
            "(?i)retards?|annul|suspend|d[ée]tour|d[ée]plac|non desserv|ferm[ée]|r[ée]percussions|impacts?|perturb|r[ée]duit|all[ée]g[ée]",
        );
        if !body
            .select(&sel("p,li"))
            .map(plain)
            .any(|p| transit.is_match(&p) && disruption.is_match(&p))
        {
            return Ok(Some(page));
        }
        let end = published_end(&plain(title), start, zone)?;
        if end.is_some_and(|e| e <= now) {
            return Ok(Some(page));
        }
        let reopened = body.select(&sel("p")).take(2).map(plain).any(|p| {
            rx("(?i)^Toutes les rues sont maintenant ouvertes à la circulation[.!]?$").is_match(&p)
        });
        if reopened {
            return Ok(Some(page));
        }
        let mut alert = json!({"id":source,"title":plain(title),"description":description,"startsAt":start,"routeIds":[],"updatedAt":now});
        if let Some(end) = end {
            alert["endsAt"] = json!(end);
        }
        page.alerts.push(alert);
        return Ok(Some(page));
    }
    let cards: Vec<_> = doc.select(&sel(".d-flex-comm,.news-list__item")).collect();
    if cards.is_empty() {
        return Ok(None);
    }
    let origin = reqwest::Url::parse(source).map_err(|_| invalid())?;
    let candidates = rx(
        "(?i)autobus|transport|circuits?|d[ée]tours?|travaux|circulation|fermeture|incident|cong[ée]|f[ée]ri[ée]|temp[êe]te|verglas",
    );
    for card in cards {
        let title = card
            .select(&sel("h5,.news-list__title"))
            .next()
            .ok_or_else(invalid)?;
        let date = card
            .select(&sel(".comm-date,.news-list__metas"))
            .next()
            .ok_or_else(invalid)?;
        let link = card.select(&sel("a.news-list__link")).next();
        let onclick = card.value().attr("onclick").unwrap_or("");
        let href = link
            .and_then(|l| l.value().attr("href"))
            .map(str::to_string)
            .or_else(|| {
                rx(r"^document\.location='([^']+)'$")
                    .captures(onclick)
                    .map(|c| c[1].to_string())
            })
            .ok_or_else(invalid)?;
        if plain(title).is_empty() {
            return Err(invalid());
        }
        date_of(&plain(date), zone)?;
        if !candidates.is_match(&plain(card)) {
            continue;
        }
        let url = origin.join(&href).map_err(|_| invalid())?;
        if url.origin() != origin.origin() {
            return Err(invalid());
        }
        if !page.urls.contains(&url.to_string()) {
            page.urls.push(url.to_string());
        }
    }
    let controls: Vec<_> = doc
        .select(&sel("a[href]"))
        .filter_map(|a| a.value().attr("href"))
        .filter_map(|a| {
            rx(r"^javascript:fChangeComm\('[^']+','(\d{4})','(\d{1,2})'\)$")
                .captures(a)
                .map(|c| (c[1].to_string(), c[2].to_string()))
        })
        .collect();
    if !controls.is_empty() {
        let re = rx(r"\.load\('([^']+)\?y='");
        let path = re.captures(html).ok_or_else(invalid)?;
        for (year, month) in controls {
            let month: u32 = month.parse().map_err(|_| invalid())?;
            if !(1..=12).contains(&month) {
                return Err(invalid());
            }
            let url = origin
                .join(&format!("{}?y={}&m={}", &path[1], year, month))
                .map_err(|_| invalid())?
                .to_string();
            if !page.urls.contains(&url) {
                page.urls.push(url);
            }
        }
    }
    Ok(Some(page))
}

pub async fn scrape(
    client: &crate::upstream::Client,
    html: &str,
    source: &str,
    now: i64,
    zone: &Tz,
) -> Result<crate::agencies::ScrapeOutcome, Box<dyn Error + Send + Sync>> {
    let first = decode(html, source, now, zone)?.ok_or_else(invalid)?;
    let mut alerts = first.alerts;
    let mut queue: VecDeque<_> = first.urls.into();
    let mut visited = vec![source.to_string()];
    let mut partial = false;
    const MAX_PAGES: usize = 512;
    while !queue.is_empty() {
        let mut requests = tokio::task::JoinSet::new();
        let mut index = 0;
        while requests.len() < 4
            && let Some(url) = queue.pop_front()
        {
            if visited.contains(&url) {
                continue;
            }
            if visited.len() == MAX_PAGES {
                partial = true;
                queue.clear();
                break;
            }
            visited.push(url.clone());
            let client = client.clone();
            let zone = *zone;
            requests.spawn(async move {
                let result = async {
                    let html = client
                        .get(&url)
                        .send()
                        .await?
                        .error_for_status()?
                        .text()
                        .await?;
                    decode(&html, &url, now, &zone)?
                        .ok_or_else(invalid)
                        .map_err(|e| Box::new(e) as Box<dyn Error + Send + Sync>)
                }
                .await;
                (index, result)
            });
            index += 1;
        }
        let mut pages = Vec::new();
        while let Some(result) = requests.join_next().await {
            match result {
                Ok(page) => pages.push(page),
                Err(_) => partial = true,
            }
        }
        pages.sort_by_key(|(index, _)| *index);
        for (_, result) in pages {
            match result {
                Ok(page) => {
                    alerts.extend(page.alerts);
                    queue.extend(page.urls);
                }
                Err(_) => partial = true,
            }
        }
    }
    Ok(crate::agencies::ScrapeOutcome {
        bytes: bytes::Bytes::from(serde_json::to_vec(
            &json!({"header":{"version":"municipal-news","timestamp":now},"tripUpdates":[],"vehiclePositions":[],"alerts":alerts}),
        )?),
        partial,
        content_type: "application/json",
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn shared_contract() {
        let contract: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/municipal-news/contract.json"
        ))
        .unwrap();
        let now = contract["now"].as_i64().unwrap();
        let zone = contract["timeZone"].as_str().unwrap().parse().unwrap();
        for case in contract["cases"].as_array().unwrap() {
            let result = super::decode(
                case["html"].as_str().unwrap(),
                case["source"].as_str().unwrap(),
                now,
                &zone,
            );
            if case["error"] == true {
                assert!(result.is_err(), "{}", case["name"]);
            } else {
                let page = result.unwrap().unwrap();
                assert_eq!(
                    serde_json::json!(page.urls),
                    case["pageUrls"],
                    "{}",
                    case["name"]
                );
                assert_eq!(
                    serde_json::json!(page.alerts),
                    case["alerts"],
                    "{}",
                    case["name"]
                );
            }
        }
    }
}
