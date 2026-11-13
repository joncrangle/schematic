//! Structural validation for RSS and Atom documents before the daemon serves
//! their original bytes to a downstream decoder.

use std::{error::Error, fmt};

use crate::agencies::ScrapeOutcome;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RssDocumentKind {
    Rss,
    Atom,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RssValidationError {
    Empty,
    TooLarge,
    InvalidEncoding,
    MalformedXml,
    UnsupportedDocument,
    InvalidRssChannel,
    InvalidEntryTitle,
}

impl fmt::Display for RssValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Empty => "RSS upstream returned an empty document",
            Self::TooLarge => "RSS document exceeds the 2 MiB limit",
            Self::InvalidEncoding => "RSS document is not valid UTF-8",
            Self::MalformedXml => "RSS upstream returned malformed or unsupported XML",
            Self::UnsupportedDocument => "XML root is neither RSS nor Atom feed",
            Self::InvalidRssChannel => "RSS document must have exactly one direct channel",
            Self::InvalidEntryTitle => "RSS entries must each have one visible non-empty title",
        };
        formatter.write_str(message)
    }
}

impl Error for RssValidationError {}

impl RssDocumentKind {
    pub const fn content_type(self) -> &'static str {
        match self {
            Self::Rss => "application/rss+xml",
            Self::Atom => "application/atom+xml",
        }
    }
}

pub const MAX_RSS_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;

/// Fetches and validates one raw RSS or Atom document through the shared
/// redirect-refusing upstream client.
pub async fn scrape_rss_feed(
    client: &crate::upstream::Client,
    url: &str,
) -> Result<ScrapeOutcome, Box<dyn Error + Send + Sync>> {
    let body = client.download(url, MAX_RSS_DOCUMENT_BYTES).await?;
    let kind = validate_rss_document(&body).map_err(|_| crate::upstream::Failure::Decode)?;
    Ok(ScrapeOutcome {
        bytes: body,
        partial: false,
        content_type: kind.content_type(),
    })
}

pub fn validate_rss_document(bytes: &[u8]) -> Result<RssDocumentKind, RssValidationError> {
    if bytes.is_empty() {
        return Err(RssValidationError::Empty);
    }
    if bytes.len() > MAX_RSS_DOCUMENT_BYTES {
        return Err(RssValidationError::TooLarge);
    }

    let document_text =
        std::str::from_utf8(bytes).map_err(|_| RssValidationError::InvalidEncoding)?;
    let document = roxmltree::Document::parse_with_options(
        document_text,
        roxmltree::ParsingOptions {
            allow_dtd: false,
            // Bound parser memory for structurally valid but node-dense inputs.
            nodes_limit: 100_000,
            entity_resolver: None,
        },
    )
    .map_err(|_| RssValidationError::MalformedXml)?;

    let root = document.root_element();
    // roxmltree deliberately permits an empty DTD block even with allow_dtd
    // false. Reject an actual declaration in the prolog, while ignoring the
    // same bytes inside comments or processing instructions.
    if has_prolog_doctype(&document, &document_text[..root.range().start]) {
        return Err(RssValidationError::MalformedXml);
    }

    match root.tag_name().name() {
        "rss" => {
            let channels = root
                .children()
                .filter(|child| child.is_element() && child.tag_name().name() == "channel")
                .count();
            if channels != 1 {
                return Err(RssValidationError::InvalidRssChannel);
            }
            if !all_nested_entries_have_titles(root) {
                return Err(RssValidationError::InvalidEntryTitle);
            }
            Ok(RssDocumentKind::Rss)
        }
        "feed" => {
            if !all_nested_entries_have_titles(root) {
                return Err(RssValidationError::InvalidEntryTitle);
            }
            Ok(RssDocumentKind::Atom)
        }
        _ => Err(RssValidationError::UnsupportedDocument),
    }
}

fn has_prolog_doctype(document: &roxmltree::Document<'_>, prolog: &str) -> bool {
    let ignored_ranges: Vec<_> = document
        .root()
        .children()
        .filter(|node| node.is_comment() || node.is_pi())
        .map(|node| node.range())
        .collect();
    let mut offset = 0;
    while let Some(relative) = prolog[offset..].find("<!DOCTYPE") {
        let position = offset + relative;
        if !ignored_ranges.iter().any(|range| range.contains(&position)) {
            return true;
        }
        offset = position + "<!DOCTYPE".len();
    }
    false
}

fn all_nested_entries_have_titles(parent: roxmltree::Node<'_, '_>) -> bool {
    parent
        .children()
        .filter(|child| child.is_element())
        .all(|child| {
            if matches!(child.tag_name().name(), "item" | "entry") {
                // Core's collectEntries treats an item/entry as one record and
                // does not recursively promote markup inside that record.
                has_visible_title(child)
            } else {
                all_nested_entries_have_titles(child)
            }
        })
}

fn has_visible_title(entry: roxmltree::Node<'_, '_>) -> bool {
    let titles = entry
        .children()
        .filter(|child| child.is_element() && child.tag_name().name() == "title");
    let mut source_text = String::new();
    for title in titles {
        if !source_text.is_empty() {
            source_text.push(' ');
        }
        append_xml_text(title, &mut source_text);
    }
    let html = scraper::Html::parse_fragment(&source_text);
    let visible_text = html
        .tree
        .nodes()
        .filter_map(|node| {
            let text = node.value().as_text()?;
            let hidden = node.ancestors().any(|ancestor| {
                ancestor
                    .value()
                    .as_element()
                    .is_some_and(|element| matches!(element.name(), "script" | "style"))
            });
            (!hidden).then_some(text.text.as_ref())
        })
        .collect::<String>();
    !visible_text.trim().is_empty()
}

fn append_xml_text(node: roxmltree::Node<'_, '_>, output: &mut String) {
    if node.is_text() {
        if let Some(text) = node.text() {
            output.push_str(text);
        }
        return;
    }
    if node.is_element() && matches!(node.tag_name().name(), "script" | "style") {
        return;
    }
    for child in node.children() {
        append_xml_text(child, output);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::{fs, path::PathBuf};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[derive(Deserialize)]
    struct FixtureContract {
        valid: Vec<String>,
        invalid: Vec<String>,
    }

    fn fixture_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/rss-proxy")
    }

    #[test]
    fn matches_the_shared_rss_proxy_validation_contract() {
        let contract: FixtureContract = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/rss-proxy/contract.json"
        ))
        .expect("shared RSS fixture contract is valid JSON");
        let directory = fixture_dir();

        for file in contract.valid {
            let bytes = fs::read(directory.join(&file)).expect("valid XML fixture exists");
            let actual = validate_rss_document(&bytes)
                .unwrap_or_else(|error| panic!("{file} should be valid: {error:?}"));
            let expected = if file.contains("atom") {
                RssDocumentKind::Atom
            } else {
                RssDocumentKind::Rss
            };
            assert_eq!(actual, expected, "unexpected root kind for {file}");
        }

        for file in contract.invalid {
            let bytes = fs::read(directory.join(&file)).expect("invalid XML fixture exists");
            assert!(
                validate_rss_document(&bytes).is_err(),
                "{file} must not be served as a feed"
            );
        }
    }

    #[test]
    fn rejects_documents_over_the_configured_size_limit() {
        let oversized = vec![b'x'; MAX_RSS_DOCUMENT_BYTES + 1];
        assert_eq!(
            validate_rss_document(&oversized),
            Err(RssValidationError::TooLarge)
        );
    }

    #[test]
    fn recognizes_doctype_only_in_the_prolog_not_inside_comments() {
        let valid = b"<!-- An old example says <!DOCTYPE rss>. -->\n<rss><channel /></rss>";
        assert_eq!(validate_rss_document(valid), Ok(RssDocumentKind::Rss));

        let invalid = b"<!-- note --><!DOCTYPE rss><rss><channel /></rss>";
        assert_eq!(
            validate_rss_document(invalid),
            Err(RssValidationError::MalformedXml)
        );
    }

    #[test]
    fn recognized_entries_require_visible_title_text_and_allow_multiple_titles() {
        let invalid = [
            b"<rss><channel><item><description>route 42</description></item></channel></rss>".as_slice(),
            b"<rss><channel><item><title> \n </title></item></channel></rss>".as_slice(),
            b"<rss><channel><item><title><span /></title></item></channel></rss>".as_slice(),
            b"<rss><channel><item><title><script>hidden</script><style>hidden</style></title></item></channel></rss>".as_slice(),
            b"<feed><entry><summary>route 42</summary></entry></feed>".as_slice(),
        ];
        for document in invalid {
            assert_eq!(
                validate_rss_document(document),
                Err(RssValidationError::InvalidEntryTitle)
            );
        }

        let valid =
            b"<rss><channel><item><title><![CDATA[route 42]]></title></item></channel></rss>";
        assert_eq!(validate_rss_document(valid), Ok(RssDocumentKind::Rss));

        let multiple_titles = b"<rss><channel><item><title>Detour</title><title>Route 42</title></item></channel></rss>";
        assert_eq!(
            validate_rss_document(multiple_titles),
            Ok(RssDocumentKind::Rss)
        );
    }

    async fn local_response(response: Vec<u8>) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 4096];
            let count = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..count]).to_string();
            stream.write_all(&response).await.unwrap();
            request
        });
        (format!("http://{address}/updates"), server)
    }

    #[tokio::test]
    async fn forwards_french_rss_bytes_unchanged_with_browser_user_agent_and_no_auth() {
        let payload =
            include_bytes!("../../../../tests/fixtures/rss-proxy/french-routes-and-categories.xml");
        let mut wire = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            payload.len()
        )
        .into_bytes();
        wire.extend_from_slice(payload);
        let (url, server) = local_response(wire).await;
        let client = crate::upstream::Client::builder().build().unwrap();

        let outcome = scrape_rss_feed(&client, &url).await.unwrap();
        let request = server.await.unwrap();
        assert_eq!(outcome.bytes.as_ref(), payload);
        assert_eq!(outcome.content_type, "application/rss+xml");
        assert!(!outcome.partial);
        assert!(
            request
                .to_ascii_lowercase()
                .contains("user-agent: mozilla/5.0")
        );
        assert!(!request.to_ascii_lowercase().contains("x-feed-token"));
        assert!(!request.to_ascii_lowercase().contains("authorization:"));
    }

    #[tokio::test]
    async fn rejects_http_errors_and_redirects_instead_of_returning_fake_feeds() {
        for response in [
            b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
            b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        ] {
            let (url, server) = local_response(response).await;
            let client = crate::upstream::Client::builder()
                    .build()
                .unwrap();
            let error = scrape_rss_feed(&client, &url)
                .await
                .expect_err("upstream status must fail closed");
            assert!(matches!(error.downcast_ref::<crate::upstream::Failure>(), Some(crate::upstream::Failure::Http)));
            let _ = server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn rejects_html_and_oversized_responses_without_serving_them() {
        for (content_length, body) in [
            (
                b"<html><body>blocked</body></html>".len(),
                b"<html><body>blocked</body></html>".as_slice(),
            ),
            (MAX_RSS_DOCUMENT_BYTES + 1, b"".as_slice()),
        ] {
            let mut wire = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {content_length}\r\nConnection: close\r\n\r\n"
            )
            .into_bytes();
            wire.extend_from_slice(body);
            let (url, server) = local_response(wire).await;
            let client = crate::upstream::Client::builder().build().unwrap();
            assert!(scrape_rss_feed(&client, &url).await.is_err());
            let _ = server.await.unwrap();
        }
    }
}
