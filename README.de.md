<p align="center">
  <img src="./docs/images/dsh-ios-logo.png" alt="DSH iOS" width="120" />
</p>

<h1 align="center">DSH iOS-Simulator</h1>

<p align="center">
  <strong>Ein live laufender, interaktiver iOS-Simulator mitten in einer <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>-Konversation — plus Ihr echtes iPhone über USB.</strong><br />
  <sub>22 Agenten-Tools &bull; Live-MJPEG-Seitenleistenpanel &bull; Simulator &amp; echtes iPhone über USB &bull; Listen-/Feed-Zeilenaktionen &bull; SwiftUI-Preview-Hot-Reload</sub>
</p>

<p align="center">
  <sub>npm: <code>@zseven-w/dsh-ios</code> &middot; Aktuelles Plugin-Release: <code>0.1.0-rc.3</code> &middot; Getestet mit DSH <code>0.1.1-rc.1</code></sub>
</p>

<p align="center">
  <a href="./README.md">English</a> &middot;   <a href="./README.zh.md">简体中文</a> &middot;   <a href="./README.zh-TW.md">繁體中文</a> &middot;   <a href="./README.ja.md">日本語</a> &middot;   <a href="./README.ko.md">한국어</a> &middot;   <a href="./README.fr.md">Français</a> &middot;   <a href="./README.es.md">Español</a> &middot;   <b>Deutsch</b> &middot;   <a href="./README.pt.md">Português</a> &middot;   <a href="./README.ru.md">Русский</a> &middot;   <a href="./README.hi.md">हिन्दी</a> &middot;   <a href="./README.tr.md">Türkçe</a> &middot;   <a href="./README.th.md">ไทย</a> &middot;   <a href="./README.vi.md">Tiếng Việt</a> &middot;   <a href="./README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <sub>npm: <code>@zseven-w/dsh-ios</code> &middot; Aktuelle Plugin-Version: <code>0.1.0-rc.3</code> &middot; Getestet mit DSH <code>0.1.1-rc.1</code></sub>
</p>

<br />

<p align="center">
  <img src="./docs/images/dsh-ios-overview.png" alt="DSH iOS Simulator — a real iPhone inside the conversation" width="100%" />
</p>
<p align="center"><sub>Ein echtes iPhone, gesteuert aus einer DSH-Konversation — Tool-Aufrufe links, Live-Geräte-Panel rechts</sub></p>

## Warum DSH iOS-Simulator

Der DSH iOS-Simulator gibt dem Agenten einen echten iOS-Simulator mitten in der Konversation — und Ihnen die Pixel. Der Agent kann ein Gerät starten, ein Xcode-Projekt oder Swift-Paket bauen und ausführen, die UI über Accessibility-Identität oder OCR-Text steuern, Unified Logs lesen sowie Prozesse, Backtraces und Speicherlecks untersuchen, während ein Live-Stream des Geräts in einem persistenten Seitenleisten-Panel gerendert wird, in dem Sie direkt auf dem Video tippen, ziehen, drehen und Home drücken können. Dieselben Verben funktionieren auch auf einem echten, per USB verbundenen iPhone: Das Plugin baut WebDriverAgent auf dem Telefon, startet es, tunnelt dessen Control- und Screen-Ports über Loopback und streamt das Gerät in dasselbe Panel, dieselben Karten und Tools. Keine Bildblöcke, keine Bildschirmaufnahme-Dateien: Visuelle Bytes erreichen die UI nur über signierte, ablaufende URLs, die vom DSH-Webserver ausgeliefert werden.

| | |
| --- | --- |
| 🖥️ **Live-Simulator in der Konversation** | Ein serve-sim-MJPEG-Stream des gestarteten Geräts, über signierte `/_dsh/dsh-ios/*`-Routen in ein persistentes Panel auf der rechten Seite geproxyt — der Browser berührt niemals den Port von serve-sim. |
| 📱 **Echtes iPhone über USB** | `ios_real_start_wda` baut WebDriverAgent auf einem verbundenen Telefon, startet es und tunnelt dessen Control- (REST) und Screen-Ports (MJPEG) über Loopback; dasselbe Panel, dieselben Tools, Karten und die Status-Kapsel steuern dann das Telefon. Das Gerät muss entsperrt sein, und jeder Tap auf echte Konten wird durch die Identifizieren-vor-Tippen-Regeln des Plugins abgesichert. |
| 🛠️ **22 Agenten-Tools** | Geräte, Starten/Herunterfahren, Screenshot, Interaktion, Build &amp; Run, Unified Logs, AXe-basierter UI-Tree + Tippen per Element, Listen-/Feed-Zeilenaktionen, Vision-OCR-Suche/-Tippen, SwiftUI-Preview-Hot-Reload, Prozesse, Backtrace, Leaks, App-Infos. |
| 👆 **Interaktives Panel** | Auf dem Live-Video tippen und ziehen; Symbolleiste für Home / Drehen / Screenshot / Aktualisieren mit Hover-Tooltips; Größenmodi (适应 · 50–125% · S/M/L); Rahmenstile (无框 / 边框 / 真机框); Größenänderung per Ziehen bis 960 px mit Doppelklick-Reset; automatische Verbreiterung im Querformat. |
| 🧾 **Listen- &amp; Feed-Zeilen** | `ios_sim_ui_rows` macht aus tiefen Accessibility-Snapshots indizierte Zeilen mit Labels und generisch geparsten Zählern; `ios_sim_tap_row` tippt innerhalb einer Zeile an relativen Koordinaten und verifiziert die Aktion über die erwartete ±1-Änderung des Zählers — die einzige zuverlässige Bestätigung, die eine Listen-App bietet. |
| 🔐 **Nur-Loopback-Transport** | serve-sim bindet 127.0.0.1 in einem dedizierten Portbereich; jede Route verlangt einen Loopback-Peer, einen Loopback-`Host` sowie Fetch-Metadata-/Origin-Prüfungen; HMAC-Capabilities laufen innerhalb von 10 Minuten ab.. |
| ⚡ **SwiftUI-Preview-Hot-Reload** | `ios_sim_preview` erzeugt eine Wegwerf-Host-App außerhalb Ihres Pakets, baut Ihre Previews als dylib und spielt Änderungen per Hot-Swap in den laufenden Simulator ein, ohne neu zu starten (~2–5 s). |
| 🧭 **Semantische UI-Automatisierung** | `ios_sim_ui_tree` exportiert den Accessibility-Baum (AXe-basiert) und `ios_sim_tap_element` tippt nach Label oder Identifier; `ios_sim_find_text` macht OCR auf dem Bildschirm, wenn der Baum leer oder degeneriert ist, und `ios_sim_tap_text` tippt auf den gefundenen Text — identitäts- und textbasierte Taps statt geratener Koordinaten. |

## Tools

Alle 22 Tools sind auf jedem Host registriert und geben reines JSON zurück — visuelle Bytes erreichen die UI nur über `presentationMeta` + signierte Routen, niemals als Bildblöcke. Simulator-udids laufen über simctl/serve-sim; udids physischer Geräte laufen automatisch über WebDriverAgent. Auf Nicht-macOS-Hosts (oder wenn serve-sim nicht auflösbar ist) bleiben die Tools registriert, schlagen aber mit einem erklärenden Fehler fehl; die einzige Ausnahme ist `ios_sim_preview` `status`, das auf jedem Host wahrheitsgemäß `{ running: false }` meldet.

### Simulator-Kerntools

| Tool | Funktion | Wichtige Parameter |
| --- | --- | --- |
| `ios_sim_devices` | Listet die auf diesem Mac verfügbaren iOS-Simulator-Geräte (udid, Name, Runtime, Zustand) und welche davon gestartet sind, plus alle per USB verbundenen physischen iPhones unter `realDevices` (udid, Name, osVersion, model, state, developerMode). Nutzen Sie es, um die udid oder den Namen zu ermitteln, die Sie an die anderen Tools übergeben. | — |
| `ios_sim_boot` | Startet ein Gerät und startet seinen live mitlaufenden serve-sim-Stream; der Stream bleibt für die Konversation am Leben, damit das Panel den Simulator live zeigen kann. | `udid` (erforderlich — udid oder Gerätename) |
| `ios_sim_shutdown` | Fährt ein Gerät herunter; stoppt den Stream, wenn er auf dieses Gerät zielt. | `udid` (erforderlich) |
| `ios_sim_screenshot` | Nimmt ein PNG auf und gibt eine kurze JSON-Zusammenfassung zurück (Pfad, Bytes, Abmessungen, Gerät); das Bild wird in der Karte/im Panel gerendert, niemals als Bildblock. Funktioniert auf dem gestreamten Simulator und auf einem per USB verbundenen Telefon über WebDriverAgent. | `udid` (optional — gestreamtes Gerät, sonst das erste gestartete) |
| `ios_sim_interact` | Interagiert mit dem gestreamten Gerät — Simulator oder per USB verbundenes Telefon: Tippen an normalisierten 0..1-Koordinaten, Texteingabe (US-Tastatur im Simulator), Drücken eines Hardware-Buttons (`home`, `lock`, `volumeUp` …), Scrollen oder Senden einer Touch-Geste; nachdem sich die Aktion gesetzt hat (~300 ms), zeigt ein frischer Screenshot die Wirkung. | `action` (erforderlich — `tap`/`type`/`button`/`gesture`/`scroll`), `x`/`y`, `text`, `name`, `json` |
| `ios_sim_list_apps` | Listet die auf einem gestarteten Simulator oder einem verbundenen Telefon INSTALLIERTEN Apps (Bundle-ID, Anzeigename, Version, System-Flag) — eine Drittanbieter-Bundle-ID lässt sich nicht erraten; listen Sie sie daher auf oder übergeben Sie `name` an `ios_sim_launch_app`. Eine FEHLGESCHLAGENE Auflistung wirft einen Fehler (z. B. „das Gerät ist per CoreDevice nicht erreichbar“) statt eine leere Liste zurückzugeben; `count: 0` bedeutet daher immer, dass das Gerät wirklich keine passende App hat. | `udid` (optional), `query` (Substring ohne Groß-/Kleinschreibung über Anzeigename UND Bundle-ID, inklusive CJK), `include_system` (Standard false) |
| `ios_sim_launch_app` | Startet eine installierte App auf einem gestarteten Simulator oder einem verbundenen Telefon — per `bundleId` oder per `name` (ein Substring des Anzeigenamens ohne Groß-/Kleinschreibung, aufgelöst über dieselbe Auflistung, inklusive CJK). Genau eines von beiden; sowohl ein Startfehler als auch ein mehrdeutiger Name kommen mit einem Hinweis zurück, was als Nächstes zu tun ist (`ios_sim_build_run` ist zum Bauen aus dem Quellcode da). | `bundleId` oder `name` (genau eines), `udid`, `relaunch` |
| `ios_sim_build_run` | Baut ein `.xcodeproj`, `.xcworkspace` oder Swift-Paket für den Simulator, installiert die gebaute `.app` und startet sie; übergeben Sie eine udid eines physischen Geräts, um stattdessen auf dem Telefon zu bauen, zu installieren und zu starten (erfordert Apple-Development-Signierung). Bei einem Fehler enthält das Ergebnis das gefilterte Ende der `xcodebuild`-Fehlerausgabe. Ein vollständiger Build dauert Minuten. | `projectPath` (erforderlich), `scheme`, `udid` (gestreamtes Gerät → gestartetes Gerät → iPhone mit neuester Runtime, das gestartet wird), `configuration` (Standard `Debug`) |
| `ios_real_start_wda` | Startet WebDriverAgent (WDA) auf einem per USB verbundenen physischen iPhone — nur echte Geräte, niemals ein Simulator. Übernimmt eine bereits laufende WDA, wenn eine antwortet; andernfalls führt es den `xcodebuild`-Build/-Start aus (ein Kalt-Build dauert Minuten) und wartet dann, bis WDA Bereitschaft meldet, und gibt die Control-/MJPEG-Ports zurück, über die das Live-Panel streamt. Rufen Sie dieses Tool zuerst auf, wenn `ios_sim_screenshot` / `ios_sim_interact` / `ios_sim_ui_tree` / `ios_sim_tap_element` melden, dass WDA für das Gerät nicht läuft. | `udid` (erforderlich — udid des physischen Geräts aus `ios_sim_devices.realDevices`) |

### UI-Tree-Tools (AXe-basiert)

| Tool | Funktion | Wichtige Parameter |
| --- | --- | --- |
| `ios_sim_ui_tree` | Exportiert den Accessibility-Elementbaum der vordersten App (Labels, Identifier, Werte, Frames in Gerätepunkten) plus die Bildschirmgröße in Punkten — AXe auf einem Simulator, WebDriverAgent auf einem per USB verbundenen Telefon (dort standardmäßig tiefenbegrenzt: ein unbegrenzter Snapshot einer beschäftigten App misst ~32 s / 751 KB, begrenzt ~2 s); die Ausgabe ist auf ~40 KB begrenzt (tiefste Ebenen werden beschnitten, `truncated` + Hinweis gesetzt). | `udid` (optional), `max_depth`, `filter` (Substring ohne Groß-/Kleinschreibung über Label/Identifier/Typ) |
| `ios_sim_tap_element` | Tippt ein Element per Identität an — zuerst exakte Übereinstimmung, dann Substring ohne Groß-/Kleinschreibung über `identifier`/`label`; verschachtelte Duplikate fallen zu einem Ziel zusammen, bei mehrdeutigen Treffern werden alle Kandidaten aufgelistet. Der Tap landet im Zentrum des Elements (AXe-HID auf einem Simulator, WebDriverAgent auf einem Telefon), danach zeigt ein ~300-ms-Screenshot die Wirkung; mit `expect_text` / `expect_gone` werden der Tap und seine Verifikation zu einem einzigen Round-Trip (`expected.matched`). | `udid` (optional), `identifier`, `label`, `expect_text`, `expect_gone` |

### Listen- &amp; Feed-Zeilen

Listen-/Feed-Apps fassen jedes Element in einer einzigen Accessibility-Zelle zusammen, deren Label die gesamte Zusammenfassung samt aller Zähler trägt (“57 回复。18 喜欢。592 次查看”) — es gibt keine untergeordneten Buttons pro Steuerelement, die man treffen könnte, und die Zeilenzellen erscheinen erst in einem tiefen Snapshot. Diese beiden Tools legen diese Struktur als Zeilen offen und agieren innerhalb einer Zeile.

| Tool | Funktion | Wichtige Parameter |
| --- | --- | --- |
| `ios_sim_ui_rows` | Liest die sichtbaren Listen-/Feed-Zeilen der vordersten App als Zeilen statt als rohen Baum: Jede Zeile meldet ihren Index, den Frame in Punkten, das aggregierte Label und die aus diesem Label geparsten Zähler (Zahl + Klassifikator-Token, z. B. `57 回复` → 回复=57, 中文 oder English — kein App-Vokabular hartcodiert). Zeilen erscheinen erst in einem tiefen Snapshot: Auf einem Telefon ist die Standard-`max_depth` 60, was ~15–25 s / ~0,5 MB pro Aufruf kostet (WDA bearbeitet Anfragen seriell) — ziehen Sie zuerst die günstigen Beobachter (`ios_sim_find_text` / `ios_sim_ui_tree`) in Betracht. Zähler werden heuristisch geparst und Schlüssel funktionieren im Round-Trip: Übergeben Sie einen Schlüssel exakt wie aufgelistet an `ios_sim_tap_row.expect_count`. Wenn keine Zeilen gefunden werden, nennt das Ergebnis den Grund (Tiefe zu gering / kein Listen-Screen / nach einem tiefen Lesevorgang tatsächlich keine Accessibility-Informationen) — ein flacher Lesevorgang wird niemals als „die App hat keine Accessibility-Informationen“ gemeldet; Zeilen außerhalb des Bildschirms werden ausgeschlossen und als `omittedOffscreen` gezählt. | `udid` (optional), `max_depth` (nur Telefon; Standard 60) |
| `ios_sim_tap_row` | Tippt an einer relativen Position innerhalb einer sichtbaren Listenzeile (gemeldet von `ios_sim_ui_rows`: 0-basierter Index; x/y als Bruchteile des Frames dieser Zeile — 0 = linke/obere Kante, 1 = rechte/untere, Standard 0,5 = Mitte) auf einem Simulator (AXe) oder einem per USB verbundenen Telefon (WebDriverAgent). Der Zeilen-Frame stammt aus einem FRISCHEN Baum-Lesevorgang, es werden also keine absoluten Bildschirmkoordinaten geraten; ein Index außerhalb des Bereichs führt zu einem FEHLER (wird nie angepasst). Sicherheits-Gate: Mit `expect_count={key,delta}` verifiziert das Tool die Aktion, indem es das Zeilen-Label erneut liest und prüft, ob sich der Zähler exakt um +1/−1 bewegt hat (`countCheck.verified`); ist der Schlüssel nicht unter den geparsten Zählern der Zeile, wird der Tap VERWEIGERT, bevor er passiert — ein Tap auf einem echten Gerät ist niemals eine Sonde. Ohne `expect_count` findet der Tap trotzdem statt (eine explizite zeilenrelative Position IST die Identifikation), aber es wird nichts verifiziert. | `udid` (optional), `index` (erforderlich), `x`, `y` (Bruchteile 0..1), `max_depth`, `expect_count` (`{key, delta}`) |

### OCR-Tools (Vision)

| Tool | Funktion | Wichtige Parameter |
| --- | --- | --- |
| `ios_sim_find_text` | Führt mit dem vom Plugin kompilierten Vision-Helper OCR auf dem AKTUELLEN Bildschirm eines gestarteten Simulators oder eines per USB verbundenen Telefons durch (präzise Erkennung, zh-Hans + en-US, wird bei der ersten Nutzung mit `swiftc` nach `~/Library/Caches/dsh-ios/bin/ocr` kompiliert). Verwenden Sie es, wenn der Accessibility-Baum leer oder degeneriert ist, für als Grafik gerenderten Text (Badge-Zähler, in Bilder eingebackene Preise) oder um unabhängig zu prüfen, was auf dem Bildschirm zu sehen ist. Nimmt einen frischen Screenshot auf und gibt `{device, size, items:[{text, confidence, rect}]}` zurück — Rects sind Boxen in Gerätepunkten (Ursprung oben links), nach Konfidenz sortiert, auf ~40 KB begrenzt (`truncated` verwirft das Ende mit der niedrigsten Konfidenz; grenzen Sie mit `query` ein oder erhöhen Sie `min_confidence`). | `udid` (optional), `query` (Substring ohne Groß-/Kleinschreibung), `min_confidence` (Standard 0,3) |
| `ios_sim_tap_text` | Führt OCR auf dem AKTUELLEN Bildschirm durch und tippt das Zentrum des besten Text-Treffers an — dieselben Mehrdeutigkeitsregeln (exakt → enthält ohne Groß-/Kleinschreibung → Kandidatenliste) wie bei `ios_sim_tap_element`, für Text, den der Accessibility-Baum nicht sehen kann (Apps ohne a11y, Badge-Zähler, in Bilder eingebackener Text). Auf einem Telefon landet der Tap über WebDriverAgent an absoluten Gerätepunkten; auf dem gestreamten Simulator wird er normalisiert über die serve-sim-Steuerung gesendet (rufen Sie zuerst `ios_sim_boot` auf). Nach ~300 ms zeigt ein frischer Screenshot die Wirkung; mit `expect_text` / `expect_gone` werden der Tap und seine Verifikation zu einem einzigen Round-Trip (`expected.matched`). Auf einem ECHTEN Gerät hat jeder Tap reale Konsequenzen — tippen Sie niemals ein nicht identifiziertes Steuerelement an, um herauszufinden, was es tut. | `udid` (optional), `query` (erforderlich), `min_confidence`, `expect_text`, `expect_gone` |
| `ios_sim_wait_for` | Wartet, bis ein Text auf dem Bildschirm erscheint oder verschwindet; pollt dieselbe Capture+OCR-Pipeline wie `ios_sim_find_text`, bis die Bedingung erfüllt ist oder das Zeitlimit abläuft (Standard 8 s, max. 60 s). Ein Timeout ist eine normale `matched:false`-Antwort, nie ein Fehler — ein Aufruf statt einer manuellen find_text-Schleife (~1,2 s pro Runde auf einem iPhone). Bei einem Treffer trägt `item` OCR-Text, Konfidenz und das Rechteck in Punkten. | `udid` (optional), `text` (erforderlich), `mode` (`appear`/`disappear`), `timeout_ms`, `min_confidence` |

### Logs-Tool

| Tool | Funktion | Wichtige Parameter |
| --- | --- | --- |
| `ios_sim_logs` | Liest, was eine Simulator-App ausgibt, aus dem Unified Log des Geräts: `snapshot` (`log show --last <duration>`, Standard 2m) oder `follow` (begrenzte Live-Aufnahme für `duration_seconds`, Standard 10, Maximum 60 — niemals ein hängender Stream). Die Ausgabe ist auf ~300 Zeilen / 30 KB begrenzt, mit einem Eingrenzungs-Hinweis. | `udid` (optional), `mode` (`snapshot`/`follow`), `duration`, `duration_seconds`, `bundle_id`, `predicate` (rohes NSPredicate, überschreibt `bundle_id`), `level` (`default`/`info`/`debug`), `grep` |

### Preview-Tool

| Tool | Funktion | Wichtige Parameter |
| --- | --- | --- |
| `ios_sim_preview` | SwiftUI-Preview-Hot-Reload, live im Simulator: `start` (Standard) validiert das Paket, erzeugt eine Wegwerf-Host-App im Plugin-Cache (niemals innerhalb Ihres Pakets), baut das Paket als dylib für den Simulator, installiert + startet den Host und überwacht die Quellen — jede Änderung baut neu und wird per Hot-Swap ohne Neustart eingespielt (~2–5 s). Compiler-Fehler erhalten die letzte funktionierende Vorschau und erscheinen über `status`; nur eine Sitzung gleichzeitig. | `packagePath` (erforderlich für `start`), `udid`, `action` (`start`/`status`/`stop`), `previewFilter` (Substring ohne Groß-/Kleinschreibung über Preview-Namen) |

### Debug-Tools

| Tool | Funktion | Wichtige Parameter |
| --- | --- | --- |
| `ios_sim_processes` | Listet die laufenden App-Prozesse eines Simulators aus dessen eigenem launchd (hostsichtbare pid, Name, Bundle-ID) — die pid-Quelle für Backtrace/Leaks; eine udid eines physischen Geräts listet stattdessen die Prozesse des Telefons über devicectl. | `udid` (optional), `filter` (Substring ohne Groß-/Kleinschreibung über Name/Bundle-ID) |
| `ios_sim_backtrace` | Einmaliger Batch-LLDB-Lauf (Attach → Thread-Backtrace → Detach, niemals interaktiv); Ausgabe auf ~200 Zeilen begrenzt, Haupt-Thread zuerst, das Ziel wird immer als wieder fortgesetzt verifiziert. Wenn macOS das Attach verweigert (Entwicklermodus aus), fällt das Tool auf Xcodes nicht suspendierende `sample`-Engine zurück und meldet den Aktivierungshinweis. Nur Simulatoren — physische Geräte werden mit Begründung abgelehnt. | `udid` (optional), `pid` / `bundle_id`, `all_threads` (Standard true) |
| `ios_sim_leaks` | Analysiert Speicherlecks mit Xcodes `leaks`-Tool: `summary` (Leck-Anzahl, gesamte geleakte Bytes, Top ~30 Typen) oder `memgraph` (ein `.memgraph`-Artefakt zum Öffnen in Xcode Instruments, wird hier nie geparst). Die App wird während des Scans suspendiert und danach immer fortgesetzt. Nur Simulatoren. | `udid` (optional), `pid` / `bundle_id`, `mode` (`summary`/`memgraph`) |
| `ios_sim_app_info` | Fakten zur installierten App: App-Bundle-Pfad, beschreibbarer Datencontainer und Info.plist-Werte — auf einem Simulator über `simctl appinfo` (mit `get_app_container`-Fallback), auf einem per USB verbundenen Telefon über `devicectl`; bei fehlenden Apps `installed: false` plus eine `note`, die auf `ios_sim_list_apps` verweist. | `udid` (optional), `bundle_id` (erforderlich) |

## Anzeigeflächen

- **Seitenleisten-Panel — “iOS 模拟器”.** Die Live-Ansicht lebt in einem persistenten Panel auf der rechten Seite (ein festes Dock, das die Konversation beiseiteschiebt, oder ein zentriertes Overlay bei schmalen Viewports). Es rendert den Live-MJPEG-Stream und nimmt Klick-zum-Tippen sowie Ziehen-für-Gesten direkt auf dem Video entgegen, mit einer Symbolleiste (Home, Screenshot, Drehen, Aktualisieren), deren Buttons Hover-Tooltips tragen. Die Größensteuerung bietet **适应** (an die Panelbreite anpassen), **50–125%** Zoom der logischen Gerätebreite sowie **S / M / L**-Presets, die die kurze Seite des Geräts bemessen (Hochformat-Breite; im Querformat wird so skaliert, dass das Gerät seine physische Größe behält). Die Rahmenstile sind **无框 / 边框 / 真机框** (rahmenlos / Rahmen / realistische Gerätehülle) mit proportionalem Eckenradius. Dreht sich das Gerät ins Querformat, verbreitert sich das Panel automatisch auf eine komfortable Größe und stellt Ihre Breite wieder her, sobald es zurückdreht — ein manuelles Ziehen währenddessen gewinnt immer. Der Griff an der linken Kante zieht das Panel breiter/schmaler (max. 960 px; Doppelklick setzt auf die Standardbreite zurück). Ist ein per USB verbundenes iPhone das Stream-Ziel, zeigt dasselbe Panel den WebDriverAgent-MJPEG-Stream des Telefons mit denselben Bedienelementen.
- **Kompakte Konversationskarten.** Tool-Ergebnisse werden als einzeilige Karten ohne Inline-Bilder gerendert: der einheitliche Titel **“iOS 模拟器”**, ein Aktions-Unterlabel (Boot / Screenshot / Interact / Build &amp; Run / Start WDA), der Gerätename, ein Status-Badge und ein Hinweis „in der Seitenleiste öffnen“. Ein Klick auf die Zeile öffnet das Panel; Klicks auf Buttons, Links oder den Live-Frame selbst lösen es nie aus.
- **Status-Kapsel über dem Eingabefeld.** Solange das Panel geschlossen und ein Stream online ist, erscheint über dem Eingabefeld eine kleine Pille mit grünem Punkt (`<device>` · 实时) und öffnet das Panel bei einem Klick. Sie ist sitzungsgebunden: Sie wird nur gerendert und abgefragt, solange die aktuelle Konversation Simulator-Ergebnisse gemountet hat, und stoppt, wenn Sie zu einer Sitzung ohne solche wechseln.
- **Standardmodus und Code Mode.** Standard-Sitzungen verwenden das vom Host projizierte `presentationMeta`. Dispatches im verschachtelten Code Mode (PTC) tragen niemals Meta, daher rekonstruiert der Client die identische Meta aus dem persistenten Ergebnis-JSON — Panel, Karten und Kapsel funktionieren in beiden Modi.

## Sicherheit

- Der Browser spricht niemals mit dem Port von serve-sim. Jedes Byte passiert den DSH-Webserver-Ursprung über plugin-eigene `/_dsh/dsh-ios/*`-Routen: `/stream/<token>` (MJPEG-Proxy), `/screenshot/<token>` (gecachtes PNG), `/ws?token=…` (HID-Steuerungs-Relay) sowie die Endpunkte `/grant`, `/capture` und `/status`.
- Tokens sind HMAC-SHA256-Capabilities (`base64url(payload).base64url(mac)`), die innerhalb von 10 Minuten ablaufen und mit einem Schlüssel pro DSH-Home signiert sind (`<DSH_HOME>/cache/dsh-ios/stream-access.key`, 0600, atomar erstellt).
- Jede Route wendet eine Loopback-/Trusted-Transport-Absicherung an, bevor irgendeine Capability geprüft wird: Loopback-Peer-Adresse, Loopback-`Host` (DNS-Rebinding wird abgelehnt) sowie Fetch-Metadata-/Origin-Prüfungen. Die Screenshot-Route liefert nur Dateien innerhalb des Plugin-Cache-Verzeichnisses aus (Symlinks werden abgelehnt, `realpath`-Einschlussprüfung).
- serve-sim läuft nur auf Loopback als Vordergrund-Kindprozess in einem dedizierten Portbereich (3181–3244), sodass ein eigenes serve-sim des Nutzers auf Port 3100 niemals berührt wird; `--host` wird niemals verwendet..
- **Übernahme/Zurückholen verwaister Prozesse** — wurde ein früherer DSH-Host unsanft beendet und sein serve-sim-Helper hat überlebt, wird dasselbe Gerät übernommen (der Handshake des verwaisten Prozesses ist maßgeblich); ein veralteter Helper, der einen Slot für ein anderes Gerät blockiert, wird per `serve-sim -k` zurückgeholt und einmal neu gestartet.
- **Keep-alive + Leerlauf-Stopp** — ein abgestürzter Stream startet im Hintergrund neu (~5 s Verzögerung); ohne Konsumenten stoppt der Stream nach 5 Minuten automatisch. Absichtliche Stopps werden niemals bekämpft. (Der Echtgeräte-Runner ist absichtlich vom Leerlauf-Aufräumen ausgenommen: Ein Neustart kostet einen mehrminütigen `xcodebuild`-Rebuild.)

## Voraussetzungen

- **macOS mit vollständigem Xcode** — nicht nur die Command Line Tools. `xcodebuild`, `xcrun simctl` und die Simulator-Runtimes werden alle mit Xcode ausgeliefert.
- **Mindestens eine iOS-Simulator-Runtime** in Xcode installiert.
- **DSH ≥ 0.1.0-rc.6 mit Web-Bundle** für das Panel. Headless-Profile funktionieren ebenfalls: Alle 22 Tools arbeiten normal, nur ohne die Live-Ansicht.
- **Nicht-macOS-Hosts**: Das Plugin lädt und alle 22 Tools registrieren sich, aber jeder Aufruf gibt einen erklärenden Fehler zurück (`iOS Simulator requires macOS with Xcode …`).
- **serve-sim** wird als npm-Abhängigkeit dieses Plugins ausgeliefert und löst sich daher bei echten Installationen lokal auf; der `npx -y serve-sim`-Fallback deckt Entwicklungsbäume ab (die erste Nutzung benötigt Netzwerk).
- **AXe** (optional — nur die AXe-basierten Tools benötigen es: `ios_sim_ui_tree` / `ios_sim_tap_element` sowie `ios_sim_ui_rows` / `ios_sim_tap_row` auf einem Simulator): `brew install cameroncooke/axe/axe` oder das Plugin die gepinnte Version automatisch herunterladen lassen (v1.8.0, SHA-256-verifiziert) nach `~/Library/Caches/dsh-ios/bin`. `DSH_IOS_AXE_BIN` überschreibt die Auflösung; `DSH_IOS_AXE_OFFLINE=1` deaktiviert den Download.
- **Vision OCR** (optional — nur `ios_sim_find_text` / `ios_sim_tap_text` benötigen es): Das Plugin kompiliert sein mitgeliefertes `assets/ocr.swift` bei der ersten Nutzung mit `swiftc` nach `~/Library/Caches/dsh-ios/bin/ocr` (Erkennung zh-Hans + en-US).
- **lldb-Attach** benötigt den macOS-Entwicklermodus: Führen Sie einmal `sudo DevToolsSecurity -enable` aus. Bis dahin verwendet `ios_sim_backtrace` Xcodes `sample`-Engine (nicht suspendierend) und `ios_sim_leaks` läuft mit dem Aktivierungshinweis in degradierter Form.. Der erste WDA-Build installiert einen signierten WebDriverAgentRunner: Vertrauen Sie bei der entsprechenden Aufforderung dem Zertifikat auf dem Gerät und führen Sie `ios_real_start_wda` erneut aus, wenn das Free-Team-Signaturprofil abläuft (Lebensdauer 7 Tage).

## In DSH installieren

```sh
dsh plugin --profile web add @zseven-w/dsh-ios@latest
dsh web
```

## Schnellstart

Eine typische erste Konversation:

1. **Geräte ermitteln** — „Liste die verfügbaren Simulatoren auf.“ → `ios_sim_devices`.
2. **Starten** — „Starte das iPhone 17 Pro.“ → `ios_sim_boot`. Der Stream startet und das **“iOS 模拟器”-Panel** öffnet sich: Das Gerät ist live in der Seitenleiste. (Klicken Sie auf eine beliebige Simulator-Kartenzeile oder die Status-Pille über dem Eingabefeld, um es erneut zu öffnen.)
3. **Auf dem Video tippen** — tippen oder ziehen Sie direkt auf dem Panel; oder lassen Sie den Agenten die UI steuern: „Öffne die Einstellungen und tippe dann auf ‚Allgemein‘.“ → `ios_sim_interact` (oder `ios_sim_ui_tree` + `ios_sim_tap_element` für identitätsbasierte Taps; `ios_sim_find_text` + `ios_sim_tap_text` für textbasierte Taps; `ios_sim_ui_rows` + `ios_sim_tap_row` für Listen-/Feed-Apps).
4. **Ihre App bauen &amp; ausführen** — „Baue und starte /path/to/MyApp.xcodeproj.“ → `ios_sim_build_run`. Ein vollständiger Build dauert Minuten; wenn er durch ist, startet die App auf dem Simulator und Sie verfolgen sie live im Panel.
5. **Preview-Hot-Reload** — „Zeige die SwiftUI-Previews von /path/to/MyPackage.“ → `ios_sim_preview start`. Bearbeiten Sie eine Quelldatei und die Preview wird innerhalb von ~2–5 s per Hot-Swap in den laufenden Simulator eingespielt — kein Neustart.
6. **Ein echtes iPhone steuern** — schließen Sie das Telefon per USB an (Datenkabel), entsperren Sie es und sagen Sie dann: „Starte WebDriverAgent auf dem Telefon.“ → `ios_real_start_wda`. Das Panel wechselt zum Live-Stream des Telefons und jedes Tool akzeptiert dessen `realDevices`-udid; wenn ein Aufruf fehlschlägt, lesen Sie den codierten Grund aus dem Status des Panels (`device-locked`, `cert-untrusted`, `profile-expired`, `tunnel-failed`, `device-unplugged`).

## Fehlerbehebung

- **Backtrace verwendet `sample` statt lldb, oder leaks beschwert sich über eingeschränkte Inspektion** — der macOS-Entwicklermodus ist aus. Führen Sie einmal `sudo DevToolsSecurity -enable` aus und versuchen Sie es erneut. Bis dahin degradieren die Tools sauber: `ios_sim_backtrace` fällt auf Xcodes `sample` zurück (symbolisiert, nicht suspendierend) und `ios_sim_leaks` meldet den Aktivierungshinweis.
- **`ios_sim_ui_tree` / `ios_sim_tap_element` benötigen AXe** — installieren Sie es mit `brew install cameroncooke/axe/axe`, oder lassen Sie das Plugin die gepinnte Version bei der ersten Nutzung herunterladen (benötigt Netzwerk zu github.com). Die Fehlermeldung enthält immer den vollständigen Installationshinweis; `DSH_IOS_AXE_BIN=/path/to/axe` überschreibt die Auflösung. Auch die Zeilen-Tools (`ios_sim_ui_rows` / `ios_sim_tap_row`) benötigen AXe auf einem Simulator.
- **`ios_sim_find_text` / `ios_sim_tap_text` melden, dass der OCR-Helper fehlt** — bei der ersten Nutzung wird das mitgelieferte `assets/ocr.swift` mit `swiftc` (benötigt Xcode) nach `~/Library/Caches/dsh-ios/bin/ocr` kompiliert; der Fehler enthält den exakten Pfad und den Hinweis.
- **`ios_sim_ui_rows` findet keine Zeilen** — das Ergebnis nennt den Grund: Tiefe zu gering (`max_depth` erhöhen; auf einem Telefon kostet jeder tiefere Snapshot ~15–25 s), kein Listen-Screen oder nach einem tiefen Lesevorgang tatsächlich keine Accessibility-Informationen. Ein flacher Lesevorgang wird niemals fälschlich als fehlende Accessibility gemeldet.
- **`ios_sim_leaks` auf iOS-26.2-Simulatoren** — auf iOS-26.2-Runtimes kann Xcodes `leaks` die Simulator-Prozesse selbst bei aktiviertem Entwicklermodus nicht untersuchen und meldet fatale Diagnosen wie `Failed to get DYLD info` oder minimal-corpse-Fehler. Das Tool degradiert sauber: Sie erhalten die rohe Diagnose, das Ziel wird immer als wieder fortgesetzt verifiziert, und nichts hängt. Es gibt keine pluginseitige Lösung — wenn es zuschlägt, versuchen Sie `mode: "memgraph"` oder eine andere Runtime..
- **Der Stream stoppt von selbst** — das ist die Leerlauf-Richtlinie, kein Absturz: Ohne Konsumenten (Panel geschlossen, keine Karten gemountet, keine aktive Route) stoppt der Stream nach 5 Minuten und startet beim nächsten Tool-Aufruf oder Panel-Öffnen neu. Ein abgestürzter Stream startet innerhalb von ~5 Sekunden im Hintergrund neu.

## Entwicklung

```sh
pnpm install
pnpm run build      # host tsc + client bundle → lib/
pnpm run typecheck
```

Die Smoke-Tests unter `scripts/` prüfen das gebaute `lib/` (nur macOS für die Teile, die einen Simulator starten oder mit einem per USB verbundenen Telefon sprechen; setzen Sie `DSH_IOS_SMOKE_SKIP_SIM=1`, um diese Teile zu überspringen):

| Skript | Was es abdeckt |
| --- | --- |
| `node scripts/dev-smoke.mjs` | Sim-Host: Binärauflösung, Stream-Start, Steuerung, Keep-alive, Dispose. |
| `node scripts/dev-tools-smoke.mjs [--full-build]` | Die Kern-Tools gegen einen echten Simulator (mit `--full-build` zusätzlich ein echter Build). |
| `node scripts/dev-routes-smoke.mjs` | Signierte Web-Routen: Grant, Stream-Proxy, Screenshot, ws-Relay, Absicherungen, Ablauf. |
| `node scripts/dev-card-smoke.mjs` | Client-Karten: statisches SSR (kein `<img>`), Status-/Capture-Vertrag, quasi-live Netzwerkteil. |
| `node scripts/dev-panel-smoke.mjs` | Panel-Komponenten, Größenmodi, Rahmenstile, Dock-/Trigger-/Kapsel-Logik (nur statisch). |
| `node scripts/dev-logs-smoke.mjs` | `ios_sim_logs`-Snapshot/Follow, Filter, Obergrenzen, Prozess-Aufräumen. |
| `node scripts/dev-uitree-smoke.mjs` | UI-Tree-Tools: AXe-Auflösungs-/Download-Pipeline, Selektoren, Baum + Tap auf echtem Simulator. |
| `node scripts/dev-debug-smoke.mjs` | Debug-Tools: Prozesse, Backtrace (lldb + sample), Leaks, App-Infos. |
| `node scripts/dev-preview-smoke.mjs` | Preview-Hot-Reload: Start, Bearbeiten → Hot-Swap ohne Neustart, Fehlerwiederherstellung, Stopp. |
| `node scripts/dev-orphan-smoke.mjs` | Übernahme/Zurückholen verwaister serve-sim-Prozesse nach unsanftem Host-Kill. |
| `node scripts/dev-ocr-smoke.mjs` | Vision-OCR-Tools: Helper-Auflösung, swiftc-Kompilier-Cache, Erkennungs-Pipeline, Tap-Text-Routing. |
| `node scripts/dev-wda-smoke.mjs` | WebDriverAgent-Host: `ServerURLHere`-Parsing, Fehlerklassifikation, Tunnel, Keep-alive (gemockt; optionaler Live-Durchlauf). |
| `node scripts/dev-realdevice-smoke.mjs` | `xcrun devicectl` gegen ein per USB verbundenes iPhone — exakt die Codepfade, die die Tools verwenden. |
| `node scripts/dev-realstart-smoke.mjs` | Die `/real-start`-Route: Absicherung, codierte Ablehnungen, Build-/Start-Gating (statisch). |
| `node scripts/dev-realtools-smoke.mjs` | Echtgeräte-Backends von `ios_sim_screenshot` / `ios_sim_interact` / `ios_sim_ui_tree` / `ios_sim_tap_element` plus `ios_real_start_wda`. |

## Ökosystem

- [DSH Crew](https://github.com/ZSeven-W/dsh-crew) — Arbeit aus Claude Code / Codex an DSH-Agenten delegieren
- [DSH Noema](https://github.com/ZSeven-W/dsh-noema) — Langzeitgedächtnis für DSH
- [DSH OpenPencil](https://github.com/ZSeven-W/dsh-openpencil) — `.op`-Designdokumente in einer Konversation prüfen und bearbeiten

## Danksagungen &amp; Lizenz

- [serve-sim](https://github.com/EvanBacon/serve-sim) — Evan Bacon — die Streaming-Engine des Simulators (Apache-2.0; mitgelieferte Laufzeitabhängigkeit).
- [AXe](https://github.com/cameroncooke/AXe) — Cameron Cooke — das Accessibility-CLI hinter den UI-Tree-Tools (MIT).
- [WebDriverAgent](https://github.com/appium/WebDriverAgent) — der WebDriver-Server, den das Plugin auf echten Geräten baut und startet (BSD-lizenziert).
- Die Architektur ist vom Codex-Plugin „Build iOS Apps“ inspiriert; die SwiftUI-Preview-Engine ist eine Clean-Room-Neuimplementierung des öffentlich dokumentierten Ansatzes — es wird kein Codex-Code kopiert.
- Die vollständigen Hinweise finden Sie in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

**Lizenz**: MIT
