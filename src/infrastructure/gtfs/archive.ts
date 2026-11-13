import { createStaticFeedIdentity, type FeedIdentity } from "./feedIdentity";
import * as Data from "effect/Data";
export const GTFS_MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
export const GTFS_MAX_EXPANDED_ENTRY_BYTES = 512 * 1024 * 1024;
export const GTFS_MAX_CSV_RECORD_BYTES = 1024 * 1024;

export class EmptyGtfsEntryError extends Data.TaggedError("EmptyGtfsEntryError")<{
  readonly entryName: string;
}> {
  override get message(): string {
    return `Required GTFS entry ${this.entryName} is empty`;
  }
}

export function assertGtfsArchiveSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > GTFS_MAX_ARCHIVE_BYTES)
    throw new Error("GTFS archive exceeds the compressed byte limit");
}

async function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cancellation must not replace the download or validation error.
  } finally {
    reader.releaseLock();
  }
}

/** Content-Length is only an early hint; count all actual bytes before retaining each chunk. */
export async function readGtfsArchiveResponse(
  response: Response,
  maxBytes = GTFS_MAX_ARCHIVE_BYTES,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > GTFS_MAX_ARCHIVE_BYTES)
    throw new Error("Invalid GTFS archive byte limit");
  const reader = response.body?.getReader();
  try {
    if (response.headers.get("content-type")?.toLowerCase().includes("text/html"))
      throw new Error("GTFS archive endpoint returned HTML");
    const length = response.headers.get("content-length")?.trim();
    if (length && /^\d+$/.test(length) && Number(length) > maxBytes)
      throw new Error("GTFS archive exceeds the compressed byte limit");
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value.byteLength > maxBytes - size)
          throw new Error("GTFS archive exceeds the compressed byte limit");
        size += chunk.value.byteLength;
        chunks.push(chunk.value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    if (reader) await releaseReader(reader);
  }
}

interface ZipEntry {
  readonly bytes: Uint8Array;
  readonly method: number;
  readonly size: number;
  readonly crc: number;
}

/** Read the central directory, retaining compressed slices rather than expanded files. */
export interface GtfsArchive extends ReadonlyMap<string, ZipEntry> {
  readonly identity?: (field: string, value: string) => string;
}
export function readGtfsArchive(bytes: Uint8Array, identity?: FeedIdentity): GtfsArchive {
  assertGtfsArchiveSize(bytes.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) <= bytes.length &&
      // Accept publisher trailers only after a footer whose directory ends here.
      view.getUint32(i + 16, true) + view.getUint32(i + 12, true) === i
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("Invalid GTFS ZIP directory");
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true))
    throw new Error("Multi-disk ZIP is unsupported");
  let pos = view.getUint32(end + 16, true);
  const entries = new Map<string, ZipEntry>();
  const count = view.getUint16(end + 10, true);
  const needed = new Set([
    "agency.txt",
    "routes.txt",
    "trips.txt",
    "stop_times.txt",
    "shapes.txt",
    "stops.txt",
    "calendar.txt",
    "calendar_dates.txt",
    "frequencies.txt",
  ]);
  for (let i = 0; i < count; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw new Error("Invalid GTFS ZIP entry");
    const nameLength = view.getUint16(pos + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
    if (needed.has(name)) {
      if (entries.has(name)) throw new Error(`Duplicate ZIP entry ${name}`);
      if (view.getUint16(pos + 8, true) & 1) throw new Error("Encrypted ZIP is unsupported");
      const method = view.getUint16(pos + 10, true);
      if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression ${method}`);
      let compressedSize = view.getUint32(pos + 20, true);
      let size = view.getUint32(pos + 24, true);
      let offset = view.getUint32(pos + 42, true);
      if ([compressedSize, size, offset].includes(0xffffffff)) {
        const extraStart = pos + 46 + nameLength,
          extraEnd = extraStart + view.getUint16(pos + 30, true);
        if (extraEnd > bytes.length) throw new Error("Truncated ZIP64 metadata");
        let found = false;
        for (let extra = extraStart; extra + 4 <= extraEnd;) {
          const kind = view.getUint16(extra, true),
            length = view.getUint16(extra + 2, true),
            limit = extra + 4 + length;
          if (limit > extraEnd) throw new Error("Truncated ZIP64 metadata");
          if (kind === 1) {
            let field = extra + 4;
            const value = () => {
              if (field + 8 > limit) throw new Error("Missing ZIP64 field");
              const number = view.getBigUint64(field, true);
              field += 8;
              if (number > BigInt(Number.MAX_SAFE_INTEGER))
                throw new Error("ZIP64 field exceeds safe byte bounds");
              return Number(number);
            };
            if (size === 0xffffffff) size = value();
            if (compressedSize === 0xffffffff) compressedSize = value();
            if (offset === 0xffffffff) offset = value();
            found = true;
            break;
          }
          extra = limit;
        }
        if (!found) throw new Error("Missing ZIP64 metadata");
      }
      if (size > GTFS_MAX_EXPANDED_ENTRY_BYTES)
        throw new Error(`GTFS expanded entry exceeds the byte limit: ${name}`);
      if (view.getUint32(offset, true) !== 0x04034b50) throw new Error("Invalid ZIP local header");
      const start =
        offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
      if (start + compressedSize > pos) throw new Error("Truncated GTFS ZIP entry");
      entries.set(name, {
        bytes: bytes.subarray(start, start + compressedSize),
        method,
        size,
        crc: view.getUint32(pos + 16, true),
      });
    }
    pos += 46 + nameLength + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true);
  }
  for (const name of ["routes.txt", "trips.txt", "stop_times.txt", "stops.txt"]) {
    const entry = entries.get(name);
    if (!entry) throw new Error(`Missing GTFS entry ${name}`);
    if (entry.size === 0) throw new EmptyGtfsEntryError({ entryName: name });
  }
  return Object.assign(entries, { identity: createStaticFeedIdentity(identity) });
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "",
    quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      result.push(current.trim());
      current = "";
    } else current += c;
  }
  if (quoted) throw new Error("Unterminated GTFS CSV field");
  result.push(current.trim());
  return result;
}

/** Never turn stop_times.txt into a whole-file string. Validate the ZIP CRC before mutation. */
export async function processArchiveCsv(
  archive: GtfsArchive,
  name: string,
  requiredColumns: readonly string[],
  onRow: (get: (column: string) => string) => void,
  /** Only stops.txt with a leading stop_id may skip unreferenced rows before width validation. */
  isRelevantStop?: (stopId: string) => boolean,
): Promise<void> {
  const entry = archive.get(name);
  if (!entry) throw new Error(`Missing GTFS entry ${name}`);
  if (entry.size > GTFS_MAX_EXPANDED_ENTRY_BYTES)
    throw new Error(`GTFS expanded entry exceeds the byte limit: ${name}`);
  let stream = new Blob([new Uint8Array(entry.bytes)]).stream();
  if (entry.method === 8) stream = stream.pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "",
    headers: string[] | undefined;
  let crc = 0xffffffff,
    size = 0,
    recordBytes = 0;
  const line = (text: string) => {
    if (!text.trim()) return;
    const row = parseCsvLine(text.trim());
    if (!headers) {
      headers = row;
      for (const column of requiredColumns)
        if (!headers.includes(column)) throw new Error(`Missing ${column} in ${name}`);
    } else {
      if (
        name === "stops.txt" &&
        headers[0] === "stop_id" &&
        isRelevantStop &&
        !isRelevantStop(archive.identity?.("stop_id", row[0]) ?? row[0])
      )
        return;
      if (row.length !== headers.length) throw new Error(`Invalid CSV row in ${name}`);
      const columns = headers;
      onRow((column) => {
        const value = row[columns.indexOf(column)] ?? "";
        return archive.identity?.(column, value) ?? value;
      });
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > GTFS_MAX_EXPANDED_ENTRY_BYTES - size)
        throw new Error(`GTFS expanded entry exceeds the byte limit: ${name}`);
      if (chunk.value.byteLength > entry.size - size)
        throw new Error(`Invalid GTFS ZIP payload ${name}: expanded bytes exceed declared size`);
      size += chunk.value.byteLength;
      for (const byte of chunk.value) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
      let start = 0;
      while (start < chunk.value.byteLength) {
        const newline = chunk.value.indexOf(10, start);
        const end = newline < 0 ? chunk.value.byteLength : newline;
        if (end - start > GTFS_MAX_CSV_RECORD_BYTES - recordBytes)
          throw new Error(`GTFS CSV record exceeds the byte limit: ${name}`);
        recordBytes += end - start;
        // Decode only a bounded physical record segment, retaining partial UTF-8 across chunks.
        const next = newline < 0 ? end : end + 1;
        const text = decoder.decode(chunk.value.subarray(start, next), { stream: true });
        if (newline < 0) pending += text;
        else {
          line(pending + text.slice(0, -1));
          pending = "";
          recordBytes = 0;
        }
        start = next;
      }
    }
    line(pending + decoder.decode());
    if (!headers || size !== entry.size || (crc ^ 0xffffffff) >>> 0 !== entry.crc)
      throw new Error(`Invalid GTFS ZIP payload ${name}`);
  } finally {
    await releaseReader(reader);
  }
}
