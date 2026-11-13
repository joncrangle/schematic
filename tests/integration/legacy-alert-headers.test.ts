import { createServer } from "node:net";
import { once } from "node:events";
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { fetchAgencyAlerts } from "~/infrastructure/realtime/fetchAgencyAlerts";

it("reads a direct self-hosted closure board with explicitly permitted folded headers", async () => {
  const html =
    "<table><tr><th>Route</th><th>Closed Stop</th><th>Alternate Stop</th><th>Start Date</th><th>End Date</th></tr><tr><td>7</td><td>Stop 42 - Oak Avenue</td><td>Stop 43 - Elm Avenue</td><td>Jan 10, 2027</td><td>Until further notice</td></tr></table>";
  const server = createServer((socket) =>
    socket.once("data", () =>
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(html)}\r\nContent-Security-Policy-Report-Only: default-src 'self';\r\n    img-src https:;\r\nConnection: close\r\n\r\n${html}`,
      ),
    ),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  try {
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "sample",
        now: () => Date.parse("2027-01-11T12:00:00Z"),
        timeZone: "America/Regina",
        hostingTarget: "self-hosted",
        fetch,
        sources: [
          {
            type: "web",
            parser: "stop-closure-table",
            url: `http://127.0.0.1:${address.port}/notices`,
            allowLegacyResponseHeaders: true,
            routeNames: { R7: ["7"] },
          },
        ],
      }),
    );
    expect(snapshot).toMatchObject({
      freshness: "live",
      alerts: [{ title: "Stop 42 closed", scope: "station", severity: "severe" }],
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});
