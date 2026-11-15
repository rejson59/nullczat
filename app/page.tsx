"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import * as C from "@/lib/crypto";
import * as L from "@/lib/live";

type Phase = "boot" | "idle" | "wait" | "chat" | "dead";
type Msg = { id: number; mine: boolean; text: string; sent: boolean };
type Wire = { k?: string; pk?: string } & Partial<C.Frame>;

const IDLE_BURN_MS = 10 * 60 * 1000; // bezczynność
const PEER_GONE_MS = 60 * 1000; // rozmówca wyszedł
const FALLBACK_TTL_MS = 30 * 60 * 1000; // gdyby serwer nie zwrócił exp

const I = {
  plus: (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M12 5v14M5 12h14" strokeLinecap="square" />
    </svg>
  ),
  copy: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="9" y="9" width="11" height="11" rx="1.5" />
      <path d="M15 5.5A1.5 1.5 0 0 0 13.5 4H5.5A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15" />
    </svg>
  ),
  check: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M5 13l4.5 4.5L19 7" strokeLinecap="square" />
    </svg>
  ),
  trash: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M4 7h16M9.5 7V4.8h5V7M6.5 7l.9 12.2h9.2L17.5 7" strokeLinecap="square" />
      <path d="M10.2 11v5M13.8 11v5" strokeLinecap="square" />
    </svg>
  ),
  send: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M5 19L19 5M19 5h-8M19 5v8" strokeLinecap="square" />
    </svg>
  ),
  hand: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.2 13.4V5.5a1.45 1.45 0 0 1 2.9 0v7.2" />
      <path d="M14.1 12.4h2.2a1.35 1.35 0 0 1 1.35 1.35v1.35" />
      <path d="M17.65 15.1a1.3 1.3 0 0 1 1.3 1.3v1.35c0 2.8-1.95 4.75-4.75 4.75h-1.9c-1.4 0-2.55-.55-3.4-1.7l-2.55-3.35a1.4 1.4 0 0 1 2.05-1.9l1.8 1.6" />
    </svg>
  ),
  eye: (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
      <path d="M2.4 13c3.6-5.4 7.3-7.2 10.6-7.2S20 7.6 23.6 13c-3.6 5.4-7.3 7.2-10.6 7.2S6 18.4 2.4 13z" />
      <circle cx="13" cy="13" r="2.6" fill="currentColor" stroke="none" />
    </svg>
  ),
  gone: (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M12 3.2c-4.3 0-7.7 3.1-7.7 7 0 2.5 1.2 4.3 2.9 5.4v2.3c0 .9.7 1.6 1.6 1.6h6.4c.9 0 1.6-.7 1.6-1.6v-2.3c1.7-1.1 2.9-2.9 2.9-5.4 0-3.9-3.4-7-7.7-7z" strokeLinejoin="round" />
      <circle cx="9.3" cy="10" r="1.35" />
      <circle cx="14.7" cy="10" r="1.35" />
      <path d="M12 13v1.6M10.4 17.4v2.2M13.6 17.4v2.2" strokeLinecap="round" />
    </svg>
  ),
  skull: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M12 3.2c-4.3 0-7.7 3.1-7.7 7 0 2.5 1.2 4.3 2.9 5.4v2.3c0 .9.7 1.6 1.6 1.6h6.4c.9 0 1.6-.7 1.6-1.6v-2.3c1.7-1.1 2.9-2.9 2.9-5.4 0-3.9-3.4-7-7.7-7z" strokeLinejoin="round" />
      <circle cx="9.3" cy="10" r="1.35" />
      <circle cx="14.7" cy="10" r="1.35" />
      <path d="M12 13v1.6M10.4 17.4v2.2M13.6 17.4v2.2" strokeLinecap="round" />
    </svg>
  ),
};

export default function Page() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [peer, setPeer] = useState(false);
  const [peerGone, setPeerGone] = useState(false);
  const [skull, setSkull] = useState(false);
  const [hint, setHint] = useState(false);
  const [goneLeft, setGoneLeft] = useState(0);
  const [fp, setFp] = useState<string[]>([]);
  const [linkUrl, setLinkUrl] = useState("");
  const [peek, setPeek] = useState(false);
  const [typing, setTyping] = useState(false);
  const [dim, setDim] = useState(false);
  const [uplink, setUplink] = useState(true);
  const [ttl, setTtl] = useState<{ ms: number; key: number } | null>(null);

  const sess = useRef<C.Session | null>(null);
  const chan = useRef<RealtimeChannel | null>(null);
  const secret = useRef<Uint8Array | null>(null);
  const eph = useRef<C.Ephemeral | null>(null);
  const hostPk = useRef<string>("");
  const room = useRef<string>("");
  const seat = useRef<string>("");
  const destroyTicket = useRef<string>("");
  const link = useRef<string>("");
  const helloT = useRef<number | null>(null);
  const isHost = useRef(false);
  const over = useRef(false);
  const counter = useRef(0);
  const feedEnd = useRef<HTMLDivElement | null>(null);
  const peekT = useRef<number | null>(null);
  const inpRef = useRef<HTMLInputElement | null>(null);
  const peekFocus = useRef(false);
  const reconnT = useRef<number | null>(null);
  const reconnN = useRef(0);
  const pending = useRef<Map<number, C.Frame>>(new Map());
  const lastAct = useRef(Date.now());
  const peerSeen = useRef(false);
  const hintDone = useRef(false);

  // Wywołania między funkcjami, które nie mogą się odwołać do siebie nawzajem.
  const api = useRef({
    connect: () => {},
    reconnect: () => {},
    frame: (_: unknown) => {},
    flush: () => {},
    shutdown: (_: boolean) => {},
    hello: () => {},
  });

  const touch = useCallback(() => {
    lastAct.current = Date.now();
  }, []);

  const markSent = useCallback((id: number) => {
    pending.current.delete(id);
    setMsgs((m) => m.map((x) => (x.id === id ? { ...x, sent: true } : x)));
  }, []);

  const pushIn = useCallback((text: string) => {
    setMsgs((m) => [...m, { id: ++counter.current, mine: false, text, sent: true }]);
  }, []);

  const sendFrame = useCallback((payload: unknown): Promise<boolean> => {
    const ch = chan.current;
    if (!ch) return Promise.resolve(false);
    return ch
      .send({ type: "broadcast", event: "f", payload })
      .then((r) => r === "ok")
      .catch(() => false);
  }, []);

  const flush = useCallback(() => {
    const entries = Array.from(pending.current.entries());
    for (const [id, frame] of entries) {
      void sendFrame(frame).then((ok) => {
        if (ok) markSent(id);
      });
    }
  }, [markSent, sendFrame]);

  const teardown = useCallback(() => {
    if (helloT.current !== null) window.clearInterval(helloT.current);
    if (reconnT.current !== null) window.clearTimeout(reconnT.current);
    helloT.current = null;
    reconnT.current = null;

    sess.current?.destroy();
    sess.current = null;

    if (chan.current) {
      try {
        void L.live().removeChannel(chan.current);
      } catch {
        /* nic */
      }
      chan.current = null;
    }

    secret.current?.fill(0);
    secret.current = null;
    eph.current?.sk.fill(0);
    eph.current = null;
    hostPk.current = "";
    room.current = "";
    seat.current = "";
    link.current = "";
    pending.current.clear();
    peerSeen.current = false;

    setMsgs([]);
    setDraft("");
    setFp([]);
    setPeer(false);
    setPeerGone(false);
    setSkull(false);
    setLinkUrl("");
    setTtl(null);
  }, []);

  const hardReset = useCallback(() => {
    setPhase("idle");
    window.location.replace("/");
    window.setTimeout(() => {
      window.location.reload();
    }, 320);
  }, []);

  const shutdown = useCallback(
    (tell: boolean) => {
      if (over.current) return;
      over.current = true;
      const d = destroyTicket.current;

      const finish = () => {
        teardown();
        destroyTicket.current = "";
        if (!d) {
          hardReset();
          return;
        }
        const bail = new Promise<void>((r) => window.setTimeout(r, 1200));
        void Promise.race([L.destroyRoom(d), bail]).then(hardReset, hardReset);
      };

      if (tell && sess.current) {
        let frame: C.Frame | null = null;
        try {
          frame = sess.current.encrypt(C.KIND_BURN, "");
        } catch {
          frame = null;
        }
        if (frame) {
          const wait = new Promise<void>((r) => window.setTimeout(r, 800));
          void Promise.race([sendFrame(frame), wait]).then(finish, finish);
          return;
        }
      }
      finish();
    },
    [hardReset, sendFrame, teardown],
  );

  const burnAway = useCallback(() => {
    // window.open musi polecieć synchronicznie w geście, inaczej przeglądarka zablokuje kartę
    let opened: Window | null = null;
    try {
      opened = window.open("https://www.google.com/", "_blank");
      if (opened) opened.opener = null;
    } catch {
      opened = null;
    }

    if (over.current) {
      window.location.replace(opened ? "about:blank" : "https://www.google.com/");
      return;
    }
    over.current = true;

    if (sess.current) {
      try {
        void sendFrame(sess.current.encrypt(C.KIND_BURN, ""));
      } catch {
        /* nic */
      }
    }

    const d = destroyTicket.current;
    destroyTicket.current = "";
    if (d) void L.destroyRoom(d);

    teardown();

    const target = opened ? "about:blank" : "https://www.google.com/";
    window.setTimeout(() => window.location.replace(target), 140);
  }, [sendFrame, teardown]);

  const handleFrame = useCallback(
    (raw: unknown) => {
      if (!raw || over.current) return;
      const f = raw as Wire;

      // --- parowanie -------------------------------------------------
      if (f.k === "h") {
        if (!isHost.current || !f.pk) return;
        if (hostPk.current) {
          void sendFrame({ k: "h2", pk: hostPk.current });
          return;
        }
        const S = secret.current;
        if (!S) return;
        const e = C.newEphemeral();
        eph.current = e;
        hostPk.current = C.b64u.enc(e.pk);
        const dh = C.agree(e.sk, C.b64u.dec(f.pk));
        const root = C.pairingRoot(S, dh, room.current);
        dh.fill(0);
        const s = new C.Session(root, true, room.current, e, C.b64u.dec(f.pk));
        root.fill(0);
        sess.current = s;
        setFp(s.fingerprint);
        void sendFrame({ k: "h2", pk: hostPk.current });
        void sendFrame(s.encrypt(C.KIND_PING, ""));
        S.fill(0);
        secret.current = null;
        return;
      }

      if (f.k === "h2") {
        if (isHost.current || sess.current || !f.pk) return;
        const S = secret.current;
        const e = eph.current;
        if (!S || !e) return;
        const dh = C.agree(e.sk, C.b64u.dec(f.pk));
        const root = C.pairingRoot(S, dh, room.current);
        dh.fill(0);
        const s = new C.Session(root, false, room.current, e, C.b64u.dec(f.pk));
        root.fill(0);
        sess.current = s;
        setFp(s.fingerprint);
        void sendFrame(s.encrypt(C.KIND_PING, ""));
        S.fill(0);
        secret.current = null;
        if (helloT.current !== null) {
          window.clearInterval(helloT.current);
          helloT.current = null;
        }
        return;
      }

      // --- zaszyfrowane ramki ----------------------------------------
      const s = sess.current;
      if (!s || typeof f.c !== "string") return;
      const out = s.decrypt(f as C.Frame);
      if (!out) return;

      if (out.kind === C.KIND_BURN) {
        api.current.shutdown(false);
        return;
      }
      if (out.kind === C.KIND_MSG) {
        pushIn(out.text);
        setPhase("chat");
        return;
      }
      if (out.kind === C.KIND_PING) setPhase("chat");
    },
    [pushIn, sendFrame],
  );

  const reconnect = useCallback(() => {
    if (over.current || reconnT.current !== null) return;
    const delay = Math.min(10000, 700 * Math.pow(1.6, reconnN.current));
    reconnN.current += 1;
    reconnT.current = window.setTimeout(() => {
      reconnT.current = null;
      const old = chan.current;
      chan.current = null;
      if (old) {
        try {
          void L.live().removeChannel(old);
        } catch {
          /* nic */
        }
      }
      api.current.connect();
    }, delay);
  }, []);

  const connect = useCallback(() => {
    if (over.current || !room.current || !seat.current) return;
    const ch = L.openChannel(room.current, seat.current);

    ch.on("broadcast", { event: "f" }, (m: { payload?: unknown }) => api.current.frame(m.payload));

    ch.on("presence", { event: "sync" }, () => {
      if (over.current) return;
      let n = 0;
      try {
        n = Object.keys(ch.presenceState()).length;
      } catch {
        n = 0;
      }
      const other = n > 1;
      setPeer(other);
      if (other) {
        peerSeen.current = true;
        setPeerGone(false);
      } else if (peerSeen.current) {
        setPeerGone(true);
      }
    });

    ch.subscribe((status: string) => {
      if (over.current) return;
      if (status === "SUBSCRIBED") {
        reconnN.current = 0;
        setUplink(true);
        void ch.track({ at: Date.now() });
        api.current.flush();
        if (!isHost.current && !sess.current) api.current.hello();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        setUplink(false);
        api.current.reconnect();
      }
    });

    chan.current = ch;
  }, []);

  const startHello = useCallback(() => {
    if (!eph.current) eph.current = C.newEphemeral();
    const beat = () => {
      if (over.current || sess.current || !eph.current) {
        if (helloT.current !== null) {
          window.clearInterval(helloT.current);
          helloT.current = null;
        }
        return;
      }
      void sendFrame({ k: "h", pk: C.b64u.enc(eph.current.pk) });
    };
    if (helloT.current !== null) return;
    beat();
    helloT.current = window.setInterval(beat, 1300);
  }, [sendFrame]);

  useEffect(() => {
    api.current.connect = connect;
    api.current.reconnect = reconnect;
    api.current.frame = handleFrame;
    api.current.flush = flush;
    api.current.shutdown = shutdown;
    api.current.hello = startHello;
  }, [connect, reconnect, handleFrame, flush, shutdown, startHello]);

  const startHost = useCallback(async () => {
    over.current = false;
    touch();
    setPhase("wait");
    const S = C.newSecret();
    secret.current = S;
    destroyTicket.current = C.deriveTicket(S, "destroy");
    link.current = "";
    const st = C.b64u.enc(C.newSecret());
    const res = await L.createRoom(C.deriveTicket(S, "invite"), destroyTicket.current, C.hashTicket(st));
    if (!res) {
      setPhase("idle");
      return;
    }
    room.current = res.room;
    seat.current = st;
    isHost.current = true;
    const exp = res.exp ? Date.parse(res.exp) : Date.now() + FALLBACK_TTL_MS;
    setTtl({ ms: Math.max(1000, exp - Date.now()), key: exp });
    link.current = `${window.location.origin}/#${C.b64u.enc(S)}`;
    setLinkUrl(link.current);
    api.current.connect();
  }, [touch]);

  const startGuest = useCallback(
    async (frag: string) => {
      over.current = false;
      touch();
      const S = C.b64u.dec(frag);
      if (S.length !== 32) {
        setPhase("dead");
        return;
      }
      secret.current = S;
      destroyTicket.current = C.deriveTicket(S, "destroy");
      const st = C.b64u.enc(C.newSecret());
      const res = await L.claimRoom(C.deriveTicket(S, "invite"), C.hashTicket(st));
      if (!res) {
        S.fill(0);
        secret.current = null;
        setPhase("dead");
        return;
      }
      room.current = res.room;
      seat.current = st;
      isHost.current = false;
      const exp = res.exp ? Date.parse(res.exp) : Date.now() + FALLBACK_TTL_MS;
      setTtl({ ms: Math.max(1000, exp - Date.now()), key: exp });
      setPhase("wait");

      api.current.connect();
    },
    [sendFrame, touch],
  );

  useEffect(() => {
    const frag = window.location.hash.slice(1);
    if (frag) window.history.replaceState(null, "", window.location.pathname);
    if (frag) void startGuest(frag);
    else setPhase("idle");
  }, [startGuest]);

  // zniknięcie przy utracie fokusu / schowaniu karty
  useEffect(() => {
    const update = () => setDim(document.visibilityState !== "visible" || !document.hasFocus());
    window.addEventListener("blur", update);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("blur", update);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  // bezczynność
  useEffect(() => {
    const iv = window.setInterval(() => {
      if (over.current) return;
      if (Date.now() - lastAct.current > IDLE_BURN_MS) api.current.shutdown(true);
    }, 20000);
    return () => window.clearInterval(iv);
  }, []);

  // koniec życia pokoju
  useEffect(() => {
    if (!ttl) return;
    const t = window.setTimeout(() => {
      if (sess.current) {
        api.current.shutdown(false);
        return;
      }
      const d = destroyTicket.current;
      teardown();
      destroyTicket.current = "";
      over.current = true;
      setPhase("dead");
      if (d) void L.destroyRoom(d);
    }, ttl.ms + 500);
    return () => window.clearTimeout(t);
  }, [ttl, teardown]);

  // odliczanie po zniknięciu rozmówcy
  useEffect(() => {
    if (!peerGone) {
      setGoneLeft(0);
      return;
    }
    const start = Date.now();
    setGoneLeft(Math.ceil(PEER_GONE_MS / 1000));
    const iv = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((PEER_GONE_MS - (Date.now() - start)) / 1000));
      setGoneLeft(left);
      if (left === 0) {
        window.clearInterval(iv);
        api.current.shutdown(false);
      }
    }, 250);
    return () => window.clearInterval(iv);
  }, [peerGone]);

  // jednorazowa demonstracja: przytrzymanie rozjaśnia tekst
  useEffect(() => {
    if (phase !== "chat" || hintDone.current || msgs.length === 0) return;
    hintDone.current = true;
    // timery celowo nie są czyszczone w cleanupie: nowa wiadomość nie może przerwać
    // trwającej demonstracji, a same gasną po 4,25 s
    window.setTimeout(() => setHint(true), 650);
    window.setTimeout(() => setHint(false), 2150);
    window.setTimeout(() => setHint(true), 2750);
    window.setTimeout(() => setHint(false), 4250);
  }, [phase, msgs]);

  useEffect(() => {
    if (!peerGone) {
      setSkull(false);
      return;
    }
    const t = window.setTimeout(() => setSkull(true), 1400);
    return () => window.clearTimeout(t);
  }, [peerGone]);

  useEffect(() => {
    if (phase !== "dead") return;
    const t = window.setTimeout(() => {
      over.current = false;
      setPhase("idle");
    }, 2400);
    return () => window.clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    feedEnd.current?.scrollIntoView({ block: "end" });
  }, [msgs]);

  const startPeek = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      touch();
      const el = inpRef.current;
      peekFocus.current = !!el && document.activeElement === el;
      // trzymanie ekranu nie może odbierać fokusu polu tekstowemu — inaczej znika klawiatura.
      // Tknięcia w samo pole zostawiamy systemowi (kursor, zaznaczanie).
      const tg = e.target as Node | null;
      const onField = !!el && !!tg && (tg === el || el.contains(tg));
      if (peekFocus.current && !onField) e.preventDefault();
      if (peekT.current !== null) return;
      peekT.current = window.setTimeout(() => setPeek(true), 180);
    },
    [touch],
  );

  const endPeek = useCallback(() => {
    if (peekT.current !== null) {
      window.clearTimeout(peekT.current);
      peekT.current = null;
    }
    setPeek(false);
    const el = inpRef.current;
    if (peekFocus.current && el && document.activeElement !== el) {
      el.focus({ preventScroll: true });
    }
    peekFocus.current = false;
  }, []);

  const copy = useCallback(() => {
    if (!link.current) return;
    void navigator.clipboard
      .writeText(link.current)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {});
  }, []);

  const say = useCallback(() => {
    const s = sess.current;
    const text = draft.trim();
    if (!s || !text) return;
    touch();
    let frame: C.Frame;
    try {
      frame = s.encrypt(C.KIND_MSG, text);
    } catch {
      return;
    }
    const id = ++counter.current;
    setMsgs((m) => [...m, { id, mine: true, text, sent: false }]);
    setDraft("");
    pending.current.set(id, frame);
    void sendFrame(frame).then((ok) => {
      if (ok) markSent(id);
    });
  }, [draft, markSent, sendFrame, touch]);

  const liveNow = phase === "chat";
  const waiting = phase === "wait";
  const blocked = !uplink;

  return (
    <main
      className={`app${peek ? " peek" : ""}${hint ? " demo" : ""}${dim ? " dim" : ""}${blocked ? " held" : ""}`}
      onPointerDown={startPeek}
      onPointerUp={endPeek}
      onPointerLeave={endPeek}
      onPointerCancel={endPeek}
      onKeyDown={touch}
    >
      {ttl && (liveNow || waiting) ? (
        <div className="ttl" key={ttl.key} style={{ animationDuration: `${ttl.ms}ms` }} aria-hidden="true" />
      ) : null}

      <header className="bar">
        <span className={`dot${peer ? " on" : ""}`} aria-hidden="true" />
        <div className="acts">
          {waiting && linkUrl ? (
            <button className="ic" onClick={copy} aria-label="copy" title="copy">
              {copied ? I.check : I.copy}
            </button>
          ) : null}
          {liveNow || waiting ? (
            <button className="ic danger" onClick={burnAway} aria-label="delete" title="delete">
              {I.trash}
            </button>
          ) : null}
        </div>
      </header>

      <section className="stage">
        {hint && liveNow ? (
          <div className="teach" aria-hidden="true">
            <span className="eye">{I.eye}</span>
            <span className="hand">{I.hand}</span>
          </div>
        ) : null}
        {phase === "idle" || phase === "boot" ? (
          <button className="plus" onClick={startHost} aria-label="new" title="new">
            {I.plus}
          </button>
        ) : null}
        {phase === "dead" ? <span className="gone" aria-hidden="true">{I.gone}</span> : null}
        {waiting ? <span className="pulse" aria-hidden="true" /> : null}
        {liveNow ? (
          <div className="feed">
            {fp.length ? (
              <div className="fp" aria-hidden="true">
                {fp.map((c, i) => (
                  <i key={i} style={{ background: c }} />
                ))}
              </div>
            ) : null}
            {msgs.map((m) => (
              <div key={m.id} className={`b ${m.mine ? "me" : "you"}${m.sent ? "" : " unsent"}`}>
                {m.text}
              </div>
            ))}
            <div ref={feedEnd} />
          </div>
        ) : null}
      </section>

      {skull && liveNow ? (
        <span className="skull" aria-hidden="true">
          {I.skull}
          <b className="secs">{goneLeft}</b>
        </span>
      ) : null}

      {liveNow ? (
        <footer className="bar foot">
          <input
            ref={inpRef}
            type="search"
            className={`inp${typing ? " on" : ""}`}
            value={draft}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
            onChange={(e) => {
              setDraft(e.target.value);
              touch();
            }}
            onKeyDown={(e) => {
              touch();
              if (e.key === "Enter") say();
            }}
            disabled={blocked}
            aria-label="message"
            aria-autocomplete="none"
            autoFocus
            autoComplete="off"
            data-form-type="other"
            data-lpignore="true"
            data-1p-ignore="true"
            data-bwignore="true"
            data-protonpass-ignore="true"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="send"
          />
          <button className="ic send" onClick={say} disabled={blocked} aria-label="send" title="send">
            {I.send}
          </button>
        </footer>
      ) : null}
    </main>
  );
}
