// WAV writer/reader: 16-bit (TPDF-dithered), 24-bit PCM, or 32-bit float. Zero dependencies.
//
//   import { encodeWav, writeWav, decodeWav } from './wav.mjs';
//   writeWav('out.wav', [L, R], 48000, { bitDepth: 24 });

import fs from 'node:fs';
import path from 'node:path';

/**
 * Encode channels (Float32Array/Float64Array, −1..1) to a RIFF/WAVE buffer.
 * @param {ArrayLike<number>[]} channels  one array per channel (all the same length)
 * @param {number} sampleRate
 * @param {{bitDepth?: 16|24|32, float?: boolean, dither?: boolean, seed?: number}} [opts]
 *   bitDepth 32 implies float. 16-bit uses deterministic TPDF dither by default.
 * @returns {Buffer}
 */
export function encodeWav(channels, sampleRate, { bitDepth = 24, float = false, dither = bitDepth === 16, seed = 0x1234567 } = {}) {
  if (!Array.isArray(channels) || channels.length === 0) throw new Error('encodeWav: channels must be a non-empty array');
  if (![16, 24, 32].includes(bitDepth)) throw new Error('encodeWav: bitDepth must be 16, 24 or 32');
  if (bitDepth === 32) float = true;
  if (float && bitDepth !== 32) throw new Error('encodeWav: float requires bitDepth 32');
  const nch = channels.length;
  const frames = channels[0].length;
  for (const c of channels) if (c.length !== frames) throw new Error('encodeWav: channel length mismatch');
  const bps = bitDepth / 8;
  const blockAlign = nch * bps;
  const dataBytes = frames * blockAlign;
  const fmtSize = float ? 18 : 16;
  const factSize = float ? 12 : 0;
  const headerSize = 12 + (8 + fmtSize) + factSize + 8;
  const buf = Buffer.alloc(headerSize + dataBytes + (dataBytes & 1));
  let o = 0;
  buf.write('RIFF', o); o += 4;
  buf.writeUInt32LE(buf.length - 8, o); o += 4;
  buf.write('WAVE', o); o += 4;
  buf.write('fmt ', o); o += 4;
  buf.writeUInt32LE(fmtSize, o); o += 4;
  buf.writeUInt16LE(float ? 3 : 1, o); o += 2;
  buf.writeUInt16LE(nch, o); o += 2;
  buf.writeUInt32LE(sampleRate, o); o += 4;
  buf.writeUInt32LE(sampleRate * blockAlign, o); o += 4;
  buf.writeUInt16LE(blockAlign, o); o += 2;
  buf.writeUInt16LE(bitDepth, o); o += 2;
  if (float) {
    buf.writeUInt16LE(0, o); o += 2; // cbSize
    buf.write('fact', o); o += 4;
    buf.writeUInt32LE(4, o); o += 4;
    buf.writeUInt32LE(frames, o); o += 4;
  }
  buf.write('data', o); o += 4;
  buf.writeUInt32LE(dataBytes, o); o += 4;

  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      let x = channels[c][i];
      if (!Number.isFinite(x)) x = 0;
      if (float) { buf.writeFloatLE(x, o); o += 4; continue; }
      if (bitDepth === 16) {
        let v = x * 32767 + (dither ? rnd() - rnd() : 0);
        v = Math.round(v);
        v = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
        buf.writeInt16LE(v, o); o += 2;
      } else {
        let v = Math.round(x * 8388607 + (dither ? rnd() - rnd() : 0));
        v = v > 8388607 ? 8388607 : v < -8388608 ? -8388608 : v;
        buf[o] = v & 0xff; buf[o + 1] = (v >> 8) & 0xff; buf[o + 2] = (v >> 16) & 0xff;
        o += 3;
      }
    }
  }
  return buf;
}

/** Encode and write to disk (creates parent directories). Returns the byte size. */
export function writeWav(file, channels, sampleRate, opts) {
  const buf = encodeWav(channels, sampleRate, opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf.length;
}

/**
 * Decode PCM 8/16/24/32-bit integer or 32/64-bit float WAV (incl. WAVE_FORMAT_EXTENSIBLE).
 * @returns {{sampleRate:number, bitDepth:number, float:boolean, channels: Float32Array[]}}
 */
export function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('decodeWav: not a RIFF/WAVE file');
  let o = 12, fmt = null, data = null;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    const body = o + 8;
    if (id === 'fmt ') {
      let tag = buf.readUInt16LE(body);
      if (tag === 0xfffe) tag = buf.readUInt16LE(body + 24); // extensible: sub-format GUID starts with the tag
      fmt = { tag, nch: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size));
    }
    o = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('decodeWav: missing fmt or data chunk');
  const { tag, nch, bits } = fmt;
  const isFloat = tag === 3;
  const bps = bits / 8;
  const frames = Math.floor(data.length / (bps * nch));
  const channels = Array.from({ length: nch }, () => new Float32Array(frames));
  let p = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      let v;
      if (isFloat) v = bits === 64 ? data.readDoubleLE(p) : data.readFloatLE(p);
      else if (bits === 8) v = (data[p] - 128) / 128;
      else if (bits === 16) v = data.readInt16LE(p) / 32768;
      else if (bits === 24) v = ((data[p] | (data[p + 1] << 8) | (data[p + 2] << 16)) << 8 >> 8) / 8388608;
      else if (bits === 32) v = data.readInt32LE(p) / 2147483648;
      else throw new Error(`decodeWav: unsupported bit depth ${bits}`);
      channels[c][i] = v;
      p += bps;
    }
  }
  return { sampleRate: fmt.sampleRate, bitDepth: bits, float: isFloat, channels };
}
