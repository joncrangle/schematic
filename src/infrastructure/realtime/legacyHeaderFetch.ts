import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** Direct self-hosted transport for explicitly declared legacy response headers. */
export async function fetchLegacyHeaderDocument(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (!["http:", "https:"].includes(url.protocol) || !["GET", "HEAD"].includes(request.method))
    throw new Error("Legacy header transport requires an HTTP GET or HEAD");
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send(
      url,
      {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        signal: request.signal,
        // Compatibility concerns HTTP syntax only; TLS certificate validation stays enabled.
        insecureHTTPParser: true,
      },
      (incoming) => {
        try {
          const headers = new Headers();
          for (let i = 0; i < incoming.rawHeaders.length; i += 2)
            headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
          const status = incoming.statusCode ?? 502;
          const noBody = request.method === "HEAD" || [204, 205, 304].includes(status);
          const iterator = incoming[Symbol.asyncIterator]();
          const body = noBody
            ? null
            : new ReadableStream<Uint8Array>({
                async pull(controller) {
                  try {
                    const next = await iterator.next();
                    if (next.done) controller.close();
                    else controller.enqueue(new Uint8Array(next.value));
                  } catch (cause) {
                    controller.error(cause);
                  }
                },
                cancel() {
                  incoming.destroy();
                },
              });
          if (noBody) incoming.resume();
          resolve(new Response(body, { status, statusText: incoming.statusMessage, headers }));
        } catch (cause) {
          incoming.destroy();
          reject(cause);
        }
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}
