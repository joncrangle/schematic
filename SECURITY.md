# Security Policy

The **Schematic** project takes security and user privacy seriously. This document details our supported versions, reporting procedures, and architectural security guarantees.

---

## Supported Versions

Only the latest release running on the `master` branch is actively supported with security updates.

| Branch                          | Supported |
| :------------------------------ | :-------- |
| `master`                        | ✅ Yes    |
| Pre-release / Experimental tags | ❌ No     |

---

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please **do not open a public GitHub issue**.

Report it through GitHub Private Vulnerability Reporting, the only channel for security reports:

1. Open the **Security** tab of the repository on GitHub.
2. Click **Report a vulnerability** and include a clear summary, steps to reproduce, and a proof of concept if you have one.

Reports are handled on a best-effort basis; there is no guaranteed response time. When a fix is released, a security advisory may be published, crediting the reporter if they wish.

### Hosted instances

Anyone can run their own instance of Schematic. The maintainers of this repository do not operate other people's instances and cannot help with access to them, their data, or their outages. Contact that instance's operator instead. Report here only problems in the code in this repository.

---

## Architectural Security & Privacy Principles

Terms are defined in [GLOSSARY.md](GLOSSARY.md).

1. **No location logging or storage on the server**:
   - Coordinates sent to the nearby server functions (`fetchNearbyTransit`, `fetchNearbyStations`) are used in memory for distance calculations and then discarded. The server does not log them or write them to a database.
   - The optional coarse-location tier estimates a city-level position from the request's IP address, using Cloudflare's edge data or a GeoLite2 database on the host. The result is returned to the browser and is not logged or stored.
   - The app sends no data to analytics services.

2. **No accounts or login**:
   - The app has no accounts, passwords, or sessions. Anyone who can reach an instance can use it. Restricting who can reach an instance is the host operator's choice.
   - Favourites stay on the device. If a rider enables commute notifications, the host stores their push subscription, the relevant favourites, and their commute schedule so it can send matching alerts.

3. **Input validation**:
   - Server function inputs are treated as untrusted and checked at the server boundary. Coordinates must be valid latitudes and longitudes, the nearby search radius is capped at 1.5 km, and list inputs are bounded.
   - Agency feeds are parsed by typed decoders before their content is shown.

4. **Credentials**:
   - Private credentials (feed API keys, VAPID keys) are read from environment variables or Cloudflare secrets and are not committed to the repository. A few agency feed URLs contain a key or token that the operator publishes openly; the [data-source list](docs/data-attribution.md) says so for each.
