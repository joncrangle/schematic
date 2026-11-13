//! Reads paragraph notices from a page headed "Service Announcement".
//! Twin of `serviceAnnouncementBoardParser.ts`.
use super::strip_html::strip_html;
use crate::agencies::ScrapeOutcome;
use bytes::Bytes;
use scraper::{ElementRef, Html, Node};
use serde_json::{Value, json};
use std::{collections::BTreeMap, error::Error, io};

#[derive(Debug)]
enum Block {
    Heading(String),
    Paragraph { plain: String, formatted: String },
    Separator,
    List,
}

fn element_text(element: ElementRef<'_>) -> String {
    strip_html(&element.html())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn notice_text(element: ElementRef<'_>, source: &str) -> String {
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
    text
}

fn collect_blocks(element: ElementRef<'_>, source: &str, blocks: &mut Vec<Block>) {
    for child in element.children() {
        let Some(child_element) = ElementRef::wrap(child) else {
            continue;
        };
        let tag = child_element.value().name();
        if matches!(tag, "nav" | "footer" | "aside" | "script" | "style") {
            continue;
        }
        if tag.len() == 2 && tag.starts_with('h') && matches!(tag.as_bytes()[1], b'1'..=b'6') {
            let text = element_text(child_element);
            if !text.is_empty() {
                blocks.push(Block::Heading(text));
            }
        } else if tag == "p" {
            let plain = element_text(child_element);
            if !plain.is_empty() {
                let formatted = notice_text(child_element, source)
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                blocks.push(Block::Paragraph { plain, formatted });
            }
        } else if tag == "hr" {
            blocks.push(Block::Separator);
        } else if matches!(tag, "ul" | "ol") {
            blocks.push(Block::List);
        } else {
            collect_blocks(child_element, source, blocks);
        }
    }
}

fn is_announcement_heading(text: &str) -> bool {
    let normalized = text
        .to_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    matches!(
        normalized.as_str(),
        "service announcement" | "service announcements"
    )
}

fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .collect()
}

fn contains_phrase(text_words: &[String], phrase: &[&str]) -> bool {
    text_words
        .windows(phrase.len())
        .any(|window| window.iter().map(String::as_str).eq(phrase.iter().copied()))
}

fn is_notice_paragraph(text: &str) -> bool {
    let tokens = words(text);
    tokens.iter().any(|token| {
        matches!(
            token.as_str(),
            "closed" | "closure" | "construction" | "reconstruction" | "detour" | "diversion"
        )
    }) || [
        &["not", "servicing"][..],
        &["not", "serving"][..],
        &["not", "stopping"][..],
        &["service", "disruption"][..],
        &["service", "advisory"][..],
        &["service", "alert"][..],
        &["service", "alerts"][..],
        &["stop", "unavailable"][..],
    ]
    .iter()
    .any(|phrase| contains_phrase(&tokens, phrase))
}

fn has_whole_token(text: &str, alias: &str) -> bool {
    let text = text.to_lowercase();
    let alias = alias.trim().to_lowercase();
    if alias.is_empty() {
        return false;
    }
    text.match_indices(&alias).any(|(index, matched)| {
        let before = text[..index].chars().next_back();
        let after = text[index + matched.len()..].chars().next();
        !before.is_some_and(|character| character.is_ascii_alphanumeric())
            && !after.is_some_and(|character| character.is_ascii_alphanumeric())
    })
}

fn is_route_list_terminator(token: &str) -> bool {
    matches!(
        token,
        "will"
            | "would"
            | "is"
            | "are"
            | "was"
            | "were"
            | "has"
            | "have"
            | "had"
            | "can"
            | "could"
            | "may"
            | "might"
            | "must"
            | "should"
            | "shall"
            | "do"
            | "does"
            | "did"
            | "be"
            | "being"
            | "been"
            | "follow"
            | "use"
            | "detour"
            | "remain"
            | "close"
            | "closed"
            | "suspend"
            | "suspended"
            | "serve"
            | "travel"
            | "operate"
            | "continue"
            | "not"
    )
}

// Match JavaScript's ASCII word boundaries while retaining punctuation inside
// each clause, so aliases see the same text in both runtimes.
fn word_spans(text: &str) -> Vec<(usize, usize, &str)> {
    let mut result = Vec::new();
    let mut start = None;
    for (index, character) in text.char_indices() {
        if character.is_ascii_alphanumeric() || character == '_' {
            start.get_or_insert(index);
        } else if let Some(from) = start.take() {
            result.push((from, index, &text[from..index]));
        }
    }
    if let Some(from) = start {
        result.push((from, text.len(), &text[from..]));
    }
    result
}

fn explicit_route_clauses(text: &str) -> Vec<String> {
    let mut clauses = Vec::new();
    for (_, end, word) in word_spans(text) {
        if !word.eq_ignore_ascii_case("route") && !word.eq_ignore_ascii_case("routes") {
            continue;
        }
        let mut tail = text[end..].trim_start();
        if tail.starts_with([':', '#', '-']) {
            tail = tail[1..].trim_start();
        }
        let sentence = tail.split(['.', '!', '?', ';']).next().unwrap_or("");
        let end = word_spans(sentence)
            .into_iter()
            .find(|(_, _, token)| is_route_list_terminator(&token.to_ascii_lowercase()))
            .map(|(start, _, _)| start)
            .unwrap_or(sentence.len());
        clauses.push(sentence[..end].to_owned());
    }
    clauses
}

fn declared_route_ids(text: &str, route_names: &BTreeMap<String, Vec<String>>) -> Vec<String> {
    let clauses = explicit_route_clauses(text);
    route_names
        .iter()
        .filter(|(_, aliases)| {
            aliases.iter().any(|alias| {
                let trimmed = alias.trim();
                let lowercase = trimmed.to_ascii_lowercase();
                let alias = if lowercase.starts_with("routes ") {
                    &trimmed["Routes ".len()..]
                } else if lowercase.starts_with("route ") {
                    &trimmed["Route ".len()..]
                } else {
                    trimmed
                };
                clauses.iter().any(|clause| has_whole_token(clause, alias))
            })
        })
        .map(|(route_id, _)| route_id.clone())
        .collect()
}

fn title_and_description(text: &str) -> (String, Option<String>) {
    let characters: Vec<_> = text.char_indices().collect();
    for (position, (index, character)) in characters.iter().enumerate() {
        if !matches!(character, '.' | '!' | '?') {
            continue;
        }
        let mut next_index = position + 1;
        while next_index < characters.len() && characters[next_index].1.is_whitespace() {
            next_index += 1;
        }
        let Some((word_start, first_character)) = characters.get(next_index).copied() else {
            continue;
        };
        if !first_character.is_ascii_uppercase() {
            continue;
        }
        let mut word_end = next_index;
        while word_end < characters.len() && characters[word_end].1.is_ascii_alphabetic() {
            word_end += 1;
        }
        if word_end - next_index <= 1 {
            continue;
        }
        let title_end = index + character.len_utf8();
        let description = text[word_start..].trim();
        return (
            text[..title_end].trim().to_owned(),
            (!description.is_empty()).then(|| description.to_owned()),
        );
    }
    (text.trim().to_owned(), None)
}

pub fn decode(
    html: &str,
    source: &str,
    route_names: &BTreeMap<String, Vec<String>>,
) -> Result<Value, io::Error> {
    let document = Html::parse_document(html);
    let main = document
        .select(&scraper::Selector::parse("main").unwrap())
        .next()
        .ok_or_else(|| io::Error::other("Missing main service content"))?;
    let mut blocks = Vec::new();
    collect_blocks(main, source, &mut blocks);
    let heading_index = blocks
        .iter()
        .position(|block| matches!(block, Block::Heading(text) if is_announcement_heading(text)));
    let Some(heading_index) = heading_index else {
        return Err(io::Error::other("Missing service announcement board"));
    };

    let mut notices = Vec::new();
    for block in blocks.iter().skip(heading_index + 1) {
        match block {
            Block::Heading(_) | Block::List => break,
            Block::Separator => continue,
            Block::Paragraph { plain, formatted } => {
                if !is_notice_paragraph(plain) {
                    if !notices.is_empty() {
                        break;
                    }
                    continue;
                }
                let (title, description) = title_and_description(formatted);
                let identity = description
                    .as_ref()
                    .map(|description| format!("{title} {description}"))
                    .unwrap_or_else(|| title.clone());
                let mut alert = json!({
                    "id": format!("{source}#{identity}"),
                    "title": title,
                    "routes": declared_route_ids(plain, route_names),
                    "start_time": "1970-01-01T00:00:00Z"
                });
                if let Some(description) = description {
                    alert["description"] = json!(description);
                }
                notices.push(alert);
            }
        }
    }
    if notices.is_empty() {
        return Err(io::Error::other(
            "No recognizable service announcements; recovery is unconfirmed",
        ));
    }
    Ok(json!(notices))
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
    let document = decode(&html, url, route_names).map_err(|_| crate::upstream::Failure::Decode)?;
    Ok(ScrapeOutcome {
        bytes: Bytes::from(serde_json::to_vec(&document)?),
        partial: false,
        content_type: "application/json",
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    #[test]
    fn test_matches_the_shared_service_announcement_contract() {
        let contract: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/service-announcement-board/contract.json"
        ))
        .unwrap();
        for entry in contract["cases"].as_array().unwrap() {
            let route_names =
                serde_json::from_value(entry.get("routeNames").cloned().unwrap_or(json!({})))
                    .unwrap();
            let result = super::decode(
                entry["html"].as_str().unwrap(),
                "https://example.test/announcements",
                &route_names,
            );
            if entry["error"] == true {
                assert!(result.is_err(), "{}", entry["name"]);
                continue;
            }

            let expected: Vec<_> = entry["notices"]
                .as_array()
                .unwrap()
                .iter()
                .map(|notice| {
                    let mut expected = json!({
                        "id": format!(
                            "https://example.test/announcements#{}",
                            notice["description"]
                                .as_str()
                                .map(|description| format!("{} {description}", notice["title"].as_str().unwrap()))
                                .unwrap_or_else(|| notice["title"].as_str().unwrap().to_owned())
                        ),
                        "title": notice["title"],
                        "routes": notice.get("routeIds").cloned().unwrap_or(json!([])),
                        "start_time": "1970-01-01T00:00:00Z"
                    });
                    if let Some(description) = notice.get("description") {
                        expected["description"] = description.clone();
                    }
                    expected
                })
                .collect();
            assert_eq!(result.unwrap(), json!(expected), "{}", entry["name"]);
        }
    }
}
