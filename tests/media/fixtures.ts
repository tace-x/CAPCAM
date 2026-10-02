import { deflateSync } from "node:zlib";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32(value: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, false);
  return result;
}

function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const contents = joinBytes(typeBytes, data);
  return joinBytes(uint32(data.length), contents, uint32(crc32(contents)));
}

export function createPngFile(width = 1, height = 1, name = "fixture.png"): File {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  header.set([8, 6, 0, 0, 0], 8);
  const row = new Uint8Array(width * 4 + 1);
  row[0] = 0;
  for (let offset = 1; offset < row.length; offset += 4) {
    row.set([70, 160, 120, 255], offset);
  }
  const scanlines = new Uint8Array(row.length * height);
  for (let y = 0; y < height; y += 1) scanlines.set(row, y * row.length);
  const png = joinBytes(
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", new Uint8Array(deflateSync(scanlines))),
    pngChunk("IEND", new Uint8Array()),
  );
  const pngBuffer = new ArrayBuffer(png.byteLength);
  new Uint8Array(pngBuffer).set(png);
  return new File([pngBuffer], name, { type: "image/png" });
}

export function createWebmHeaderFile(name = "fixture.webm", declaredType = "video/webm"): File {
  return new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x86, 0x81, 0x01])], name, { type: declaredType });
}

export function createTextFile(name = "not-media.txt"): File {
  return new File(["This is not a supported media container."], name, { type: "text/plain" });
}

export function createCorruptPngFile(name = "corrupt.png"): File {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0])], name, { type: "image/png" });
}
