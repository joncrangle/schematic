/**
 * Lightweight, zero-dependency binary Protobuf wire format reader.
 * The GTFS-RT binary engine is agency-agnostic infrastructure.
 * Compatible with Node, Bun, Cloudflare Workers, and Browsers.
 */
const UTF8_DECODER = new TextDecoder();

export class ProtobufReader {
  private readonly buffer: Uint8Array;
  private readonly view: DataView;
  private offset: number;
  private readonly end: number;

  constructor(buffer: Uint8Array | ArrayBuffer, offset = 0, length?: number) {
    if (buffer instanceof ArrayBuffer) {
      this.buffer = new Uint8Array(buffer);
    } else {
      this.buffer = buffer;
    }
    this.view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
    this.offset = offset;
    this.end = length !== undefined ? offset + length : this.buffer.byteLength;
  }

  public hasMore(): boolean {
    return this.offset < this.end;
  }

  public getOffset(): number {
    return this.offset;
  }

  public setOffset(pos: number): void {
    this.offset = pos;
  }

  /**
   * Reads a protobuf field tag and wire type.
   * Returns [fieldNumber, wireType], or null if at end of buffer.
   */
  public readTag(): [number, number] | null {
    if (this.offset >= this.end) return null;
    const key = this.readVarint();
    const fieldNumber = key >>> 3;
    const wireType = key & 0x07;
    return [fieldNumber, wireType];
  }

  /**
   * Reads a varint as its exact unsigned 64-bit wire value.
   */
  private readVarintBig(): bigint {
    let result = 0n;
    let shift = 0n;
    let b: number;
    do {
      // A varint that runs out of bytes before its terminator is truncated.
      // Failing here keeps a partial value from decoding as a real one.
      this.ensure(1);
      b = this.buffer[this.offset++]!;
      // GTFS-RT timestamps are unsigned protobuf varints. Bitwise operators
      // coerce to signed 32-bit integers, which corrupts values above 2^31.
      // BigInt keeps the wire value unsigned and exact until the public number
      // boundary; all GTFS-RT fields consumed by this reader are JS-safe.
      // Bytes past the 64th bit of an overlong varint are consumed, not kept.
      if (shift < 64n) {
        result |= BigInt(b & 0x7f) << shift;
      }
      shift += 7n;
    } while (b & 0x80);
    return result;
  }

  /**
   * Throws unless `len` bytes remain before this reader's end. Every read goes
   * through this check, so a field cannot silently consume its parent's bytes.
   */
  private ensure(len: number): void {
    if (this.offset + len > this.end) {
      throw new Error(
        `Protobuf field of ${len} bytes overruns its enclosing message at offset ${this.offset}`,
      );
    }
  }

  /**
   * Reads an unsigned varint (up to 64-bit safe in JS integers).
   */
  public readVarint(): number {
    return Number(this.readVarintBig());
  }

  /**
   * Reads a signed int32. Negative values are sign-extended to 64 bits on the
   * wire, so they arrive as 10-byte varints that must be reinterpreted.
   */
  public readInt32(): number {
    return Number(BigInt.asIntN(32, this.readVarintBig()));
  }

  /**
   * Reads a signed int64 as a JS number, interpreting the 64-bit two's
   * complement value as negative when its top bit is set.
   */
  public readInt64String(): string {
    return BigInt.asIntN(64, this.readVarintBig()).toString();
  }

  public readInt64(): number {
    return Number(BigInt.asIntN(64, this.readVarintBig()));
  }

  /**
   * Reads a signed varint (ZigZag encoded sint32).
   */
  public readSint32(): number {
    const n = this.readVarint();
    return (n >>> 1) ^ -(n & 1);
  }

  /**
   * Reads a UTF-8 string with length prefix.
   */
  public readString(): string {
    const len = this.readVarint();
    if (len === 0) return "";
    this.ensure(len);
    const bytes = this.buffer.subarray(this.offset, this.offset + len);
    this.offset += len;
    return UTF8_DECODER.decode(bytes);
  }

  /**
   * Reads raw bytes with length prefix.
   */
  public readBytes(): Uint8Array {
    const len = this.readVarint();
    this.ensure(len);
    const bytes = this.buffer.subarray(this.offset, this.offset + len);
    this.offset += len;
    return bytes;
  }

  /**
   * Creates a sub-reader for an embedded message.
   */
  public readSubReader(): ProtobufReader {
    const len = this.readVarint();
    this.ensure(len);
    const subReader = new ProtobufReader(this.buffer, this.offset, len);
    this.offset += len;
    return subReader;
  }

  /**
   * Reads a 32-bit float (wire type 5).
   */
  public readFloat(): number {
    this.ensure(4);
    const val = this.view.getFloat32(this.offset, true); // little-endian
    this.offset += 4;
    return val;
  }

  /**
   * Reads a 64-bit double (wire type 1).
   */
  public readDouble(): number {
    this.ensure(8);
    const val = this.view.getFloat64(this.offset, true); // little-endian
    this.offset += 8;
    return val;
  }

  /**
   * Reads a 32-bit fixed integer (wire type 5).
   */
  public readFixed32(): number {
    this.ensure(4);
    const val = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return val;
  }

  /**
   * Skips a field based on its wire type.
   */
  public skip(wireType: number): void {
    switch (wireType) {
      case 0: // Varint
        this.readVarint();
        break;
      case 1: // 64-bit
        this.ensure(8);
        this.offset += 8;
        break;
      case 2: {
        // Length-delimited
        const len = this.readVarint();
        this.ensure(len);
        this.offset += len;
        break;
      }
      case 5: // 32-bit
        this.ensure(4);
        this.offset += 4;
        break;
      default:
        throw new Error(`Unsupported Protobuf wire type: ${wireType}`);
    }
  }
}
