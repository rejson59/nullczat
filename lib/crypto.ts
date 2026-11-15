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
 *  - co 32 wiadomości nowa epoka: świeży X25519 => nowy root (uzdrawianie
 *                po przejęciu: stary stan nie odszyfruje przyszłości),
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

export type Frame = { d: number; e: number; i: number; n: string; c: string; p?: string };

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

const RATCHET_EVERY = 32; // ile wiadomości w epoce, zanim wejdziemy w nową

type ChainState = { chain: Bytes; idx: number; skipped: Map<number, Bytes> };

export class Session {
  private root: Bytes;
  private dh: Ephemeral;
  private peerDh: Bytes | null;
  private epoch = 0;
  private send: ChainState;
  private recv: ChainState;
  private prev: (ChainState & { epoch: number }) | null = null;
  private sent = 0;
  private heard = 0;
  private dir: number;
  private roomId: string;
  private host: boolean;
  private dead = false;
  readonly fingerprint: string[];

  /**
   * `own` — nasza para kluczy ratchetu (kopia; obiekt wywołującego nie jest ruszany),
   * `peerPk` — publiczny klucz ratchetu drugiej strony (kopia).
   */
  constructor(root: Bytes, isHost: boolean, roomId: string, own: Ephemeral, peerPk: Bytes | null) {
    this.dir = isHost ? 0 : 1;
    this.roomId = roomId;
    this.host = isHost;
    this.root = new Uint8Array(root);
    this.dh = { sk: new Uint8Array(own.sk), pk: new Uint8Array(own.pk) };
    this.peerDh = peerPk ? new Uint8Array(peerPk) : null;
    this.send = { chain: this.chainFor(this.root, this.dir), idx: 0, skipped: new Map() };
    this.recv = { chain: this.chainFor(this.root, 1 - this.dir), idx: 0, skipped: new Map() };
    const f = hkdf(sha256, this.root, enc.encode("fp"), enc.encode("nullczat/v1/fp"), 8);
    this.fingerprint = [0, 1, 2, 3].map((k) => PALETTE[(f[k] * 7 + f[k + 4]) % PALETTE.length]);
  }

  private chainFor(root: Bytes, dir: number): Bytes {
    return hkdf(sha256, root, enc.encode("nullczat/v1/chain"), enc.encode("dir/" + dir), 32);
  }

  private aad(dir: number, e: number, i: number): Bytes {
    return enc.encode(`${this.roomId}|${dir}|${e}|${i}|2`);
  }

  /** Nowa epoka: świeży X25519 (tylko host inicjuje) => nowy root => nowe łańcuchy. */
  private ratchet(): void {
    if (!this.peerDh) return;
    const fresh = newEphemeral();
    const dh = agree(fresh.sk, this.peerDh);
    this.rotate(dh, this.epoch + 1);
    this.dh.sk.fill(0);
    this.dh = fresh;
  }

  private rotate(dh: Bytes, e: number): void {
    const root = hkdf(sha256, dh, this.root, enc.encode("nullczat/v1/ratchet/" + e), 32);
    dh.fill(0);
    const send = this.chainFor(root, this.dir);
    const recv = this.chainFor(root, 1 - this.dir);

    this.dropPrev();
    // poprzednia epoka zostaje wyłącznie po to, by dojechały ramki wysłane w locie
    this.prev = { chain: this.recv.chain, idx: this.recv.idx, skipped: this.recv.skipped, epoch: this.epoch };

    this.send.chain.fill(0);
    this.recv.chain.fill(0);
    this.send = { chain: send, idx: 0, skipped: new Map() };
    this.recv = { chain: recv, idx: 0, skipped: new Map() };
    this.root.fill(0);
    this.root = root;
    this.epoch = e;
    this.sent = 0;
    this.heard = 0;
  }

  private dropPrev(): void {
    if (!this.prev) return;
    for (const k of this.prev.skipped.values()) k.fill(0);
    this.prev.skipped.clear();
    this.prev.chain.fill(0);
    this.prev = null;
  }

  encrypt(kind: number, text: string): Frame {
    if (this.dead) throw new Error("dead");
    // epoka zmienia się dopiero, gdy wiemy, że rozmówca jest w tej samej —
    // inaczej przeskoczyłby o epokę i nie policzyłby nowego root
    if (this.host && this.heard > 0 && this.sent >= RATCHET_EVERY) this.ratchet();

    const st = step(this.send.chain);
    const i = this.send.idx;
    const nonce = randomBytes(24);
    const ct = xchacha20poly1305(st.key, nonce, this.aad(this.dir, this.epoch, i)).encrypt(pad(kind, text));
    st.key.fill(0);
    this.send.chain.fill(0);
    this.send = { chain: st.next, idx: i + 1, skipped: this.send.skipped };
    this.sent++;

    const out: Frame = { d: this.dir, e: this.epoch, i, n: b64u.enc(nonce), c: b64u.enc(ct) };
    if (this.epoch > 0) out.p = b64u.enc(this.dh.pk);
    return out;
  }

  /** Otwiera ramkę na kopii stanu — nieudane odszyfrowanie nie psuje sesji. */
  private open(st: ChainState, frame: Frame): { pt: { kind: number; text: string }; state: ChainState } | null {
    const i = frame.i | 0;
    let key: Bytes;
    let next: ChainState;

    if (i < st.idx) {
      const found = st.skipped.get(i);
      if (!found) return null;
      key = found;
      const m = new Map(st.skipped);
      m.delete(i);
      next = { chain: st.chain, idx: st.idx, skipped: m };
    } else {
      if (i - st.idx > MAX_SKIP) return null;
      let chain: Bytes = new Uint8Array(st.chain);
      let idx = st.idx;
      const skipped = new Map(st.skipped);
      while (idx < i) {
        const r = step(chain);
        chain.fill(0);
        skipped.set(idx, r.key);
        chain = r.next;
        idx++;
      }
      const r = step(chain);
      chain.fill(0);
      key = r.key;
      next = { chain: r.next, idx: idx + 1, skipped };
    }

    try {
      const pt = xchacha20poly1305(key, b64u.dec(frame.n), this.aad(frame.d, frame.e, i)).decrypt(b64u.dec(frame.c));
      const out = unpad(pt);
      if (!out) return null;
      return { pt: out, state: next };
    } catch {
      return null;
    } finally {
      key.fill(0);
    }
  }

  decrypt(frame: Frame): { kind: number; text: string } | null {
    if (this.dead) return null;
    if (typeof frame.e !== "number" || typeof frame.i !== "number") return null;
    if (frame.d !== 1 - this.dir) return null;
    const e = frame.e | 0;

    if (e === this.epoch) {
      const r = this.open(this.recv, frame);
      if (!r) return null;
      this.recv = r.state;
      this.heard++;
      // `p` jest uwierzytelnione przez AEAD; w bieżącej epoce to zawsze
      // aktualny klucz rozmówcy, więc nadążamy za jego obrotem
      if (this.host && frame.p) {
        const pk = b64u.dec(frame.p);
        this.peerDh?.fill(0);
        this.peerDh = pk;
      }
      return r.pt;
    }

    // przejęcie nowej epoki jest transakcyjne: commitujemy tylko po udanym odszyfrowaniu
    if (e === this.epoch + 1) {
      if (!frame.p || !this.peerDh) return null;
      let dh: Bytes;
      try {
        dh = agree(this.dh.sk, b64u.dec(frame.p));
      } catch {
        return null;
      }
      const root = hkdf(sha256, dh, this.root, enc.encode("nullczat/v1/ratchet/" + e), 32);
      dh.fill(0);
      const send = this.chainFor(root, this.dir);
      const recv = this.chainFor(root, 1 - this.dir);
      const r = this.open({ chain: recv, idx: 0, skipped: new Map() }, frame);
      if (!r) {
        root.fill(0);
        send.fill(0);
        recv.fill(0);
        return null;
      }

      this.dropPrev();
      this.prev = { chain: this.recv.chain, idx: this.recv.idx, skipped: this.recv.skipped, epoch: this.epoch };
      this.send.chain.fill(0);
      this.root.fill(0);
      this.send = { chain: send, idx: 0, skipped: new Map() };
      this.recv = r.state;
      this.root = root;
      this.epoch = e;
      this.sent = 0;
      this.heard = 1;
      const pk = b64u.dec(frame.p);
      this.peerDh.fill(0);
      this.peerDh = pk;
      // własna para też się obraca: klucz użyty w tej epoce nie może
      // posłużyć do policzenia następnej (inaczej przejęcie stanu zostaje ważne)
      if (!this.host) {
        const fresh = newEphemeral();
        this.dh.sk.fill(0);
        this.dh = fresh;
      }
      return r.pt;
    }

    if (this.prev && e === this.prev.epoch) {
      const r = this.open(this.prev, frame);
      if (!r) return null;
      this.prev = { chain: r.state.chain, idx: r.state.idx, skipped: r.state.skipped, epoch: this.prev.epoch };
      return r.pt;
    }

    return null;
  }

  destroy(): void {
    this.dead = true;
    for (const k of this.send.skipped.values()) k.fill(0);
    for (const k of this.recv.skipped.values()) k.fill(0);
    this.send.skipped.clear();
    this.recv.skipped.clear();
    this.dropPrev();
    this.send.chain.fill(0);
    this.recv.chain.fill(0);
    this.root.fill(0);
    this.dh.sk.fill(0);
    if (this.peerDh) this.peerDh.fill(0);
    this.peerDh = null;
  }
}

/** Hash biletu — to jedyna postać, jaką widzi serwer. */
export function hashTicket(t: string): string {
  return hex(sha256(enc.encode(t)));
}
