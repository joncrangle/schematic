import { expect, it, vi } from "vitest";
import {
  assertGtfsArchiveSize,
  readGtfsArchiveResponse,
  readGtfsArchive,
  processArchiveCsv,
} from "~/infrastructure/gtfs/archive";
import { gtfsZip } from "../helpers/gtfsArchive";

it("bounds compressed archive sizes without allocating an archive", () => {
  expect(() => assertGtfsArchiveSize(128 * 1024 * 1024)).not.toThrow();
  expect(() => assertGtfsArchiveSize(128 * 1024 * 1024 + 1)).toThrow(/archive.*limit/i);
});

it.each(["4", null])(
  "reads a response exactly at its byte limit, content-length=%s",
  async (length) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    });
    const response = new Response(stream, { headers: length ? { "content-length": length } : {} });
    expect(await readGtfsArchiveResponse(response, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(stream.locked).toBe(false);
  },
);

it.each([null, "1", "not-a-number", "-1"])(
  "counts actual response bytes and preserves the overflow error despite cancellation failure, content-length=%s",
  async (length) => {
    let part = 0;
    const cancel = vi.fn(() => {
      throw new Error("cancel failed");
    });
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array(part++ === 0 ? [1, 2] : [3, 4, 5]));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const response = new Response(stream, { headers: length ? { "content-length": length } : {} });
    await expect(readGtfsArchiveResponse(response, 4)).rejects.toThrow(/archive.*limit/i);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  },
);

it("rejects an oversized Content-Length before reading the body", async () => {
  const pull = vi.fn();
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  const response = new Response(stream, { headers: { "content-length": "134217729" } });
  await expect(readGtfsArchiveResponse(response)).rejects.toThrow(/archive.*limit/i);
  expect(pull).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(stream.locked).toBe(false);
});

function declaredSize(name: string, size: number) {
  const bytes = gtfsZip(
    {
      "routes.txt": "route_id,route_type\nr,3\n",
      "trips.txt": "route_id,trip_id\nr,t\n",
      "stop_times.txt": "trip_id,stop_id,stop_sequence\nt,1,1\n",
      "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\n1,Main,43,-79\n",
      "ignored.txt": "unused",
    },
    true,
  );
  const view = new DataView(bytes.buffer);
  let pos = view.getUint32(bytes.length - 6, true);
  while (view.getUint32(pos, true) === 0x02014b50) {
    const length = view.getUint16(pos + 28, true);
    if (new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + length)) === name) {
      view.setUint32(pos + 24, size, true);
      return bytes;
    }
    pos += 46 + length;
  }
  throw new Error("Missing fixture entry");
}

it("rejects oversized needed entries before decompression, without imposing expanded limits on ignored files", () => {
  expect(() => readGtfsArchive(declaredSize("stop_times.txt", 512 * 1024 * 1024 + 1))).toThrow(
    /expanded.*limit/i,
  );
  expect(readGtfsArchive(declaredSize("ignored.txt", 0xffffffff)).has("routes.txt")).toBe(true);
});

it("rejects actual expansion beyond a forged smaller declaration before decoding rows", async () => {
  const archive = readGtfsArchive(declaredSize("stops.txt", 1));
  const onRow = vi.fn();
  await expect(processArchiveCsv(archive, "stops.txt", ["stop_id"], onRow)).rejects.toThrow(
    /declared size/i,
  );
  expect(onRow).not.toHaveBeenCalled();
});

it("rejects an HTML shell returned successfully by an archive endpoint", async () => {
  await expect(
    readGtfsArchiveResponse(
      new Response("<!doctype html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    ),
  ).rejects.toThrow("GTFS archive endpoint returned HTML");
});

it("reads bounded ZIP64 entry sizes and offsets through CSV decoding", async () => {
  const bytes = gtfsZip(
    {
      "routes.txt": "route_id,route_type\nr,3\n",
      "trips.txt": "trip_id\nt\n",
      "stop_times.txt": "trip_id\nt\n",
      "stops.txt": "stop_id\nP\n",
    },
    true,
    true,
  );
  const values: string[] = [];
  await processArchiveCsv(readGtfsArchive(bytes), "stops.txt", ["stop_id"], (get) =>
    values.push(get("stop_id")),
  );
  expect(values).toEqual(["P"]);
});

it("reads a complete archive followed by a truncated duplicate end record", async () => {
  const zip = gtfsZip({
    "routes.txt": "route_id,route_type\nr,3\n",
    "trips.txt": "trip_id\nt\n",
    "stop_times.txt": "trip_id\nt\n",
    "stops.txt": "stop_id\nP\n",
  });
  const duplicate = zip.slice(-22);
  const view = new DataView(duplicate.buffer);
  view.setUint32(16, view.getUint32(16, true) + 21, true);
  const bytes = new Uint8Array(zip.length + 21);
  bytes.set(zip);
  bytes.set(duplicate.subarray(1), zip.length);
  const values: string[] = [];
  await processArchiveCsv(readGtfsArchive(bytes), "stops.txt", ["stop_id"], (get) =>
    values.push(get("stop_id")),
  );
  expect(values).toEqual(["P"]);
});

it("ignores a trailing end signature that does not point to the central directory", () => {
  const zip = gtfsZip({
    "routes.txt": "route_id\nr\n",
    "trips.txt": "trip_id\nt\n",
    "stop_times.txt": "trip_id\nt\n",
    "stops.txt": "stop_id\nP\n",
  });
  const bytes = new Uint8Array(zip.length + 22);
  bytes.set(zip);
  new DataView(bytes.buffer).setUint32(zip.length, 0x06054b50, true);
  expect(readGtfsArchive(bytes).has("stops.txt")).toBe(true);
});

it("rejects a directory outside the bounded footer search", () => {
  const zip = gtfsZip({});
  const bytes = new Uint8Array(zip.length + 65536);
  bytes.set(zip);
  expect(() => readGtfsArchive(bytes)).toThrow("Invalid GTFS ZIP directory");
});
