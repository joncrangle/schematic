use axum::{
    Router,
    extract::Request,
    http::StatusCode,
    middleware::{self, Next},
    response::IntoResponse,
    routing::get,
};
use std::{env, time::Duration};

pub mod agencies;
#[allow(clippy::all)]
pub mod gtfs {
    include!(concat!(env!("OUT_DIR"), "/transit_realtime.rs"));
}
pub mod parsers;
pub mod upstream;
pub mod util;

/// Creates the application router with health check and auth middleware
pub fn create_app(feeds: agencies::SharedFeedMap, auth_token: Option<String>) -> Router {
    let auth_token = auth_token.filter(|t| !t.trim().is_empty());
    Router::new()
        .route("/health", get(health_check))
        .merge(agencies::router(feeds))
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            let expected = auth_token.clone();
            async move {
                let path = req.uri().path().trim_end_matches('/');
                // Allow unauthenticated GET health check probes, including subpath mounts
                if req.method() == axum::http::Method::GET
                    && (path == "/health" || path.ends_with("/health"))
                {
                    return health_check().await.into_response();
                }

                if let Some(ref token) = expected {
                    let header_match = req
                        .headers()
                        .get("x-feed-token")
                        .and_then(|h| h.to_str().ok())
                        .is_some_and(|v| v == token);

                    let query_match = req.uri().query().is_some_and(|q| {
                        q.split('&').any(|pair| {
                            pair.strip_prefix("token=").is_some_and(|val| {
                                let normalized = val.replace('+', " ");
                                percent_encoding::percent_decode_str(&normalized)
                                    .decode_utf8()
                                    .is_ok_and(|decoded| decoded == token.as_str())
                            })
                        })
                    });

                    if !header_match && !query_match {
                        return StatusCode::UNAUTHORIZED.into_response();
                    }
                }
                next.run(req).await
            }
        }))
}

async fn health_check() -> impl IntoResponse {
    (
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        r#"{"status":"ok"}"#,
    )
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let auth_token = env::var("FEED_ALERT_PROXY_TOKEN")
        .ok()
        .filter(|s| !s.trim().is_empty());
    let port = env::var("PORT").unwrap_or_else(|_| "3001".to_string());

    if auth_token.is_none() {
        eprintln!(
            "[security] FEED_ALERT_PROXY_TOKEN not configured; endpoints are unauthenticated"
        );
    }

    let client = crate::upstream::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .expect("Failed to build reqwest client");

    // Spawn background feeds & get feed state
    let registry = agencies::load_registry_config()?;
    let feeds = agencies::spawn_pollers(client, registry)?;
    let app = create_app(feeds, auth_token);

    let addr = format!("0.0.0.0:{port}");
    eprintln!("[server] Listening on {addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use arc_swap::ArcSwap;
    use axum::{
        body::Body,
        http::{Request, StatusCode, header},
    };
    use bytes::Bytes;
    use http_body_util::BodyExt;
    use std::{collections::HashMap, sync::Arc};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    use tower::ServiceExt;

    #[test]
    fn modified_trip_fixture_preserves_standard_gtfs_fields() {
        use prost::Message;
        let hex = include_str!("../../../tests/fixtures/gtfs-rt/modified-trip.hex")
            .split_whitespace()
            .collect::<String>();
        let bytes = (0..hex.len())
            .step_by(2)
            .map(|offset| u8::from_str_radix(&hex[offset..offset + 2], 16).unwrap())
            .collect::<Vec<_>>();
        let feed = gtfs::FeedMessage::decode(bytes.as_slice()).unwrap();
        let update = feed.entity[0].trip_update.as_ref().unwrap();
        assert_eq!(update.trip.trip_id, None);
        assert_eq!(
            update
                .trip
                .modified_trip
                .as_ref()
                .unwrap()
                .affected_trip_id
                .as_deref(),
            Some("trip-42")
        );
        let event = update.stop_time_update[0].departure.as_ref().unwrap();
        assert_eq!(event.time, Some(1_700_000_320));
        assert_eq!(event.scheduled_time, Some(1_700_000_000));
    }

    fn test_entry(payload: Bytes) -> agencies::FeedEntry {
        let etag = agencies::compute_etag(&payload);
        agencies::FeedEntry {
            bytes: payload,
            etag,
            last_success_secs: agencies::current_epoch_secs(),
            is_stale: false,
            content_type: "application/x-protobuf",
            ..Default::default()
        }
    }

    fn test_feed_map(agency: &str, entry: agencies::FeedEntry) -> agencies::SharedFeedMap {
        test_feed_map_with_format_and_max_staleness(
            agency,
            entry,
            agencies::EndpointFormat::Protobuf,
            3600,
        )
    }

    fn test_feed_map_with_max_staleness(
        agency: &str,
        entry: agencies::FeedEntry,
        max_staleness_secs: u64,
    ) -> agencies::SharedFeedMap {
        test_feed_map_with_format_and_max_staleness(
            agency,
            entry,
            agencies::EndpointFormat::Protobuf,
            max_staleness_secs,
        )
    }

    fn test_feed_map_with_format_and_max_staleness(
        agency: &str,
        entry: agencies::FeedEntry,
        format: agencies::EndpointFormat,
        max_staleness_secs: u64,
    ) -> agencies::SharedFeedMap {
        let mut map = HashMap::new();
        map.insert(
            agency.to_string(),
            agencies::FeedHandle {
                buffer: Arc::new(ArcSwap::from_pointee(entry)),
                max_staleness_secs,
                format,
            },
        );
        Arc::new(map)
    }

    fn upstream_response(status: &str, body: &[u8]) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        response
    }

    async fn local_upstream(responses: Vec<Vec<u8>>) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for response in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut chunk = [0; 1024];
                loop {
                    let count = stream.read(&mut chunk).await.unwrap();
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&chunk[..count]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                stream.write_all(&response).await.unwrap();
            }
        });
        (format!("http://{address}/alerts"), server)
    }

    fn rss_registry(url: &str) -> agencies::registry::ConfiguredRegistry {
        let config = format!(
            r#"{{"feeds":[{{"id":"sample","parser":"rss","upstreamUrl":"{url}","pollIntervalSecs":1,"maxStalenessSecs":30}}]}}"#
        );
        agencies::registry::parse_registry_config(&config, None, None).unwrap()
    }

    async fn wait_for_entry(
        handle: &agencies::FeedHandle,
        predicate: impl Fn(&agencies::FeedEntry) -> bool,
    ) -> Arc<agencies::FeedEntry> {
        tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                let entry = handle.buffer.load_full();
                if predicate(&entry) {
                    break entry;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("poller should reach its expected cache state")
    }

    #[tokio::test]
    async fn test_health_endpoint() {
        let feeds: agencies::SharedFeedMap = Arc::new(HashMap::new());
        let app = create_app(feeds, Some("secret123".to_string()));

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body, r#"{"status":"ok"}"#);
    }

    #[tokio::test]
    async fn test_uninitialized_feed_returns_503() {
        let feeds = test_feed_map("sample", agencies::FeedEntry::default());
        let app = create_app(feeds, None);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/sample.pb")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body, "Feed initializing");
    }

    #[tokio::test]
    async fn test_initialized_feed_returns_200_and_protobuf_mimetype_with_etag() {
        let payload = Bytes::from_static(b"\x08\x02\x12\x04test");
        let entry = test_entry(payload.clone());
        let expected_etag = entry.etag.clone();
        let feeds = test_feed_map("sample", entry);
        let app = create_app(feeds, None);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/sample.pb")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/x-protobuf"
        );
        assert_eq!(
            resp.headers().get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=60"
        );
        assert_eq!(
            resp.headers().get(header::ETAG).unwrap(),
            expected_etag.as_str()
        );
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body, payload);
    }

    #[tokio::test]
    async fn serves_original_json_only_at_the_json_endpoint() {
        let payload = Bytes::from_static(b"{\"alerts\":{\"short_term\":[],\"long_term\":[]}}");
        let mut entry = test_entry(payload.clone());
        entry.content_type = "application/json";
        let feeds = test_feed_map_with_format_and_max_staleness(
            "sample",
            entry,
            agencies::EndpointFormat::Json,
            3600,
        );
        let app = create_app(feeds, None);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/sample.json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            payload
        );
        let mismatch = app
            .oneshot(
                Request::builder()
                    .uri("/sample.pb")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(mismatch.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_rss_xml_route_preserves_payload_auth_etag_and_stale_warning() {
        let payload = Bytes::from_static(
            b"<?xml version=\"1.0\"?><rss version=\"2.0\"><channel><title>Alerts</title></channel></rss>",
        );
        let mut entry = test_entry(payload.clone());
        entry.is_stale = true;
        entry.content_type = "application/rss+xml";
        let expected_etag = entry.etag.clone();
        let feeds = test_feed_map_with_format_and_max_staleness(
            "sample",
            entry,
            agencies::EndpointFormat::Xml,
            3600,
        );
        let app = create_app(feeds, Some("worker-secret".to_string()));

        let unauthorized = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/sample.xml")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/sample.xml")
                    .header("x-feed-token", "worker-secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/rss+xml"
        );
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=60"
        );
        assert_eq!(
            response.headers().get(header::ETAG).unwrap(),
            expected_etag.as_str()
        );
        assert_eq!(
            response.headers().get(header::WARNING).unwrap(),
            "110 - \"Response is Stale\""
        );
        assert_eq!(
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .as_ref(),
            payload
        );

        let wrong_format = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/sample.pb")
                    .header("x-feed-token", "worker-secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(wrong_format.status(), StatusCode::NOT_FOUND);

        let not_modified = app
            .oneshot(
                Request::builder()
                    .uri("/sample.xml")
                    .header("x-feed-token", "worker-secret")
                    .header(header::IF_NONE_MATCH, &expected_etag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(not_modified.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(
            not_modified.headers().get(header::WARNING).unwrap(),
            "110 - \"Response is Stale\""
        );
    }

    #[tokio::test]
    async fn rss_polling_keeps_last_good_bytes_and_marks_them_stale_after_upstream_error() {
        let payload = include_bytes!("../../../tests/fixtures/rss-proxy/routes-and-categories.xml");
        let (url, server) = local_upstream(vec![
            upstream_response("200 OK", payload),
            upstream_response("503 Service Unavailable", b""),
        ])
        .await;
        let feeds =
            agencies::spawn_pollers(crate::upstream::Client::new(), rss_registry(&url)).unwrap();
        let handle = feeds.get("sample").unwrap();
        let entry = wait_for_entry(handle, |entry| entry.is_stale && !entry.bytes.is_empty()).await;
        server.await.unwrap();

        assert_eq!(entry.bytes.as_ref(), payload);
        assert_eq!(entry.content_type, "application/rss+xml");
        let response = create_app(feeds, Some("worker-token".to_string()))
            .oneshot(
                Request::builder()
                    .uri("/sample.xml")
                    .header("x-feed-token", "worker-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/rss+xml"
        );
        assert_eq!(
            response.headers().get(header::WARNING).unwrap(),
            "110 - \"Response is Stale\""
        );
        assert_eq!(
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .as_ref(),
            payload.as_slice()
        );
    }

    #[tokio::test]
    async fn rss_polling_keeps_cold_endpoint_unavailable_after_bad_upstream_response() {
        let (url, server) =
            local_upstream(vec![upstream_response("503 Service Unavailable", b"")]).await;
        let feeds =
            agencies::spawn_pollers(crate::upstream::Client::new(), rss_registry(&url)).unwrap();
        let handle = feeds.get("sample").unwrap();
        let _entry = wait_for_entry(handle, |entry| entry.bytes.is_empty()).await;
        server.await.unwrap();

        let response = create_app(feeds, None)
            .oneshot(
                Request::builder()
                    .uri("/sample.xml")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            "Feed initializing"
        );
    }

    #[tokio::test]
    async fn test_if_none_match_returns_304() {
        let payload = Bytes::from_static(b"cached-data");
        let entry = test_entry(payload);
        let etag = entry.etag.clone();
        let feeds = test_feed_map("sample", entry);
        let app = create_app(feeds, None);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/sample.pb")
                    .header(header::IF_NONE_MATCH, &etag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(resp.headers().get(header::ETAG).unwrap(), etag.as_str());
    }

    #[tokio::test]
    async fn test_stale_feed_warning_header() {
        let payload = Bytes::from_static(b"stale-data");
        let mut entry = test_entry(payload);
        entry.is_stale = true;
        let feeds = test_feed_map("sample", entry);
        let app = create_app(feeds, None);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/sample.pb")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::WARNING).unwrap(),
            "110 - \"Response is Stale\""
        );
    }

    #[tokio::test]
    async fn test_feed_expired_beyond_max_staleness_returns_503() {
        let payload = Bytes::from_static(b"ancient-data");
        let mut entry = test_entry(payload);
        entry.last_success_secs = 1000; // Far in the past
        let feeds = test_feed_map_with_max_staleness("sample", entry, 1);
        let app = create_app(feeds, None);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/sample.pb")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body, "Feed stale: upstream unreachable");
    }

    #[tokio::test]
    async fn test_route_wildcard_subpaths() {
        let payload = Bytes::from_static(b"protobuf-data");
        let feeds = test_feed_map("sample", test_entry(payload));
        let app = create_app(feeds, None);

        let resp1 = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/sample")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp1.status(), StatusCode::OK);

        let resp2 = app
            .oneshot(
                Request::builder()
                    .uri("/nested/tunnel/sample.pb")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp2.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_unknown_feed_returns_404() {
        let feeds = test_feed_map("sample", test_entry(Bytes::from_static(b"data")));
        let app = create_app(feeds, None);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/unknown.pb")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_auth_rejection_when_token_missing() {
        let feeds = test_feed_map("sample", test_entry(Bytes::from_static(b"data")));
        let app = create_app(feeds, Some("my-token".to_string()));

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/sample.pb")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_auth_rejection_with_invalid_token() {
        let feeds = test_feed_map("sample", test_entry(Bytes::from_static(b"data")));
        let app = create_app(feeds, Some("my-token".to_string()));

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/sample.pb")
                    .header("x-feed-token", "wrong-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_auth_success_via_header() {
        let feeds = test_feed_map("sample", test_entry(Bytes::from_static(b"data")));
        let app = create_app(feeds, Some("my-token".to_string()));

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/sample.pb")
                    .header("x-feed-token", "my-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_auth_success_via_url_encoded_query_token() {
        let feeds = test_feed_map("sample", test_entry(Bytes::from_static(b"data")));
        let app = create_app(feeds, Some("my secret token".to_string()));

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/sample.pb?token=my%20secret%20token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_subpath_health_endpoint() {
        let feeds = test_feed_map("sample", agencies::FeedEntry::default());
        let app = create_app(feeds, Some("secret123".to_string()));

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/tunnel/prefix/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body, r#"{"status":"ok"}"#);
    }

    #[tokio::test]
    async fn test_route_trailing_slash() {
        let payload = Bytes::from_static(b"protobuf-data");
        let feeds = test_feed_map("sample", test_entry(payload));
        let app = create_app(feeds, None);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/sample.pb/")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_if_none_match_weak_etag_returns_304() {
        let payload = Bytes::from_static(b"cached-data");
        let entry = test_entry(payload);
        let weak_etag = format!("W/{}", entry.etag);
        let feeds = test_feed_map("sample", entry);
        let app = create_app(feeds, None);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/sample.pb")
                    .header(header::IF_NONE_MATCH, &weak_etag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NOT_MODIFIED);
    }

    #[tokio::test]
    async fn test_if_none_match_comma_separated_list_returns_304() {
        let payload = Bytes::from_static(b"cached-data");
        let entry = test_entry(payload);
        let if_none_match = format!("\"other-etag\", {}, \"stale-etag\"", entry.etag);
        let feeds = test_feed_map("sample", entry);
        let app = create_app(feeds, None);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/sample.pb")
                    .header(header::IF_NONE_MATCH, &if_none_match)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NOT_MODIFIED);
    }

    #[tokio::test]
    async fn test_if_none_match_stale_feed_includes_warning_header() {
        let payload = Bytes::from_static(b"cached-data");
        let mut entry = test_entry(payload);
        entry.is_stale = true;
        let etag = entry.etag.clone();
        let feeds = test_feed_map("sample", entry);
        let app = create_app(feeds, None);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/sample.pb")
                    .header(header::IF_NONE_MATCH, &etag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(
            resp.headers()
                .get(header::WARNING)
                .and_then(|v| v.to_str().ok()),
            Some("110 - \"Response is Stale\"")
        );
    }

    #[tokio::test]
    async fn test_empty_token_string_is_unauthenticated() {
        let feeds = test_feed_map("sample", test_entry(Bytes::from_static(b"data")));
        // Empty string from compose ${FEED_ALERT_PROXY_TOKEN:-} should allow unauthenticated access
        let app = create_app(feeds, Some("   ".to_string()));

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/sample.pb")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
    }
    #[tokio::test]
    async fn status_auth_reports_never_successful_and_expired_feeds_without_payloads() {
        let mut expired = test_entry(Bytes::from_static(b"private-payload"));
        expired.last_success_secs = 1;
        expired.last_attempt_secs = Some(2);
        expired.partial = true;
        expired.last_failure = Some(crate::upstream::Failure::Transport);
        let mut map = (*test_feed_map("z-expired", expired)).clone();
        map.extend((*test_feed_map("a-cold", agencies::FeedEntry::default())).clone());
        let app = create_app(Arc::new(map), Some("private-token".into()));
        let denied = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/status")
                    .header("x-feed-token", "private-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let status: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let feeds = status["feeds"].as_array().unwrap();
        assert_eq!(feeds[0]["id"], "a-cold");
        assert!(feeds[0]["lastAttemptSecs"].is_null());
        assert!(feeds[0]["lastSuccessSecs"].is_null());
        assert!(feeds[0]["cachedAgeSecs"].is_null());
        assert_eq!(feeds[0]["stale"], true);
        assert_eq!(feeds[1]["lastAttemptSecs"], 2);
        assert_eq!(feeds[1]["lastSuccessSecs"], 1);
        assert_eq!(feeds[1]["stale"], true);
        assert_eq!(feeds[1]["partial"], true);
        assert_eq!(feeds[1]["lastFailure"], "transport");
        assert!(!String::from_utf8_lossy(&body).contains("private"));
    }

    #[tokio::test]
    async fn gtfs_relays_preserve_wire_bytes_and_failed_polls_keep_last_success() {
        for (parser, suffix, payload, content_type) in [
            (
                "gtfs-rt-protobuf",
                "pb",
                vec![10, 5, 10, 3, b'2', b'.', b'0', 160, 6, 1],
                "application/x-protobuf",
            ),
            (
                "gtfs-rt-json",
                "json",
                br#"{ "header":{"gtfs_realtime_version":"2.0"}, "entity":[], "custom":true }"#
                    .to_vec(),
                "application/json",
            ),
        ] {
            let malformed = if suffix == "json" {
                br#"{"header":{"gtfs_realtime_version":"2.0"},"entity":[{"id":"a","alert":{"header_text":{"translation":"broken"}}}]}"#.to_vec()
            } else {
                vec![
                    0x0a, 0x05, 0x0a, 0x03, b'2', b'.', b'0', 0x12, 0x05, 0x0a, 0x01, b'a', 0x1a,
                    0x00,
                ]
            };
            let (url, server) = local_upstream(vec![
                upstream_response("200 OK", &payload),
                upstream_response("200 OK", &malformed),
                upstream_response("200 OK", &payload),
            ])
            .await;
            let registry = agencies::registry::parse_registry_config(&serde_json::json!({"feeds":[{"id":"sample","parser":parser,"upstreamUrl":url,"pollIntervalSecs":1}]}).to_string(),None,None).unwrap();
            let feeds = agencies::spawn_pollers(crate::upstream::Client::new(), registry).unwrap();
            let handle = &feeds["sample"];
            let first = wait_for_entry(handle, |e| !e.bytes.is_empty()).await;
            let failed = wait_for_entry(handle, |e| e.last_failure.is_some()).await;
            assert_eq!(failed.bytes.as_ref(), payload);
            assert_eq!(failed.last_success_secs, first.last_success_secs);
            assert_eq!(failed.last_failure.unwrap().to_string(), "Decode");
            let app = create_app(feeds.clone(), None);
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/sample.{suffix}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_TYPE], content_type);
            assert!(response.headers().contains_key(header::WARNING));
            let etag = response.headers()[header::ETAG].clone();
            assert_eq!(
                response
                    .into_body()
                    .collect()
                    .await
                    .unwrap()
                    .to_bytes()
                    .as_ref(),
                payload
            );
            let response = app
                .oneshot(
                    Request::builder()
                        .uri(format!("/sample.{suffix}"))
                        .header(header::IF_NONE_MATCH, etag)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
            assert!(response.headers().contains_key(header::WARNING));
            let recovered = wait_for_entry(handle, |entry| {
                entry.last_failure.is_none() && entry.last_success_secs > first.last_success_secs
            })
            .await;
            assert!(!recovered.is_stale);
            assert!(!recovered.partial);
            server.await.unwrap();
        }
    }
    #[test]
    fn registry_rejects_invalid_request_configuration_at_startup() {
        for request in [
            serde_json::json!({"headers":{"x-bad\nname":"value"}}),
            serde_json::json!({"headers":{"x-key":"value\r\ninjected: yes"}}),
            serde_json::json!({"headers":{"Connection":"close"}}),
            serde_json::json!({"headers":{"If-None-Match":"*"}}),
            serde_json::json!({"headers":{"X-Key":"one","x-key":"two"}}),
            serde_json::json!({"headerSecrets":{"authorization":"MISSING"}}),
            serde_json::json!({"querySecrets":{"key":"BLANK"}}),
            serde_json::json!({"querySecrets":{"existing":"KEY"}}),
        ] {
            let config = serde_json::json!({"feeds":[{"id":"sample","parser":"gtfs-rt-json","upstreamUrl":"https://example.test/feed?existing=1","request":request}]}).to_string();
            let error = agencies::registry::parse_registry_config_with_secrets(
                &config,
                None,
                None,
                |name| match name {
                    "KEY" => Some("synthetic-secret".into()),
                    "BLANK" => Some(" ".into()),
                    _ => None,
                },
            )
            .unwrap_err();
            assert!(!error.contains("synthetic-secret"));
        }
    }
}
