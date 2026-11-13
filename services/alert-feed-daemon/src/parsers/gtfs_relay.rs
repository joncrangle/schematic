//! Byte-preserving GTFS-RT wire validation. Interpretation stays in Core.
use crate::{
    agencies::ScrapeOutcome,
    upstream::{Client, Failure},
};
use prost_reflect::{
    DescriptorPool, DeserializeOptions, DynamicMessage, Kind, MessageDescriptor, ReflectMessage,
    Value,
};
use std::{error::Error, sync::OnceLock};

pub const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;

fn feed_descriptor() -> MessageDescriptor {
    static DESCRIPTOR: OnceLock<MessageDescriptor> = OnceLock::new();
    DESCRIPTOR
        .get_or_init(|| {
            DescriptorPool::decode(
                include_bytes!(concat!(env!("OUT_DIR"), "/gtfs-descriptor.bin")).as_ref(),
            )
            .expect("compiled GTFS descriptor")
            .get_message_by_name("transit_realtime.FeedMessage")
            .expect("GTFS FeedMessage")
        })
        .clone()
}

pub fn validate(bytes: &[u8], json: bool) -> Result<(), Failure> {
    if bytes.is_empty() || bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(Failure::Decode);
    }
    let descriptor = feed_descriptor();
    let message = if json {
        let value: serde_json::Value =
            serde_json::from_slice(bytes).map_err(|_| Failure::Decode)?;
        validate_json_names(&value, &descriptor)?;
        DynamicMessage::deserialize_with_options(
            descriptor,
            &value,
            &DeserializeOptions::new().deny_unknown_fields(false),
        )
        .map_err(|_| Failure::Decode)?
    } else {
        DynamicMessage::decode(descriptor, bytes).map_err(|_| Failure::Decode)?
    };
    validate_required(&message)?;
    let header = message.get_field_by_name("header").ok_or(Failure::Decode)?;
    let Value::Message(header) = header.as_ref() else {
        return Err(Failure::Decode);
    };
    let version = header
        .get_field_by_name("gtfs_realtime_version")
        .ok_or(Failure::Decode)?;
    if !matches!(version.as_ref(), Value::String(version) if matches!(version.as_str(), "1" | "1.0" | "2.0"))
    {
        return Err(Failure::Decode);
    }
    Ok(())
}

/// Validate wire presence rather than Prost's defaulted required-field values.
fn validate_required(message: &DynamicMessage) -> Result<(), Failure> {
    for field in message.descriptor().fields() {
        if field.is_required() && !message.has_field(&field) {
            return Err(Failure::Decode);
        }
    }
    for (_, value) in message.fields() {
        validate_value(value)?;
    }
    Ok(())
}
fn validate_value(value: &Value) -> Result<(), Failure> {
    match value {
        Value::Message(message) => validate_required(message)?,
        Value::List(values) => {
            for value in values {
                validate_value(value)?;
            }
        }
        Value::Map(values) => {
            for value in values.values() {
                validate_value(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Core consumes snake_case JSON. Reject known camelCase aliases rather than
/// caching a document whose fields Core would ignore. Unknown extensions survive.
fn validate_json_names(
    value: &serde_json::Value,
    descriptor: &MessageDescriptor,
) -> Result<(), Failure> {
    let Some(object) = value.as_object() else {
        return if value.is_null() {
            Ok(())
        } else {
            Err(Failure::Decode)
        };
    };
    for field in descriptor.fields() {
        if field.json_name() != field.name() && object.contains_key(field.json_name()) {
            return Err(Failure::Decode);
        }
        if let Some(value) = object.get(field.name())
            && let Kind::Message(child) = field.kind()
        {
            if field.is_list() {
                if let Some(values) = value.as_array() {
                    for value in values {
                        validate_json_names(value, &child)?;
                    }
                }
            } else {
                validate_json_names(value, &child)?;
            }
        }
    }
    Ok(())
}

pub async fn scrape(
    client: &Client,
    url: &str,
    json: bool,
) -> Result<ScrapeOutcome, Box<dyn Error + Send + Sync>> {
    let bytes = client.download(url, MAX_DOCUMENT_BYTES).await?;
    validate(&bytes, json)?;
    Ok(ScrapeOutcome {
        bytes,
        partial: false,
        content_type: if json {
            "application/json"
        } else {
            "application/x-protobuf"
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn preserves_the_compound_entity_contract_for_core() {
        use base64::Engine;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/complete-trip-updates.json"
        ))
        .unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(fixture["feedBase64"].as_str().unwrap())
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let response = bytes.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        response.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            socket.write_all(&response).await.unwrap();
        });
        let outcome = scrape(&Client::new(), &format!("http://{address}/feed"), false)
            .await
            .unwrap();
        assert_eq!(outcome.bytes, bytes);
        assert!(!outcome.partial);
        server.await.unwrap();
    }

    #[test]
    fn preserves_named_extension_evidence_for_core_interpretation() {
        let payload = br#"{"header":{"gtfs_realtime_version":"2.0"},"entity":[{"id":"notice-a","alert":{"header_text":{"translation":[{"text":"Work on the network"}]},"example.alert":{"category":"Suspension","priority":3,"published":true}}}]}"#;
        assert!(validate(payload, true).is_ok());
    }

    #[test]
    fn validates_wire_envelopes_without_interpreting_alerts() {
        assert!(
            validate(
                br#"{"header":{"gtfs_realtime_version":"2.0"},"entity":[],"extension":true}"#,
                true
            )
            .is_ok()
        );
        assert!(validate(&[10, 5, 10, 3, b'2', b'.', b'0', 160, 6, 1], false).is_ok());
        for bytes in [
            b"<html>blocked</html>".as_slice(),
            b"{}",
            br#"{"header":{}}"#,
            br#"{"header":{"gtfs_realtime_version":"2.0"},"entity":{}}"#,
            br#"{"header":{"gtfs_realtime_version":"2.0"},"entity":[{"id":"a","alert":false}]}"#,
        ] {
            assert!(validate(bytes, true).is_err());
            assert!(validate(bytes, false).is_err());
        }
        assert!(validate(br#"{"header":{"gtfs_realtime_version":"2.0"},"entity":[{"id":"a","alert":{"header_text":{"translation":"broken"}}}]}"#, true).is_err());
        assert!(
            validate(
                &[
                    0x0a, 0x05, 0x0a, 0x03, b'2', b'.', b'0', 0x12, 0x05, 0x0a, 0x01, b'a', 0x1a,
                    0x00
                ],
                false
            )
            .is_err()
        );
        assert!(validate(&[10, 0], false).is_err());
    }
    #[tokio::test]
    async fn rejects_challenges_redirects_and_oversized_bodies() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let redirect_target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        for response in [
            b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\nConnection: close\r\n\r\n<html>blocked</html>".to_vec(),
            format!("HTTP/1.1 302 Found\r\nLocation: http://{}/secret\r\nContent-Length: 0\r\n\r\n", redirect_target.local_addr().unwrap()).into_bytes(),
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", MAX_DOCUMENT_BYTES + 1).into_bytes(),
            {
                let mut response = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
                response.resize(response.len() + MAX_DOCUMENT_BYTES + 1, b'x');
                response
            },
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket,_) = listener.accept().await.unwrap();
                let mut buffer = [0;4096];
                assert!(socket.read(&mut buffer).await.unwrap() > 0);
                let _ = socket.write_all(&response).await;
            });
            let config: crate::upstream::RequestConfig = serde_json::from_value(serde_json::json!({"headerSecrets":{"authorization":"KEY"},"querySecrets":{"key":"KEY"}})).unwrap();
            let url = format!("http://{address}/feed");
            let client = Client::new().configured(config.resolve(&url, |_| Some("synthetic-secret".into())).unwrap());
            let error = scrape(&client,&url,true).await.unwrap_err();
            assert!(!error.to_string().contains("synthetic-secret"));
            assert!(error.downcast_ref::<Failure>().is_some());
            server.await.unwrap();
        }
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(50),
                redirect_target.accept()
            )
            .await
            .is_err()
        );
    }
}
