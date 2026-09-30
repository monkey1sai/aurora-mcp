// Zero-dependency self-signed TLS certificate (ECDSA P-256, X.509 v3) for the dev server's HTTPS mode
// (tools/serve.mjs --https / --lan). Browsers only run AudioWorklet (and Web MIDI, Wake Lock…) in a secure
// context — https or localhost — so a phone or tablet opening http://<LAN-IP>:5173 gets no sound at all.
//
//   import { createSelfSignedCert } from './selfsigned.mjs';
//   const { cert, key } = createSelfSignedCert({ hosts: ['localhost', '127.0.0.1', '192.168.1.20'] });
//
// Node's crypto can make keys and sign, but has no certificate builder: this file DER-encodes the
// TBSCertificate by hand (RFC 5280) and signs it with the key itself. Nothing here trusts the result — the
// browser shows a one-time "not private" warning that the user accepts (or they use mkcert, see README).

import crypto from 'node:crypto';
import net from 'node:net';

// ── minimal DER encoder ──
const len = n => (n < 0x80 ? Buffer.from([n]) : (() => { const b = []; for (let x = n; x > 0; x >>>= 8) b.unshift(x & 0xff); return Buffer.from([0x80 | b.length, ...b]); })());
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), len(content.length), content]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const ctx = (n, content) => tlv(0xa0 + n, content);               // [n] EXPLICIT, constructed
const bool = v => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const octet = b => tlv(0x04, b);
const bits = (b, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
const utf8 = s => tlv(0x0c, Buffer.from(String(s), 'utf8'));
function int(v) {
  let b = Buffer.isBuffer(v) ? v : Buffer.from([v]);
  let i = 0;
  while (i < b.length - 1 && b[i] === 0 && !(b[i + 1] & 0x80)) i++; // minimal encoding
  b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);        // keep it positive
  return tlv(0x02, b);
}
function oid(s) {
  const a = s.split('.').map(Number);
  const out = [40 * a[0] + a[1]];
  for (const n of a.slice(2)) {
    const enc = [n & 0x7f];
    for (let x = Math.floor(n / 128); x > 0; x = Math.floor(x / 128)) enc.unshift(0x80 | (x & 0x7f));
    out.push(...enc);
  }
  return tlv(0x06, Buffer.from(out));
}
function time(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const y = d.getUTCFullYear();
  const body = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return y < 2050 ? tlv(0x17, Buffer.from(`${p(y % 100)}${body}`)) : tlv(0x18, Buffer.from(`${p(y, 4)}${body}`));
}
/** IPv4 / IPv6 literal → 4 / 16 raw bytes (for the iPAddress SAN). */
function ipBytes(ip) {
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  const [head, tail = ''] = ip.includes('::') ? ip.split('::') : [ip, null];
  const hs = head ? head.split(':') : [];
  const ts = tail ? tail.split(':') : [];
  const groups = tail === null ? hs : [...hs, ...Array(8 - hs.length - ts.length).fill('0'), ...ts];
  const b = Buffer.alloc(16);
  groups.forEach((g, i) => b.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  return b;
}

const OID = {
  ecdsaSha256: '1.2.840.10045.4.3.2', commonName: '2.5.4.3', organization: '2.5.4.10',
  subjectAltName: '2.5.29.17', basicConstraints: '2.5.29.19', keyUsage: '2.5.29.15', extKeyUsage: '2.5.29.37', serverAuth: '1.3.6.1.5.5.7.3.1',
};

/**
 * @param {{ hosts?: string[], commonName?: string, days?: number, now?: Date }} [o]
 *   hosts: DNS names and IP literals the certificate is valid for (subjectAltName).
 *   days: validity (≤ 397 keeps Apple's TLS rules happy even if the user chooses to trust it).
 * @returns {{ cert: string, key: string, hosts: string[], notAfter: Date }} PEM strings
 */
export function createSelfSignedCert({ hosts = ['localhost', '127.0.0.1', '::1'], commonName = 'AURORA dev server', days = 397, now = new Date() } = {}) {
  const uniq = [...new Set(hosts.map(h => String(h).trim()).filter(Boolean))];
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const name = seq(set(seq(oid(OID.commonName), utf8(commonName))), set(seq(oid(OID.organization), utf8('AURORA synthesizer (self-signed)'))));
  const notBefore = new Date(now.getTime() - 24 * 3600e3);            // tolerate a phone's clock skew
  const notAfter = new Date(now.getTime() + days * 24 * 3600e3);
  const san = uniq.map(h => (net.isIP(h) ? tlv(0x87, ipBytes(h)) : tlv(0x82, Buffer.from(h, 'ascii'))));
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f;
  const tbs = seq(
    ctx(0, int(2)),                                                     // v3
    int(serial),
    seq(oid(OID.ecdsaSha256)),
    name,                                                               // issuer = subject (self-signed)
    seq(time(notBefore), time(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    ctx(3, seq(
      seq(oid(OID.subjectAltName), octet(seq(...san))),
      seq(oid(OID.basicConstraints), bool(true), octet(seq())),         // CA:false
      seq(oid(OID.keyUsage), bool(true), octet(bits(Buffer.from([0x80]), 7))), // digitalSignature
      seq(oid(OID.extKeyUsage), octet(seq(oid(OID.serverAuth)))),
    )),
  );
  const sig = crypto.sign('sha256', tbs, privateKey);                   // DER ECDSA-Sig-Value
  const der = seq(tbs, seq(oid(OID.ecdsaSha256)), bits(sig));
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').trim();
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    hosts: uniq,
    notAfter,
  };
}
