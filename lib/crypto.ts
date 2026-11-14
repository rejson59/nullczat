"use client";

/**
 * nullczat — silnik kryptograficzny.
 *
 * Zasady:
 *  - sekret pokoju S (256 bit) powstaje w przeglądarce i żyje wyłącznie
 *    w pamięci + fragmencie URL (który nigdy nie trafia do serwera),
 *  - z S wyprowadzane są: bilet zaproszenia i bilet zniszczenia (serwer
 *    dostaje tylko ich SHA-256),
 *  - parowanie: efemeryczny X25519 + PSK (S) => klucz główny,
 *  - wiadomości: osobny łańcuch HMAC na każdy kierunek (forward secrecy),
 *                każda wiadomość ma własny klucz, XChaCha20-Poly1305,
 *  - dopełnianie do 256 B, żeby długość nie zdradzała treści.
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, randomBytes } from "@noble/hashes/utils";

export type Bytes = Uint8Array;

export const KIND_MSG = 1;
export const KIND_BURN = 2;
export const KIND_PING = 3;

const enc = new TextEncoder();
const PAD = 256;
const MAX_SKIP = 256;

export const PALETTE = [
  "#c0392b", "#2e86c1", "#27ae60", "#d4ac0d",
  "#8e44ad", "#d35400", "#16a085", "#7f8c8d",
  "#e74c3c", "#2980b9", "#1abc9c", "#f39c12",
];

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const b64u = {
  enc(b: Bytes): string {
    let out = "";
    let i = 0;
    for (; i + 2 < b.length; i += 3) {
      const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    const rest = b.length - i;
    if (rest === 1) {
      const n = b[i] << 16;
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    } else if (rest === 2) {
      const n = (b[i] << 16) | (b[i + 1] << 8);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63];
    }
    return out;
  },
  dec(s: string): Bytes {
    const clean = s.replace(/[^A-Za-z0-9\-_]/g, "");
    const acc: number[] = [];
    let bits = 0;
    let cur = 0;
    for (const ch of clean) {
      const v = B64.indexOf(ch);
      if (v < 0) continue;
      cur = (cur << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        acc.push((cur >> bits) & 0xff);
      }
    }
    return new Uint8Array(acc);
  },
};

export function hex(b: Bytes): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

/** Wartość wyprowadzona z sekretu pokoju — serwer widzi tylko jej hash. */
export function deriveTicket(secret: Bytes, label: string): string {
  return hex(sha256(concatBytes(secret, enc.encode("|nullczat|" + label))));
}

export function newSecret(len = 32): Bytes {
  return randomBytes(len);
}

export type Ephemeral = { sk: Bytes; pk: Bytes };

export function newEphemeral(): Ephemeral {
  const sk = x25519.utils.randomPrivateKey();
  return { sk, pk: x25519.getPublicKey(sk) };
}

export function agree(sk: Bytes, pk: Bytes): Bytes {
  return x25519.getSharedSecret(sk, pk);
}

/** Klucz główny = PSK (S, tylko z linku) + świeży DH (forward secrecy). */
export function pairingRoot(secret: Bytes, dh: Bytes, roomId: string): Bytes {
  return hkdf(sha256, concatBytes(secret, dh), enc.encode(roomId), enc.encode("nullczat/v1/pair"), 32);
}

export type Frame = { d: number; i: number; n: string; c: string };

function step(chain: Bytes): { next: Bytes; key: Bytes } {
  return {
    next: hmac(sha256, chain, new Uint8Array([1])),
    key: hmac(sha256, chain, new Uint8Array([2])),
  };
}

function pad(kind: number, text: string): Bytes {
  const body = enc.encode(text);
  const head = 5;
  const size = Math.max(PAD, Math.ceil((head + body.length) / PAD) * PAD);
  const out = randomBytes(size);
  out[0] = kind;
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(1, body.length, false);
  out.set(body, head);
  return out;
}

function unpad(buf: Bytes): { kind: number; text: string } | null {
  if (buf.length < 5) return null;
  const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1, false);
  if (len > buf.length - 5) return null;
  return { kind: buf[0], text: new TextDecoder().decode(buf.subarray(5, 5 + len)) };
}

export class Session {
  private sendChain: Bytes;
  private recvChain: Bytes;
  private sendIdx = 0;
  private recvIdx = 0;
  private skipped = new Map<number, Bytes>();
  private dir: number;
  private roomId: string;
  private dead = false;
  readonly fingerprint: string[];

  constructor(root: Bytes, isHost: boolean, roomId: string) {
    this.dir = isHost ? 0 : 1;
    this.roomId = roomId;
    this.sendChain = hkdf(sha256, root, enc.encode("nullczat/v1/chain"), enc.encode("dir/" + this.dir), 32);
    this.recvChain = hkdf(sha256, root, enc.encode("nullczat/v1/chain"), enc.encode("dir/" + (1 - this.dir)), 32);
    const f = hkdf(sha256, root, enc.encode("fp"), enc.encode("nullczat/v1/fp"), 8);
    this.fingerprint = [0, 1, 2, 3].map((k) => PALETTE[(f[k] * 7 + f[k + 4]) % PALETTE.length]);
    root.fill(0);
  }

  private aad(dir: number, i: number): Bytes {
    return enc.encode(`${this.roomId}|${dir}|${i}|1`);
  }

  encrypt(kind: number, text: string): Frame {
    if (this.dead) throw new Error("dead");
    const { next, key } = step(this.sendChain);
    const i = this.sendIdx++;
    const nonce = randomBytes(24);
    const ct = xchacha20poly1305(key, nonce, this.aad(this.dir, i)).encrypt(pad(kind, text));
    key.fill(0);
    this.sendChain.fill(0);
    this.sendChain = next;
    return { d: this.dir, i, n: b64u.enc(nonce), c: b64u.enc(ct) };
  }

  decrypt(frame: Frame): { kind: number; text: string } | null {
    if (this.dead || frame.d !== 1 - this.dir) return null;
    const i = frame.i | 0;
    let key: Bytes | undefined;

    if (i < this.recvIdx) {
      key = this.skipped.get(i);
      if (!key) return null;
      this.skipped.delete(i);
    } else {
      if (i - this.recvIdx > MAX_SKIP) return null;
      while (this.recvIdx < i) {
        const r = step(this.recvChain);
        this.skipped.set(this.recvIdx, r.key);
        this.recvChain.fill(0);
        this.recvChain = r.next;
        this.recvIdx++;
      }
      const r = step(this.recvChain);
      key = r.key;
      this.recvChain.fill(0);
      this.recvChain = r.next;
      this.recvIdx++;
    }

    try {
      const pt = xchacha20poly1305(key, b64u.dec(frame.n), this.aad(frame.d, i)).decrypt(b64u.dec(frame.c));
      return unpad(pt);
    } catch {
      return null;
    } finally {
      key.fill(0);
    }
  }

  destroy(): void {
    this.dead = true;
    for (const k of this.skipped.values()) k.fill(0);
    this.skipped.clear();
    this.sendChain.fill(0);
    this.recvChain.fill(0);
  }
}

/** Hash biletu — to jedyna postać, jaką widzi serwer. */
export function hashTicket(t: string): string {
  return hex(sha256(enc.encode(t)));
}
