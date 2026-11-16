// Minimal dependency-free PNG decode -> downscale -> Gaussian-like blur -> PNG encode.
// The room uses it to hand AI guessers exactly the blur stage a human sees, so
// vision models get no sharper picture than people do.
//
// blurPx is defined relative to a 512 px wide image (the client scales its CSS
// blur by displayWidth / 512 to match).

import { deflateSync, inflateSync } from "node:zlib";

export const BLUR_REFERENCE_WIDTH = 512;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PAPER = [246, 239, 223]; // Transparent pixels are composited over paper cream.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decodes an 8-bit, non-interlaced PNG into { width, height, rgb: Uint8Array }. */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Not a PNG image");
  let offset = 8;
  let header = null;
  let palette = null;
  let paletteAlpha = null;
  const data = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), bitDepth: body[8], colorType: body[9], interlace: body[12] };
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") paletteAlpha = body;
    else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
  }
  if (!header) throw new Error("PNG has no header");
  const { width, height, bitDepth, colorType, interlace } = header;
  if (bitDepth !== 8 || interlace !== 0) throw new Error("Only 8-bit non-interlaced PNGs are supported");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error("Palette PNG without a palette");
  if (width < 1 || height < 1 || width * height > 16_000_000) throw new Error("PNG size is out of range");
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error("PNG data is truncated");
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const source = y * (stride + 1) + 1;
    const target = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[target + x - channels] : 0;
      const up = y > 0 ? pixels[target - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[target - stride + x - channels] : 0;
      const value = raw[source + x];
      let out;
      switch (filter) {
        case 0: out = value; break;
        case 1: out = value + left; break;
        case 2: out = value + up; break;
        case 3: out = value + ((left + up) >> 1); break;
        case 4: out = value + paeth(left, up, upLeft); break;
        default: throw new Error(`Bad PNG filter ${filter}`);
      }
      pixels[target + x] = out & 0xff;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    let r;
    let g;
    let b;
    let a = 255;
    const p = index * channels;
    if (colorType === 0) r = g = b = pixels[p];
    else if (colorType === 4) { r = g = b = pixels[p]; a = pixels[p + 1]; }
    else if (colorType === 2) { r = pixels[p]; g = pixels[p + 1]; b = pixels[p + 2]; }
    else if (colorType === 6) { r = pixels[p]; g = pixels[p + 1]; b = pixels[p + 2]; a = pixels[p + 3]; }
    else {
      const entry = pixels[p];
      r = palette[entry * 3]; g = palette[entry * 3 + 1]; b = palette[entry * 3 + 2];
      a = paletteAlpha && entry < paletteAlpha.length ? paletteAlpha[entry] : 255;
    }
    rgb[index * 3] = (r * a + PAPER[0] * (255 - a)) / 255;
    rgb[index * 3 + 1] = (g * a + PAPER[1] * (255 - a)) / 255;
    rgb[index * 3 + 2] = (b * a + PAPER[2] * (255 - a)) / 255;
  }
  return { width, height, rgb };
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** Encodes RGB8 pixels as a PNG (Sub filter on every row, which suits smooth blurred images). */
export function encodePng({ width, height, rgb }) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 1;
    for (let x = 0; x < stride; x += 1) {
      const value = rgb[y * stride + x];
      const left = x >= 3 ? rgb[y * stride + x - 3] : 0;
      raw[row + 1 + x] = (value - left) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Area-average downscale so the longer side is at most `maxSide`. */
export function downscale(image, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  if (scale === 1) return image;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor((y * image.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * image.height) / height));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor((x * image.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * image.width) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const p = (sy * image.width + sx) * 3;
          r += image.rgb[p]; g += image.rgb[p + 1]; b += image.rgb[p + 2];
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const q = (y * width + x) * 3;
      rgb[q] = r / count; rgb[q + 1] = g / count; rgb[q + 2] = b / count;
    }
  }
  return { width, height, rgb };
}

// Box sizes whose three passes approximate a Gaussian with standard deviation sigma.
function boxRadii(sigma) {
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower -= 1;
  const upper = lower + 2;
  const m = Math.round((12 * sigma * sigma - 3 * lower * lower - 12 * lower - 9) / (-4 * lower - 4));
  return [0, 1, 2].map((index) => ((index < m ? lower : upper) - 1) / 2);
}

function boxPass(source, target, width, height, radius, horizontal) {
  const lines = horizontal ? height : width;
  const length = horizontal ? width : height;
  const step = horizontal ? 3 : width * 3;
  const span = radius * 2 + 1;
  for (let line = 0; line < lines; line += 1) {
    const base = horizontal ? line * width * 3 : line * 3;
    for (let channel = 0; channel < 3; channel += 1) {
      const at = (index) => source[base + Math.min(length - 1, Math.max(0, index)) * step + channel];
      let sum = 0;
      for (let index = -radius; index <= radius; index += 1) sum += at(index);
      for (let index = 0; index < length; index += 1) {
        target[base + index * step + channel] = sum / span;
        sum += at(index + radius + 1) - at(index - radius);
      }
    }
  }
}

/** Gaussian-like blur (three box passes each way) with standard deviation `sigma` in pixels. */
export function blur(image, sigma) {
  if (!(sigma > 0.3)) return image;
  const { width, height } = image;
  let a = Float32Array.from(image.rgb);
  let b = new Float32Array(a.length);
  for (const radius of boxRadii(sigma)) {
    if (radius < 1) continue;
    boxPass(a, b, width, height, radius, true);
    boxPass(b, a, width, height, radius, false);
  }
  return { width, height, rgb: Uint8Array.from(a, (value) => Math.round(value)) };
}

/** PNG buffer in, blurred PNG data URL out (512 px reference width). */
export function blurredPngDataUrl(pngBuffer, blurPx) {
  const small = downscale(decodePng(pngBuffer), BLUR_REFERENCE_WIDTH);
  const sigma = blurPx * (small.width / BLUR_REFERENCE_WIDTH);
  return `data:image/png;base64,${encodePng(blur(small, sigma)).toString("base64")}`;
}
