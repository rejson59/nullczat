// Testy silnika kryptograficznego nullczat.
// Uruchomienie: node --experimental-strip-types test/engine.test.mjs
//
// Uwaga: pola `private` w TS są tylko kompilacyjne, więc test może je czytać —
// to celowe: chcemy sprawdzać stan ratchetu, nie tylko API.

import {
  Session,
  newEphemeral,
  newSecret,
  agree,
  pairingRoot,
  b64u,
  KIND_MSG,
  KIND_BURN,
  KIND_PING,
} from "../lib/crypto.ts";

let pass = 0;
let fail = 0;

function ok(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`);
  }
}

function cloneSession(s) {
  const c = Object.create(Session.prototype);
  c.root = new Uint8Array(s.root);
  c.dh = { sk: new Uint8Array(s.dh.sk), pk: new Uint8Array(s.dh.pk) };
  c.peerDh = s.peerDh ? new Uint8Array(s.peerDh) : null;
  c.epoch = s.epoch;
  c.send = { chain: new Uint8Array(s.send.chain), idx: s.send.idx, skipped: new Map(s.send.skipped) };
  c.recv = { chain: new Uint8Array(s.recv.chain), idx: s.recv.idx, skipped: new Map(s.recv.skipped) };
  c.prev = s.prev
    ? {
        chain: new Uint8Array(s.prev.chain),
        idx: s.prev.idx,
        skipped: new Map(s.prev.skipped),
        epoch: s.prev.epoch,
      }
    : null;
  c.sent = s.sent;
  c.heard = s.heard;
  c.dir = s.dir;
  c.roomId = s.roomId;
  c.host = s.host;
  c.dead = false;
  c.fingerprint = s.fingerprint;
  return c;
}

function pair(roomId = "7f3c1a90-0000-4000-8000-abcdefabcdef") {
  const S = newSecret();
  const h = newEphemeral();
  const g = newEphemeral();
  const dhH = agree(h.sk, g.pk);
  const dhG = agree(g.sk, h.pk);
  const rootH = pairingRoot(S, dhH, roomId);
  const rootG = pairingRoot(S, dhG, roomId);
  const host = new Session(rootH, true, roomId, h, g.pk);
  const guest = new Session(rootG, false, roomId, g, h.pk);
  return { host, guest, S, h, g };
}

console.log("\n1. parowanie i odcisk");
{
  const { host, guest } = pair();
  ok("obie strony mają ten sam odcisk", host.fingerprint.join() === guest.fingerprint.join());
  ok("odcisk ma 4 elementy", host.fingerprint.length === 4);
}

console.log("\n2. zwykła rozmowa w obie strony");
{
  const { host, guest } = pair();
  let good = true;
  for (let n = 0; n < 5; n++) {
    const f1 = host.encrypt(KIND_MSG, `host ${n}`);
    const d1 = guest.decrypt(f1);
    if (!d1 || d1.text !== `host ${n}` || d1.kind !== KIND_MSG) good = false;
    const f2 = guest.encrypt(KIND_MSG, `guest ${n}`);
    const d2 = host.decrypt(f2);
    if (!d2 || d2.text !== `guest ${n}`) good = false;
  }
  ok("20 wiadomości przechodzi w obie strony", good);
}

console.log("\n3. kolejność odwrócona w obrębie epoki");
{
  const { host, guest } = pair();
  const frames = [0, 1, 2, 3].map((n) => host.encrypt(KIND_MSG, `m${n}`));
  const got = [guest.decrypt(frames[3]), guest.decrypt(frames[0]), guest.decrypt(frames[2]), guest.decrypt(frames[1])];
  ok(
    "wszystkie 4 docierają, mimo kolejności 3,0,2,1",
    got.every((g, i) => g && g.text === `m${[3, 0, 2, 1][i]}`),
  );
}

console.log("\n4. powtórzenie ramki (replay)");
{
  const { host, guest } = pair();
  const f = host.encrypt(KIND_MSG, "raz");
  const a = guest.decrypt(f);
  const b = guest.decrypt(f);
  ok("pierwsze odszyfrowanie OK", a && a.text === "raz");
  ok("drugie odrzucone", b === null);
}

console.log("\n5. ramka sfałszowana nie psuje sesji");
{
  const { host, guest } = pair();
  const f = host.encrypt(KIND_MSG, "oryginał");
  const ct = b64u.dec(f.c);
  ct[10] ^= 0xff;
  const bad = guest.decrypt({ ...f, c: b64u.enc(ct) });
  ok("sfałszowana ramka odrzucona", bad === null);
  const good = host.encrypt(KIND_MSG, "następna");
  const d = guest.decrypt(good);
  ok("sesja dalej działa po odrzuceniu", d && d.text === "następna");
}

console.log("\n6. dopełnianie do 256 B");
{
  const { host } = pair();
  const small = host.encrypt(KIND_MSG, "a");
  const big = host.encrypt(KIND_MSG, "x".repeat(300));
  const l1 = b64u.dec(small.c).length;
  const l2 = b64u.dec(big.c).length;
  ok("krótka wiadomość = 256 B + 16 B tagu", l1 === 272, `jest ${l1}`);
  ok("długa wiadomość dopełniona do wielokrotności 256", (l2 - 16) % 256 === 0, `jest ${l2}`);
}

console.log("\n7. ratchet: nowa epoka po 32 wiadomościach");
{
  const { host, guest } = pair();
  // najpierw musimy wiedzieć, że rozmówca jest w tej samej epoce
  const hello = guest.encrypt(KIND_PING, "");
  host.decrypt(hello);

  let last = null;
  for (let n = 0; n < 40; n++) {
    const f = host.encrypt(KIND_MSG, `n${n}`);
    last = f;
    const d = guest.decrypt(f);
    if (!d || d.text !== `n${n}`) {
      ok(`wiadomość ${n} przed ratchetem`, false);
      break;
    }
  }
  ok("host przeszedł na epokę 1", host.epoch === 1, `epoka ${host.epoch}`);
  ok("gość też jest w epoce 1", guest.epoch === 1, `epoka ${guest.epoch}`);
  ok("ramki nowej epoki niosą klucz publiczny", typeof last.p === "string" && last.p.length > 20);
  ok("indeksy w nowej epoce startują od zera", last.i <= 8, `i=${last.i}`);

  const back = guest.encrypt(KIND_MSG, "po ratchecie");
  const db = host.decrypt(back);
  ok("rozmówca odpowiada po zmianie epoki", db && db.text === "po ratchecie");
}

console.log("\n8. uzdrawianie po przejęciu (post-compromise security)");
{
  const room = "7f3c1a90-0000-4000-8000-abcdefabcdef";
  const { host, guest } = pair(room);
  host.decrypt(guest.encrypt(KIND_PING, ""));

  // host dobija do progu 32 wysłanych, ale jeszcze nie przechodzi epoki
  for (let n = 0; n < 32; n++) guest.decrypt(host.encrypt(KIND_MSG, `a${n}`));
  ok("jeszcze epoka 0", host.epoch === 0 && guest.epoch === 0);

  // atakujący kopiuje pełny stan gościa w tej chwili (epoka 0)
  const clone = cloneSession(guest);

  // jedna wiadomość więcej => epoka 1 oparta na kluczach z epoki 0
  guest.decrypt(host.encrypt(KIND_MSG, "próg"));
  ok("host w epoce 1", host.epoch === 1);
  ok("gość przyjął epokę 1", guest.epoch === 1);
  host.decrypt(guest.encrypt(KIND_MSG, "jestem"));

  // atakujący ma klucz z epoki 0, więc czyta jeszcze epokę 1 — to okno jednej epoki
  let lagOk = 0;
  for (let n = 0; n < 20; n++) {
    if (clone.decrypt(host.encrypt(KIND_MSG, `b${n}`))) lagOk++;
  }
  ok("skradziony stan czyta epokę 1 (okno jednej epoki)", lagOk === 20, `${lagOk}/20`);

  // kolejne przejście liczy już klucz wygenerowany PO przejęciu
  let before = host.epoch;
  let guard = 0;
  while (host.epoch === before && guard++ < 40) guest.decrypt(host.encrypt(KIND_MSG, "x"));
  ok("host w epoce 2", host.epoch === 2);

  let healed = 0;
  let leaked = 0;
  for (let n = 0; n < 20; n++) {
    const f = host.encrypt(KIND_MSG, `c${n}`);
    if (guest.decrypt(f)) healed++;
    if (clone.decrypt(f)) leaked++;
  }
  ok("gość czyta epokę 2", healed === 20, `${healed}/20`);
  ok("skradziony stan nie czyta nic z epoki 2", leaked === 0, `wyciekło ${leaked}`);
}

console.log("\n9. ramki z poprzedniej epoki dojeżdżają w locie");
{
  const { host, guest } = pair();
  host.decrypt(guest.encrypt(KIND_PING, ""));

  const stuck = host.encrypt(KIND_MSG, "wysłana przed ratchetem");
  for (let n = 0; n < 40; n++) guest.decrypt(host.encrypt(KIND_MSG, `n${n}`));
  ok("epoka zmieniona", guest.epoch === 1);
  const late = guest.decrypt(stuck);
  ok("spóźniona ramka z epoki 0 nadal czytelna", late && late.text === "wysłana przed ratchetem");
}

console.log("\n10. fałszywe przejęcie epoki nie psuje sesji");
{
  const { host, guest } = pair();
  const real = host.encrypt(KIND_MSG, "prawdziwa");

  // atakujący bez klucza próbuje przeskoczyć epokę
  const evil = { d: 0, e: 1, i: 0, n: b64u.enc(new Uint8Array(24)), c: real.c };
  const r1 = guest.decrypt(evil);
  ok("ramka bez klucza publicznego odrzucona", r1 === null);

  const evil2 = { ...evil, p: b64u.enc(new Uint8Array(32)) };
  const r2 = guest.decrypt(evil2);
  ok("ramka z obcym kluczem odrzucona", r2 === null);
  ok("sesja została w epoce 0", guest.epoch === 0);

  const d = guest.decrypt(real);
  ok("legalna ramka dalej czytelna", d && d.text === "prawdziwa");
}

console.log("\n11. granice i typy wiadomości");
{
  const { host, guest } = pair();
  const far = host.encrypt(KIND_MSG, "daleko");
  const skipped = guest.decrypt({ ...far, i: 500 });
  ok("zbyt duży skok indeksu odrzucony", skipped === null);

  const burn = host.encrypt(KIND_BURN, "");
  const b = guest.decrypt(burn);
  ok("KIND_BURN dociera z pustą treścią", b && b.kind === KIND_BURN && b.text === "");

  const wrongDir = guest.decrypt({ ...host.encrypt(KIND_MSG, "x"), d: 1 });
  ok("ramka z kierunkiem gościa odrzucona", wrongDir === null);
}

console.log("\n12. zniszczenie sesji");
{
  const { host, guest } = pair();
  const f = guest.encrypt(KIND_MSG, "przed");
  host.decrypt(f);
  host.destroy();
  let threw = false;
  try {
    host.encrypt(KIND_MSG, "po");
  } catch {
    threw = true;
  }
  ok("po zniszczeniu nie da się szyfrować", threw);
  ok("po zniszczeniu nie da się odszyfrować", host.decrypt(guest.encrypt(KIND_MSG, "po")) === null);
  ok("root wyzerowany", host.root.every((b) => b === 0));
  ok("klucz DH wyzerowany", host.dh.sk.every((b) => b === 0));
}

console.log(`\n${pass} PASS, ${fail} FAIL\n`);
process.exit(fail === 0 ? 0 : 1);
