# Modified trip fixture

`modified-trip.textproto` reduces a 2026-10-09 vendor capture to fictional trip,
stop, and modification IDs. The TypeScript realtime and station decoders and
Rust generated decoder share the text-encoded protobuf bytes in `modified-trip.hex`.

Regenerate from the repository root:

```sh
protoc --encode=transit_realtime.FeedMessage proto/gtfs-realtime.proto < tests/fixtures/gtfs-rt/modified-trip.textproto | xxd -p > tests/fixtures/gtfs-rt/modified-trip.hex
```

The fixture retains a route-less modified selector and a zero wire delay beside
predicted and scheduled event times. Static membership supplies route `R` and
direction `1`; the departure is 320 seconds late.
