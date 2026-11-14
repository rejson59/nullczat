"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import * as C from "@/lib/crypto";
import * as L from "@/lib/live";

type Phase = "boot" | "idle" | "wait" | "chat" | "dead";
type Msg = { id: number; mine: boolean; text: string };

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
};

export default function Page() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [peer, setPeer] = useState(false);
  const [fp, setFp] = useState<string[]>([]);
  const [linkUrl, setLinkUrl] = useState("");
  const [peek, setPeek] = useState(false);

  const sess = useRef<C.Session | null>(null);
  const chan = useRef<RealtimeChannel | null>(null);
  const secret = useRef<Uint8Array | null>(null);
  const eph = useRef<C.Ephemeral | null>(null);
  const hostPk = useRef<string>("");
  const room = useRef<string>("");
  const destroyTicket = useRef<string>("");
  const link = useRef<string>("");
  const retry = useRef<number | null>(null);
  const isHost = useRef(false);
  const over = useRef(false);
  const counter = useRef(0);
  const feedEnd = useRef<HTMLDivElement | null>(null);
  const peekT = useRef<number | null>(null);

  const resetRef = useRef<() => void>(() => {});
  const shutdownRef = useRef<(tell: boolean) => void>(() => {});

  const startPeek = useCallback(() => {
    if (peekT.current !== null) return;
    peekT.current = window.setTimeout(() => setPeek(true), 180);
  }, []);

  const endPeek = useCallback(() => {
    if (peekT.current !== null) {
      window.clearTimeout(peekT.current);
      peekT.current = null;
    }
    setPeek(false);
  }, []);

  const push = useCallback((mine: boolean, text: string) => {
    setMsgs((m) => [...m, { id: ++counter.current, mine, text }]);
  }, []);

  const wipe = useCallback(
    (opts: { tell: boolean }) => {
      if (over.current) return;
      over.current = true;

      if (opts.tell && sess.current && chan.current) {
        try {
          const f = sess.current.encrypt(C.KIND_BURN, "");
          void chan.current.send({ type: "broadcast", event: "f", payload: f });
        } catch {
          /* nic */
        }
      }

      if (retry.current !== null) {
        window.clearInterval(retry.current);
        retry.current = null;
      }

      sess.current?.destroy();
      sess.current = null;

      if (chan.current) {
        try {
          void chan.current.unsubscribe();
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
      link.current = "";

      setMsgs([]);
      setDraft("");
      setFp([]);
      setPeer(false);
      setLinkUrl("");


      try {
        window.localStorage.clear();
        window.sessionStorage.clear();
      } catch {
        /* nic */
      }
    },
    [],
  );

  const send = useCallback((payload: unknown) => {
    const ch = chan.current;
    if (!ch) return;
    try {
      void ch.send({ type: "broadcast", event: "f", payload });
    } catch {
      /* nic */
    }
  }, []);

  const handleFrame = useCallback(
    (p: unknown) => {
      if (!p || over.current) return;
      const f = p as { k?: string; pk?: string } & Partial<C.Frame>;

      // --- parowanie -------------------------------------------------
      if (f.k === "h") {
        if (!isHost.current || !f.pk) return;
        if (hostPk.current) {
          send({ k: "h2", pk: hostPk.current });
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
        const s = new C.Session(root, true, room.current);
        sess.current = s;
        setFp(s.fingerprint);
        send({ k: "h2", pk: hostPk.current });
        send(s.encrypt(C.KIND_PING, ""));
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
        const s = new C.Session(root, false, room.current);
        sess.current = s;
        setFp(s.fingerprint);
        send(s.encrypt(C.KIND_PING, ""));
        S.fill(0);
        secret.current = null;
        if (retry.current !== null) {
          window.clearInterval(retry.current);
          retry.current = null;
        }
        return;
      }

      // --- zaszyfrowane ramki ----------------------------------------
      const s = sess.current;
      if (!s || typeof f.c !== "string") return;
      const out = s.decrypt(f as C.Frame);
      if (!out) return;

      if (out.kind === C.KIND_BURN) {
        shutdownRef.current(false);
        return;
      }
      if (out.kind === C.KIND_MSG) {
        push(false, out.text);
        setPhase("chat");
        return;
      }
      if (out.kind === C.KIND_PING) setPhase("chat");
    },
    [push, send, wipe],
  );

  const subscribe = useCallback(
    (roomId: string, seat: string, ready: () => void) => {
      const ch = L.openChannel(roomId, seat);
      ch.on("broadcast", { event: "f" }, (msg: { payload?: unknown }) => handleFrame(msg.payload));
      ch.on("presence", { event: "sync" }, () => {
        try {
          setPeer(Object.keys(ch.presenceState()).length > 1);
        } catch {
          /* nic */
        }
      });
      ch.subscribe((status: string) => {
        if (status === "SUBSCRIBED") {
          void ch.track({ at: Date.now() });
          ready();
        }
      });
      chan.current = ch;
    },
    [handleFrame],
  );

  const startHost = useCallback(async () => {
    over.current = false;
    setPhase("wait");
    const S = C.newSecret();
    secret.current = S;
    destroyTicket.current = C.deriveTicket(S, "destroy");
    link.current = "";
    const seat = C.b64u.enc(C.newSecret());
    const roomId = await L.createRoom(C.deriveTicket(S, "invite"), destroyTicket.current, C.hashTicket(seat));
    if (!roomId) {
      setPhase("idle");
      return;
    }
    room.current = roomId;
    isHost.current = true;
    link.current = `${window.location.origin}/#${C.b64u.enc(S)}`;
    setLinkUrl(link.current);
    subscribe(roomId, seat, () => {});
  }, [subscribe]);

  const startGuest = useCallback(
    async (frag: string) => {
      over.current = false;
      const S = C.b64u.dec(frag);
      if (S.length !== 32) {
        setPhase("dead");
        return;
      }
      secret.current = S;
      destroyTicket.current = C.deriveTicket(S, "destroy");
      const seat = C.b64u.enc(C.newSecret());
      const roomId = await L.claimRoom(C.deriveTicket(S, "invite"), C.hashTicket(seat));
      if (!roomId) {
        secret.current.fill(0);
        secret.current = null;
        setPhase("dead");
        return;
      }
      room.current = roomId;
      isHost.current = false;
      setPhase("wait");
      subscribe(roomId, seat, () => {
        const e = C.newEphemeral();
        eph.current = e;
        const hello = () => {
          if (!sess.current && eph.current) send({ k: "h", pk: C.b64u.enc(eph.current.pk) });
        };
        hello();
        retry.current = window.setInterval(hello, 1300);
      });
    },
    [send, subscribe],
  );

  useEffect(() => {
    const frag = window.location.hash.slice(1);
    if (frag) window.history.replaceState(null, "", window.location.pathname);
    if (frag) void startGuest(frag);
    else setPhase("idle");
  }, [startGuest]);

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

  const hardReset = useCallback(() => {
    setPhase("idle");
    window.location.replace("/");
    window.setTimeout(() => window.location.reload(), 300);
  }, []);

  useEffect(() => {
    resetRef.current = hardReset;
  }, [hardReset]);

  const shutdown = useCallback(
    (tell: boolean) => {
      const d = destroyTicket.current;
      wipe({ tell });
      const go = () => hardReset();
      if (!d) {
        go();
        return;
      }
      const bail = new Promise<void>((r) => window.setTimeout(r, 1200));
      void Promise.race([L.destroyRoom(d), bail]).then(go, go);
    },
    [wipe, hardReset],
  );

  useEffect(() => {
    shutdownRef.current = shutdown;
  }, [shutdown]);

  const burn = useCallback(() => shutdown(true), [shutdown]);

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
    try {
      send(s.encrypt(C.KIND_MSG, text));
      push(true, text);
      setDraft("");
    } catch {
      /* nic */
    }
  }, [draft, push, send]);

  const live = phase === "chat";
  const waiting = phase === "wait";

  return (
    <main
      className={`app${peek ? " peek" : ""}`}
      onPointerDown={startPeek}
      onPointerUp={endPeek}
      onPointerLeave={endPeek}
      onPointerCancel={endPeek}
    >
      <header className="bar">
        <span className={`dot${peer ? " on" : ""}`} aria-hidden="true" />
        <div className="acts">
          {waiting && linkUrl ? (
            <button className="ic" onClick={copy} aria-label="copy" title="copy">
              {copied ? I.check : I.copy}
            </button>
          ) : null}
          {live || waiting ? (
            <button className="ic danger" onClick={burn} aria-label="delete" title="delete">
              {I.trash}
            </button>
          ) : null}
        </div>
      </header>

      <section className="stage">
        {phase === "idle" || phase === "boot" ? (
          <button className="plus" onClick={startHost} aria-label="new" title="new">
            {I.plus}
          </button>
        ) : null}
        {phase === "dead" ? <span className="dead" aria-hidden="true" /> : null}
        {waiting ? <span className="pulse" aria-hidden="true" /> : null}
        {live ? (
          <div className="feed">
            {fp.length ? (
              <div className="fp" aria-hidden="true">
                {fp.map((c, i) => (
                  <i key={i} style={{ background: c }} />
                ))}
              </div>
            ) : null}
            {msgs.map((m) => (
              <div key={m.id} className={`b ${m.mine ? "me" : "you"}`}>
                {m.text}
              </div>
            ))}
            <div ref={feedEnd} />
          </div>
        ) : null}
      </section>

      {live ? (
        <footer className="bar foot">
          <input
            className="inp"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") say();
            }}
            aria-label="message"
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="send"
          />
          <button className="ic send" onClick={say} aria-label="send" title="send">
            {I.send}
          </button>
        </footer>
      ) : null}
    </main>
  );
}
