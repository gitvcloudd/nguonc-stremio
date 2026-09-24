/* Pure JavaScript SHA-256 + AES-256-GCM for StreamC envelope decryption.
 * Ported from NguonC-for-Nuvio 1.0.6. Zero external dependencies.
 * Compatible with Cloudflare Workers.
 */

function utf8Encode(str) {
  str = String(str || "");
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0xd800 || c >= 0xe000) {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      i++;
      c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

function utf8Decode(bytes) {
  let str = "", i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i++];
    if (b1 < 0x80) str += String.fromCharCode(b1);
    else if (b1 > 0xbf && b1 < 0xe0) {
      const b2 = bytes[i++];
      str += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f));
    } else if (b1 > 0xdf && b1 < 0xf0) {
      const b2 = bytes[i++], b3 = bytes[i++];
      str += String.fromCharCode(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
    } else {
      const b2 = bytes[i++], b3 = bytes[i++], b4 = bytes[i++];
      const cp = (((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f)) - 0x10000;
      str += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return str;
}

function hexToBytes(hex) {
  hex = String(hex || "").replace(/[^0-9a-fA-F]/g, "");
  const len = hex.length / 2;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = new Uint8Array(256);
for (let i = 0; i < B64_CHARS.length; i++) B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;

function base64ToBytes(b64) {
  b64 = String(b64 || "").replace(/\s+/g, "");
  if (!b64 || /[^A-Za-z0-9+\/=]/.test(b64) || b64.length % 4 === 1) throw new Error("bad_base64");
  while (b64.length % 4) b64 += "=";
  const pad = b64.slice(-2) === "==" ? 2 : b64.slice(-1) === "=" ? 1 : 0;
  const outLen = (b64.length / 4) * 3 - pad;
  const bytes = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < b64.length; i += 4) {
    const c0 = B64_LOOKUP[b64.charCodeAt(i)];
    const c1 = B64_LOOKUP[b64.charCodeAt(i + 1)];
    const c2 = b64.charAt(i + 2) === "=" ? 0 : B64_LOOKUP[b64.charCodeAt(i + 2)];
    const c3 = b64.charAt(i + 3) === "=" ? 0 : B64_LOOKUP[b64.charCodeAt(i + 3)];
    const tmp = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (o < outLen) bytes[o++] = (tmp >>> 16) & 255;
    if (o < outLen) bytes[o++] = (tmp >>> 8) & 255;
    if (o < outLen) bytes[o++] = tmp & 255;
  }
  return bytes;
}

function rotr(n, x) { return (x >>> n) | (x << (32 - n)); }

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function sha256(input) {
  const bytes = typeof input === "string" ? utf8Encode(input) : input;
  const l = bytes.length;
  const bitLen = l * 8;
  const padLen = ((l + 8) >> 6) + 1;
  const w = new Int32Array(padLen << 4);
  for (let i = 0; i < l; i++) w[i >> 2] |= bytes[i] << (24 - (i & 3) * 8);
  w[l >> 2] |= 0x80 << (24 - (l & 3) * 8);
  w[w.length - 1] = bitLen;
  w[w.length - 2] = Math.floor(bitLen / 0x100000000);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const W = new Int32Array(64);

  for (let i = 0; i < w.length; i += 16) {
    for (let j = 0; j < 16; j++) W[j] = w[i + j];
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(7, W[j - 15]) ^ rotr(18, W[j - 15]) ^ (W[j - 15] >>> 3);
      const s1 = rotr(17, W[j - 2]) ^ rotr(19, W[j - 2]) ^ (W[j - 2] >>> 10);
      W[j] = (W[j - 16] + s0 + W[j - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K256[j] + W[j]) | 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32);
  const state = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (state[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (state[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (state[i] >>> 8) & 0xff;
    out[i * 4 + 3] = state[i] & 0xff;
  }
  return out;
}

const SBOX = new Uint8Array([
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
]);

const RCON = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function expandKey256(key) {
  const w = new Uint32Array(60);
  for (let i = 0; i < 8; i++) {
    w[i] = (key[i * 4] << 24) | (key[i * 4 + 1] << 16) | (key[i * 4 + 2] << 8) | key[i * 4 + 3];
  }
  for (let i = 8; i < 60; i++) {
    let temp = w[i - 1];
    if (i % 8 === 0) {
      temp = ((SBOX[(temp >>> 16) & 0xff] << 24) | (SBOX[(temp >>> 8) & 0xff] << 16) |
              (SBOX[temp & 0xff] << 8) | SBOX[temp >>> 24]) ^ (RCON[i / 8] << 24);
    } else if (i % 8 === 4) {
      temp = (SBOX[temp >>> 24] << 24) | (SBOX[(temp >>> 16) & 0xff] << 16) |
             (SBOX[(temp >>> 8) & 0xff] << 8) | SBOX[temp & 0xff];
    }
    w[i] = (w[i - 8] ^ temp) >>> 0;
  }
  return w;
}

function xtime(x) { return ((x << 1) ^ (((x >> 7) & 1) * 0x11b)) & 0xff; }

function aesEncryptBlock(w, input, out, outOff = 0) {
  let s0 = input[0] ^ (w[0] >>> 24), s1 = input[1] ^ ((w[0] >>> 16) & 0xff), s2 = input[2] ^ ((w[0] >>> 8) & 0xff), s3 = input[3] ^ (w[0] & 0xff);
  let s4 = input[4] ^ (w[1] >>> 24), s5 = input[5] ^ ((w[1] >>> 16) & 0xff), s6 = input[6] ^ ((w[1] >>> 8) & 0xff), s7 = input[7] ^ (w[1] & 0xff);
  let s8 = input[8] ^ (w[2] >>> 24), s9 = input[9] ^ ((w[2] >>> 16) & 0xff), s10 = input[10] ^ ((w[2] >>> 8) & 0xff), s11 = input[11] ^ (w[2] & 0xff);
  let s12 = input[12] ^ (w[3] >>> 24), s13 = input[13] ^ ((w[3] >>> 16) & 0xff), s14 = input[14] ^ ((w[3] >>> 8) & 0xff), s15 = input[15] ^ (w[3] & 0xff);

  for (let round = 1; round <= 13; round++) {
    const kw0 = w[round * 4], kw1 = w[round * 4 + 1], kw2 = w[round * 4 + 2], kw3 = w[round * 4 + 3];
    const t0 = SBOX[s0], t1 = SBOX[s5], t2 = SBOX[s10], t3 = SBOX[s15];
    const t4 = SBOX[s4], t5 = SBOX[s9], t6 = SBOX[s14], t7 = SBOX[s3];
    const t8 = SBOX[s8], t9 = SBOX[s13], t10 = SBOX[s2], t11 = SBOX[s7];
    const t12 = SBOX[s12], t13 = SBOX[s1], t14 = SBOX[s6], t15 = SBOX[s11];
    s0 = xtime(t0 ^ t1) ^ t1 ^ t2 ^ t3 ^ (kw0 >>> 24);
    s1 = xtime(t1 ^ t2) ^ t2 ^ t3 ^ t0 ^ ((kw0 >>> 16) & 0xff);
    s2 = xtime(t2 ^ t3) ^ t3 ^ t0 ^ t1 ^ ((kw0 >>> 8) & 0xff);
    s3 = xtime(t3 ^ t0) ^ t0 ^ t1 ^ t2 ^ (kw0 & 0xff);
    s4 = xtime(t4 ^ t5) ^ t5 ^ t6 ^ t7 ^ (kw1 >>> 24);
    s5 = xtime(t5 ^ t6) ^ t6 ^ t7 ^ t4 ^ ((kw1 >>> 16) & 0xff);
    s6 = xtime(t6 ^ t7) ^ t7 ^ t4 ^ t5 ^ ((kw1 >>> 8) & 0xff);
    s7 = xtime(t7 ^ t4) ^ t4 ^ t5 ^ t6 ^ (kw1 & 0xff);
    s8 = xtime(t8 ^ t9) ^ t9 ^ t10 ^ t11 ^ (kw2 >>> 24);
    s9 = xtime(t9 ^ t10) ^ t10 ^ t11 ^ t8 ^ ((kw2 >>> 16) & 0xff);
    s10 = xtime(t10 ^ t11) ^ t11 ^ t8 ^ t9 ^ ((kw2 >>> 8) & 0xff);
    s11 = xtime(t11 ^ t8) ^ t8 ^ t9 ^ t10 ^ (kw2 & 0xff);
    s12 = xtime(t12 ^ t13) ^ t13 ^ t14 ^ t15 ^ (kw3 >>> 24);
    s13 = xtime(t13 ^ t14) ^ t14 ^ t15 ^ t12 ^ ((kw3 >>> 16) & 0xff);
    s14 = xtime(t14 ^ t15) ^ t15 ^ t12 ^ t13 ^ ((kw3 >>> 8) & 0xff);
    s15 = xtime(t15 ^ t12) ^ t12 ^ t13 ^ t14 ^ (kw3 & 0xff);
  }
  const kw0 = w[56], kw1 = w[57], kw2 = w[58], kw3 = w[59];
  out[outOff]     = SBOX[s0]  ^ (kw0 >>> 24);
  out[outOff + 1] = SBOX[s5]  ^ ((kw0 >>> 16) & 0xff);
  out[outOff + 2] = SBOX[s10] ^ ((kw0 >>> 8) & 0xff);
  out[outOff + 3] = SBOX[s15] ^ (kw0 & 0xff);
  out[outOff + 4] = SBOX[s4]  ^ (kw1 >>> 24);
  out[outOff + 5] = SBOX[s9]  ^ ((kw1 >>> 16) & 0xff);
  out[outOff + 6] = SBOX[s14] ^ ((kw1 >>> 8) & 0xff);
  out[outOff + 7] = SBOX[s3]  ^ (kw1 & 0xff);
  out[outOff + 8] = SBOX[s8]  ^ (kw2 >>> 24);
  out[outOff + 9] = SBOX[s13] ^ ((kw2 >>> 16) & 0xff);
  out[outOff + 10]= SBOX[s2]  ^ ((kw2 >>> 8) & 0xff);
  out[outOff + 11]= SBOX[s7]  ^ (kw2 & 0xff);
  out[outOff + 12]= SBOX[s12] ^ (kw3 >>> 24);
  out[outOff + 13]= SBOX[s1]  ^ ((kw3 >>> 16) & 0xff);
  out[outOff + 14]= SBOX[s6]  ^ ((kw3 >>> 8) & 0xff);
  out[outOff + 15]= SBOX[s11] ^ (kw3 & 0xff);
}

function ghashMultiply(x, y) {
  let z0 = 0, z1 = 0, z2 = 0, z3 = 0;
  let v0 = (y[0] << 24) | (y[1] << 16) | (y[2] << 8) | y[3];
  let v1 = (y[4] << 24) | (y[5] << 16) | (y[6] << 8) | y[7];
  let v2 = (y[8] << 24) | (y[9] << 16) | (y[10] << 8) | y[11];
  let v3 = (y[12] << 24) | (y[13] << 16) | (y[14] << 8) | y[15];
  for (let i = 0; i < 16; i++) {
    const b = x[i];
    for (let j = 7; j >= 0; j--) {
      if ((b >>> j) & 1) { z0 ^= v0; z1 ^= v1; z2 ^= v2; z3 ^= v3; }
      const lsb = v3 & 1;
      v3 = (v3 >>> 1) | ((v2 & 1) << 31);
      v2 = (v2 >>> 1) | ((v1 & 1) << 31);
      v1 = (v1 >>> 1) | ((v0 & 1) << 31);
      v0 = (v0 >>> 1);
      if (lsb) v0 ^= 0xe1000000;
    }
  }
  x[0] = (z0 >>> 24) & 0xff; x[1] = (z0 >>> 16) & 0xff; x[2] = (z0 >>> 8) & 0xff; x[3] = z0 & 0xff;
  x[4] = (z1 >>> 24) & 0xff; x[5] = (z1 >>> 16) & 0xff; x[6] = (z1 >>> 8) & 0xff; x[7] = z1 & 0xff;
  x[8] = (z2 >>> 24) & 0xff; x[9] = (z2 >>> 16) & 0xff; x[10] = (z2 >>> 8) & 0xff; x[11] = z2 & 0xff;
  x[12] = (z3 >>> 24) & 0xff; x[13] = (z3 >>> 16) & 0xff; x[14] = (z3 >>> 8) & 0xff; x[15] = z3 & 0xff;
}

function aes256GcmDecrypt(key, iv, ciphertext, tag, aad) {
  const w = expandKey256(key);
  const H = new Uint8Array(16);
  aesEncryptBlock(w, new Uint8Array(16), H, 0);

  const J0 = new Uint8Array(16);
  if (iv.length === 12) { J0.set(iv); J0[15] = 1; }
  else throw new Error("iv_must_be_12_bytes");

  const tagMask = new Uint8Array(16);
  aesEncryptBlock(w, J0, tagMask, 0);

  const counter = new Uint8Array(J0);
  const plain = new Uint8Array(ciphertext.length);
  const block = new Uint8Array(16);
  let offset = 0;
  while (offset < ciphertext.length) {
    for (let i = 15; i >= 12; i--) { counter[i]++; if (counter[i] !== 0) break; }
    aesEncryptBlock(w, counter, block, 0);
    const n = Math.min(16, ciphertext.length - offset);
    for (let i = 0; i < n; i++) plain[offset + i] = ciphertext[offset + i] ^ block[i];
    offset += n;
  }

  const S = new Uint8Array(16);
  if (aad && aad.length) {
    const aadPadded = new Uint8Array(Math.ceil(aad.length / 16) * 16);
    aadPadded.set(aad);
    for (let i = 0; i < aadPadded.length; i += 16) {
      for (let j = 0; j < 16; j++) S[j] ^= aadPadded[i + j];
      ghashMultiply(S, H);
    }
  }
  const ctPadded = new Uint8Array(Math.ceil(ciphertext.length / 16) * 16);
  ctPadded.set(ciphertext);
  for (let i = 0; i < ctPadded.length; i += 16) {
    for (let j = 0; j < 16; j++) S[j] ^= ctPadded[i + j];
    ghashMultiply(S, H);
  }

  const lenBlock = new Uint8Array(16);
  const aBits = (aad ? aad.length : 0) * 8;
  const cBits = ciphertext.length * 8;
  lenBlock[4] = (aBits >>> 24) & 0xff; lenBlock[5] = (aBits >>> 16) & 0xff;
  lenBlock[6] = (aBits >>> 8) & 0xff; lenBlock[7] = aBits & 0xff;
  lenBlock[12] = (cBits >>> 24) & 0xff; lenBlock[13] = (cBits >>> 16) & 0xff;
  lenBlock[14] = (cBits >>> 8) & 0xff; lenBlock[15] = cBits & 0xff;
  for (let i = 0; i < 16; i++) S[i] ^= lenBlock[i];
  ghashMultiply(S, H);

  for (let i = 0; i < 16; i++) {
    if ((S[i] ^ tagMask[i]) !== tag[i]) throw new Error("aes_gcm_auth_tag_mismatch");
  }
  return plain;
}

/**
 * Decrypt a StreamC aesgcm-v1 envelope.
 * @param {{format:string, iv:string, data:string}} envelope
 * @param {string} embedUrl - full embed URL used as AAD context
 * @returns {object} parsed JSON (usually contains playlist URL or sources)
 */
export function decryptStreamCEnvelope(envelope, embedUrl) {
  if (!envelope || envelope.format !== "aesgcm-v1") throw new Error("unsupported_envelope_format");
  if (!envelope.iv || !envelope.data) throw new Error("missing_envelope_data");

  const contextStr = "stream-bootstrap-v1\n" + embedUrl;
  const key = sha256(contextStr);
  const iv = hexToBytes(envelope.iv);
  const combined = base64ToBytes(envelope.data);
  if (combined.length <= 16) throw new Error("ciphertext_too_short");

  const ciphertext = combined.subarray(0, combined.length - 16);
  const tag = combined.subarray(combined.length - 16);
  const aad = utf8Encode(contextStr);

  const decryptedBytes = aes256GcmDecrypt(key, iv, ciphertext, tag, aad);
  return JSON.parse(utf8Decode(decryptedBytes));
}
