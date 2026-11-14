# nullczat — propozycja architektury szyfrowania

Dokument decyzyjny. Nic tu jeszcze nie jest zaimplementowane — to wybór kierunku.

---

## 1. Streszczenie (wersja dla niecierpliwych)

**Rekomendacja: Wariant A+ — „klucz w linku" + szyfrowanie end-to-end + krótki TTL + przycisk zniszczenia.**

- Zero kont, zero maili, zero haseł. Pokój powstaje z jednego kliknięcia.
- Klucz szyfrujący powstaje **w przeglądarce** i żyje **wyłącznie w adresie URL po `#`** — fragmentu adresu przeglądarka nigdy nie wysyła do serwera. Serwer (Supabase/Vercel) widzi tylko losowe ID pokoju i kawałki ciphertextu.
- Szyfr: **XChaCha20-Poly1305** (AEAD) lub **AES-256-GCM**, klucze z **HKDF-SHA-256**, wymiana kluczy **X25519**.
- Serwer nie ma klucza. Nawet pełny dump bazy nie daje treści.
- Przycisk „wszystko znika" = jedno kliknięcie, bez potwierdzania: niszczy klucze w pamięci, czyści IndexedDB/localStorage, zrywa WebSocket, każe serwerowi usunąć pokój, wraca do pustego ekranu.

**Czego ten wariant NIE robi** (i żaden inny nie zrobi): nie ochroni Cię przed drugim uczestnikiem, przed screenshotten, przed złośliwym skryptem w Twojej przeglądarce ani przed logami IP po stronie hostingu. To jest opisane w sekcji 3 i 7 — przeczytaj ją, bo tu ludzie robią sobie krzywdę marketingiem.

**Ścieżka rozwoju:** A → A+ (ratchet, forward secrecy) → B (pełny Signal / Double Ratchet) → ewentualnie klient natywny. Interfejs kryptograficzny projektujemy od początku tak, żeby dało się podmienić silnik bez przepisywania UI.

---

## 2. Najpierw mit: „szyfry, jakich używają banki"

Krótko i bez owijania: **takie szyfry nie istnieją.** Banki nie mają dostępu do niczego, czego nie ma publicznie. Standard w bankowości to:

| Warstwa | Co tam naprawdę jest |
|---|---|
| Transport | TLS 1.3 (AES-256-GCM / ChaCha20-Poly1305, X25519) |
| Dane w spoczynku | AES-256-GCM lub AES-256-XTS |
| Klucze | HSM / KMS, ceremonia klucza, rozdział obowiązków, audyt |
| Haseł użytkownika | Argon2id / scrypt / PBKDF2 |

To **dokładnie te same algorytmy**, które proponuję powyżej. Banki nie są „mocniejsze" kryptograficznie — są mocniejsze **operacyjnie**: mają sprzętowe moduły, procedury i ludzi pilnujących kluczy. Algorytm jest ten sam, różni się dyscyplina wokół niego.

Trzy rzeczy, o których warto wiedzieć, żeby nie dać się nabrać:

1. **AES-256 jest uważany za nie do złamania siłą brute force.** 2²⁵⁶ to więcej niż atomów w obserwowalnym wszechświecie (~2²⁶⁵, ale rząd wielkości ten sam). Problem nigdy nie leży w sile sboxów, tylko w tym, **kto ma klucz** i **czy go nie ukradł**.
2. **„Genialny, nieznany szyfr" = czerwona flaga.** Szyfry projektowane potajemnie i nieanalizowane przez środowisko są prawie zawsze słabe (patrz: cała historia kryptografii amatorskiej). Używamy wyłącznie rzeczy publicznych, zrecenzowanych, z latami kryptoanalizy na koncie.
3. **One-time pad jest formalnie nie do złamania** — i jest bezużyteczny w czacie. Wymaga klucza tej samej długości co wiadomość, wymienionego bezpiecznym kanałem, raz. Klucz byłby tak samo trudny do przekazania jak sama wiadomość. Dlatego nie ma go w ofercie.

**Wniosek: nie da się kupić „mocniejszego szyfru". Można za to dobrze zaprojektować to, co wokół niego — i to jest 90% roboty.**

---

## 3. Model zagrożeń — co realnie chronimy

To najważniejsza sekcja. Bez tego cała reszta to teatr.

### Chronimy przed

| Zagrożenie | Jak |
|---|---|
| Hosting (Vercel), baza (Supabase) i ich personel czytający wiadomości | E2EE — serwer ma tylko ciphertext |
| Wyciek / kradzież dumpa bazy | Bez kluczy ciphertext jest szumem |
| Wezwanie do wydania treści (subpoena) | Nie ma czego wydać |
| Retencja — „wiadomości zostają na zawsze" | TTL 15 min, kasowanie po odczytaniu, brak historii po zamknięciu |
| Przypadkowy podglądacz / ktoś, kto weźmie laptopa | Kasowanie przy zamknięciu, brak lokalnej historii |
| Długoterminowa korelacja rozmów | Brak kont, losowe ID pokoi, brak trwałych identyfikatorów |

### NIE chronimy przed (i trzeba to powiedzieć wprost w UI)

| Zagrożenie | Dlaczego nie da się tego naprawić w web apce |
|---|---|
| **Drugi uczestnik** | Jeśli powie coś dalej, jego klawiatura jest poza naszą kontrolą. E2EE chroni *kanał*, nie *ludzi*. |
| **Screenshot / nagranie ekranu / zdjęcie telefonem** | Nie istnieje technologia, która to blokuje w przeglądarce. Można utrudniać (CSS, blur przy zmianie fokusu), nie można uniemożliwić. |
| **Złośliwy skrypt w Twojej przeglądarce** | XSS, kompromitacja zależności npm, rozszerzenie, keylogger. **To jest realnie najgroźniejszy wektor** — jeśli atakujący wykona kod w kontekście strony, ma plaintext, zanim go zaszyfrujemy. |
| **Malware na urządzeniu** | Pozamiatane, z definicji. |
| **Metadane** | Kto, z kim, kiedy, ile wiadomości, z jakiego IP — to widzi Vercel i Supabase. Treść jest ukryta, wzorzec rozmowy nie. |
| **Adwersarz kwantowy z przyszłości** | X25519 da się złamać komputerem kwantowym. Ścieżka: hybryda X25519 + ML-KEM-768 (standard NIST 2024). Dziś wsparcie w WebCrypto jest szczątkowe, więc to roadmapa, nie MVP. |
| **Twoje własne urządzenie zajęte przez kogoś z bronią/przywilejem** | Nic nie pomoże. |

**Uczciwa reklama, jaką możemy dać:** „Serwer nie może przeczytać Twoich wiadomości i nie ma ich po 15 minutach. Jeśli ktoś je skopiuje — nie ma technologii, która go powstrzyma." Nie „niezniszczalne", nie „wojskowe", nie „bankowe". Zaufanie buduje się tym, czego się nie obiecuje.

---

## 4. Fundamenty kryptograficzne

### Prymitywy

| Funkcja | Wybór | Uzasadnienie |
|---|---|---|
| Szyfr (AEAD) | **XChaCha20-Poly1305** (domyślnie) lub **AES-256-GCM** | AEAD = szyfrowanie + autentyczność w jednym. XChaCha ma 192-bitowy nonce → losowy nonce nigdy się nie powtórzy. AES-GCM ma sprzętowe przyspieszenie (AES-NI). |
| Wyprowadzanie kluczy | **HKDF-SHA-256** | Dzieli jeden sekret na klucz, nonce-seed, klucze per-sender. |
| Wymiana kluczy | **X25519** (ECDH) | Szybkie, odporne na pułapki, standard od dekady. |
| Podpisy (opcjonalnie, do uwierzytelnienia uczestnika) | **Ed25519** | Do „odcisku" pokoju, jeśli kiedyś dodamy weryfikację poza pasmem. |
| Hasło → klucz (jeśli kiedyś) | **Argon2id** | Jedyny sensowny wybór. Nigdy PBKDF2 z niską iteracją. |
| Losowość | `crypto.getRandomValues` | Nigdy `Math.random()`. Nigdy. |
| Hash do ID | **SHA-256 / BLAKE3** | |

### Biblioteki

| Opcja | Plus | Minus |
|---|---|---|
| **`libsodium-wrappers-sumo`** | Audytowane, XChaCha20 natywnie, „trudno się postrzelić w stopę", API sekretne→jawne | ~200 KB WASM/JS, jedna zależność |
| **`@noble/ciphers` + `@noble/hashes` + `@noble/curves`** | Audytowane (Cure53), czysty TS, małe, tree-shake, pełna kontrola | Więcej kodu po naszej stronie, brak gwarancji constant-time w JS |
| **WebCrypto (natywne)** | Najbezpieczniejsze (implementacja przeglądarki), AES-GCM+HKDF+ECDH | Brak XChaCha20, X25519/Ed25519 dopiero wchodzą (Chrome 133+/137+, Safari i Firefox różnie) |

**Wybór: `@noble/*` jako silnik + WebCrypto jako akcelerator dla AES-GCM, gdy dostępny.** Powód: deterministyczny, audytowany kod, brak WASM (łatwiej o politykę CSP `wasm-unsafe-eval` wyłączoną), działa wszędzie tak samo. Alternatywa libsodium jest równie dobra — jeśli wolisz mniej własnego kodu, bierzemy libsodium.

### Struktura klucza (Wariant A)

```
Sekret pokoju S  = 32 losowe bajty (256 bit)      ← powstaje w przeglądarce
roomId           = losowe 16 bajtów, base64url    ← jawny, idzie do serwera

rootKey  = HKDF(S, salt = roomId, info = "nullczat/v1/root")
msgKey_i = HKDF(rootKey, salt = nonce_i, info = "nullczat/v1/msg")
```

Każda wiadomość: **nowy losowy nonce (24 B)**, a w AAD pakujemy `roomId || wersja || indeks` — dzięki temu ciphertext nie da się przełożyć do innego pokoju ani podmienić kolejności bez wykrycia.

### Gdzie leży klucz i jak nie wycieka

```
https://nullchat.app/#k=7f3a...   ← fragment NIE jest wysyłany w nagłówku HTTP
         ↑
   serwer widzi tylko to (roomId)
```

Szczegóły, które trzeba zrobić dobrze (i które robi mało projektów):

1. Po wczytaniu strony **natychmiast** `history.replaceState()` — klucz znika z paska adresu i z historii przeglądarki, zostaje w pamięci.
2. `Referrer-Policy: no-referrer` — link nie wycieka nagłówkiem Referer.
3. **Ostrzeżenie w UI:** „Wyślij ten link przez kanał, któremu ufasz. WhatsApp/Slack/Messenger zapiszą go u siebie." Link = klucz = dostęp. Kto ma link, ten czyta.
4. Klucz trzymany w `Uint8Array` i zerowany (`fill(0)`) przy zniszczeniu. W JS nie ma gwarancji, że GC nie zostawi kopii — to jest ograniczenie języka, nie nasze. Dlatego mówimy o „best effort" i dlatego docelowo klient natywny ma sens.

---

## 5. Cztery warianty — porównanie

### Wariant A — „Klucz w linku", klucz statyczny
Jeden losowy klucz na pokój, ciphertext przez AEAD, TTL 15 min, kasowanie po odczycie.

- ✅ Najprostszy, ~1 dzień pracy, łatwy do audytu
- ✅ Zero kont, zero key exchange przez serwer
- ❌ Brak forward secrecy: jeśli klucz wycieknie, **wszystkie** wiadomości z pokoju (te przechwycone wcześniej) da się odszyfrować
- ❌ Ktoś, kto przechwyci ciphertext i później zdobędzie link, odczyta historię

### Wariant A+ — „Klucz w linku" + ratchet symetryczny ⭐ **rekomendacja**
Jak A, ale z łańcuchem kluczy: każda wiadomość ma własny klucz wyprowadzony z poprzedniego, poprzednie są kasowane.

```
chainKey_0 = HKDF(rootKey, info="chain/" + senderId)
chainKey_{i+1} = HMAC-SHA256(chainKey_i, 0x01)
msgKey_i       = HMAC-SHA256(chainKey_i, 0x02) → HKDF → klucz + nonce-base
```

- ✅ **Forward secrecy**: zdobycie dzisiejszego klucza nie odszyfruje wczorajszych wiadomości
- ✅ Nadal jeden link, zero kont, zero serwerowej wymiany kluczy
- ✅ Prosty do implementacji (kilkadziesiąt linii, nie tysiąc)
- ❌ Brak post-compromise security (nie „leczy się" po przejęciu jak Double Ratchet)
- ❌ Trzeba obsłużyć wiadomości poza kolejnością (i wiadomości z wielu kart przeglądarki)

### Wariant B — Pełny Signal Protocol (X3DH + Double Ratchet)
To samo, czego używa Signal/WhatsApp: tożsamość per urządzenie, prekeys, ratchet DH z każdą zmianą kierunku.

- ✅ Najlepsze bezpieczeństwo: FS + post-compromise security + silne uwierzytelnienie
- ✅ „Prawdziwe E2EE" w rozumieniu ekspertów, łatwiej o zaufanie i audyt
- ❌ Dużo złożoności: przechowywanie tożsamości w IndexedDB, synchronizacja kart, prekeys, obsługa braku odbiorcy
- ❌ Konflikt z „jeden link i zero śladów": tożsamość per urządzenie to trwały stan, który trzeba gdzieś trzymać
- ❌ Realnie 3–5× więcej pracy i znacznie więcej miejsc, gdzie można się pomylić

### Wariant C — MLS (RFC 9420), grupy
Standard dla grup od 2 do tysięcy, efektywne uzgadnianie kluczy (TreeKEM).

- ✅ Jedyne sensowne rozwiązanie, gdy chcemy **realne grupy** (5+ osób) z wydajnym ratchetem
- ❌ Ciężki, mało dojrzałych implementacji JS, przerost formy dla 1:1

### Wariant D — „Bankowo": tylko TLS + szyfrowanie w bazie (bez E2EE)
- ✅ Proste, i… tyle
- ❌ **Odrzucam.** Serwer ma plaintext, więc „nic nie zostaje" jest kłamstwem, a obietnica „najbardziej prywatnej apki" byłaby nieuczciwa.

### Tabela zbiorcza

| | A | **A+** | B | C |
|---|---|---|---|---|
| Serwer czyta treść | nie | nie | nie | nie |
| Forward secrecy | ❌ | ✅ | ✅ | ✅ |
| Post-compromise security | ❌ | ❌ | ✅ | ✅ |
| Konta / tożsamość trwała | nie | nie | tak | tak |
| Grupy > 2 | tak (słabo) | tak (słabo) | tak | ✅ |
| Złożoność | ★ | ★★ | ★★★★★ | ★★★★★ |
| Czas do MVP | 1 dzień | 2–3 dni | 2 tyg. | 3–4 tyg. |
| „Jeden link i nic więcej" | ✅ | ✅ | ⚠️ | ⚠️ |

---

## 6. Rekomendacja i ścieżka

**Budujemy A teraz, ale z API silnika przygotowanym pod A+ i B.**

```
src/crypto/
  engine.ts        // interfejs: createRoom(), encrypt(), decrypt(), destroy()
  aead.ts          // XChaCha20-Poly1305 / AES-256-GCM
  kdf.ts           // HKDF, ratchet
  room.ts          // sekret pokoju, link, zerowanie
  engine-a.ts      // implementacja v1
  engine-aplus.ts  // v2 (ratchet)
```

Dzięki temu UI i warstwa transportu nie wiedzą, jaki silnik działa. Podmiana to jeden plik.

**Kolejność:**
1. **v1 (A+ od razu, bo to tylko trochę więcej pracy niż A):** pokój z linku, AEAD, TTL, przycisk zniszczenia, brak kont.
2. **v1.1:** ratchet symetryczny, obsługa out-of-order, obecność („pokój umiera, gdy wychodzi ostatnia osoba").
3. **v2:** Double Ratchet (B) + odcisk bezpieczeństwa do weryfikacji poza pasmem.
4. **v3:** hybryda post-quantum (X25519 + ML-KEM-768), gdy WebCrypto to udźwignie.
5. **Równolegle:** rozważ klienta natywnego. Web apka ma sufit bezpieczeństwa wyznaczony przez przeglądarkę — nie da się go przeskoczyć.

---

## 7. Przycisk „wszystko znika" — dokładna specyfikacja

Chcesz **jeden przycisk**. Nie robię hold-to-confirm, nie robię „czy na pewno?" — to zabija sens paniki. Jedno kliknięcie, natychmiast.

### Sekwencja (w tej kolejności, bo kolejność ma znaczenie)

```
1. Zniszcz klucze w pamięci          → key.fill(0), zeruj ratchet, zeruj nonce
2. Zerwij kanał                      → unsubscribe Realtime, socket.close()
3. Wyczyść magazyn lokalny           → IndexedDB.deleteDatabase, localStorage.clear,
                                       sessionStorage.clear, caches.delete(all)
4. Wyrejestruj service workera       → getRegistrations().forEach(unregister)
5. Poproś serwer o skasowanie pokoju → RPC purge_room(roomId)  (best effort, fire & forget)
6. Zniszcz UI                        → stan = null, historia = [], input wyczyszczony
7. Zamknij kontekst                  → location.replace('about:blank')
```

Punkt 5 jest **best effort** i tak trzeba go opisać w UI: jeśli jesteś offline albo serwer nie odpowiada, ciphertext w bazie zostanie do wygaśnięcia TTL. Serwer nie ma klucza, więc to i tak szum — ale nie obiecujemy, że zniknął natychmiast.

`about:blank` w punkcie 7 to celowy wybór: czyszczenie DOM, heapu i Back/Forward cache przeglądarki jest najbardziej niezawodne przez porzucenie całego kontekstu. Wraca się do pustej apki od zera.

### Co jeszcze dostaje „znikaniem" poza przyciskiem

| Mechanizm | Działanie |
|---|---|
| **TTL** | Wiadomość żyje 15 min (konfigurowalne 1 min–1 h), potem `DELETE` po stronie bazy i zniknięcie z UI |
| **Burn after read** | Opcjonalnie: znika po pierwszym odczytaniu przez drugą stronę |
| **Pokój-śmierć** | Gdy wychodzi ostatnia osoba (presence), pokój i wszystkie wiadomości są kasowane |
| **Inactivity wipe** | Brak aktywności 5 min → to samo co przycisk (awaryjnie, np. gdy zapomnisz) |
| **Blur przy zmianie fokusu** | Treść rozmywana, gdy okno traci fokus (anty-podglądacz, nie anty-screenshot) |
| **Zakaz cache** | `Cache-Control: no-store`, żadnego service workera cache'ującego treść |

### Czego przycisk NIE zrobi — do napisania wprost w UI

- Nie usunie wiadomości z **urządzenia drugiej osoby**.
- Nie usunie zrzutów ekranu.
- Nie usunie logów dostępowych po stronie Vercel/Supabase (IP, timestamp).
- Nie usunie niczego z kopii zapasowych, które już powstały (dlatego TTL jest krótki — mniej okazji).
- W JS nie ma gwarancji, że zerowanie pamięci faktycznie nadpisze wszystkie kopie (GC, stringi niezmienialne). „Best effort", uczciwie.

---

## 8. Higiena niekryptograficzna (równie ważna jak szyfr)

Szyfrowanie jest bezużyteczne, jeśli obok wjeżdża Google Analytics i skrypt z CDN-u.

- **CSP w trybie strict**: `default-src 'self'`, zero `unsafe-inline`, zero `unsafe-eval`, brak `wasm-unsafe-eval`.
- **Zero zewnętrznych skryptów.** Fonty systemowe albo self-hostowane. Żadnego GA, Sentry, Hotjar, żadnych pixeli.
- **Zero cookies** (poza technicznymi, jeśli Supabase ich wymaga — sprawdzimy i zminimalizujemy).
- **`Referrer-Policy: no-referrer`**, `X-Content-Type-Options: nosniff`, `Permissions-Policy` wycinająca kamerę/mikrofon/geolokalizację.
- **COOP/COEP** → izolacja procesu, plus sensowny `Cross-Origin-Resource-Policy`.
- **Brak logowania treści** po stronie serwera — ciphertext nie jest logowany, `roomId` tylko jako hash w logach (jeśli w ogóle).
- **Minimalizacja metadanych:** brak kont, brak nicków zapisywanych na serwerze (nick żyje w pokoju i ginie z nim), losowe ID.
- **Zależności:** lockfile, `npm audit` w CI, minimalna liczba paczek, SRI gdzie się da. Każda zależność to potencjalny XSS.
- **RODO:** brak danych osobowych w treści (szyfrowane), ale IP to dana osobowa → krótka polityka prywatności, retencja logów minimalna, hosting w UE jeśli się da (Vercel/Supabase mają regiony — do sprawdzenia).

---

## 9. Pytania decyzyjne

1. **Wariant szyfrowania:** A+ (rekomendacja) / A (prościej) / B (pełny Signal, dłużej)?
2. **Przycisk:** jedno kliknięcie niszczy pokój **dla wszystkich** / niszczy tylko u mnie / zostawiam wybór w ustawieniach?
3. **Stack:** Next.js (App Router) + Supabase (Postgres + Realtime) + Vercel — zostawiamy?
4. **Zakres:** tylko 1:1 na start, czy od razu grupy do ~8 osób?

Po Twojej decyzji siadam do implementacji: najpierw silnik + testy wektorowe, potem UI, potem transport.

---

## 10. Co faktycznie stoi (v1) — stan po decyzjach

Wybrane: **A+ z linkiem jednorazowym**, zniszczenie dla wszystkich, 1:1, Supabase + Vercel.

### Przepływ

```
1. „+"  → przeglądarka losuje S (256 bit)
2. serwer dostaje TYLKO: SHA256(T_invite), SHA256(T_destroy), SHA256(seat)
   — nigdy S, nigdy klucz, nigdy treść
3. link = https://…/#<base64url(S)>   ← fragment nie idzie w nagłówku HTTP
4. druga osoba otwiera link → claim (atomowy, jednorazowy) → para
5. X25519 efemeryczne + PSK(S) → klucz główny → S zerowane po obu stronach
6. wiadomości: osobny łańcuch HMAC na kierunek, klucz per wiadomość,
   XChaCha20-Poly1305, dopełnianie do 256 B, AAD = room|kierunek|indeks
7. kosz → ramka „burn" (uwierzytelniona AEAD) → obie strony zerują klucze,
   odpinają kanał, kasują pokój w bazie, przeładowują kontekst
```

### Czego w bazie NIE MA

- **Tabeli wiadomości.** Treść nigdy nie dotyka dysku: przechodzi tylko przez
  ulotny pub/sub Supabase Realtime (pamięć, bez persystencji).
- Kluczy, haseł, maili, nicków, historii. Zostają wyłącznie dwa wiersze:
  pokój (hash biletu) i miejsca (hash). Oba kasowane przy zniszczeniu,
  po 2 h przez TTL, a osierocone przez `pg_cron` co 10 min.

### Reguły potwierdzone testem

| Test | Wynik |
|---|---|
| link → S → te same bilety | OK |
| DH zgodne po obu stronach | OK |
| fingerprint zgodny (4 kolory) | OK |
| wiadomości w obie strony, kolejność, out-of-order, replay | OK |
| podmiana bitu w ciphertext | odrzucone |
| link użyty drugi raz | odrzucone |
| link po zniszczeniu pokoju | odrzucone |
| link po TTL | odrzucone |
| zniszczenie złym biletem | odrzucone |

### Ograniczenia, które zostają

| Ograniczenie | Dlaczego |
|---|---|
| **Kto pierwszy otworzy link, ten wchodzi** | Link jest nośnikiem PSK. Dlatego obie strony widzą 4 kropki (fingerprint) — trzeba je porównać na żywo. To jedyna obrona przed podstawieniem się. |
| Brak wiadomości offline | Kanał jest ulotny z założenia: brak historii = brak treści do wydania. |
| Odświeżenie karty kończy pokój | Nic nie jest zapisywane w localStorage/IndexedDB — celowo. |
| Metadane (IP, czas, długość) | Supabase/Vercel je widzą. Długość maskowana dopełnianiem, IP nie da się ukryć bez Tor/VPN. |
| `script-src 'unsafe-inline'` w CSP | Wymóg Next.js bez nonce. Do usunięcia w v2. |
| Screenshot / drugi uczestnik / XSS | Poza zasięgiem każdej aplikacji webowej. |

### Do zrobienia dalej

1. Podmiana `unsafe-inline` na nonce + `strict-dynamic`.
2. DH-ratchet (Double Ratchet) zamiast samego łańcucha symetrycznego.
3. Hybryda post-quantum (X25519 + ML-KEM-768), gdy WebCrypto to udźwignie.
4. Własna domena — `nullczat.vercel.app` jest zajęta przez inny projekt Vercel.
