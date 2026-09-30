// Minimal PNG encoder + tiny RGB raster with anti-aliased lines and a 5×8 bitmap font.
// Zero dependencies (node:zlib only). Used by analyze.mjs for spectrograms / waveforms.
//
//   import { encodePng, Raster, parseColor } from './png.mjs';
//   const r = new Raster(640, 200, '#07080d');
//   r.line(0, 0, 639, 199, '#5cf2ff');
//   r.text(8, 8, 'Hello 440 Hz', '#e8ecff', { scale: 2 });
//   fs.writeFileSync('x.png', r.toPng());

import zlib from 'node:zlib';

// ───────────────────────── CRC32 / chunks ─────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf, start = 0, end = buf.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Encode 8-bit RGB or RGBA pixels as PNG.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Uint8ClampedArray} pixels  row-major, `channels` bytes per pixel
 * @param {{channels?: 3|4, level?: number}} [opts]
 * @returns {Buffer}
 */
export function encodePng(width, height, pixels, { channels = 4, level = 9 } = {}) {
  if (channels !== 3 && channels !== 4) throw new Error('encodePng: channels must be 3 or 4');
  const stride = width * channels;
  if (pixels.length < stride * height) throw new Error('encodePng: pixel buffer too small');
  // Adaptive per-row filtering (minimum sum of absolute differences heuristic).
  const raw = Buffer.alloc((stride + 1) * height);
  const cand = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = row - stride;
    let best = 0, bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = cand[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const x = pixels[row + i];
        const a = i >= channels ? pixels[row + i - channels] : 0;
        const b = y > 0 ? pixels[prev + i] : 0;
        const c = y > 0 && i >= channels ? pixels[prev + i - channels] : 0;
        let v;
        switch (f) {
          case 0: v = x; break;
          case 1: v = x - a; break;
          case 2: v = x - b; break;
          case 3: v = x - ((a + b) >> 1); break;
          default: v = x - paeth(a, b, c);
        }
        v &= 0xff;
        out[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    const o = y * (stride + 1);
    raw[o] = best;
    raw.set(cand[best], o + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // colour type RGBA / RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Decode a PNG produced by encodePng (8-bit RGB/RGBA, non-interlaced). For tests. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, channels = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (crc32(buf, off + 4, off + 8 + len) !== buf.readUInt32BE(off + 8 + len)) throw new Error(`bad CRC in ${type}`);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error('only 8-bit supported');
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (!channels) throw new Error('only RGB/RGBA supported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? px[y * stride + i - channels] : 0;
      const b = y > 0 ? px[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= channels ? px[(y - 1) * stride + i - channels] : 0;
      const x = raw[src + i];
      let v;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error(`bad filter ${f}`);
      }
      px[y * stride + i] = v & 0xff;
    }
  }
  return { width, height, channels, pixels: px };
}

// ───────────────────────── Colours ─────────────────────────
/** '#rgb' | '#rrggbb' | [r,g,b] (0..255) → [r,g,b] */
export function parseColor(c) {
  if (Array.isArray(c) || ArrayBuffer.isView(c)) return [c[0] | 0, c[1] | 0, c[2] | 0];
  if (typeof c === 'string' && c[0] === '#') {
    const h = c.slice(1);
    if (h.length === 3) return [0, 1, 2].map(i => parseInt(h[i] + h[i], 16));
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  }
  throw new Error(`bad colour ${c}`);
}

// ───────────────────────── 5×8 bitmap font ─────────────────────────
// Each glyph: 8 rows, 5 bits per row (bit 4 = leftmost). Row 7 is the descender row.
const G = {
  ' ': [0, 0, 0, 0, 0, 0, 0, 0],
  '!': [4, 4, 4, 4, 4, 0, 4, 0],
  '"': [10, 10, 0, 0, 0, 0, 0, 0],
  '#': [10, 10, 31, 10, 31, 10, 10, 0],
  '%': [24, 25, 2, 4, 8, 19, 3, 0],
  '&': [12, 18, 20, 8, 21, 18, 13, 0],
  "'": [4, 4, 0, 0, 0, 0, 0, 0],
  '(': [2, 4, 8, 8, 8, 4, 2, 0],
  ')': [8, 4, 2, 2, 2, 4, 8, 0],
  '*': [0, 4, 21, 14, 21, 4, 0, 0],
  '+': [0, 4, 4, 31, 4, 4, 0, 0],
  ',': [0, 0, 0, 0, 0, 12, 4, 8],
  '-': [0, 0, 0, 31, 0, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 12, 12, 0],
  '/': [0, 1, 2, 4, 8, 16, 0, 0],
  '0': [14, 17, 19, 21, 25, 17, 14, 0],
  '1': [4, 12, 4, 4, 4, 4, 14, 0],
  '2': [14, 17, 1, 2, 4, 8, 31, 0],
  '3': [31, 2, 4, 2, 1, 17, 14, 0],
  '4': [2, 6, 10, 18, 31, 2, 2, 0],
  '5': [31, 16, 30, 1, 1, 17, 14, 0],
  '6': [6, 8, 16, 30, 17, 17, 14, 0],
  '7': [31, 1, 2, 4, 8, 8, 8, 0],
  '8': [14, 17, 17, 14, 17, 17, 14, 0],
  '9': [14, 17, 17, 15, 1, 2, 12, 0],
  ':': [0, 12, 12, 0, 12, 12, 0, 0],
  ';': [0, 12, 12, 0, 12, 4, 8, 0],
  '<': [2, 4, 8, 16, 8, 4, 2, 0],
  '=': [0, 0, 31, 0, 31, 0, 0, 0],
  '>': [8, 4, 2, 1, 2, 4, 8, 0],
  '?': [14, 17, 1, 2, 4, 0, 4, 0],
  '@': [14, 17, 1, 13, 21, 21, 14, 0],
  A: [14, 17, 17, 17, 31, 17, 17, 0],
  B: [30, 17, 17, 30, 17, 17, 30, 0],
  C: [14, 17, 16, 16, 16, 17, 14, 0],
  D: [28, 18, 17, 17, 17, 18, 28, 0],
  E: [31, 16, 16, 30, 16, 16, 31, 0],
  F: [31, 16, 16, 30, 16, 16, 16, 0],
  G: [14, 17, 16, 23, 17, 17, 15, 0],
  H: [17, 17, 17, 31, 17, 17, 17, 0],
  I: [14, 4, 4, 4, 4, 4, 14, 0],
  J: [7, 2, 2, 2, 2, 18, 12, 0],
  K: [17, 18, 20, 24, 20, 18, 17, 0],
  L: [16, 16, 16, 16, 16, 16, 31, 0],
  M: [17, 27, 21, 21, 17, 17, 17, 0],
  N: [17, 17, 25, 21, 19, 17, 17, 0],
  O: [14, 17, 17, 17, 17, 17, 14, 0],
  P: [30, 17, 17, 30, 16, 16, 16, 0],
  Q: [14, 17, 17, 17, 21, 18, 13, 0],
  R: [30, 17, 17, 30, 20, 18, 17, 0],
  S: [15, 16, 16, 14, 1, 1, 30, 0],
  T: [31, 4, 4, 4, 4, 4, 4, 0],
  U: [17, 17, 17, 17, 17, 17, 14, 0],
  V: [17, 17, 17, 17, 17, 10, 4, 0],
  W: [17, 17, 17, 21, 21, 21, 10, 0],
  X: [17, 17, 10, 4, 10, 17, 17, 0],
  Y: [17, 17, 17, 10, 4, 4, 4, 0],
  Z: [31, 1, 2, 4, 8, 16, 31, 0],
  '[': [14, 8, 8, 8, 8, 8, 14, 0],
  ']': [14, 2, 2, 2, 2, 2, 14, 0],
  _: [0, 0, 0, 0, 0, 0, 31, 0],
  a: [0, 0, 14, 1, 15, 17, 15, 0],
  b: [16, 16, 22, 25, 17, 17, 30, 0],
  c: [0, 0, 14, 16, 16, 17, 14, 0],
  d: [1, 1, 13, 19, 17, 17, 15, 0],
  e: [0, 0, 14, 17, 31, 16, 14, 0],
  f: [6, 9, 8, 28, 8, 8, 8, 0],
  g: [0, 0, 15, 17, 17, 15, 1, 14],
  h: [16, 16, 22, 25, 17, 17, 17, 0],
  i: [4, 0, 12, 4, 4, 4, 14, 0],
  j: [2, 0, 6, 2, 2, 2, 18, 12],
  k: [16, 16, 18, 20, 24, 20, 18, 0],
  l: [12, 4, 4, 4, 4, 4, 14, 0],
  m: [0, 0, 26, 21, 21, 17, 17, 0],
  n: [0, 0, 22, 25, 17, 17, 17, 0],
  o: [0, 0, 14, 17, 17, 17, 14, 0],
  p: [0, 0, 30, 17, 17, 30, 16, 16],
  q: [0, 0, 15, 17, 17, 15, 1, 1],
  r: [0, 0, 22, 25, 16, 16, 16, 0],
  s: [0, 0, 15, 16, 14, 1, 30, 0],
  t: [8, 8, 28, 8, 8, 9, 6, 0],
  u: [0, 0, 17, 17, 17, 19, 13, 0],
  v: [0, 0, 17, 17, 17, 10, 4, 0],
  w: [0, 0, 17, 17, 21, 21, 10, 0],
  x: [0, 0, 17, 10, 4, 10, 17, 0],
  y: [0, 0, 17, 17, 17, 15, 1, 14],
  z: [0, 0, 31, 2, 4, 8, 31, 0],
  '|': [4, 4, 4, 4, 4, 4, 4, 0],
  '~': [0, 0, 8, 21, 2, 0, 0, 0],
  '°': [12, 18, 18, 12, 0, 0, 0, 0],
  '·': [0, 0, 0, 12, 12, 0, 0, 0],
  '×': [0, 17, 10, 4, 10, 17, 0, 0],
  '→': [0, 4, 2, 31, 2, 4, 0, 0],
  '♯': [10, 10, 31, 10, 31, 10, 10, 0],
  '♭': [16, 16, 22, 25, 17, 18, 28, 0],
  '▶': [16, 24, 28, 30, 28, 24, 16, 0],
  '█': [31, 31, 31, 31, 31, 31, 31, 31],
  '□': [31, 17, 17, 17, 17, 17, 31, 0], // □ fallback for unknown glyphs
};
const FALLBACK = G['□'];
export const FONT_W = 5, FONT_H = 8, FONT_ADV = 6;

// ───────────────────────── Raster ─────────────────────────
export class Raster {
  /** RGB raster, origin top-left. */
  constructor(width, height, bg = '#000000') {
    this.width = width | 0;
    this.height = height | 0;
    this.data = new Uint8ClampedArray(this.width * this.height * 3);
    this.fillRect(0, 0, this.width, this.height, bg);
  }

  /** Alpha-blend a pixel (integer coords; out of bounds ignored). */
  blend(x, y, r, g, b, a = 1) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || a <= 0) return;
    const i = (y * this.width + x) * 3;
    const d = this.data;
    if (a >= 1) { d[i] = r; d[i + 1] = g; d[i + 2] = b; return; }
    d[i] += (r - d[i]) * a;
    d[i + 1] += (g - d[i + 1]) * a;
    d[i + 2] += (b - d[i + 2]) * a;
  }

  /** Additive (screen-like) glow blend: brightens without darkening. */
  add(x, y, r, g, b, a = 1) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || a <= 0) return;
    const i = (y * this.width + x) * 3;
    const d = this.data;
    d[i] = d[i] + r * a; d[i + 1] = d[i + 1] + g * a; d[i + 2] = d[i + 2] + b * a;
  }

  get(x, y) {
    const i = (y * this.width + x) * 3;
    return [this.data[i], this.data[i + 1], this.data[i + 2]];
  }

  fillRect(x, y, w, h, color, alpha = 1) {
    const [r, g, b] = parseColor(color);
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w)), y1 = Math.min(this.height, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.blend(xx, yy, r, g, b, alpha);
  }

  /** Vertical gradient fill from colour c0 (top) to c1 (bottom). */
  gradientRect(x, y, w, h, c0, c1, alpha = 1) {
    const a = parseColor(c0), b = parseColor(c1);
    const y0 = Math.max(0, Math.round(y)), y1 = Math.min(this.height, Math.round(y + h));
    const x0 = Math.max(0, Math.round(x)), x1 = Math.min(this.width, Math.round(x + w));
    for (let yy = y0; yy < y1; yy++) {
      const t = h > 1 ? (yy - y) / (h - 1) : 0;
      const r = a[0] + (b[0] - a[0]) * t, g = a[1] + (b[1] - a[1]) * t, bb = a[2] + (b[2] - a[2]) * t;
      for (let xx = x0; xx < x1; xx++) this.blend(xx, yy, r, g, bb, alpha);
    }
  }

  hline(x0, x1, y, color, alpha = 1, dash = 0) {
    const [r, g, b] = parseColor(color);
    y = Math.round(y);
    for (let x = Math.round(Math.min(x0, x1)); x <= Math.round(Math.max(x0, x1)); x++) {
      if (dash && Math.floor(x / dash) % 2) continue;
      this.blend(x, y, r, g, b, alpha);
    }
  }

  vline(x, y0, y1, color, alpha = 1, dash = 0) {
    const [r, g, b] = parseColor(color);
    x = Math.round(x);
    for (let y = Math.round(Math.min(y0, y1)); y <= Math.round(Math.max(y0, y1)); y++) {
      if (dash && Math.floor(y / dash) % 2) continue;
      this.blend(x, y, r, g, b, alpha);
    }
  }

  /** Anti-aliased line (Xiaolin Wu). */
  line(x0, y0, x1, y1, color, alpha = 1) {
    const [r, g, b] = parseColor(color);
    const steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
    if (steep) { [x0, y0] = [y0, x0]; [x1, y1] = [y1, x1]; }
    if (x0 > x1) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; }
    const dx = x1 - x0, dy = y1 - y0;
    const grad = dx === 0 ? 1 : dy / dx;
    const plot = (x, y, c) => (steep ? this.blend(y, x, r, g, b, c * alpha) : this.blend(x, y, r, g, b, c * alpha));
    let y = y0 + grad * (Math.round(x0) - x0);
    for (let x = Math.round(x0); x <= Math.round(x1); x++) {
      const fy = Math.floor(y);
      const f = y - fy;
      plot(x, fy, 1 - f);
      plot(x, fy + 1, f);
      y += grad;
    }
  }

  /** Polyline through points [[x,y],...] */
  polyline(pts, color, alpha = 1) {
    for (let i = 1; i < pts.length; i++) this.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], color, alpha);
  }

  textWidth(str, scale = 1) {
    const n = [...String(str)].length;
    return n ? (n * FONT_ADV - 1) * scale : 0;
  }

  /**
   * Draw text with the built-in 5×8 font. (x, y) = top-left of the text box (cap height 7·scale).
   * opts: { scale = 1, align: 'left'|'center'|'right', alpha = 1, shadow: colour|null }
   * Returns the drawn width in pixels.
   */
  text(x, y, str, color, { scale = 1, align = 'left', alpha = 1, shadow = null } = {}) {
    str = String(str);
    const w = this.textWidth(str, scale);
    if (align === 'center') x -= w / 2;
    else if (align === 'right') x -= w;
    x = Math.round(x); y = Math.round(y);
    if (shadow) this.#drawText(x + scale, y + scale, str, parseColor(shadow), scale, alpha * 0.8);
    this.#drawText(x, y, str, parseColor(color), scale, alpha);
    return w;
  }

  #drawText(x, y, str, [r, g, b], scale, alpha) {
    let cx = x;
    for (const ch of str) {
      const glyph = G[ch] || G[ch.normalize('NFD')[0]] || (ch.charCodeAt(0) < 128 ? G[ch.toUpperCase()] : null) || FALLBACK;
      for (let row = 0; row < FONT_H; row++) {
        const bits = glyph[row];
        if (!bits) continue;
        for (let col = 0; col < FONT_W; col++) {
          if (!(bits & (16 >> col))) continue;
          for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++)
            this.blend(cx + col * scale + sx, y + row * scale + sy, r, g, b, alpha);
        }
      }
      cx += FONT_ADV * scale;
    }
  }

  toPng(level = 9) {
    return encodePng(this.width, this.height, this.data, { channels: 3, level });
  }
}
