//! Twin of headingServiceNoticesParser.ts. Published sections have no inferred dates or scope.
use super::strip_html::strip_html;
use crate::agencies::ScrapeOutcome;
use bytes::Bytes;
use chrono::Datelike;
use scraper::{ElementRef, Html, Node, Selector};
use serde_json::{Value, json};
use std::{error::Error, io, sync::LazyLock};

static CLEAR_STATEMENT: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)^there are no (.+?) service changes planned at this time(?:[.!](?:\s|$)|$)",
    )
    .unwrap()
});

/// Only a declared whole-service name clears, so scoped claims never read as all-clear.
fn explicitly_clear(text: &str, clear_statement_names: &[String]) -> bool {
    CLEAR_STATEMENT
        .captures(text)
        .and_then(|captures| captures.get(1))
        .is_some_and(|qualifier| {
            let qualifier = qualifier.as_str().to_lowercase();
            clear_statement_names
                .iter()
                .any(|name| name.to_lowercase() == qualifier)
        })
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationReference {
    pub publication_year: i32,
    pub valid_from: String,
    pub valid_through: String,
}

/// Source-declared facts the page itself cannot establish.
#[derive(Clone, Copy, Default)]
pub struct SourceDeclarations<'a> {
    pub publication_reference: Option<&'a PublicationReference>,
    pub clear_statement_names: &'a [String],
}

/// Route headings establish scope independently of alternatives in their body.
fn route_heading_articles(
    html: &str,
    source: &str,
    route_names: &std::collections::BTreeMap<String, Vec<String>>,
) -> Result<Option<Value>, io::Error> {
    let document = Html::parse_document(html);
    let articles = Selector::parse("article").unwrap();
    let headings = Selector::parse("h1,h2,h3,h4,h5,h6").unwrap();
    let pattern = regex::Regex::new(r"(?i)^(?:Ligne|Route)\s*#\s*[\p{L}\d+-]+$").unwrap();
    fn body(node: ElementRef<'_>, source: &str) -> String {
        let tag = node.value().name();
        if matches!(tag, "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
            return String::new();
        }
        if matches!(tag, "script" | "style" | "br") {
            return " ".into();
        }
        if tag == "a" {
            return notice_text(node, source);
        }
        let mut text = String::new();
        for child in node.children() {
            if let Some(element) = ElementRef::wrap(child) {
                text.push_str(&body(element, source));
            } else if let Node::Text(value) = child.value() {
                text.push_str(value);
            }
        }
        if matches!(tag, "article" | "div" | "p" | "li" | "section") {
            text.push(' ');
        }
        text
    }
    let mut alerts = Vec::new();
    let mut unrecognized_article = false;
    for article in document.select(&articles) {
        if article
            .ancestors()
            .filter_map(ElementRef::wrap)
            .any(|node| matches!(node.value().name(), "nav" | "footer" | "aside"))
        {
            continue;
        }
        if article.select(&articles).next().is_some() {
            continue;
        }
        let titles: Vec<_> = article.select(&headings).collect();
        if titles.len() != 1 {
            unrecognized_article = true;
            continue;
        }
        let title = strip_html(&titles[0].html()).trim().to_string();
        if !pattern.is_match(&title) {
            unrecognized_article = true;
            continue;
        }
        let routes: Vec<_> = route_names
            .iter()
            .filter(|(_, names)| {
                names
                    .iter()
                    .any(|name| name.to_lowercase() == title.to_lowercase())
            })
            .map(|(id, _)| id.clone())
            .collect();
        if routes.is_empty() {
            return Err(io::Error::other("Unmapped route article heading"));
        }
        let description = body(article, source)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if description.is_empty() {
            return Err(io::Error::other("Route article has no body"));
        }
        alerts.push(json!({"id": format!("{source}#{title}"), "title":title, "description":description, "routes":routes, "start_time":"1970-01-01T00:00:00Z"}));
    }
    if !alerts.is_empty() && unrecognized_article {
        return Err(io::Error::other("Incomplete route article board"));
    }
    Ok(if alerts.is_empty() {
        None
    } else {
        Some(json!(alerts))
    })
}

fn has_notice_text(text: &str) -> bool {
    let text = text.to_lowercase();
    let words: Vec<_> = text
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let normalized = format!(" {} ", words.join(" "));
    [
        "detour",
        "closure",
        "outage",
        "outages",
        "temporarily closed",
        "service alert",
        "service alerts",
        "not be running",
        "service disruption",
        "affected services",
        "service change",
        "service changes",
        "schedule change",
        "schedule changes",
        "schedule adjustment",
        "schedule adjustments",
        "route adjustment",
        "route adjustments",
        "route status",
        "not in service",
        "not operating",
        "combined with",
        "combined into",
    ]
    .iter()
    .any(|phrase| normalized.contains(&format!(" {phrase} ")))
}

pub(super) fn notice_text(element: ElementRef<'_>, source: &str) -> String {
    match element.value().name() {
        "script" | "style" | "br" => return " ".into(),
        "a" => {
            let label = strip_html(&element.html()).replace(['[', ']'], "");
            if let Some(url) = element
                .value()
                .attr("href")
                .filter(|href| !href.is_empty())
                .and_then(|href| reqwest::Url::parse(source).ok()?.join(href).ok())
                .filter(|url| matches!(url.scheme(), "http" | "https"))
            {
                return format!(
                    "[{label}]({})",
                    url.as_str().replace('(', "%28").replace(')', "%29")
                );
            }
            return label;
        }
        _ => {}
    }
    let mut text = String::new();
    for child in element.children() {
        if let Some(child_element) = ElementRef::wrap(child) {
            text.push_str(&notice_text(child_element, source));
        } else if let Node::Text(value) = child.value() {
            text.push_str(value);
        }
    }
    if matches!(element.value().name(), "th" | "td" | "li" | "p") {
        text.push(' ');
    }
    text
}

pub(super) fn has_whole_token(text: &str, token: &str) -> bool {
    let text = text.to_lowercase();
    let token = token.to_lowercase();
    text.match_indices(&token).any(|(at, _)| {
        !text[..at]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_alphanumeric())
            && !text[at + token.len()..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric())
    })
}

pub fn decode(
    html: &str,
    source: &str,
    route_names: &std::collections::BTreeMap<String, Vec<String>>,
    stop_names: &std::collections::BTreeMap<String, Vec<String>>,
    time_zone: &chrono_tz::Tz,
) -> Result<Value, io::Error> {
    decode_with_reference(
        html,
        source,
        route_names,
        stop_names,
        time_zone,
        SourceDeclarations::default(),
    )
}

pub fn decode_with_reference(
    html: &str,
    source: &str,
    route_names: &std::collections::BTreeMap<String, Vec<String>>,
    stop_names: &std::collections::BTreeMap<String, Vec<String>>,
    time_zone: &chrono_tz::Tz,
    declarations: SourceDeclarations<'_>,
) -> Result<Value, io::Error> {
    decode_at(
        html,
        source,
        route_names,
        stop_names,
        time_zone,
        chrono::Utc::now().timestamp_millis(),
        declarations,
    )
}

fn featured_urls(html: &str, source: &str) -> Result<Option<Vec<String>>, io::Error> {
    let document = Html::parse_document(html);
    let selector = Selector::parse(".featured-update-card").unwrap();
    let cards: Vec<_> = document.select(&selector).collect();
    if cards.is_empty() {
        return Ok(None);
    }
    let mut urls = Vec::new();
    for card in cards {
        let get = |selector: &str| card.select(&Selector::parse(selector).unwrap()).next();
        let title =
            get(".field--name-title").ok_or_else(|| io::Error::other("Missing featured title"))?;
        let caption =
            get(".text-caption").ok_or_else(|| io::Error::other("Missing featured caption"))?;
        let link = get("a[href]").ok_or_else(|| io::Error::other("Missing featured link"))?;
        if strip_html(&title.html()).trim().is_empty() {
            return Err(io::Error::other("Missing featured title"));
        }
        let status = card
            .select(&Selector::parse("span,div").unwrap())
            .map(|n| strip_html(&n.html()).trim().to_string())
            .collect::<Vec<_>>();
        if status.iter().any(|s| s == "Complete") && strip_html(&caption.html()).contains("Ended:")
        {
            continue;
        }
        if !status
            .iter()
            .any(|s| ["active", "in progress", "upcoming"].contains(&s.to_lowercase().as_str()))
        {
            return Err(io::Error::other("Unknown featured status"));
        }
        let base = reqwest::Url::parse(source).map_err(io::Error::other)?;
        let url = base
            .join(link.value().attr("href").unwrap())
            .map_err(io::Error::other)?;
        if base.origin() != url.origin() {
            return Err(io::Error::other("Foreign featured update"));
        }
        let url = url.to_string();
        if !urls.contains(&url) {
            urls.push(url);
        }
    }
    Ok(Some(urls))
}
fn featured_body(
    html: &str,
    source: &str,
    route_names: &std::collections::BTreeMap<String, Vec<String>>,
    stop_names: &std::collections::BTreeMap<String, Vec<String>>,
    time_zone: &chrono_tz::Tz,
    now_ms: i64,
    declarations: SourceDeclarations<'_>,
) -> Result<Value, io::Error> {
    match decode_body_at(
        html,
        source,
        route_names,
        stop_names,
        time_zone,
        now_ms,
        declarations,
    ) {
        Ok(v) => Ok(v),
        Err(e) if e.to_string() == "No recognizable service notices; recovery is unconfirmed" => {
            Ok(json!([]))
        }
        Err(e) => Err(e),
    }
}

fn decode_at(
    html: &str,
    source: &str,
    route_names: &std::collections::BTreeMap<String, Vec<String>>,
    stop_names: &std::collections::BTreeMap<String, Vec<String>>,
    time_zone: &chrono_tz::Tz,
    now_ms: i64,
    declarations: SourceDeclarations<'_>,
) -> Result<Value, io::Error> {
    if let Some(urls) = featured_urls(html, source)? {
        if !urls.is_empty() {
            return Err(io::Error::other("Service updates require detail pages"));
        }
        return featured_body(
            html,
            source,
            route_names,
            stop_names,
            time_zone,
            now_ms,
            declarations,
        );
    }
    decode_body_at(
        html,
        source,
        route_names,
        stop_names,
        time_zone,
        now_ms,
        declarations,
    )
}
fn decode_body_at(
    html: &str,
    source: &str,
    route_names: &std::collections::BTreeMap<String, Vec<String>>,
    stop_names: &std::collections::BTreeMap<String, Vec<String>>,
    time_zone: &chrono_tz::Tz,
    now_ms: i64,
    declarations: SourceDeclarations<'_>,
) -> Result<Value, io::Error> {
    if let Some(page) = super::municipal_news::decode(html, source, now_ms, time_zone)? {
        return Ok(Value::Array(page.alerts));
    }
    if let Some(detail) = super::linked_service_notices::decode_detail(
        html,
        source,
        time_zone,
        route_names,
        stop_names,
    )? {
        return Ok(detail);
    }
    if let Some(board) = super::embedded_service_notices::decode(
        html,
        source,
        route_names,
        time_zone,
        now_ms,
        declarations.publication_reference,
    )? {
        return Ok(board);
    }
    if let Some(articles) = route_heading_articles(html, source, route_names)? {
        return Ok(articles);
    }
    let SourceDeclarations {
        publication_reference,
        clear_statement_names,
    } = declarations;
    if let Some(board) = transit_notice_board(html, source, route_names, time_zone)? {
        return Ok(board);
    }
    if let Some(status) = super::component_service_status::decode(
        html,
        &serde_json::to_value(route_names)?,
        &serde_json::to_value(stop_names)?,
    )? {
        return Ok(status);
    }
    let disclosure = match disclosure_accordion_notices(html)? {
        Some(value) => Some(value),
        None => accordion_group_notices(html)?,
    };
    let normalized = match disclosure {
        Some(value) if value.is_empty() => return Ok(json!([])),
        Some(value) => Some(value),
        None => match accordion_notices(html)? {
            Some(value) => Some(value),
            None => component_notices(html)?,
        },
    };
    let document = Html::parse_document(normalized.as_deref().unwrap_or(html));
    let main_selector = Selector::parse("main").unwrap();
    let block_selector = Selector::parse("h2, h3, h4, p, li, tr, hr").unwrap();
    let main = document
        .select(&main_selector)
        .next()
        .ok_or_else(|| io::Error::other("Missing main service content"))?;
    if let Some(cards) = decode_update_cards(
        main,
        source,
        route_names,
        stop_names,
        time_zone,
        now_ms,
        publication_reference,
    )? {
        return Ok(cards);
    }
    if let Some(article) = decode_route_list_article(main, source, route_names, time_zone)? {
        return Ok(article);
    }
    if let Some(article) =
        decode_published_article(main, source, route_names, stop_names, time_zone)?
    {
        return Ok(json!([article]));
    }
    struct Section {
        title: String,
        posted_at: Option<i64>,
        listed: bool,
        body: Vec<(String, String, Vec<Value>)>,
    }
    let mut sections: Vec<Section> = Vec::new();
    let mut pending_date: Option<i64> = None;
    let mut separated = false;
    let mut confirmed_clear = false;
    for block in main.select(&block_selector) {
        if block
            .ancestors()
            .filter_map(scraper::ElementRef::wrap)
            .any(|parent| {
                matches!(
                    parent.value().name(),
                    "nav" | "footer" | "aside" | "script" | "style"
                )
            })
        {
            continue;
        }
        let tag = block.value().name();
        if tag == "hr" {
            separated = !sections.last().is_some_and(|section| {
                section
                    .body
                    .iter()
                    .any(|(plain, _, _)| plain.to_lowercase().starts_with("route(s):"))
            });
            pending_date = None;
            continue;
        }
        // A row owns its nested paragraphs, as in the TypeScript tree walk.
        if block
            .ancestors()
            .skip(1)
            .filter_map(ElementRef::wrap)
            .any(|p| matches!(p.value().name(), "tr" | "li" | "p"))
        {
            continue;
        }
        let row_html = block
            .html()
            .replace("</th>", " </th>")
            .replace("</td>", " </td>");
        let text = strip_html(&row_html)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let text = text.strip_prefix("* ").unwrap_or(&text).to_string();
        if tag == "p" && explicitly_clear(&text, clear_statement_names) {
            confirmed_clear = true;
        }
        if text.is_empty() {
            continue;
        }
        let date_parts: Vec<_> = text.split_whitespace().collect();
        let date_shape = date_parts.len() == 3
            && [
                "january",
                "february",
                "march",
                "april",
                "may",
                "june",
                "july",
                "august",
                "september",
                "october",
                "november",
                "december",
            ]
            .contains(&date_parts[0].to_lowercase().as_str())
            && date_parts[1].ends_with(',')
            && (2..=3).contains(&date_parts[1].len())
            && date_parts[1]
                .trim_end_matches(',')
                .chars()
                .all(|c| c.is_ascii_digit())
            && date_parts[2].len() == 4
            && date_parts[2].chars().all(|c| c.is_ascii_digit());
        if tag == "p" && date_shape {
            let date = chrono::NaiveDate::parse_from_str(&text, "%B %d, %Y")
                .map_err(|_| io::Error::other("Invalid notice publication date"))?;
            pending_date = Some(
                date.and_hms_opt(0, 0, 0)
                    .unwrap()
                    .and_utc()
                    .timestamp_millis(),
            );
            continue;
        }
        if matches!(tag, "p" | "li" | "tr") {
            if separated {
                continue;
            }
            if let Some(section) = sections.last_mut() {
                let formatted = notice_text(block, source)
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                let formatted = formatted
                    .strip_prefix("* ")
                    .unwrap_or(&formatted)
                    .to_string();
                section
                    .body
                    .push((text, formatted, closed_stop_targets(block, route_names)));
            }
        } else {
            sections.push(Section {
                title: text,
                posted_at: if tag == "h4" { pending_date } else { None },
                listed: block.value().attr(LISTED_NOTICE).is_some(),
                body: Vec::new(),
            });
            pending_date = None;
            separated = false;
        }
    }
    let mut notices: Vec<Value> = Vec::new();
    let mut targets_by_id: std::collections::BTreeMap<String, Vec<Value>> =
        std::collections::BTreeMap::new();
    for Section {
        title,
        posted_at,
        listed,
        body,
    } in sections
    {
        let notice_start = if posted_at.is_some() || listed || has_notice_text(&title) {
            Some(0)
        } else {
            body.iter().position(|(plain, _, _)| has_notice_text(plain))
        };
        let Some(notice_start) = notice_start else {
            continue;
        };
        let targets: Vec<Value> = body
            .iter()
            .skip(notice_start)
            .flat_map(|(_, _, targets)| targets.clone())
            .collect();
        let body: Vec<_> = body
            .into_iter()
            .skip(notice_start)
            .map(|(_, text, _)| text)
            .collect();
        if body.is_empty() {
            return Err(io::Error::other("Service notice has no body"));
        }
        let mut paragraphs: Vec<String> = Vec::new();
        let identity = format!(
            "{source}#{}{title}",
            posted_at.map(|at| format!("{at}-")).unwrap_or_default()
        );
        let merged_targets = targets_by_id.entry(identity.clone()).or_default();
        merged_targets.extend(targets);
        let targets = merged_targets.clone();
        let existing = notices.iter().position(|notice| notice["id"] == identity);
        if let Some(index) = existing {
            let prior = &notices[index];
            paragraphs.extend(
                prior["description"]
                    .as_str()
                    .unwrap()
                    .split('\n')
                    .map(str::to_string),
            );
        }
        for paragraph in body {
            if !paragraphs.contains(&paragraph) {
                paragraphs.push(paragraph);
            }
        }
        let description = paragraphs.join("\n");
        let labelled = labelled_notice_period(&description, time_zone)?;
        let caption = description.lines().find(|line| {
            let line = line.to_lowercase();
            line.starts_with("route(s):")
                || line.starts_with("routes:")
                || line.starts_with("route:")
        });
        let text = if caption.is_some() {
            caption.unwrap_or(&description).to_lowercase()
        } else {
            format!("{title} {description}").to_lowercase()
        };
        let routes: Vec<_> = route_names
            .iter()
            .filter(|(_, names)| names.iter().any(|name| has_whole_token(&text, name)))
            .map(|(id, _)| id.clone())
            .collect();
        let caption = description
            .lines()
            .find(|line| line.to_lowercase().starts_with("affected stations:"));
        let caption_stations: std::collections::BTreeMap<_, _> = stop_names
            .iter()
            .filter(|(_, names)| {
                names
                    .iter()
                    .any(|name| caption.is_some_and(|text| has_whole_token(text, name)))
            })
            .map(|(id, names)| (id.clone(), names.clone()))
            .collect();
        let affected_description = sentence_parts(&description)
            .into_iter()
            .filter(|paragraph| {
                !has_whole_token(paragraph, "shuttle")
                    || ["closed", "closure", "outage", "out of service"]
                        .iter()
                        .any(|word| has_whole_token(paragraph, word))
            })
            .collect::<Vec<_>>()
            .join(" ");
        let candidates = if caption.is_some() {
            &caption_stations
        } else {
            stop_names
        };
        let stations: Vec<_> = candidates
            .iter()
            .filter(|(_, names)| {
                names.iter().any(|name| {
                    caption.is_some_and(|text| has_whole_token(text, name))
                        || has_whole_token(&title, name)
                        || if name.split_whitespace().any(|word| {
                            word.eq_ignore_ascii_case("station")
                                || word.eq_ignore_ascii_case("terminal")
                        }) {
                            has_whole_token(&affected_description, name)
                        } else {
                            ["Station", "Terminal"].iter().any(|kind| {
                                has_whole_token(&affected_description, &format!("{name} {kind}"))
                            })
                        }
                })
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut notice = json!({"id": identity, "title": title, "description": description, "routes": routes, "start_time": "1970-01-01T00:00:00Z"});
        if let Some(posted_at) = posted_at {
            notice["start_time"] = json!(
                chrono::DateTime::from_timestamp_millis(posted_at)
                    .unwrap()
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            );
        }
        if let Some((start, end)) = labelled {
            notice["start_time"] = json!(
                chrono::DateTime::from_timestamp_millis(start)
                    .unwrap()
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            );
            if let Some(end) = end {
                notice["expires_at"] = json!(
                    chrono::DateTime::from_timestamp_millis(end)
                        .unwrap()
                        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
                );
            }
        }
        if !stop_names.is_empty() || !targets.is_empty() {
            if targets.is_empty() {
                notice["stops"] = json!(stations);
                notice["targets"] = json!(
                    stations
                        .iter()
                        .map(|id| json!({"stopId":id}))
                        .collect::<Vec<_>>()
                );
            } else {
                let mut unique = Vec::new();
                for target in targets {
                    if !unique.contains(&target) {
                        unique.push(target);
                    }
                }
                notice["stops"] = json!([]);
                notice["targets"] = json!(unique);
            }
        }
        if let Some(index) = existing {
            notices[index] = notice;
        } else {
            notices.push(notice);
        }
    }
    let mut expanded = Vec::new();
    let clock_re = regex::Regex::new(r"(?im)^Time: (\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?) (?:to|-) (\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)$").unwrap();
    for notice in notices {
        let description = notice["description"].as_str().unwrap_or("");

        let clocked = clock_re.is_match(description);
        if clocked
            && description
                .lines()
                .any(|line| line.to_lowercase().starts_with("route(s):"))
            && notice["expires_at"].is_string()
        {
            let start =
                chrono::DateTime::parse_from_rfc3339(notice["start_time"].as_str().unwrap())
                    .unwrap()
                    .with_timezone(time_zone);
            let end = chrono::DateTime::parse_from_rfc3339(notice["expires_at"].as_str().unwrap())
                .unwrap()
                .with_timezone(time_zone);
            let mut date = start.date_naive();
            let mut periods = Vec::new();
            while date <= end.date_naive() {
                if periods.len() >= 366 {
                    return Err(io::Error::other("Labelled daily notice exceeds one year"));
                }
                use chrono::TimeZone;
                let mut daily = notice.clone();
                let from = time_zone
                    .from_local_datetime(&date.and_time(start.time()))
                    .single()
                    .ok_or_else(|| io::Error::other("Ambiguous daily service clock"))?;
                let until = time_zone
                    .from_local_datetime(&date.and_time(end.time()))
                    .single()
                    .ok_or_else(|| io::Error::other("Ambiguous daily service clock"))?;
                daily["start_time"] = json!(
                    from.with_timezone(&chrono::Utc)
                        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
                );
                daily["expires_at"] = json!(
                    until
                        .with_timezone(&chrono::Utc)
                        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
                );
                daily["id"] = json!(format!(
                    "{}#{}",
                    notice["id"].as_str().unwrap(),
                    from.timestamp_millis()
                ));
                periods.push(daily);
                date = date.succ_opt().unwrap();
            }
            if periods.len() == 1 {
                periods[0]["id"] = notice["id"].clone();
            }
            expanded.extend(periods);
        } else {
            expanded.push(notice);
        }
    }
    let notices = expanded;
    if notices.is_empty() && !confirmed_clear {
        return Err(io::Error::other(
            "No recognizable service notices; recovery is unconfirmed",
        ));
    }
    Ok(Value::Array(notices))
}

// Extract just the stated date range so surrounding dates cannot change its boundaries.
fn transit_notice_board(
    html: &str,
    source: &str,
    route_names: &std::collections::BTreeMap<String, Vec<String>>,
    time_zone: &chrono_tz::Tz,
) -> Result<Option<Value>, io::Error> {
    let document = Html::parse_document(html);
    let selector = Selector::parse(".paragraph--type--transit-service-notice").unwrap();
    let rows: Vec<_> = document.select(&selector).collect();
    if rows.is_empty() {
        return Ok(None);
    }
    let clock_re = regex::Regex::new(r"(\d{1,2}):(\d{2})\s*$").unwrap();
    let year_re = regex::Regex::new(r"\b(\d{4})\b").unwrap();
    let timestamp = |text: &str| -> Result<i64, io::Error> {
        let clock = clock_re
            .captures(text)
            .ok_or_else(|| io::Error::other("Invalid transit notice service time"))?;
        let year: i32 = year_re
            .captures(text)
            .and_then(|c| c[1].parse().ok())
            .ok_or_else(|| io::Error::other("Invalid transit notice service year"))?;
        let date = crate::util::time::extract_dates(&text[..clock.get(0).unwrap().start()], year)
            .first()
            .copied()
            .ok_or_else(|| io::Error::other("Invalid transit notice service date"))?;
        let hour: u32 = clock[1].parse().unwrap();
        let minute: u32 = clock[2].parse().unwrap();
        if hour > 23 || minute > 59 {
            return Err(io::Error::other("Invalid transit notice service clock"));
        }
        use chrono::TimeZone;
        let date = time_zone
            .from_local_datetime(&date.and_hms_opt(hour, minute, 0).unwrap())
            .single()
            .ok_or_else(|| io::Error::other("Ambiguous service time"))?;
        Ok(date.timestamp_millis())
    };
    let effective_re = regex::Regex::new(r"(?im)(?:^|\n)Date Effective:\s*([^\n]+)").unwrap();
    let departure_re = regex::Regex::new(r"(?i)departing at (.*?) from ").unwrap();
    let arrival_re = regex::Regex::new(r"(?i)arriving at (.*?\d{1,2}:\d{2})\b").unwrap();
    let stop_re = regex::Regex::new(r"\((\d+)\)|@\s*(\d+)").unwrap();
    let mut notices = Vec::new();
    let raw_re = regex::Regex::new(r"(?i)^Routes?:\s*([A-Za-z0-9]+)").unwrap();
    let direction_re =
        regex::Regex::new(r"(?i)\b(Inbound|Outbound|Northbound|Southbound|Eastbound|Westbound)\b")
            .unwrap();
    for row in rows {
        let field = |name: &str| -> Result<String, io::Error> {
            let selector =
                Selector::parse(&format!(".field--name-field-tm-rss-{name} > .field__item"))
                    .unwrap();
            row.select(&selector)
                .next()
                .map(|e| strip_html(&e.html()))
                .filter(|s| !s.is_empty())
                .ok_or_else(|| io::Error::other("Incomplete transit notice field"))
        };
        let title = field("title")?;
        let description = field("description")?;
        let time_selector = Selector::parse("time[datetime]").unwrap();
        let published = row
            .select(&time_selector)
            .next()
            .and_then(|n| n.value().attr("datetime"))
            .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
            .ok_or_else(|| io::Error::other("Incomplete transit notice content"))?;
        let cancelled = title.to_lowercase().contains("trip departing at")
            && description.to_lowercase().contains("is cancelled");
        let effective = effective_re
            .captures(&description)
            .map(|c| c[1].to_string())
            .filter(|s| !s.eq_ignore_ascii_case("Immediate"));
        let departure = if cancelled {
            departure_re
                .captures(&description)
                .map(|c| c[1].to_string())
        } else {
            None
        };
        let arrival = if cancelled {
            arrival_re.captures(&description).map(|c| c[1].to_string())
        } else {
            None
        };
        if cancelled && (departure.is_none() || arrival.is_none()) {
            return Err(io::Error::other(
                "Cancelled trip requires its service window",
            ));
        }
        let start = departure
            .as_ref()
            .or(effective.as_ref())
            .map(|s| timestamp(s))
            .transpose()?
            .unwrap_or(published.timestamp_millis());
        let end = arrival.as_ref().map(|s| timestamp(s)).transpose()?;
        if end.is_some_and(|end| end < start) {
            return Err(io::Error::other("Invalid cancelled trip service window"));
        }
        let trip_caption = title
            .split_whitespace()
            .take(3)
            .collect::<Vec<_>>()
            .join(" ");
        let caption = description
            .lines()
            .find(|s| s.starts_with("Routes:") || s.starts_with("Route:"))
            .unwrap_or(if cancelled { &trip_caption } else { &title });
        let mut routes: Vec<_> = route_names
            .iter()
            .filter(|(_, names)| names.iter().any(|name| has_whole_token(caption, name)))
            .map(|(id, _)| id.clone())
            .collect();
        if routes.is_empty()
            && let Some(raw) = raw_re.captures(caption)
        {
            routes.push(raw[1].to_string());
        }
        let direction = direction_re.captures(caption).map(|c| c[1].to_string());
        let stop_scoped = title.to_lowercase().contains("stop closure");
        let stop = if title.to_lowercase().contains("stop closure") {
            stop_re
                .captures(&title)
                .and_then(|c| c.get(1).or_else(|| c.get(2)))
                .map(|m| m.as_str().to_string())
        } else {
            None
        };
        let mut notice = json!({"id":format!("{source}#{title}"),"title":title,"description":description,"routes":routes,"start_time":chrono::DateTime::from_timestamp_millis(start).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Secs,true)});
        if let Some(end) = end {
            notice["expires_at"] = json!(
                chrono::DateTime::from_timestamp_millis(end)
                    .unwrap()
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            );
        }
        if cancelled {
            notice["tripScoped"] = json!(true);
            notice["effect"] = json!("NO_SERVICE");
        } else if description.to_lowercase().starts_with("detour notice") {
            notice["effect"] = json!("DETOUR");
        }
        if let Some(stop) = stop {
            notice["stops"] = json!([stop]);
            notice["targets"] = if routes.is_empty() {
                json!([{"stopId":stop}])
            } else {
                json!(
                    routes
                        .iter()
                        .map(|route| json!({"routeId":route,"stopId":stop}))
                        .collect::<Vec<_>>()
                )
            };
        }
        if stop_scoped {
            notice["stopScoped"] = json!(true);
        }
        if let Some(direction) = direction {
            if !notice["targets"].is_array() {
                notice["targets"] = json!(
                    routes
                        .iter()
                        .map(|id| json!({"routeId":id}))
                        .collect::<Vec<_>>()
                );
            }
            for target in notice["targets"].as_array_mut().unwrap() {
                target["directionText"] = json!(direction);
            }
        }
        notices.push(notice);
    }
    Ok(Some(json!(notices)))
}

fn labelled_notice_period(
    description: &str,
    time_zone: &chrono_tz::Tz,
) -> Result<Option<(i64, Option<i64>)>, io::Error> {
    use crate::util::time::{extract_dates, extract_times, make_zoned_timestamp};
    if !description
        .lines()
        .any(|line| line.to_lowercase().starts_with("route(s):"))
    {
        return Ok(None);
    }
    let normalized = description.replace("Sept.", "Sep").replace("Sept", "Sep");
    let fields = regex::Regex::new(
        r"(?im)(?:^|\n| )((?:Start |End )?Date|Time):\s*(.*?)(?: End Date:|\n|$)",
    )
    .unwrap();
    // Keep adjacent date fields separate before reading their values.
    let normalized = normalized.replace(" End Date:", "\nEnd Date:");
    let values: std::collections::BTreeMap<_, _> = fields
        .captures_iter(&normalized)
        .map(|c| (c[1].to_lowercase(), c[2].trim().to_string()))
        .collect();
    let start = values.get("start date").or_else(|| values.get("date"));
    let end = values.get("end date").or_else(|| values.get("date"));
    let clock_re = regex::Regex::new(
        r"(?i)^(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?) (?:to|-) (\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)$",
    )
    .unwrap();
    let clocks = values
        .get("time")
        .filter(|s| clock_re.is_match(s))
        .map(|s| extract_times(s))
        .unwrap_or_default();
    let year_re = regex::Regex::new(r"\b(\d{4})\b").unwrap();
    let date_re = regex::Regex::new(r"\b\d{1,2},? \d{4}\b").unwrap();
    let timestamp = |value: &str, end: bool| -> Result<i64, io::Error> {
        let year = year_re
            .captures(value)
            .and_then(|c| c[1].parse::<i32>().ok())
            .ok_or_else(|| io::Error::other("Labelled notice requires an explicit date year"))?;
        let date = extract_dates(&value.replace('.', ""), year)
            .first()
            .copied()
            .ok_or_else(|| io::Error::other("Invalid labelled notice date"))?;
        let clock = if clocks.len() == 2 {
            clocks.get(if end { 1 } else { 0 })
        } else {
            None
        };
        Ok(make_zoned_timestamp(date, clock, end && clock.is_none(), time_zone) as i64 * 1000)
    };
    let starts_at = start.map(|s| timestamp(s, false)).transpose()?.unwrap_or(0);
    let ends_at = end
        .filter(|s| {
            date_re.is_match(s)
                && !s.to_lowercase().contains("until further notice")
                && !s.contains("N/A")
        })
        .map(|s| timestamp(s, true))
        .transpose()?;
    if ends_at.is_some_and(|end| end < starts_at) {
        return Err(io::Error::other("Invalid labelled notice period"));
    }
    Ok(Some((starts_at, ends_at)))
}

fn article_date_range(text: &str) -> Option<String> {
    let tokens: Vec<_> = text.split_whitespace().collect();
    let month = |index: usize| {
        tokens.get(index).is_some_and(|token| {
            matches!(
                token.trim_end_matches('.').to_ascii_lowercase().as_str(),
                "january"
                    | "february"
                    | "march"
                    | "april"
                    | "may"
                    | "june"
                    | "july"
                    | "august"
                    | "september"
                    | "october"
                    | "november"
                    | "december"
                    | "jan"
                    | "feb"
                    | "mar"
                    | "apr"
                    | "jun"
                    | "jul"
                    | "aug"
                    | "sep"
                    | "sept"
                    | "oct"
                    | "nov"
                    | "dec"
            )
        })
    };
    let digits = |index: usize, min: usize, max: usize| {
        tokens.get(index).is_some_and(|token| {
            let number = token.trim_end_matches([',', '.']);
            (min..=max).contains(&number.len()) && number.bytes().all(|b| b.is_ascii_digit())
        })
    };
    for index in 1..tokens.len() {
        if !tokens[index].eq_ignore_ascii_case("on")
            || !tokens[index - 1].eq_ignore_ascii_case("service")
        {
            continue;
        }
        let mut start = index + 1;
        if tokens.get(start).is_some_and(|t| {
            matches!(
                t.trim_end_matches(',').to_ascii_lowercase().as_str(),
                "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday"
            )
        }) {
            start += 1;
        }
        if !month(start) || !digits(start + 1, 1, 2) {
            continue;
        }
        let mut end = start + 2;
        if digits(end, 4, 4) {
            end += 1;
        }
        let date = tokens[start..end].join(" ");
        let date = date.trim_end_matches([',', '.']);
        return Some(format!("from {date} to {date}"));
    }
    for index in 0..tokens.len() {
        if !tokens[index].eq_ignore_ascii_case("from")
            || !month(index + 1)
            || !digits(index + 2, 1, 2)
        {
            continue;
        }
        let mut end = index + 3;
        if digits(end, 4, 4) {
            end += 1;
        }
        if !tokens
            .get(end)
            .is_some_and(|t| t.eq_ignore_ascii_case("to"))
            || !month(end + 1)
            || !digits(end + 2, 1, 2)
        {
            continue;
        }
        end += 3;
        if digits(end, 4, 4) {
            end += 1;
        }
        return Some(tokens[index..end].join(" "));
    }
    None
}

fn decode_update_cards(
    main: ElementRef<'_>,
    source: &str,
    route_names: &std::collections::BTreeMap<String, Vec<String>>,
    stop_names: &std::collections::BTreeMap<String, Vec<String>>,
    time_zone: &chrono_tz::Tz,
    now_ms: i64,
    publication_reference: Option<&PublicationReference>,
) -> Result<Option<Value>, io::Error> {
    let sel = |s: &str| Selector::parse(s).unwrap();
    let cards: Vec<_> = main.select(&sel(".service-update")).collect();
    if cards.is_empty() {
        return Ok(None);
    }
    let reference = publication_reference.ok_or_else(|| {
        io::Error::other("Yearless update archive has no verified publication reference")
    })?;
    let valid_from = chrono::NaiveDate::parse_from_str(&reference.valid_from, "%Y-%m-%d")
        .map_err(|_| io::Error::other("Invalid publication reference validFrom"))?;
    let valid_through = chrono::NaiveDate::parse_from_str(&reference.valid_through, "%Y-%m-%d")
        .map_err(|_| io::Error::other("Invalid publication reference validThrough"))?;
    if !(2020..=2050).contains(&reference.publication_year)
        || valid_from > valid_through
        || valid_from.year() != reference.publication_year
        || valid_through.year() != reference.publication_year
    {
        return Err(io::Error::other("Invalid publication reference range"));
    }
    let local_date = chrono::DateTime::from_timestamp_millis(now_ms)
        .ok_or_else(|| io::Error::other("Invalid source clock"))?
        .with_timezone(time_zone)
        .date_naive();
    if local_date < valid_from || local_date > valid_through {
        return Err(io::Error::other(
            "Verified publication reference is outside its validity window",
        ));
    }
    let date_re = regex::Regex::new(r"(?i)^([A-Za-z]+ \d{1,2}) (\d{1,2}):(\d{2})(am|pm)$").unwrap();
    let until_re = regex::Regex::new(r"(?i)\buntil\s+([A-Za-z]+\s+\d{1,2})\b").unwrap();
    let today_re = regex::Regex::new(r"(?i)\btoday\b").unwrap();
    let no_closures_re = regex::Regex::new(r"(?i)\bno closures\b").unwrap();
    let cancellation_re =
        regex::Regex::new(r"(?i)\b(cancelled|canceled|cancelling|canceling)\b").unwrap();
    let following_re = regex::Regex::new(r"(?i)\bfollowing\b").unwrap();
    let departure_clock_re = regex::Regex::new(r"(?i)\b\d{1,2}:\d{2}\s*[ap]\.?m\.?").unwrap();
    let route_list_re =
        regex::Regex::new(r"(?i)\broutes?\s+([\w\s,&/+-]+?)(?:\s+(?:are|have|will|is|were)\b|:)")
            .unwrap();
    let until_clock_re =
        regex::Regex::new(r"(?i)\buntil\s+(\d{1,2}:\d{2}\s*[ap]\.?m\.?)(?:\s|[,!?]|$)").unwrap();
    let interval_end_clock_re = regex::Regex::new(
        r"(?i)\bfrom\s+\d{1,2}:\d{2}\s*[ap]\.?m\.?(?:\s|,)[^!?]{0,100}?\bto\s+(\d{1,2}:\d{2}\s*[ap]\.?m\.?)(?:\s|[,!?]|$)",
    ).unwrap();
    let event_start_re = regex::Regex::new(
        r"(?i)\b(?:today,?\s+)?([A-Za-z]+\s+\d{1,2}),?\s+from\s+(\d{1,2}:\d{2}\s*[ap]\.?m\.?)",
    )
    .unwrap();
    let clock_re = regex::Regex::new(r"(?i)^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$").unwrap();
    let mut notices = Vec::new();
    for card in cards {
        let headings: Vec<_> = card.select(&sel("h4")).collect();
        let heading = if headings.len() == 1 {
            strip_html(&headings[0].html()).trim().to_string()
        } else {
            String::new()
        };
        let date = date_re
            .captures(&heading)
            .ok_or_else(|| io::Error::other("Invalid dated service update"))?;
        let hour: u32 = date[2].parse().unwrap_or(0);
        let minute: u32 = date[3].parse().unwrap_or(60);
        let description = card
            .select(&sel("p"))
            .map(|p| {
                notice_text(p, source)
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .collect::<Vec<_>>()
            .join("\n");
        if description.is_empty()
            || chrono::NaiveDate::parse_from_str(
                &format!("{} {}", &date[1], reference.publication_year),
                "%B %d %Y",
            )
            .is_err()
            || !(1..=12).contains(&hour)
            || minute > 59
        {
            return Err(io::Error::other("Invalid dated service update"));
        }
        let clock = format!("{}:{}{}", &date[2], &date[3], &date[4]);
        let posted = crate::parsers::ghd_news::parse_posted_at(
            &format!("{} {} {}", &date[1], reference.publication_year, clock),
            time_zone,
            reference.publication_year,
        )
        .ok_or_else(|| io::Error::other("Invalid update publication date"))?;
        if no_closures_re.is_match(&description) {
            continue;
        }
        let until = until_re
            .captures(&description)
            .map(|capture| capture[1].to_string());
        let one_day = cancellation_re.is_match(&description)
            && following_re.is_match(&description)
            && departure_clock_re.is_match(&description);
        let end_date = if description.to_lowercase().contains("until further notice") {
            None
        } else if let Some(value) = until.clone() {
            Some(value)
        } else if today_re.is_match(&description) || one_day {
            Some(date[1].to_string())
        } else {
            None
        };
        let explicit_end_clock = until_clock_re
            .captures(&description)
            .or_else(|| interval_end_clock_re.captures(&description))
            .map(|capture| capture[1].to_string());
        let event_date = event_start_re
            .captures(&description)
            .map(|capture| capture[1].to_string());
        let expires_at = end_date.and_then(|value| {
            if description.to_lowercase().contains("approximately") {
                return None;
            }
            let when = format!(
                "from {value} {} to {value} {}",
                reference.publication_year, reference.publication_year
            );
            crate::util::time::parse_period_lexical(
                Some(&when),
                time_zone,
                reference.publication_year,
            )
            .last()
            .and_then(|range| range.end)
            .and_then(|value| i64::try_from(value).ok())
            .map(|value| value * 1000)
        });
        let explicit_clock_expiry = explicit_end_clock
            .filter(|_| !description.to_lowercase().contains("approximately"))
            .map(|clock| -> Result<i64, io::Error> {
                let expiry_date = until
                    .as_deref()
                    .or(event_date.as_deref())
                    .unwrap_or(&date[1]);
                let date = chrono::NaiveDate::parse_from_str(
                    &format!("{} {}", expiry_date, reference.publication_year),
                    "%B %d %Y",
                )
                .map_err(|_| io::Error::other("Invalid update retirement date"))?;
                let clock_match = clock_re
                    .captures(&clock)
                    .ok_or_else(|| io::Error::other("Invalid update retirement time"))?;
                let hour: u32 = clock_match[1]
                    .parse()
                    .map_err(|_| io::Error::other("Invalid update retirement time"))?;
                let minute: u32 = clock_match[2]
                    .parse()
                    .map_err(|_| io::Error::other("Invalid update retirement time"))?;
                let time = crate::util::time::ParsedTime {
                    hour,
                    minute,
                    is_pm: clock_match[3].eq_ignore_ascii_case("p"),
                };
                if !(1..=23).contains(&hour)
                    || minute > 59
                    || (hour > 12 && clock_match[3].eq_ignore_ascii_case("a"))
                {
                    return Err(io::Error::other("Invalid update retirement time"));
                }
                Ok(
                    crate::util::time::make_zoned_timestamp(date, Some(&time), false, time_zone)
                        as i64
                        * 1000,
                )
            })
            .transpose()?;
        let expires_at = explicit_clock_expiry.or(expires_at);
        let route_list = route_list_re.captures(&description);
        let routes: Vec<_> = route_names
            .iter()
            .filter(|(id, names)| {
                names.iter().any(|name| has_whole_token(&description, name))
                    || route_list
                        .as_ref()
                        .is_some_and(|list| has_whole_token(&list[1], id))
            })
            .map(|(id, _)| id.clone())
            .collect();
        let stops: Vec<_> = stop_names
            .iter()
            .filter(|(_, names)| names.iter().any(|name| has_whole_token(&description, name)))
            .map(|(id, _)| id.clone())
            .collect();
        let first = sentence_parts(&description)
            .into_iter()
            .next()
            .unwrap_or(&description)
            .trim();
        let title = format!("{heading}: {first}");
        let start_time = chrono::DateTime::from_timestamp(posted, 0)
            .ok_or_else(|| io::Error::other("Invalid update timestamp"))?
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let mut notice = json!({"id":format!("{source}#{}-{title}", posted * 1000),"title":title,"description":description,"routes":routes,"start_time":start_time});
        if let Some(event) = event_start_re.captures(&description) {
            let start = crate::parsers::ghd_news::parse_posted_at(
                &format!("{} {} {}", &event[1], reference.publication_year, &event[2]),
                time_zone,
                reference.publication_year,
            )
            .ok_or_else(|| io::Error::other("Invalid update service start"))?;
            notice["activePeriod"] = json!({"start":chrono::DateTime::from_timestamp(start, 0).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)});
        }
        if let Some(ends_at) = expires_at {
            notice["expires_at"] = json!(
                chrono::DateTime::from_timestamp_millis(ends_at)
                    .unwrap()
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            );
        }
        if !stops.is_empty() {
            notice["stops"] = json!(stops);
            notice["targets"] = json!(
                stops
                    .iter()
                    .flat_map(|stop| if routes.is_empty() {
                        vec![json!({"stopId":stop})]
                    } else {
                        routes
                            .iter()
                            .map(|route| json!({"stopId":stop,"routeId":route}))
                            .collect()
                    })
                    .collect::<Vec<_>>()
            );
        }
        notices.push(notice);
    }
    Ok(Some(json!(notices)))
}

fn decode_route_list_article(
    main: ElementRef<'_>,
    source: &str,
    route_names: &std::collections::BTreeMap<String, Vec<String>>,
    time_zone: &chrono_tz::Tz,
) -> Result<Option<Value>, io::Error> {
    use chrono::Datelike;
    let sel = |s: &str| Selector::parse(s).unwrap();
    let Some(header) = main.select(&sel(".blog-post__header")).next() else {
        return Ok(None);
    };
    let article = header
        .parent()
        .and_then(ElementRef::wrap)
        .filter(|e| e.value().name() == "article")
        .ok_or_else(|| io::Error::other("Invalid article structure"))?;
    let publication = article
        .select(&sel(".date"))
        .next()
        .map(|e| strip_html(&e.html()))
        .ok_or_else(|| io::Error::other("Missing article date"))?;
    let posted = chrono::NaiveDate::parse_from_str(&publication, "%b %d, %Y")
        .or_else(|_| chrono::NaiveDate::parse_from_str(&publication, "%B %d, %Y"))
        .map_err(|_| io::Error::other("Invalid article date"))?;
    let items: Vec<_> = article
        .select(&sel("ul:not(.wp-block-social-links) > li"))
        .collect();
    if items.is_empty() {
        return Err(io::Error::other("Missing article notices"));
    }
    let range_re = regex::Regex::new(
        r"(?i)\bfrom\s+([A-Za-z]+\s+\d{1,2})\s+to\s+(approximately\s+)?([A-Za-z]+\s+\d{1,2})",
    )
    .unwrap();
    let single_re = regex::Regex::new(
        r"(?i)\b(?:starting|starts service on|ends service on)\s+([A-Za-z]+\s+\d{1,2})",
    )
    .unwrap();
    let mut notices = Vec::new();
    for item in items {
        let description = strip_html(&item.html())
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let (title, _) = description
            .split_once(':')
            .ok_or_else(|| io::Error::other("Unrecognized article notice scope"))?;
        let title = title.trim();
        let routes: Vec<_> = route_names
            .iter()
            .filter(|(_, names)| names.iter().any(|name| has_whole_token(title, name)))
            .map(|(id, _)| id.clone())
            .collect();
        if routes.is_empty() {
            return Err(io::Error::other("Unrecognized article notice scope"));
        }
        let range = range_re.captures(&description);
        let single = single_re.captures(&description);
        let start = range
            .as_ref()
            .and_then(|m| m.get(1))
            .or_else(|| single.as_ref().and_then(|m| m.get(1)))
            .ok_or_else(|| io::Error::other("Article notice lacks a readable start date"))?
            .as_str();
        let end = range
            .as_ref()
            .and_then(|m| m.get(3))
            .map_or(start, |m| m.as_str());
        let period = crate::util::time::parse_period_lexical(
            Some(&format!("from {start} to {end}")),
            time_zone,
            posted.year(),
        );
        let mut start = period[0]
            .start
            .ok_or_else(|| io::Error::other("Invalid article period"))?;
        let end = period[0]
            .end
            .ok_or_else(|| io::Error::other("Invalid article period"))?;
        if end < start {
            return Err(io::Error::other("Reversed article period"));
        }
        if description.to_lowercase().contains("ends service on") {
            start = end + 1;
        }
        let mut notice = json!({"id":format!("{source}#{}-{title}", start * 1000),"title":title,"description":description,"routes":routes,"start_time":chrono::DateTime::from_timestamp(start as i64, 0).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Secs,true)});
        if range.as_ref().is_some_and(|m| m.get(2).is_none()) {
            notice["expires_at"] = json!(
                chrono::DateTime::from_timestamp(end as i64, 0)
                    .unwrap()
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            );
        }
        notices.push(notice);
    }
    Ok(Some(json!(notices)))
}

fn decode_published_article(
    main: ElementRef<'_>,
    source: &str,
    route_names: &std::collections::BTreeMap<String, Vec<String>>,
    stop_names: &std::collections::BTreeMap<String, Vec<String>>,
    time_zone: &chrono_tz::Tz,
) -> Result<Option<Value>, io::Error> {
    use chrono::Datelike;
    let meta_sel = Selector::parse(".gs-news-details-meta").unwrap();
    let Some(meta) = main.select(&meta_sel).next() else {
        return Ok(None);
    };
    let date_sel = Selector::parse(".gs-news-details-date").unwrap();
    let title_sel = Selector::parse("h1").unwrap();
    let publication = meta
        .select(&date_sel)
        .next()
        .ok_or_else(|| io::Error::other("Incomplete news article"))?;
    let title = main
        .select(&title_sel)
        .next()
        .map(|e| strip_html(&e.html()))
        .ok_or_else(|| io::Error::other("Incomplete news article"))?;
    let body = meta
        .next_siblings()
        .filter_map(ElementRef::wrap)
        .next()
        .filter(|e| e.value().classes().any(|c| c == "usn_cmp_text"))
        .ok_or_else(|| io::Error::other("Incomplete news article"))?;
    let blocks = Selector::parse("p, li, h2, h3, h4").unwrap();
    let paragraphs: Vec<String> = body
        .select(&blocks)
        .filter(|block| {
            !block
                .ancestors()
                .skip(1)
                .filter_map(ElementRef::wrap)
                .any(|p| {
                    matches!(
                        p.value().name(),
                        "p" | "li"
                            | "h2"
                            | "h3"
                            | "h4"
                            | "nav"
                            | "footer"
                            | "aside"
                            | "script"
                            | "style"
                    )
                })
        })
        .map(|b| {
            notice_text(b, source)
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|s| !s.is_empty())
        .collect();
    let description = paragraphs.join("\n");
    if title.is_empty() || !has_notice_text(&format!("{title} {description}")) {
        return Err(io::Error::other("Article is not a service notice"));
    }
    let period_text = paragraphs
        .iter()
        .find_map(|line| article_date_range(line))
        .ok_or_else(|| io::Error::other("Article has no stated retirement"))?;
    let date_text = strip_html(&publication.html());
    let posted = chrono::NaiveDate::parse_from_str(&date_text, "%b %d, %Y")
        .or_else(|_| chrono::NaiveDate::parse_from_str(&date_text, "%B %d, %Y"))
        .or_else(|_| chrono::NaiveDate::parse_from_str(&date_text, "%A, %B %d, %Y"))
        .or_else(|_| chrono::NaiveDate::parse_from_str(&date_text, "%A, %b %d, %Y"))
        .map_err(|_| io::Error::other("Invalid article publication date"))?;
    let period =
        crate::util::time::parse_period_lexical(Some(&period_text), time_zone, posted.year());
    let start = period[0]
        .start
        .ok_or_else(|| io::Error::other("Article requires a stated period"))?;
    let end = period[0]
        .end
        .ok_or_else(|| io::Error::other("Article requires a stated retirement"))?;
    if end < start {
        return Err(io::Error::other("Article period ends before it starts"));
    }
    let routes: Vec<_> = route_names
        .iter()
        .filter(|(_, names)| {
            names
                .iter()
                .any(|name| has_whole_token(&format!("{title} {description}"), name))
        })
        .map(|(id, _)| id.clone())
        .collect();
    let mut notice = json!({"id": format!("{source}#{}-{title}", start * 1000), "title": title, "description": description, "routes": routes,
      "start_time": chrono::DateTime::from_timestamp(start as i64, 0).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
      "expires_at": chrono::DateTime::from_timestamp(end as i64, 0).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)});
    if !stop_names.is_empty() {
        let stations: Vec<_> = stop_names
            .iter()
            .filter(|(_, names)| {
                names.iter().any(|name| {
                    has_whole_token(&title, name)
                        || ["Station", "Terminal"]
                            .iter()
                            .any(|kind| has_whole_token(&description, &format!("{name} {kind}")))
                })
            })
            .map(|(id, _)| id.clone())
            .collect();
        notice["stops"] = json!(stations);
        notice["targets"] = json!(
            stations
                .iter()
                .map(|stop| json!({"stopId": stop}))
                .collect::<Vec<_>>()
        );
    }
    Ok(Some(notice))
}

pub async fn scrape(
    client: &crate::upstream::Client,
    url: &str,
    route_names: &std::collections::BTreeMap<String, Vec<String>>,
    stop_names: &std::collections::BTreeMap<String, Vec<String>>,
    time_zone: &chrono_tz::Tz,
    declarations: SourceDeclarations<'_>,
) -> Result<ScrapeOutcome, Box<dyn Error + Send + Sync>> {
    let html = client
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    if super::municipal_news::decode(&html, url, now_ms, time_zone)?.is_some() {
        return super::municipal_news::scrape(client, &html, url, now_ms, time_zone).await;
    }
    let featured = featured_urls(&html, url)?;
    let urls = if featured.is_some() {
        featured.clone()
    } else {
        super::linked_service_notices::index_urls(&html, url)?
    };
    if let Some(urls) = urls {
        let mut notices = if featured.is_some() {
            featured_body(
                &html,
                url,
                route_names,
                stop_names,
                time_zone,
                now_ms,
                declarations,
            )?
            .as_array()
            .cloned()
            .ok_or_else(|| io::Error::other("Invalid featured body"))?
        } else {
            Vec::new()
        };
        let mut partial = urls.len() > 9;
        for page in urls.into_iter().take(9) {
            let result = async {
                let html = client
                    .get(&page)
                    .send()
                    .await?
                    .error_for_status()?
                    .text()
                    .await?;
                super::linked_service_notices::decode_detail(
                    &html,
                    &page,
                    time_zone,
                    route_names,
                    stop_names,
                )?
                .ok_or_else(|| io::Error::other("Missing linked advisory detail"))
                .map_err(|error| Box::new(error) as Box<dyn Error + Send + Sync>)
            }
            .await;
            match result {
                Ok(Value::Array(values)) => notices.extend(values),
                _ => partial = true,
            }
        }
        return Ok(ScrapeOutcome {
            bytes: Bytes::from(serde_json::to_vec(&notices)?),
            partial,
            content_type: "application/json",
        });
    }
    let document =
        decode_with_reference(&html, url, route_names, stop_names, time_zone, declarations)
            .map_err(|_| crate::upstream::Failure::Decode)?;
    Ok(ScrapeOutcome {
        bytes: Bytes::from(serde_json::to_vec(&document)?),
        partial: false,
        content_type: "application/json",
    })
}

fn sentence_parts(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    for (index, character) in text.char_indices() {
        let end = index + character.len_utf8();
        if character == '\n'
            || (matches!(character, '.' | '!' | '?')
                && text[end..].chars().next().is_some_and(char::is_whitespace))
        {
            parts.push(&text[start..end]);
            start = end;
        }
    }
    parts.push(&text[start..]);
    parts
}

fn date_key(text: &str) -> String {
    text.to_lowercase()
        .split(|character: char| {
            character.is_whitespace() || matches!(character, ',' | '-' | '–' | '—')
        })
        .filter(|word| {
            !word.is_empty()
                && ![
                    "monday",
                    "tuesday",
                    "wednesday",
                    "thursday",
                    "friday",
                    "saturday",
                    "sunday",
                ]
                .contains(word)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// AEM notices occupy bounded text/banner components and labelled outage tables.
fn component_notices(html: &str) -> Result<Option<String>, io::Error> {
    let document = Html::parse_document(html);
    let selector = |value: &str| Selector::parse(value).unwrap();
    let Some(main) = document.select(&selector(".maincontentparct")).next() else {
        return Ok(None);
    };
    let plain = |element: ElementRef<'_>| {
        strip_html(&element.html())
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let escape = |text: &str| {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let mut notices: Vec<(String, String)> = Vec::new();
    for component in main.select(&selector(".alert-body, .text.parbase")) {
        let Some(heading) = component.select(&selector("h2, h3, h4")).next() else {
            continue;
        };
        let title = plain(
            component
                .select(&selector(".title-text"))
                .next()
                .unwrap_or(heading),
        );
        if !has_notice_text(&title) {
            continue;
        }
        let body = component
            .children()
            .map(|node| {
                if node.id() == heading.id() {
                    return String::new();
                }
                if let Some(element) = ElementRef::wrap(node) {
                    if element.value().name() == "a" {
                        format!("<p>{}</p>", element.html())
                    } else {
                        element.html()
                    }
                } else if let Node::Text(value) = node.value() {
                    value.to_string()
                } else {
                    String::new()
                }
            })
            .collect::<String>();
        if strip_html(&body).trim().is_empty() {
            continue;
        }
        notices.push((title, body));
    }
    let mut equipment = None;
    for element in main.select(&selector("h2, h3, h4, table")) {
        if element.value().name() != "table" {
            equipment = match plain(element).to_lowercase().as_str() {
                "planned elevator outages" => Some("elevator"),
                "planned escalator outages" => Some("escalator"),
                _ => None,
            };
            continue;
        }
        let Some(equipment) = equipment else {
            continue;
        };
        let rows: Vec<_> = element.select(&selector("tr")).collect();
        let cells = |row: ElementRef<'_>| {
            row.children()
                .filter_map(ElementRef::wrap)
                .filter(|c| matches!(c.value().name(), "td" | "th"))
                .map(plain)
                .collect::<Vec<_>>()
        };
        let headers = rows.first().map(|row| cells(*row)).unwrap_or_default();
        if rows.len() < 2
            || !headers.iter().any(|h| h == "Outage Start Date")
            || !headers.iter().any(|h| h == "Expected In-Service Date")
        {
            return Err(io::Error::other("Unrecognized outage table"));
        }
        for row in rows.iter().skip(1) {
            let values: Vec<_> = cells(*row)
                .into_iter()
                .map(|value| {
                    for prefix in [
                        "Location:",
                        "Direction:",
                        "Outage Start Date:",
                        "Expected In-Service Date:",
                    ] {
                        if let Some(rest) = value.strip_prefix(prefix) {
                            return rest.trim().to_string();
                        }
                    }
                    value
                })
                .collect();
            if values.len() != headers.len() || values.iter().any(|v| v.is_empty()) {
                return Err(io::Error::other("Incomplete outage row"));
            }
            let location = &values[0];
            let start = &values[headers
                .iter()
                .position(|h| h == "Outage Start Date")
                .unwrap()];
            let end = &values[headers
                .iter()
                .position(|h| h == "Expected In-Service Date")
                .unwrap()];
            let period_key = date_key(&format!("{start} - {end}"));
            if notices.iter().any(|(title, _)| {
                has_whole_token(title, location)
                    && has_whole_token(title, equipment)
                    && date_key(if title.contains('|') {
                        title.rsplit('|').next().unwrap()
                    } else {
                        title.split(':').next().unwrap()
                    }) == period_key
            }) {
                continue;
            }
            let suffix = if has_whole_token(location, equipment) {
                String::new()
            } else {
                format!(" {equipment}")
            };
            let title = format!("{location}{suffix} outage | {start} - {end}");
            let body = values
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    format!("<p>{}: {}</p>", escape(&headers[index]), escape(value))
                })
                .collect::<String>();
            notices.push((title, body));
        }
    }
    Ok(Some(format!(
        "<main>{}{}</main>",
        // Banners and asides are scoped callouts, so only body text may clear the board.
        main.select(&selector(".text.parbase p"))
            .find(|node| {
                CLEAR_STATEMENT.is_match(&plain(*node))
                    && !node
                        .ancestors()
                        .filter_map(ElementRef::wrap)
                        .take_while(|ancestor| ancestor.id() != main.id())
                        .any(|ancestor| {
                            matches!(
                                ancestor.value().name(),
                                "nav" | "footer" | "aside" | "script" | "style"
                            ) || ancestor
                                .value()
                                .has_class("alert-body", scraper::CaseSensitivity::CaseSensitive)
                        })
            })
            .map(|node| format!("<p>{}</p>", escape(&plain(node))))
            .unwrap_or_default(),
        notices
            .iter()
            .map(|(title, body)| format!("<h3>{}</h3>{body}<hr>", escape(title)))
            .collect::<String>()
    )))
}

/// An empty disclosure set under an advisory heading is the quiet board, returned as "".
fn disclosure_accordion_notices(html: &str) -> Result<Option<String>, io::Error> {
    let document = Html::parse_document(html);
    let selector = |value| Selector::parse(value).unwrap();
    let plain = |element: ElementRef<'_>| {
        strip_html(&element.html())
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let escape = |value: &str| {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let has_class =
        |element: ElementRef<'_>, name: &str| element.value().classes().any(|class| class == name);
    let incomplete = || io::Error::other("Incomplete disclosure notice");
    let mut boards = 0;
    let mut notices = Vec::new();
    for board in document.select(&selector(".accordion")) {
        let Some(set) = board
            .children()
            .filter_map(ElementRef::wrap)
            .find(|child| has_class(*child, "accordSet"))
        else {
            continue;
        };
        let Some(heading) = board.prev_siblings().find_map(ElementRef::wrap) else {
            continue;
        };
        let heading_text = plain(heading);
        let lower = heading_text.to_lowercase();
        if !matches!(heading.value().name(), "h2" | "h3" | "h4")
            || (!has_notice_text(&heading_text)
                && !lower
                    .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                    .any(|word| word == "detours" || word == "closures"))
        {
            continue;
        }
        boards += 1;
        let buttons: Vec<_> = set.select(&selector("button")).collect();
        let panels: Vec<_> = set.select(&selector(".accordCnt")).collect();
        if buttons.is_empty() && !plain(set).is_empty() {
            return Err(io::Error::other("Unrecognized disclosure board content"));
        }
        if buttons.len() != panels.len() {
            return Err(incomplete());
        }
        for button in buttons {
            let controls = button.value().attr("aria-controls");
            let panel = panels
                .iter()
                .find(|panel| controls.is_some() && panel.value().attr("id") == controls)
                .ok_or_else(incomplete)?;
            let title = plain(button);
            if title.is_empty() || plain(*panel).is_empty() {
                return Err(incomplete());
            }
            notices.push(format!(
                "<h3>{}</h3>{}<hr>",
                escape(&title),
                panel.inner_html()
            ));
        }
    }
    Ok(match (boards, notices.is_empty()) {
        (0, _) => None,
        (_, true) => Some(String::new()),
        (_, false) => Some(format!("<main>{}</main>", notices.join(""))),
    })
}

/// Marks a heading whose board already established it as a notice.
const LISTED_NOTICE: &str = "data-listed-notice";

/// Accordion groups list one notice per item under an advisory heading.
/// A titled group with no item list is the quiet board, returned as "".
fn accordion_group_notices(html: &str) -> Result<Option<String>, io::Error> {
    let document = Html::parse_document(html);
    let selector = |value| Selector::parse(value).unwrap();
    let plain = |element: ElementRef<'_>| {
        strip_html(&element.html())
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let escape = |value: &str| {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let has_class =
        |element: ElementRef<'_>, name: &str| element.value().classes().any(|class| class == name);
    let incomplete = || io::Error::other("Incomplete accordion group notice");
    let mut boards = 0;
    let mut notices = Vec::new();
    for group in document.select(&selector(".o-accordion-group")) {
        let children: Vec<_> = group.children().filter_map(ElementRef::wrap).collect();
        let Some(heading) = children
            .iter()
            .find(|child| has_class(**child, "o-accordion-group__title"))
        else {
            continue;
        };
        let heading_text = plain(*heading);
        let lower = heading_text.to_lowercase();
        if !matches!(heading.value().name(), "h2" | "h3" | "h4")
            || (!has_notice_text(&heading_text)
                && !lower
                    .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                    .any(|word| matches!(word, "detours" | "closures" | "impacts")))
        {
            continue;
        }
        boards += 1;
        let Some(list) = children
            .iter()
            .find(|child| has_class(**child, "o-accordion-group__list"))
        else {
            // A quiet board has no item markup at all; moved or renamed items must not read as all-clear.
            let has_items = group.select(&selector("*")).any(|node| {
                node.value().name() == "button"
                    || node.value().classes().any(|class| {
                        class.starts_with("m-accordion")
                            || class.starts_with("o-accordion-group__list")
                    })
            });
            if has_items {
                return Err(io::Error::other("Unrecognized accordion group content"));
            }
            continue;
        };
        let rows: Vec<_> = list.children().filter_map(ElementRef::wrap).collect();
        if rows.is_empty() || rows.iter().any(|row| row.value().name() != "li") {
            return Err(io::Error::other("Unrecognized accordion group content"));
        }
        for row in rows {
            let trigger = row
                .select(&selector("button.m-accordion__trigger"))
                .next()
                .ok_or_else(incomplete)?;
            let content = row
                .select(&selector(".m-accordion__content"))
                .next()
                .ok_or_else(incomplete)?;
            let title = plain(trigger);
            if title.is_empty() || plain(content).is_empty() {
                return Err(incomplete());
            }
            notices.push(format!(
                "<h3 {LISTED_NOTICE}>{}</h3>{}<hr>",
                escape(&title),
                content.inner_html()
            ));
        }
    }
    Ok(match (boards, notices.is_empty()) {
        (0, _) => None,
        (_, true) => Some(String::new()),
        (_, false) => Some(format!("<main>{}</main>", notices.join(""))),
    })
}

fn accordion_notices(html: &str) -> Result<Option<String>, io::Error> {
    let document = Html::parse_document(html);
    let selector = |value| Selector::parse(value).unwrap();
    let plain = |element: ElementRef<'_>| {
        strip_html(&element.html())
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let escape = |value: &str| {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let mut notices = Vec::new();
    for board in document.select(&selector(".accordion-module")) {
        let Some(heading) = board.select(&selector("h2, h3, h4")).next() else {
            continue;
        };
        if !has_notice_text(&plain(heading))
            && !plain(heading)
                .to_lowercase()
                .split_whitespace()
                .any(|word| word == "closures")
        {
            continue;
        }
        for section in board.select(&selector(".accordion__section")) {
            let title = section
                .select(&selector(".accordion__section__title"))
                .next()
                .ok_or_else(|| io::Error::other("Incomplete accordion notice"))?;
            let body = section
                .select(&selector(".accordion__section__content"))
                .next()
                .ok_or_else(|| io::Error::other("Incomplete accordion notice"))?;
            let title = plain(title);
            let text = plain(body);
            if title.is_empty() || text.is_empty() {
                return Err(io::Error::other("Incomplete accordion notice"));
            }
            let normalized = text.to_lowercase();
            let normalized = normalized.trim_end_matches('.');
            if ["detours", "service alerts", "closures"]
                .iter()
                .any(|kind| {
                    ["in effect", "at this time"].iter().any(|end| {
                        normalized == format!("no {kind} {end}")
                            || normalized == format!("no general {kind} {end}")
                    })
                })
            {
                continue;
            }
            notices.push(format!("<h3>{}</h3>{}<hr>", escape(&title), body.html()));
        }
    }
    Ok(if notices.is_empty() {
        None
    } else {
        Some(format!("<main>{}</main>", notices.join("")))
    })
}

fn closed_stop_targets(
    block: ElementRef<'_>,
    route_names: &std::collections::BTreeMap<String, Vec<String>>,
) -> Vec<Value> {
    let plain = |element: ElementRef<'_>| {
        strip_html(&element.html())
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let mut text = plain(block);
    let tag = block.value().name();
    if tag == "tr" {
        let Some(table) = block
            .ancestors()
            .filter_map(ElementRef::wrap)
            .find(|node| node.value().name() == "table")
        else {
            return Vec::new();
        };
        let Some(cell) = block
            .children()
            .filter_map(ElementRef::wrap)
            .find(|node| node.value().name() == "td")
        else {
            return Vec::new();
        };
        text = plain(cell);
        if !table
            .select(&Selector::parse("th").unwrap())
            .any(|header| plain(header).eq_ignore_ascii_case("closed bus stops:"))
        {
            // A `Stop | Status` table whose rows lead with the feed stop ID: `8737: King Street`.
            let Some(header_row) = table.select(&Selector::parse("tr").unwrap()).next() else {
                return Vec::new();
            };
            let header = header_row
                .children()
                .filter_map(ElementRef::wrap)
                .find(|node| matches!(node.value().name(), "td" | "th"));
            if header_row.id() == block.id()
                || !header.is_some_and(|header| {
                    matches!(plain(header).to_lowercase().as_str(), "stop" | "stops")
                })
            {
                return Vec::new();
            }
            let Some((id, _)) = text.split_once(':') else {
                return Vec::new();
            };
            let letters = id.trim_end_matches(|c: char| c.is_ascii_digit());
            if letters.len() == id.len() || !letters.chars().all(|c| c.is_ascii_alphabetic()) {
                return Vec::new();
            }
            return stop_targets(id.to_owned(), &text, route_names);
        }
    } else if tag == "li" {
        if !text.to_lowercase().starts_with("bus stop #")
            || !text.to_lowercase().contains(" - route")
        {
            return Vec::new();
        }
    } else if tag != "p" {
        return Vec::new();
    }
    let lower = text.to_lowercase();
    let Some(at) = lower.find("bus stop #") else {
        return Vec::new();
    };
    let id: String = text[at + "bus stop #".len()..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    if id.is_empty() {
        return Vec::new();
    }
    let after_stop = &lower[at + "bus stop #".len() + id.len()..];
    if tag == "p"
        && ![
            "will be closed",
            "will be temporarily closed",
            "is closed",
            "is temporarily closed",
            "are closed",
            "are temporarily closed",
        ]
        .iter()
        .any(|phrase| has_whole_token(after_stop, phrase))
    {
        return Vec::new();
    }
    stop_targets(id, &text, route_names)
}

fn stop_targets(
    id: String,
    text: &str,
    route_names: &std::collections::BTreeMap<String, Vec<String>>,
) -> Vec<Value> {
    let routes: Vec<_> = route_names
        .iter()
        .filter(|(_, names)| names.iter().any(|name| has_whole_token(text, name)))
        .map(|(id, _)| id)
        .collect();
    if routes.is_empty() {
        vec![json!({"stopId": id})]
    } else {
        routes
            .into_iter()
            .map(|route| json!({"stopId": id, "routeId": route}))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_matches_the_shared_parity_contract() {
        let contract: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/heading-service-notices/contract.json"
        ))
        .unwrap();
        for entry in contract["cases"].as_array().unwrap() {
            let publication_reference: Option<PublicationReference> = entry
                .get("publicationReference")
                .and_then(|reference| serde_json::from_value(reference.clone()).ok());
            let clear_statement_names: Vec<String> = serde_json::from_value(
                entry
                    .get("clearStatementNames")
                    .cloned()
                    .unwrap_or(json!([])),
            )
            .unwrap();
            let result = decode_at(
                entry["html"].as_str().unwrap(),
                "https://example.test/board",
                &serde_json::from_value(entry.get("routeNames").cloned().unwrap_or(json!({})))
                    .unwrap(),
                &serde_json::from_value(entry.get("stopNames").cloned().unwrap_or(json!({})))
                    .unwrap(),
                &entry
                    .get("timeZone")
                    .and_then(Value::as_str)
                    .unwrap_or("UTC")
                    .parse()
                    .unwrap(),
                entry.get("now").and_then(Value::as_i64).unwrap_or(1234),
                SourceDeclarations {
                    publication_reference: publication_reference.as_ref(),
                    clear_statement_names: &clear_statement_names,
                },
            );
            if entry["error"] == true {
                assert!(result.is_err(), "{}", entry["name"]);
            } else {
                let mut expected: Vec<_> = entry["notices"].as_array().unwrap().iter().map(|notice| json!({
                    "id": format!("https://example.test/board#{}", notice["title"].as_str().unwrap()),
                    "title": notice["title"], "description": notice["description"], "routes": notice.get("routeIds").cloned().unwrap_or(json!([])), "start_time": "1970-01-01T00:00:00Z"
                })).collect();
                for (notice, wanted) in expected
                    .iter_mut()
                    .zip(entry["notices"].as_array().unwrap())
                {
                    if let Some(posted_at) = wanted
                        .get("updatedAt")
                        .or_else(|| wanted.get("startsAt"))
                        .and_then(Value::as_i64)
                    {
                        notice["id"] = json!(format!(
                            "https://example.test/board#{posted_at}-{}",
                            wanted["title"].as_str().unwrap()
                        ));
                        notice["start_time"] = json!(
                            chrono::DateTime::from_timestamp_millis(posted_at)
                                .unwrap()
                                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
                        );
                    }
                }
                for (notice, wanted) in expected
                    .iter_mut()
                    .zip(entry["notices"].as_array().unwrap())
                {
                    if wanted.get("updatedAt").is_some()
                        && wanted.get("startsAt") != wanted.get("updatedAt")
                    {
                        let start = wanted["startsAt"].as_i64().unwrap();
                        notice["activePeriod"] = json!({"start":chrono::DateTime::from_timestamp_millis(start).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)});
                    }
                }
                for (notice, wanted) in expected
                    .iter_mut()
                    .zip(entry["notices"].as_array().unwrap())
                {
                    for (key, raw_key) in [
                        ("effect", "effect"),
                        ("tripScoped", "tripScoped"),
                        ("stopScoped", "stopScoped"),
                        ("affectedStations", "stops"),
                        ("targets", "targets"),
                    ] {
                        if let Some(value) = wanted.get(key) {
                            notice[raw_key] = value.clone();
                        }
                    }
                    if let Some(id) = wanted.get("id") {
                        notice["id"] = id.clone();
                    }
                    if let Some(start) = wanted.get("periodStartsAt").and_then(Value::as_i64) {
                        notice["start_time"] = json!(
                            chrono::DateTime::from_timestamp_millis(start)
                                .unwrap()
                                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
                        );
                    }
                    if let Some(ends_at) = wanted.get("endsAt").and_then(Value::as_i64) {
                        notice["expires_at"] = json!(
                            chrono::DateTime::from_timestamp_millis(ends_at)
                                .unwrap()
                                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
                        );
                    }
                }
                if entry.get("stopNames").is_some() {
                    for (notice, wanted) in expected
                        .iter_mut()
                        .zip(entry["notices"].as_array().unwrap())
                    {
                        notice["stops"] =
                            wanted.get("affectedStations").cloned().unwrap_or(json!([]));
                        notice["targets"] = wanted.get("targets").cloned().unwrap_or(json!([]));
                    }
                }
                assert_eq!(result.unwrap(), json!(expected), "{}", entry["name"]);
            }
        }
    }
}
