<p align="center">
  <img src="./docs/images/dsh-ios-logo.png" alt="DSH iOS" width="120" />
</p>

<h1 align="center">DSH Simulator iOS</h1>

<p align="center">
  <strong>Simulator iOS langsung dan interaktif di dalam percakapan <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> — plus iPhone asli Anda melalui USB.</strong><br />
  <sub>21 alat agen &bull; panel samping MJPEG langsung &bull; simulator &amp; iPhone asli melalui USB &bull; aksi baris daftar/umpan &bull; muat ulang panas pratinjau SwiftUI</sub>
</p>

<p align="center">
  <sub>npm: <code>@zseven-w/dsh-ios</code> &middot; Rilis plugin saat ini: <code>0.1.0-rc.1</code> &middot; Diuji dengan DSH <code>0.1.0-rc.6</code></sub>
</p>

<p align="center">
  <a href="./README.md">English</a> &middot; <a href="./README.zh.md">简体中文</a> &middot; <a href="./README.zh-TW.md">繁體中文</a> &middot; <a href="./README.ja.md">日本語</a> &middot; <a href="./README.ko.md">한국어</a> &middot; <a href="./README.fr.md">Français</a> &middot; <a href="./README.es.md">Español</a> &middot; <a href="./README.de.md">Deutsch</a> &middot; <a href="./README.pt.md">Português</a> &middot; <a href="./README.ru.md">Русский</a> &middot; <a href="./README.hi.md">हिन्दी</a> &middot; <a href="./README.tr.md">Türkçe</a> &middot; <a href="./README.th.md">ไทย</a> &middot; <a href="./README.vi.md">Tiếng Việt</a> &middot; <b>Bahasa Indonesia</b>
</p>

<p align="center">
  <sub>rc: <code>0.1.0-rc.1</code> belum dipublikasikan ke npm — lihat <a href="#pasang-di-dsh">Pemasangan</a></sub>
</p>

<br />

<p align="center">
  <img src="./docs/images/dsh-ios-overview.png" alt="DSH iOS Simulator — a real iPhone inside the conversation" width="100%" />
</p>
<p align="center"><sub>iPhone sungguhan yang dikendalikan dari dalam percakapan DSH — panggilan alat di kiri, panel perangkat langsung di kanan</sub></p>

## Mengapa DSH Simulator iOS

DSH Simulator iOS memberi agen simulator iOS sungguhan di dalam percakapan — dan memberi Anda pikselnya. Agen dapat mem-boot perangkat, membangun dan menjalankan proyek Xcode atau paket Swift, menggerakkan UI berdasarkan identitas aksesibilitas atau teks OCR, membaca log terpadu, serta memeriksa proses, backtrace, dan kebocoran memori, sementara aliran langsung perangkat dirender di panel samping persisten tempat Anda bisa mengetuk, menyeret, memutar, dan menekan Home langsung pada video. Kata kerja yang sama juga bekerja pada iPhone asli yang terhubung melalui USB: plugin membangun dan meluncurkan WebDriverAgent di ponsel, menerowongkan port kontrol dan port layarnya melalui loopback, dan mengalirkan perangkat ke panel, kartu, dan alat yang sama. Tanpa blok gambar, tanpa file rekaman layar: byte visual hanya mencapai UI melalui URL bertanda tangan dan kedaluwarsa yang disajikan server web DSH.

| | |
| --- | --- |
| 🖥️ **Simulator langsung dalam percakapan** | Aliran MJPEG serve-sim dari perangkat yang di-boot, diproksikan melalui rute `/_dsh/dsh-ios/*` bertanda tangan ke panel kanan persisten — peramban tidak pernah menyentuh port serve-sim. |
| 📱 **iPhone asli melalui USB** | `ios_real_start_wda` membangun dan meluncurkan WebDriverAgent pada ponsel yang terhubung dan menerowongkan port kontrol (REST) serta port layar (MJPEG) melalui loopback; panel, alat, kartu, dan kapsul status yang sama kemudian menggerakkan ponsel. Perangkat harus dalam keadaan terbuka kunci, dan setiap ketukan pada akun asli dibatasi aturan “kenali dulu, ketuk kemudian” milik plugin. |
| 🛠️ **21 alat agen** | Perangkat, nyalakan/matikan, tangkapan layar, interaksi, build dan jalankan, log terpadu, pohon UI berbasis AXe dan ketuk per elemen, aksi baris daftar/umpan, temukan/ketuk teks dengan Vision OCR, muat ulang panas pratinjau SwiftUI, proses, backtrace, kebocoran, info aplikasi. |
| 👆 **Panel interaktif** | Ketuk dan seret pada video langsung; bilah ikon Home / putar / tangkapan layar / segarkan dengan tooltip saat kursor di atas; mode ukuran (适应 · 50–125% · S/M/L); gaya bingkai (无框 / 边框 / 真机框); seret-ubah ukuran hingga 960 px dengan klik ganda untuk reset; perlebar otomatis saat lanskap. |
| 🧾 **Baris daftar dan umpan** | `ios_sim_ui_rows` mengubah snapshot aksesibilitas dalam menjadi baris berindeks dengan label dan penghitung yang diurai secara generik; `ios_sim_tap_row` mengetuk di dalam baris pada koordinat relatif dan memverifikasi aksi melalui perubahan ±1 penghitung sesuai harapan — satu-satunya konfirmasi andal yang ditawarkan aplikasi daftar. |
| 🔐 **Transport khusus loopback** | serve-sim hanya mengikat 127.0.0.1 pada rentang port khusus; setiap rute mewajibkan peer loopback, `Host` loopback, dan pemeriksaan Fetch-Metadata/Origin; kapabilitas HMAC kedaluwarsa dalam 10 menit.. |
| ⚡ **Muat ulang panas pratinjau SwiftUI** | `ios_sim_preview` membuat aplikasi host sekali pakai di luar paket Anda, membangun pratinjau Anda sebagai dylib, dan menukar-panas editan ke simulator yang sedang berjalan tanpa meluncurkan ulang (~2–5 detik). |
| 🧭 **Otomasi UI semantik** | `ios_sim_ui_tree` membuang pohon aksesibilitas (berbasis AXe) dan `ios_sim_tap_element` mengetuk berdasarkan label atau pengenal; saat pohon kosong atau menurun, `ios_sim_find_text` meng-OCR layar dan `ios_sim_tap_text` mengetuk teks yang cocok — ketukan berbasis identitas dan teks, bukan koordinat tebakan. |

## Alat

Ke-21 alat terdaftar di setiap host dan hanya mengembalikan JSON polos — byte visual hanya mencapai UI melalui `presentationMeta` + rute bertanda tangan, tidak pernah sebagai blok gambar. udid simulator dirutekan melalui simctl/serve-sim; udid perangkat fisik dirutekan melalui WebDriverAgent secara otomatis. Pada host non-macOS (atau saat serve-sim tidak dapat diselesaikan) alat tetap terdaftar tetapi gagal dengan error yang menjelaskan; satu-satunya pengecualian adalah `status` milik `ios_sim_preview`, yang melaporkan `{ running: false }` secara jujur di host mana pun.

### Alat simulator inti

| Alat | Fungsinya | Parameter utama |
| --- | --- | --- |
| `ios_sim_devices` | Mencantumkan perangkat simulator iOS yang tersedia di Mac ini (udid, nama, runtime, status) dan mana yang sedang boot, plus iPhone fisik yang terhubung USB di `realDevices` (udid, nama, osVersion, model, state, developerMode). Gunakan untuk menemukan udid atau nama yang akan diteruskan ke alat lain. | — |
| `ios_sim_boot` | Mem-boot perangkat dan memulai aliran serve-sim langsungnya; aliran tetap hidup selama percakapan sehingga panel dapat menampilkan simulator secara langsung. | `udid` (wajib — udid atau nama perangkat) |
| `ios_sim_shutdown` | Mematikan perangkat; menghentikan aliran bila aliran menarget perangkat tersebut. | `udid` (wajib) |
| `ios_sim_screenshot` | Menangkap PNG dan mengembalikan ringkasan JSON singkat (path, byte, dimensi, perangkat); gambar dirender di kartu/panel, tidak pernah sebagai blok gambar. Bekerja pada simulator yang sedang dialirkan dan pada ponsel USB melalui WebDriverAgent. | `udid` (opsional — perangkat yang dialirkan, jika tidak maka simulator pertama yang boot) |
| `ios_sim_interact` | Berinteraksi dengan perangkat yang dialirkan — simulator atau ponsel USB: ketuk pada koordinat ternormalisasi 0..1, ketik teks (keyboard AS pada simulator), tekan tombol perangkat keras (`home`, `lock`, `volumeUp`…), gulir, atau kirim gestur sentuh; setelah aksi tenang (~300 ms) tangkapan layar baru memperlihatkan efeknya. | `action` (wajib — `tap`/`type`/`button`/`gesture`/`scroll`), `x`/`y`, `text`, `name`, `json` |
| `ios_sim_list_apps` | Mencantumkan aplikasi yang TERPASANG pada simulator yang boot atau ponsel yang terhubung (bundle id, nama tampilan, versi, tanda sistem) — bundle id pihak ketiga tidak dapat ditebak, jadi cantumkan dulu atau teruskan `name` ke `ios_sim_launch_app`. Pencantuman yang GAGAL melempar error (mis. “perangkat tidak dapat dijangkau melalui CoreDevice”) alih-alih mengembalikan daftar kosong, sehingga `count: 0` selalu berarti perangkat benar-benar tidak punya aplikasi yang cocok. | `udid` (opsional), `query` (substring tanpa membedakan huruf besar/kecil pada nama tampilan DAN bundle id, termasuk CJK), `include_system` (default false) |
| `ios_sim_launch_app` | Meluncurkan aplikasi terpasang pada simulator yang boot atau ponsel yang terhubung — lewat `bundleId`, atau lewat `name` (substring nama tampilan tanpa membedakan huruf besar/kecil, diselesaikan lewat pencantuman yang sama, termasuk CJK). Tepat salah satu dari keduanya; kegagalan peluncuran dan nama yang ambigu sama-sama mengembalikan langkah berikutnya (`ios_sim_build_run` untuk membangun dari sumber). | `bundleId` atau `name` (tepat satu), `udid`, `relaunch` |
| `ios_sim_build_run` | Membangun `.xcodeproj`, `.xcworkspace`, atau paket Swift untuk simulator, memasang `.app` hasilnya, dan meluncurkannya; teruskan udid perangkat fisik untuk membangun, memasang, dan meluncurkan di ponsel (butuh penandatanganan Apple Development). Saat gagal, hasilnya memuat ekor error `xcodebuild` yang sudah difilter. Build penuh memakan waktu beberapa menit. | `projectPath` (wajib), `scheme`, `udid` (dialirkan → boot → iPhone runtime terbaru, yang di-boot), `configuration` (default `Debug`) |
| `ios_real_start_wda` | Memulai WebDriverAgent (WDA) pada iPhone fisik yang terhubung USB — hanya perangkat asli, tidak pernah simulator. Mengadopsi WDA yang sudah berjalan bila ada yang merespons; jika tidak, menjalankan build/peluncuran `xcodebuild` (build dingin memakan waktu beberapa menit), lalu menunggu WDA melaporkan siap dan mengembalikan port kontrol/MJPEG yang dipakai panel langsung. Jalankan ini lebih dulu ketika `ios_sim_screenshot` / `ios_sim_interact` / `ios_sim_ui_tree` / `ios_sim_tap_element` melaporkan WDA tidak berjalan untuk perangkat itu. | `udid` (wajib — udid perangkat fisik dari `ios_sim_devices.realDevices`) |

### Alat pohon UI (berbasis AXe)

| Alat | Fungsinya | Parameter utama |
| --- | --- | --- |
| `ios_sim_ui_tree` | Membuang pohon elemen aksesibilitas aplikasi terdepan (label, pengenal, nilai, frame dalam poin perangkat) plus ukuran layar dalam poin — AXe pada simulator, WebDriverAgent pada ponsel USB (di sana kedalaman dibatasi secara default: snapshot tanpa batas dari aplikasi sibuk terukur ~32 dtk / 751 KB, dengan batas ~2 dtk); output dibatasi ~40 KB (level terdalam dipangkas, ditandai `truncated` + petunjuk). | `udid` (opsional), `max_depth`, `filter` (substring tanpa membedakan huruf besar/kecil pada label/pengenal/tipe) |
| `ios_sim_tap_element` | Mengetuk elemen berdasarkan identitas — cocok persis dulu, lalu substring tanpa membedakan huruf besar/kecil pada `identifier`/`label`; duplikat bersarang diciutkan menjadi satu target, kecocokan ambigu mencantumkan semua kandidat. Ketukan mendarat di tengah elemen (AXe HID pada simulator, WebDriverAgent pada ponsel), lalu tangkapan layar ~300 ms memperlihatkan efeknya; teruskan `expect_text` / `expect_gone` dan ketukan beserta verifikasinya menjadi satu perjalanan pulang-pergi (`expected.matched`). | `udid` (opsional), `identifier`, `label`, `expect_text`, `expect_gone` |

### Baris daftar &amp; umpan

Aplikasi daftar/umpan menggabungkan setiap item ke dalam satu sel aksesibilitas yang labelnya memuat seluruh ringkasan dan semua penghitungnya (“57 回复。18 喜欢。592 次查看”) — tidak ada tombol anak per kontrol untuk dicocokkan, dan sel baris hanya muncul pada snapshot dalam. Kedua alat ini menampilkan struktur itu sebagai baris dan bertindak di dalam sebuah baris.

| Alat | Fungsinya | Parameter utama |
| --- | --- | --- |
| `ios_sim_ui_rows` | Membaca baris daftar/umpan yang terlihat dari aplikasi terdepan sebagai baris, bukan pohon mentah: setiap baris melaporkan indeksnya, frame dalam poin, label gabungan, dan penghitung yang diurai dari label itu (angka + token pengklasifikasi, mis. `57 回复` → 回复=57, bahasa Tionghoa atau Inggris — tanpa kosakata aplikasi yang dikodekan). Baris hanya muncul pada snapshot dalam: di ponsel `max_depth` default adalah 60, dengan biaya ~15–25 dtk / ~0.5 MB per panggilan (WDA melayani permintaan secara serial) — utamakan pengamat yang murah (`ios_sim_find_text` / `ios_sim_ui_tree`). Penghitung diurai secara heuristik dan kunci dapat bolak-balik: teruskan kunci ke `ios_sim_tap_row.expect_count` persis seperti yang tercantum. Saat tidak ada baris ditemukan, hasilnya menjelaskan alasannya (kedalaman terlalu dangkal / bukan layar daftar / benar-benar tidak ada informasi aksesibilitas setelah pembacaan dalam) — pembacaan dangkal tidak pernah dilaporkan sebagai “aplikasi tidak punya informasi aksesibilitas”; baris di luar layar dikecualikan dan dihitung sebagai `omittedOffscreen`. | `udid` (opsional), `max_depth` (khusus ponsel; default 60) |
| `ios_sim_tap_row` | Mengetuk pada posisi relatif di dalam satu baris daftar yang terlihat (dilaporkan `ios_sim_ui_rows`: indeks berbasis 0; x/y sebagai pecahan frame baris itu — 0 = tepi kiri/atas, 1 = kanan/bawah, default 0.5 = tengah) pada simulator (AXe) atau ponsel USB (WebDriverAgent). Frame baris berasal dari pembacaan pohon yang SEGAR, jadi tidak ada koordinat layar absolut yang ditebak; indeks di luar rentang GAGAL (tidak pernah dijepit). Gerbang pengaman: dengan `expect_count={key,delta}`, alat memverifikasi aksi dengan membaca ulang label baris dan memeriksa penghitung bergeser tepat +1/−1 (`countCheck.verified`); jika kunci tidak ada di antara penghitung terurai milik baris, ketukan DITOLAK sebelum terjadi — ketukan pada perangkat asli tidak pernah menjadi percobaan. Tanpa `expect_count`, ketukan tetap terjadi (posisi relatif baris yang eksplisit ADALAH identifikasinya) tetapi tidak ada yang diverifikasi. | `udid` (opsional), `index` (wajib), `x`, `y` (pecahan 0..1), `max_depth`, `expect_count` (`{key, delta}`) |

### Alat OCR (Vision)

| Alat | Fungsinya | Parameter utama |
| --- | --- | --- |
| `ios_sim_find_text` | Meng-OCR layar SAAT INI dari simulator yang boot atau ponsel USB dengan helper Vision yang dikompilasi plugin (pengenalan akurat, zh-Hans + en-US, dikompilasi `swiftc` pada pemakaian pertama ke `~/Library/Caches/dsh-ios/bin/ocr`). Gunakan saat pohon aksesibilitas kosong atau menurun, untuk teks yang dirender sebagai grafis (angka badge, harga yang tercetak dalam gambar), atau untuk memverifikasi secara independen apa yang ada di layar. Menangkap tangkapan layar baru dan mengembalikan `{device, size, items:[{text, confidence, rect}]}` — rect adalah kotak poin perangkat (asal kiri-atas), terurut berdasarkan keyakinan, output dibatasi ~40 KB (`truncated` membuang ekor dengan keyakinan terendah; persempit dengan `query` atau naikkan `min_confidence`). | `udid` (opsional), `query` (substring tanpa membedakan huruf besar/kecil), `min_confidence` (default 0.3) |
| `ios_sim_tap_text` | Meng-OCR layar SAAT INI dan mengetuk pusat kecocokan teks terbaik — aturan yang sama: persis → mengandung tanpa membedakan huruf besar/kecil → daftar kandidat saat ambigu, seperti `ios_sim_tap_element`, untuk teks yang tidak terlihat pohon aksesibilitas (aplikasi tanpa a11y, angka badge, teks yang tercetak dalam gambar). Di ponsel, ketukan mendarat pada poin absolut perangkat melalui WebDriverAgent; pada simulator yang dialirkan, dikirim ternormalisasi melalui kontrol serve-sim (jalankan `ios_sim_boot` dulu). Setelah ~300 ms tangkapan layar baru memperlihatkan efeknya; teruskan `expect_text` / `expect_gone` dan ketukan beserta verifikasinya menjadi satu perjalanan pulang-pergi (`expected.matched`). Pada perangkat ASLI, setiap ketukan punya konsekuensi nyata — jangan pernah mengetuk kontrol yang tidak dikenal untuk mencari tahu fungsinya. | `udid` (opsional), `query` (wajib), `min_confidence`, `expect_text`, `expect_gone` |

### Alat log

| Alat | Fungsinya | Parameter utama |
| --- | --- | --- |
| `ios_sim_logs` | Membaca apa yang dicetak aplikasi simulator dari log terpadu perangkat: `snapshot` (`log show --last <duration>`, default 2m) atau `follow` (tangkapan langsung terbatas selama `duration_seconds`, default 10, maksimal 60 — tidak pernah aliran yang menggantung). Output dibatasi ~300 baris / 30 KB dengan petunjuk penyempitan. | `udid` (opsional), `mode` (`snapshot`/`follow`), `duration`, `duration_seconds`, `bundle_id`, `predicate` (NSPredicate mentah, menimpa `bundle_id`), `level` (`default`/`info`/`debug`), `grep` |

### Alat pratinjau

| Alat | Fungsinya | Parameter utama |
| --- | --- | --- |
| `ios_sim_preview` | Muat ulang panas pratinjau SwiftUI, langsung di simulator: `start` (default) memvalidasi paket, membuat aplikasi host sekali pakai di cache plugin (tidak pernah di dalam paket Anda), membangun paket sebagai dylib untuk simulator, memasang dan meluncurkan host, lalu memantau sumber — setiap editan dibangun ulang dan ditukar-panas tanpa peluncuran ulang (~2–5 dtk). Error kompiler mempertahankan pratinjau baik terakhir dan muncul lewat `status`; satu sesi pada satu waktu. | `packagePath` (wajib untuk `start`), `udid`, `action` (`start`/`status`/`stop`), `previewFilter` (substring tanpa membedakan huruf besar/kecil pada nama pratinjau) |

### Alat debug

| Alat | Fungsinya | Parameter utama |
| --- | --- | --- |
| `ios_sim_processes` | Mencantumkan proses aplikasi yang berjalan dari satu simulator lewat launchd miliknya sendiri (pid yang terlihat host, nama, bundle id) — sumber pid untuk backtrace/kebocoran; udid perangkat fisik mencantumkan proses ponsel lewat devicectl. | `udid` (opsional), `filter` (substring tanpa membedakan huruf besar/kecil pada nama/bundle id) |
| `ios_sim_backtrace` | LLDB batch sekali jalan (pasang → backtrace thread → lepas, tidak pernah interaktif); output dibatasi ~200 baris, thread utama lebih dulu, target selalu diverifikasi telah dilanjutkan. Saat macOS menolak pemasangan (Mode Pengembang mati), menurun ke mesin `sample` milik Xcode (tanpa menangguhkan) dan melaporkan petunjuk pengaktifan. Khusus simulator — perangkat fisik ditolak beserta alasannya. | `udid` (opsional), `pid` / `bundle_id`, `all_threads` (default true) |
| `ios_sim_leaks` | Menganalisis kebocoran dengan alat `leaks` milik Xcode: `summary` (jumlah kebocoran, total byte bocor, ~30 tipe teratas) atau `memgraph` (artefak `.memgraph` untuk dibuka di Xcode Instruments, tidak pernah diurai di sini). Aplikasi ditangguhkan selama pemindaian dan selalu dilanjutkan. Khusus simulator. | `udid` (opsional), `pid` / `bundle_id`, `mode` (`summary`/`memgraph`) |
| `ios_sim_app_info` | Fakta aplikasi terpasang: path app bundle, kontainer data yang dapat ditulis, dan nilai Info.plist — lewat `simctl appinfo` (dengan cadangan `get_app_container`) pada simulator, lewat `devicectl` pada ponsel USB; `installed: false` plus `note` yang menyebut `ios_sim_list_apps` untuk aplikasi yang hilang. | `udid` (opsional), `bundle_id` (wajib) |

## Permukaan tampilan

- **Panel samping — “iOS 模拟器”.** Tampilan langsung berada di panel kanan persisten (dok tetap yang menyingkirkan percakapan, atau hamparan terpusat pada viewport sempit). Panel merender aliran MJPEG langsung dan menerima klik-untuk-mengetuk serta seret-untuk-gestur langsung pada video, dengan bilah ikon (Home, tangkapan layar, putar, segarkan) yang tombolnya memuat tooltip saat kursor di atas. Kontrol ukuran menawarkan **适应** (pas dengan lebar panel), perbesaran **50–125%** dari lebar logis perangkat, dan preset **S / M / L** yang mengukur sisi pendek perangkat (lebar potret; saat lanskap diskalakan agar perangkat mempertahankan ukuran fisiknya). Gaya bingkai adalah **无框 / 边框 / 真机框** (tanpa bingkai / bezel / cangkang perangkat realistis) dengan radius sudut proporsional. Saat perangkat berputar ke lanskap, panel otomatis melebar ke ukuran nyaman dan mengembalikan lebar Anda saat berputar balik — seretan manual selama itu selalu menang. Pegangan tepi kiri menyeret panel lebih lebar/sempit (maks. 960 px; klik ganda mengatur ulang ke lebar default). Saat iPhone yang terhubung USB menjadi target aliran, panel yang sama menampilkan aliran MJPEG WebDriverAgent ponsel dengan kontrol yang sama.
- **Kartu percakapan ringkas.** Hasil alat dirender sebagai kartu satu baris tanpa citra sebaris: judul terpadu **“iOS 模拟器”**, sublabel aksi (Nyalakan / Tangkapan layar / Interaksi / Build dan jalankan / Mulai WebDriverAgent), nama perangkat, lencana status, dan isyarat “buka di panel samping”. Mengeklik baris membuka panel; klik pada tombol, tautan, atau frame langsung itu sendiri tidak pernah memicunya.
- **Kapsul status di atas input.** Saat panel tertutup dan aliran daring, pil kecil bertitik hijau (`<device>` · 实时) muncul di atas kolom input dan membuka panel saat diklik. Ia terbatas sesi: hanya dirender dan dipol saat percakapan saat ini memiliki hasil simulator terpasang, dan berhenti saat Anda pindah ke sesi tanpanya.
- **Mode standar dan Mode Code.** Sesi standar memakai `presentationMeta` yang diproyeksikan host. Dispatch Mode Code (PTC) bersarang tidak pernah membawa meta, jadi klien merekonstruksi meta yang identik dari JSON hasil yang tahan lama — panel, kartu, dan kapsul bekerja di kedua mode.

## Keamanan

- Peramban tidak pernah berbicara dengan port serve-sim. Setiap byte melintasi origin server web DSH melalui rute `/_dsh/dsh-ios/*` milik plugin: `/stream/<token>` (proxy MJPEG), `/screenshot/<token>` (PNG ter-cache), `/ws?token=…` (relai kontrol HID), plus endpoint `/grant`, `/capture`, dan `/status`.
- Token adalah kapabilitas HMAC-SHA256 (`base64url(payload).base64url(mac)`) yang kedaluwarsa dalam 10 menit, ditandatangani dengan kunci per-rumah DSH (`<DSH_HOME>/cache/dsh-ios/stream-access.key`, 0600, dibuat secara atomik).
- Setiap rute menerapkan pagar transport loopback/tepercaya sebelum kapabilitas apa pun diperiksa: alamat peer loopback, `Host` loopback (DNS-rebinding ditolak), dan pemeriksaan Fetch-Metadata/Origin. Rute tangkapan layar hanya menyajikan file di dalam direktori cache plugin (tautan simbolis ditolak, pemeriksaan `realpath`).
- serve-sim berjalan sebagai proses anak latar depan hanya di loopback, pada rentang port khusus (3181–3244), sehingga serve-sim milik pengguna sendiri di port 3100 tidak pernah tersentuh; `--host` tidak pernah digunakan..
- **Adopsi/reklaim yatim** — jika host DSH sebelumnya dimatikan secara kasar dan helper serve-sim-nya selamat, perangkat yang sama diadopsi (handshake si yatim bersifat berwenang); helper basi yang menduduki slot perangkat lain direklaim lewat `serve-sim -k` dan diluncurkan ulang sekali.
- **Keep-alive + berhenti saat idle** — aliran yang crash dimulai ulang di latar belakang (~5 dtk jeda); tanpa konsumen, aliran berhenti otomatis setelah 5 menit. Penghentian yang disengaja tidak pernah dilawan. (Runner perangkat asli sengaja dikecualikan dari pemungutan idle: memulai ulangnya menghabiskan build ulang `xcodebuild` berdurasi menit.)

## Persyaratan

- **macOS dengan Xcode lengkap** — bukan hanya Command Line Tools. `xcodebuild`, `xcrun simctl`, dan runtime simulator semuanya disertakan bersama Xcode.
- **Setidaknya satu runtime simulator iOS** terpasang di Xcode.
- **DSH ≥ 0.1.0-rc.6 dengan bundel web** untuk panel. Profil headless juga bekerja: ke-21 alat berfungsi normal, hanya tanpa tampilan langsung.
- **Host non-macOS**: plugin dimuat dan ke-21 alat terdaftar, tetapi setiap panggilan mengembalikan error yang menjelaskan (`iOS Simulator requires macOS with Xcode …`).
- **serve-sim** dikirim sebagai dependensi npm plugin ini, sehingga terselesaikan secara lokal pada pemasangan sungguhan; cadangan `npx -y serve-sim` menutupi pohon pengembangan (pemakaian pertama butuh jaringan).
- **AXe** (opsional — hanya alat berbasis AXe yang membutuhkannya: `ios_sim_ui_tree` / `ios_sim_tap_element`, plus `ios_sim_ui_rows` / `ios_sim_tap_row` pada simulator): `brew install cameroncooke/axe/axe`, atau biarkan plugin mengunduh otomatis rilis yang disematkan (v1.8.0, terverifikasi SHA-256) ke `~/Library/Caches/dsh-ios/bin`. `DSH_IOS_AXE_BIN` menimpa resolusi; `DSH_IOS_AXE_OFFLINE=1` menonaktifkan unduhan.
- **Vision OCR** (opsional — hanya `ios_sim_find_text` / `ios_sim_tap_text` yang membutuhkannya): plugin mengompilasi `assets/ocr.swift` bawaannya dengan `swiftc` pada pemakaian pertama ke `~/Library/Caches/dsh-ios/bin/ocr` (pengenalan zh-Hans + en-US).
- **Pemasangan lldb butuh Mode Pengembang macOS**: jalankan `sudo DevToolsSecurity -enable` sekali. Sampai saat itu `ios_sim_backtrace` memakai mesin `sample` milik Xcode (tanpa menangguhkan) dan `ios_sim_leaks` menurun dengan petunjuk pengaktifan.. Build WDA pertama memasang WebDriverAgentRunner yang ditandatangani: percayai sertifikatnya di perangkat saat diminta, dan jalankan ulang `ios_real_start_wda` saat profil penandatanganan tim gratis kedaluwarsa (masa berlaku 7 hari).

## Pasang di DSH

```sh
dsh plugin --profile web add @zseven-w/dsh-ios@latest
dsh web
```

> **Catatan rc** — `0.1.0-rc.1` belum dipublikasikan ke npm. Sampai saat itu, pasang tarball yang telah dikemas:
>
> ```sh
> npm pack                                   # di repositori ini → dsh-ios-0.1.0-rc.1.tgz
> dsh plugin --profile web add /path/to/dsh-ios-0.1.0-rc.1.tgz
> dsh web
> ```

## Mulai cepat

Percakapan pertama yang umum:

1. **Temukan perangkat** — “Cantumkan simulator yang tersedia.” → `ios_sim_devices`.
2. **Nyalakan** — “Nyalakan iPhone 17 Pro.” → `ios_sim_boot`. Aliran dimulai dan **panel “iOS 模拟器”** terbuka: perangkat tampil langsung di panel samping. (Klik baris kartu simulator mana pun, atau pil status di atas input, untuk membukanya kembali.)
3. **Ketuk pada video** — ketuk atau seret langsung pada panel; atau biarkan agen menggerakkan UI: “Buka Pengaturan, lalu ketuk General.” → `ios_sim_interact` (atau `ios_sim_ui_tree` + `ios_sim_tap_element` untuk ketukan berbasis identitas; `ios_sim_find_text` + `ios_sim_tap_text` untuk ketukan berbasis teks; `ios_sim_ui_rows` + `ios_sim_tap_row` untuk aplikasi daftar/umpan).
4. **Build dan jalankan aplikasi Anda** — “Build dan jalankan /path/to/MyApp.xcodeproj.” → `ios_sim_build_run`. Build penuh memakan waktu beberapa menit; saat selesai, aplikasi diluncurkan di simulator dan Anda menontonnya langsung di panel.
5. **Muat ulang panas pratinjau** — “Tampilkan pratinjau SwiftUI dari /path/to/MyPackage.” → `ios_sim_preview start`. Edit file sumber dan pratinjau tertukar-panas ke simulator yang berjalan dalam ~2–5 dtk — tanpa peluncuran ulang.
6. **Gerakkan iPhone asli** — colokkan ponsel lewat USB (kabel data), buka kuncinya, lalu “Mulai WebDriverAgent di ponsel.” → `ios_real_start_wda`. Panel beralih ke aliran langsung ponsel dan setiap alat menerima udid `realDevices` miliknya; saat panggilan gagal, baca alasan berkode dari status panel (`device-locked`, `cert-untrusted`, `profile-expired`, `tunnel-failed`, `device-unplugged`).

## Pemecahan masalah

- **Backtrace memakai `sample` alih-alih lldb, atau leaks mengeluhkan pemeriksaan terbatas** — Mode Pengembang macOS mati. Jalankan `sudo DevToolsSecurity -enable` sekali lalu coba lagi. Sampai saat itu alat menurun dengan rapi: `ios_sim_backtrace` beralih ke `sample` milik Xcode (tersimbolisasi, tanpa menangguhkan) dan `ios_sim_leaks` melaporkan petunjuk pengaktifan.
- **`ios_sim_ui_tree` / `ios_sim_tap_element` butuh AXe** — pasang dengan `brew install cameroncooke/axe/axe`, atau biarkan plugin mengunduh rilis yang disematkan pada pemakaian pertama (butuh jaringan ke github.com). Pesan error selalu memuat petunjuk pemasangan lengkap; `DSH_IOS_AXE_BIN=/path/to/axe` menimpa resolusi. Alat baris (`ios_sim_ui_rows` / `ios_sim_tap_row`) juga butuh AXe pada simulator.
- **`ios_sim_find_text` / `ios_sim_tap_text` melaporkan helper OCR hilang** — pemakaian pertama mengompilasi `assets/ocr.swift` bawaan dengan `swiftc` (butuh Xcode) ke `~/Library/Caches/dsh-ios/bin/ocr`; error memuat path dan petunjuk persisnya.
- **`ios_sim_ui_rows` tidak menemukan baris** — hasilnya menjelaskan alasannya: kedalaman terlalu dangkal (naikkan `max_depth`; di ponsel setiap snapshot lebih dalam berbiaya ~15–25 dtk), bukan layar daftar, atau benar-benar tidak ada informasi aksesibilitas setelah pembacaan dalam. Pembacaan dangkal tidak pernah salah dilaporkan sebagai aksesibilitas yang hilang.
- **`ios_sim_leaks` pada simulator iOS 26.2** — pada runtime iOS 26.2, `leaks` milik Xcode bisa gagal memeriksa proses simulator dengan diagnostik fatal seperti `Failed to get DYLD info` atau error minimal-corpse, bahkan dengan Mode Pengembang aktif. Alat menurun dengan rapi: Anda mendapat diagnostik mentah, target selalu diverifikasi dilanjutkan, dan tidak ada yang macet. Tidak ada perbaikan di sisi plugin — saat terjadi, coba `mode: "memgraph"` atau runtime lain..
- **Aliran berhenti sendiri** — itu kebijakan idle, bukan crash: tanpa konsumen (panel tertutup, tidak ada kartu terpasang, tidak ada rute aktif) aliran berhenti setelah 5 menit dan dimulai ulang pada panggilan alat berikutnya atau saat panel dibuka. Aliran yang crash dimulai ulang di latar belakang dalam ~5 detik.

## Pengembangan

```sh
pnpm install
pnpm run build      # tsc host + bundel klien → lib/
pnpm run typecheck
```

Pengujian asap di `scripts/` melatih `lib/` yang telah dibangun (khusus macOS untuk bagian yang mem-boot simulator atau berbicara dengan ponsel USB; setel `DSH_IOS_SMOKE_SKIP_SIM=1` untuk melewati bagian itu):

| Skrip | Cakupannya |
| --- | --- |
| `node scripts/dev-smoke.mjs` | Host sim: resolusi biner, peluncuran aliran, kontrol, keep-alive, dispose. |
| `node scripts/dev-tools-smoke.mjs [--full-build]` | Alat inti terhadap simulator sungguhan (plus build sungguhan dengan `--full-build`). |
| `node scripts/dev-routes-smoke.mjs` | Rute web bertanda tangan: grant, proxy aliran, tangkapan layar, relai ws, pagar, kedaluwarsa. |
| `node scripts/dev-card-smoke.mjs` | Kartu klien: SSR statis (tanpa `<img>`), kontrak status/capture, bagian jaringan hampir-langsung. |
| `node scripts/dev-panel-smoke.mjs` | Komponen panel, mode ukuran, gaya bingkai, logika dok/pemicu/kapsul (statis saja). |
| `node scripts/dev-logs-smoke.mjs` | snapshot/follow `ios_sim_logs`, filter, batas, pemungutan proses. |
| `node scripts/dev-uitree-smoke.mjs` | Alat pohon UI: resolusi/pipa unduhan AXe, selektor, pohon dan ketukan pada simulator sungguhan. |
| `node scripts/dev-debug-smoke.mjs` | Alat debug: proses, backtrace (lldb + sample), kebocoran, info aplikasi. |
| `node scripts/dev-preview-smoke.mjs` | Muat ulang panas pratinjau: mulai, edit → tukar-panas tanpa peluncuran ulang, pemulihan error, berhenti. |
| `node scripts/dev-orphan-smoke.mjs` | Adopsi/reklaim serve-sim yatim setelah host dimatikan secara kasar. |
| `node scripts/dev-ocr-smoke.mjs` | Alat Vision-OCR: resolusi helper, cache kompilasi swiftc, pipa pengenalan, perutean tap-text. |
| `node scripts/dev-wda-smoke.mjs` | Host WebDriverAgent: parsing `ServerURLHere`, klasifikasi kegagalan, terowongan, keep-alive (dipalsukan; pass langsung opsional). |
| `node scripts/dev-realdevice-smoke.mjs` | `xcrun devicectl` terhadap iPhone yang terhubung USB — persis jalur kode yang dipakai alat. |
| `node scripts/dev-realstart-smoke.mjs` | Rute `/real-start`: pagar, penolakan berkode, gerbang build/peluncuran (statis). |
| `node scripts/dev-realtools-smoke.mjs` | Backend perangkat asli dari `ios_sim_screenshot` / `ios_sim_interact` / `ios_sim_ui_tree` / `ios_sim_tap_element` plus `ios_real_start_wda`. |

## Kredit &amp; lisensi

- [serve-sim](https://github.com/EvanBacon/serve-sim) — Evan Bacon — mesin streaming simulator (Apache-2.0; dependensi runtime bawaan).
- [AXe](https://github.com/cameroncooke/AXe) — Cameron Cooke — CLI aksesibilitas di balik alat pohon UI (MIT).
- [WebDriverAgent](https://github.com/appium/WebDriverAgent) — server WebDriver yang dibangun dan diluncurkan plugin pada perangkat asli (berlisensi BSD).
- Arsitektur terinspirasi plugin “Build iOS Apps” milik Codex; mesin pratinjau SwiftUI adalah implementasi ulang clean-room dari pendekatan yang didokumentasikan publik — tidak ada kode Codex yang disalin.
- Lihat [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) untuk pemberitahuan lengkap.

**Lisensi**: MIT
