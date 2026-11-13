//! Per-feed request configuration. Resolved secrets never appear in Debug output.
use reqwest::{
    Url,
    header::{HeaderMap, HeaderName, HeaderValue},
};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, HashSet},
    error::Error,
    fmt,
};
#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Failure {
    Transport,
    Http,
    Decode,
    TooLarge,
    Upstream,
}
impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl Error for Failure {}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestConfig {
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    header_secrets: BTreeMap<String, String>,
    #[serde(default)]
    query_secrets: BTreeMap<String, String>,
}

#[derive(Clone, Default)]
pub struct ResolvedRequest {
    headers: HeaderMap,
    query: Vec<(String, String)>,
    origin: String,
}
impl std::fmt::Debug for ResolvedRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ResolvedRequest [redacted]")
    }
}
impl RequestConfig {
    pub fn resolve(
        &self,
        url: &str,
        secret: impl Fn(&str) -> Option<String>,
    ) -> Result<ResolvedRequest, String> {
        let url = Url::parse(url).map_err(|_| "invalid upstream URL")?;
        let mut resolved = ResolvedRequest {
            origin: url.origin().ascii_serialization(),
            ..Default::default()
        };
        let mut names = HashSet::new();
        for (name, value, is_secret) in self
            .headers
            .iter()
            .map(|(k, v)| (k, v, false))
            .chain(self.header_secrets.iter().map(|(k, v)| (k, v, true)))
        {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "invalid request header name")?;
            if matches!(
                name.as_str(),
                "host"
                    | "connection"
                    | "content-length"
                    | "transfer-encoding"
                    | "te"
                    | "trailer"
                    | "upgrade"
                    | "proxy-authorization"
                    | "proxy-connection"
                    | "if-match"
                    | "if-none-match"
                    | "if-modified-since"
                    | "if-unmodified-since"
                    | "if-range"
                    | "keep-alive"
                    | "expect"
                    | "accept-encoding"
                    | "range"
                    | "content-type"
                    | "anyride-profile-data"
                    | "anyride-profile-display"
            ) || !names.insert(name.clone())
            {
                return Err("conflicting or reserved request header".into());
            }
            let value = if is_secret {
                resolve_secret(value, &secret)?
            } else {
                value.clone()
            };
            let mut value =
                HeaderValue::from_str(&value).map_err(|_| "invalid request header value")?;
            value.set_sensitive(true);
            resolved.headers.insert(name, value);
        }
        for (name, env) in &self.query_secrets {
            if name.trim().is_empty()
                || name.chars().any(char::is_control)
                || url.query_pairs().any(|(key, _)| key == name.as_str())
            {
                return Err("conflicting or invalid credential query name".into());
            }
            resolved
                .query
                .push((name.clone(), resolve_secret(env, &secret)?));
        }
        Ok(resolved)
    }
}
fn resolve_secret(name: &str, secret: &impl Fn(&str) -> Option<String>) -> Result<String, String> {
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return Err("invalid credential environment reference".into());
    }
    secret(name)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| "missing or blank upstream credential environment variable".into())
}

/// Requests are origin-bound when configured. Every request, including subrequests,
/// receives credentials independently; redirects are always refused.
#[derive(Clone, Debug)]
pub struct Client {
    inner: reqwest::Client,
    request: ResolvedRequest,
}
pub struct ClientBuilder(reqwest::ClientBuilder);
impl Default for Client {
    fn default() -> Self {
        Self::new()
    }
}
impl Client {
    pub fn new() -> Self {
        Self::builder().build().expect("HTTP client")
    }
    pub fn builder() -> ClientBuilder {
        ClientBuilder(
            reqwest::Client::builder()
                .user_agent("Mozilla/5.0")
                // Legacy servers fold response headers across lines; unfold them before decoding.
                .http1_allow_obsolete_multiline_headers_in_responses(true),
        )
    }
    /// Downloads a complete successful response without retaining URLs in errors.
    pub async fn download(&self, url: &str, limit: usize) -> Result<bytes::Bytes, Failure> {
        let mut response = self.get(url).send().await.map_err(|_| Failure::Transport)?;
        if !response.status().is_success() {
            return Err(Failure::Http);
        }
        if response.content_length().is_some_and(|n| n > limit as u64) {
            return Err(Failure::TooLarge);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Failure::Transport)? {
            if bytes.len().saturating_add(chunk.len()) > limit {
                return Err(Failure::TooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes.into())
    }
    pub fn configured(&self, request: ResolvedRequest) -> Self {
        Self {
            inner: self.inner.clone(),
            request,
        }
    }
    pub fn get(&self, url: impl AsRef<str>) -> reqwest::RequestBuilder {
        self.request(reqwest::Method::GET, url.as_ref())
    }
    pub fn post(&self, url: impl AsRef<str>) -> reqwest::RequestBuilder {
        self.request(reqwest::Method::POST, url.as_ref())
    }
    fn request(&self, method: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
        let Ok(mut url) = Url::parse(url) else {
            return self.inner.request(method, url);
        };
        if !self.request.origin.is_empty()
            && url.origin().ascii_serialization() != self.request.origin
        {
            // Invalid header produces a builder error without issuing a request.
            return self
                .inner
                .request(method, url)
                .header("x-invalid-origin", "\n");
        }
        for (name, value) in &self.request.query {
            // Replace credentials even when a paginator echoes the previous URL.
            let pairs: Vec<_> = url
                .query_pairs()
                .filter(|(key, _)| key != name.as_str())
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            url.set_query(None);
            url.query_pairs_mut()
                .extend_pairs(pairs)
                .append_pair(name, value);
        }
        self.inner
            .request(method, url)
            .headers(self.request.headers.clone())
    }
}
impl ClientBuilder {
    pub fn timeout(self, timeout: std::time::Duration) -> Self {
        Self(self.0.timeout(timeout))
    }
    pub fn build(self) -> Result<Client, reqwest::Error> {
        Ok(Client {
            inner: self.0.redirect(reqwest::redirect::Policy::none()).build()?,
            request: ResolvedRequest::default(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn accepts_legacy_folded_response_headers() {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(&mut stream);
            loop {
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
            }
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Security-Policy-Report-Only: default-src 'self';\r\n    img-src https:;\r\nConnection: close\r\n\r\nOK").unwrap();
        });
        let body = Client::new()
            .download(&format!("http://{address}/feed"), 16)
            .await
            .unwrap();
        assert_eq!(body.as_ref(), b"OK");
        server.join().unwrap();
    }
    #[test]
    fn validates_credentials_without_disclosing_values() {
        for config in [
            serde_json::json!({"headers":{"Host":"secret-value"}}),
            serde_json::json!({"headers":{"X-Key":"secret-value"},"headerSecrets":{"x-key":"KEY"}}),
            serde_json::json!({"headerSecrets":{"x-key":"KEY"}}),
        ] {
            let config: RequestConfig = serde_json::from_value(config).unwrap();
            let error = config
                .resolve("https://example.test/feed", |_| None)
                .unwrap_err();
            assert!(!error.contains("secret-value"));
        }
        let config: RequestConfig = serde_json::from_value(serde_json::json!({"headerSecrets":{"authorization":"KEY"},"querySecrets":{"key":"KEY"}})).unwrap();
        let resolved = config
            .resolve("https://example.test/feed", |_| {
                Some("private-value".into())
            })
            .unwrap();
        assert!(!format!("{resolved:?}").contains("private-value"));
        let client = Client::new().configured(resolved);
        let request = client
            .get("https://example.test/page?key=echo&n=2")
            .build()
            .unwrap();
        assert_eq!(request.headers()["authorization"], "private-value");
        assert_eq!(
            request
                .url()
                .query_pairs()
                .filter(|(k, _)| k == "key")
                .count(),
            1
        );
        assert_eq!(
            request
                .url()
                .query_pairs()
                .find(|(k, _)| k == "key")
                .unwrap()
                .1,
            "private-value"
        );
        assert!(client.get("https://other.test/page").build().is_err());
    }
}
