<p align="center">
  <img src="./docs/images/dsh-ios-logo.png" alt="DSH iOS" width="120" />
</p>

<h1 align="center">DSH iOS Simülatörü</h1>

<p align="center">
  <strong><a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> sohbetinin içinde canlı, etkileşimli bir iOS simülatörü — ayrıca USB üzerinden gerçek iPhone'unuz.</strong><br />
  <sub>22 ajan aracı &bull; canlı MJPEG kenar çubuğu paneli &bull; simülatör &amp; USB üzerinden gerçek iPhone &bull; liste/akış satırı eylemleri &bull; SwiftUI önizleme sıcak yeniden yükleme</sub>
</p>

<p align="center">
  <sub>npm: <code>@zseven-w/dsh-ios</code> &middot; Güncel eklenti sürümü: <code>0.1.0-rc.2</code> &middot; DSH <code>0.1.1-rc.1</code> ile test edildi</sub>
</p>

<p align="center">
  <a href="./README.md">English</a> &middot; <a href="./README.zh.md">简体中文</a> &middot; <a href="./README.zh-TW.md">繁體中文</a> &middot; <a href="./README.ja.md">日本語</a> &middot; <a href="./README.ko.md">한국어</a> &middot; <a href="./README.fr.md">Français</a> &middot; <a href="./README.es.md">Español</a> &middot; <a href="./README.de.md">Deutsch</a> &middot; <a href="./README.pt.md">Português</a> &middot; <a href="./README.ru.md">Русский</a> &middot; <a href="./README.hi.md">हिन्दी</a> &middot; <b>Türkçe</b> &middot; <a href="./README.th.md">ไทย</a> &middot; <a href="./README.vi.md">Tiếng Việt</a> &middot; <a href="./README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <sub>npm: <code>@zseven-w/dsh-ios</code> &middot; Geçerli eklenti sürümü: <code>0.1.0-rc.2</code> &middot; DSH <code>0.1.1-rc.1</code> ile test edildi</sub>
</p>

<br />

<p align="center">
  <img src="./docs/images/dsh-ios-overview.png" alt="DSH iOS Simulator — a real iPhone inside the conversation" width="100%" />
</p>
<p align="center"><sub>DSH sohbetinin içinden sürülen gerçek bir iPhone — solda araç çağrıları, sağda canlı cihaz paneli</sub></p>

## Neden DSH iOS Simülatörü

DSH iOS Simülatörü ajana sohbetin içinde gerçek bir iOS simülatörü verir — ve size pikselleri. Ajan bir cihazı başlatabilir, bir Xcode projesini veya Swift paketini derleyip çalıştırabilir, arayüzü erişilebilirlik kimliğiyle veya OCR metniyle yönetebilir, birleşik günlükleri okuyabilir; süreçleri, backtrace'leri ve bellek sızıntılarını inceleyebilir. Bu sırada cihazın canlı akışı kalıcı bir kenar çubuğu panelinde görüntülenir ve videonun üzerinde doğrudan dokunabilir, sürükleyebilir, döndürebilir ve Home'a basabilirsiniz. Aynı fiiller USB ile bağlı gerçek bir iPhone'da da çalışır: eklenti telefonda WebDriverAgent'ı derleyip başlatır, kontrol ve ekran bağlantı noktalarını loopback üzerinden tüneller ve cihazı aynı panele, kartlara ve araçlara akıtır. Görüntü bloğu yok, ekran kaydı dosyası yok: görsel baytlar arayüze yalnızca DSH web sunucusunun sunduğu imzalı, süresi dolan URL'ler üzerinden ulaşır.

| | |
| --- | --- |
| 🖥️ **Sohbetin içinde canlı simülatör** | Başlatılmış cihazın serve-sim MJPEG akışı, imzalı `/_dsh/dsh-ios/*` rotaları üzerinden kalıcı sağ panele vekillenir — tarayıcı serve-sim'in bağlantı noktasına asla dokunmaz. |
| 📱 **USB üzerinden gerçek iPhone** | `ios_real_start_wda` bağlı telefonda WebDriverAgent'ı derleyip başlatır ve kontrol (REST) ile ekran (MJPEG) bağlantı noktalarını loopback üzerinden tüneller; ardından aynı panel, araçlar, kartlar ve durum kapsülü telefonu yönetir. Cihazın kilidi açık olmalıdır ve gerçek hesaptaki her dokunuş eklentinin “önce tanı, sonra dokun” kurallarıyla korunur. |
| 🛠️ **22 ajan aracı** | Cihazlar, başlatma/kapatma, ekran görüntüsü, etkileşim, derleme ve çalıştırma, birleşik günlükler, AXe destekli UI ağacı ve öğeye dokunma, liste/akış satırı eylemleri, Vision OCR bul/dokun, SwiftUI önizleme sıcak yeniden yükleme, süreçler, backtrace, bellek sızıntıları, uygulama bilgisi. |
| 👆 **Etkileşimli panel** | Canlı videoda dokunun ve sürükleyin; üzerine gelince araç ipuçlu Home / döndür / ekran görüntüsü / yenile simge çubuğu; boyut modları (适应 · 50–125% · S/M/L); çerçeve stilleri (无框 / 边框 / 真机框); çift tıklamayla sıfırlamalı, 960 px'e kadar sürükleyerek yeniden boyutlandırma; yatayda otomatik genişleme. |
| 🧾 **Liste ve akış satırları** | `ios_sim_ui_rows` derin erişilebilirlik anlık görüntülerini etiketli ve genel olarak ayrıştırılmış sayaçlı, dizinli satırlara dönüştürür; `ios_sim_tap_row` satırın içinde göreli koordinatlarda dokunur ve eylemi sayacın beklenen ±1 değişimiyle doğrular — bir liste uygulamasının sunduğu tek güvenilir onay budur. |
| 🔐 **Yalnızca loopback taşıma** | serve-sim ayrılmış bir bağlantı noktası aralığında 127.0.0.1'e bağlanır; her rota bir loopback eşi, loopback `Host` ve Fetch-Metadata/Origin denetimleri ister; HMAC yeteneklerinin süresi 10 dakika içinde dolar.. |
| ⚡ **SwiftUI önizleme sıcak yeniden yükleme** | `ios_sim_preview` paketinizin dışında tek kullanımlık bir ana uygulama üretir, önizlemelerinizi dylib olarak derler ve düzenlemeleri yeniden başlatmadan çalışan simülatöre sıcak değişimle uygular (~2–5 sn). |
| 🧭 **Anlamsal UI otomasyonu** | `ios_sim_ui_tree` erişilebilirlik ağacını (AXe destekli) döker ve `ios_sim_tap_element` etikete veya tanımlayıcıya göre dokunur; ağaç boş veya bozulmuşken `ios_sim_find_text` ekranı OCR'lar ve `ios_sim_tap_text` eşleşen metne dokunur — tahmin edilen koordinatlar yerine kimlik ve metin tabanlı dokunuşlar. |

## Araçlar

22 aracın tamamı her ana makinede kayıtlıdır ve yalnızca düz JSON döndürür — görsel baytlar arayüze yalnızca `presentationMeta` + imzalı rotalar üzerinden ulaşır, asla görüntü bloğu olarak dönmez. Simülatör udid'leri simctl/serve-sim üzerinden, fiziksel cihaz udid'leri otomatik olarak WebDriverAgent üzerinden yönlenir. macOS olmayan ana makinelerde (veya serve-sim çözümlenemediğinde) araçlar kayıtlı kalır ama açıklayıcı bir hatayla başarısız olur; tek istisna `ios_sim_preview` `status`'udur ve her ana makinede dürüstçe `{ running: false }` bildirir.

### Temel simülatör araçları

| Araç | Ne yapar | Temel parametreler |
| --- | --- | --- |
| `ios_sim_devices` | Bu Mac'te bulunan iOS simülatörü cihazlarını (udid, ad, çalışma zamanı, durum) ve hangilerinin başlatıldığını listeler; ayrıca USB ile bağlı fiziksel iPhone'ları `realDevices` altında (udid, ad, osVersion, model, state, developerMode) gösterir. Diğer araçlara aktarılacak udid'i veya adı keşfetmek için önce bunu kullanın. | — |
| `ios_sim_boot` | Bir cihazı başlatır ve canlı serve-sim akışını başlatır; akış sohbet boyunca canlı kalır, böylece panel simülatörü canlı gösterebilir. | `udid` (zorunlu — udid veya cihaz adı) |
| `ios_sim_shutdown` | Bir cihazı kapatır; akış o cihazı hedefliyorsa akışı da durdurur. | `udid` (zorunlu) |
| `ios_sim_screenshot` | Bir PNG yakalar ve kısa bir JSON özeti döndürür (yol, bayt, boyutlar, cihaz); görüntü kartta/panelde işlenir, asla görüntü bloğu olarak dönmez. Akıştaki simülatörde ve USB ile bağlı telefonda (WebDriverAgent üzerinden) çalışır. | `udid` (isteğe bağlı — akıştaki cihaz, yoksa ilk başlatılmış simülatör) |
| `ios_sim_interact` | Akıştaki cihazla etkileşir — simülatör veya USB telefon: 0..1 normalleştirilmiş koordinatlarda dokunma, metin yazma (simülatörde ABD klavyesi), donanım düğmesine basma (`home`, `lock`, `volumeUp`…), kaydırma veya dokunma hareketi gönderme; eylem yerleştikten sonra (~300 ms) taze bir ekran görüntüsü etkiyi gösterir. | `action` (zorunlu — `tap`/`type`/`button`/`gesture`/`scroll`), `x`/`y`, `text`, `name`, `json` |
| `ios_sim_list_apps` | Başlatılmış bir simülatörde veya bağlı telefonda KURULU uygulamaları listeler (bundle id, görünen ad, sürüm, sistem bayrağı) — üçüncü taraf bir bundle id tahmin edilemez; bu yüzden önce listeleyin veya `ios_sim_launch_app`'e `name` verin. BAŞARISIZ bir listeleme boş liste döndürmek yerine hata fırlatır (ör. “cihaza CoreDevice üzerinden erişilemiyor”), bu yüzden `count: 0` her zaman cihazda gerçekten eşleşen uygulama olmadığı anlamına gelir. | `udid` (isteğe bağlı), `query` (görünen ad VE bundle id üzerinde büyük/küçük harfe duyarsız alt dize, CJK dahil), `include_system` (varsayılan false) |
| `ios_sim_launch_app` | Başlatılmış simülatörde veya bağlı telefonda kurulu bir uygulamayı başlatır — `bundleId` ile veya `name` ile (aynı listelemeyle çözümlenen, görünen ada büyük/küçük harfe duyarsız alt dize, CJK dahil). İkisinden tam olarak biri; başlatma hatası ve belirsiz ad, ikisi de sonra ne yapılacağını söyleyerek döner (kaynaktan derlemek için `ios_sim_build_run`). | `bundleId` veya `name` (tam olarak biri), `udid`, `relaunch` |
| `ios_sim_build_run` | Simülatör için bir `.xcodeproj`, `.xcworkspace` veya Swift paketi derler, üretilen `.app`'i kurar ve başlatır; fiziksel cihaz udid'i verirseniz bunun yerine telefonda derler, kurar ve başlatır (Apple Development imzası gerekir). Başarısızlıkta sonuç, filtrelenmiş `xcodebuild` hata kuyruğunu içerir. Tam derleme dakikalar sürer. | `projectPath` (zorunlu), `scheme`, `udid` (akıştaki → başlatılmış → en yeni çalışma zamanlı iPhone; başlatılır), `configuration` (varsayılan `Debug`) |
| `ios_real_start_wda` | USB ile bağlı fiziksel iPhone'da WebDriverAgent'ı (WDA) başlatır — yalnızca gerçek cihazlar, asla simülatör. Yanıt veren çalışan bir WDA varsa onu devralır; yoksa `xcodebuild` derleme/başlatma çalıştırır (soğuk derleme dakikalar sürer), ardından WDA hazır olduğunu bildirene kadar bekler ve canlı panelin kullandığı kontrol/MJPEG bağlantı noktalarını döndürür. `ios_sim_screenshot` / `ios_sim_interact` / `ios_sim_ui_tree` / `ios_sim_tap_element` cihaz için WDA'nın çalışmadığını bildirdiğinde önce bunu çalıştırın. | `udid` (zorunlu — `ios_sim_devices.realDevices`'tan fiziksel cihaz udid'i) |

### UI ağacı araçları (AXe destekli)

| Araç | Ne yapar | Temel parametreler |
| --- | --- | --- |
| `ios_sim_ui_tree` | En öndeki uygulamanın erişilebilirlik öğe ağacını (etiketler, tanımlayıcılar, değerler, cihaz noktası cinsinden çerçeveler) ve ekran boyutunu (nokta cinsinden) döker — simülatörde AXe, USB telefonda WebDriverAgent (orada derinlik varsayılan olarak sınırlıdır: yoğun bir uygulamanın sınırsız anlık görüntüsü ~32 sn / 751 KB, sınırlı ~2 sn sürer); çıktı ~40 KB ile sınırlıdır (en derin seviyeler budanır, `truncated` + ipucu ayarlanır). | `udid` (isteğe bağlı), `max_depth`, `filter` (etiket/tanımlayıcı/tür üzerinde büyük/küçük harfe duyarsız alt dize) |
| `ios_sim_tap_element` | Bir öğeye kimliğine göre dokunur — önce tam eşleşme, sonra `identifier`/`label` üzerinde büyük/küçük harfe duyarsız alt dize; iç içe yinelemeler tek hedefe indirgenir, belirsiz eşleşmeler her adayı listeler. Dokunuş öğenin merkezine iner (simülatörde AXe HID, telefonda WebDriverAgent) ve ~300 ms sonra ekran görüntüsü etkiyi gösterir; `expect_text` / `expect_gone` verirseniz dokunuş ve doğrulaması tek gidiş-dönüş olur (`expected.matched`). | `udid` (isteğe bağlı), `identifier`, `label`, `expect_text`, `expect_gone` |

### Liste &amp; akış satırları

Liste/akış uygulamaları her öğeyi, etiketi tüm özeti ve tüm sayaçları taşıyan tek bir erişilebilirlik hücresinde toplar (“57 回复。18 喜欢。592 次查看”) — eşleşecek denetim başına alt düğme yoktur ve satır hücreleri yalnızca derin bir anlık görüntüde ortaya çıkar. Bu iki araç o yapıyı satırlar olarak açar ve satırın içinde işlem yapar.

| Araç | Ne yapar | Temel parametreler |
| --- | --- | --- |
| `ios_sim_ui_rows` | En öndeki uygulamanın görünür liste/akış satırlarını ham ağaç yerine satırlar olarak okur: her satır dizinini, nokta cinsinden çerçevesini, toplanmış etiketi ve o etiketten ayrıştırılmış sayaçları bildirir (sayı + sınıflandırıcı belirteç, ör. `57 回复` → 回复=57, Çince veya İngilizce — hiçbir uygulama sözlüğü kodlanmamıştır). Satırlar yalnızca derin bir anlık görüntüde ortaya çıkar: telefonda varsayılan `max_depth` 60'tır ve her çağrı ~15–25 sn / ~0.5 MB tutar (WDA istekleri seri işler) — önce ucuz gözlemcileri deneyin (`ios_sim_find_text` / `ios_sim_ui_tree`). Sayaçlar sezgisel olarak ayrıştırılır ve anahtarlar gidiş-dönüş yapar: `ios_sim_tap_row.expect_count`'a anahtarı tam listede göründüğü gibi verin. Satır bulunamadığında sonuç nedenini söyler (derinlik çok sığ / liste ekranı değil / derin okumadan sonra gerçekten erişilebilirlik bilgisi yok) — sığ bir okuma asla “uygulamanın erişilebilirlik bilgisi yok” diye bildirilmez; ekran dışı satırlar dışlanır ve `omittedOffscreen` sayılır. | `udid` (isteğe bağlı), `max_depth` (yalnızca telefon; varsayılan 60) |
| `ios_sim_tap_row` | Görünür bir liste satırının içinde göreli konumda dokunur (`ios_sim_ui_rows`'un bildirdiği satır: 0 tabanlı dizin; x/y o satırın çerçevesinin kesirleri — 0 = sol/üst kenar, 1 = sağ/alt, varsayılan 0.5 = merkez) simülatörde (AXe) veya USB telefonda (WebDriverAgent). Satır çerçevesi TAZE bir ağaç okumasından gelir, bu yüzden mutlak ekran koordinatı tahmin edilmez; aralık dışı dizin BAŞARISIZ olur (asla kırpılmaz). Güvenlik kapısı: `expect_count={key,delta}` ile araç, satır etiketini yeniden okuyup sayacın tam olarak +1/−1 değiştiğini doğrulayarak eylemi onaylar (`countCheck.verified`); anahtar satırın ayrıştırılmış sayaçları arasında yoksa dokunuş gerçekleşmeden REDDEDİLİR — gerçek cihazda dokunuş asla bir sondalama değildir. `expect_count` olmadan dokunuş yine de gerçekleşir (satıra göreli açık konum ZATEN tanımlamadır) ama hiçbir şey doğrulanmaz. | `udid` (isteğe bağlı), `index` (zorunlu), `x`, `y` (0..1 kesirler), `max_depth`, `expect_count` (`{key, delta}`) |

### OCR araçları (Vision)

| Araç | Ne yapar | Temel parametreler |
| --- | --- | --- |
| `ios_sim_find_text` | Başlatılmış bir simülatörün veya USB telefonun GEÇERLİ ekranını, eklentinin derlediği Vision yardımcısıyla OCR'lar (isabetli tanıma, zh-Hans + en-US, ilk kullanımda `swiftc` ile `~/Library/Caches/dsh-ios/bin/ocr` içine derlenir). Erişilebilirlik ağacı boş veya bozulmuşken, grafik olarak çizilen metinler için (rozet sayıları, görsellere gömülü fiyatlar) veya ekrandakini bağımsızca doğrulamak için kullanın. Taze bir ekran görüntüsü alıp `{device, size, items:[{text, confidence, rect}]}` döndürür — rect'ler cihaz noktası kutularıdır (başlangıç sol üstte), güvene göre sıralı, çıktı ~40 KB ile sınırlı (`truncated` en düşük güvenli kuyruğu düşürür; `query` ile daraltın veya `min_confidence`'ı yükseltin). | `udid` (isteğe bağlı), `query` (büyük/küçük harfe duyarsız alt dize), `min_confidence` (varsayılan 0.3) |
| `ios_sim_tap_text` | GEÇERLİ ekranı OCR'lar ve en iyi metin eşleşmesinin merkezine dokunur — `ios_sim_tap_element` ile aynı tam → büyük/küçük harfe duyarsız içerme → aday listesi belirsizlik kuralları, erişilebilirlik ağacının göremediği metinler için (a11y'siz uygulamalar, rozet sayıları, görsellere gömülü metinler). Telefonda dokunuş WebDriverAgent üzerinden mutlak cihaz noktalarına iner; akıştaki simülatörde serve-sim kontrolü üzerinden normalleştirilmiş olarak gönderilir (önce `ios_sim_boot` çalıştırın). ~300 ms sonra taze ekran görüntüsü etkiyi gösterir; `expect_text` / `expect_gone` verirseniz dokunuş ve doğrulaması tek gidiş-dönüş olur (`expected.matched`). GERÇEK cihazda her dokunuşun gerçek sonuçları vardır — ne yaptığını öğrenmek için tanınmayan bir denetime asla dokunmayın. | `udid` (isteğe bağlı), `query` (zorunlu), `min_confidence`, `expect_text`, `expect_gone` |
| `ios_sim_wait_for` | Bir metnin ekranda belirmesini veya kaybolmasını bekler; koşul sağlanana ya da süre dolana kadar (varsayılan 8 sn, en çok 60 sn) `ios_sim_find_text` ile aynı yakalama+OCR hattını yoklar. Zaman aşımı normal bir `matched:false` yanıtıdır, asla hata değildir — gerçek iPhone’da tur başına ~1,2 sn süren elle find_text döngüsü yerine tek bir çağrı. Eşleşmede `item`, OCR metnini, güven değerini ve cihaz noktalarındaki dikdörtgeni taşır. | `udid` (isteğe bağlı), `text` (zorunlu), `mode` (`appear`/`disappear`), `timeout_ms`, `min_confidence` |

### Günlük aracı

| Araç | Ne yapar | Temel parametreler |
| --- | --- | --- |
| `ios_sim_logs` | Simülatör uygulamasının yazdırdıklarını cihazın birleşik günlüğünden okur: `snapshot` (`log show --last <duration>`, varsayılan 2m) veya `follow` (`duration_seconds` kadar sınırlı canlı yakalama, varsayılan 10, en çok 60 — asla asılı kalan bir akış değil). Çıktı ~300 satır / 30 KB ile sınırlıdır ve daraltma ipucu içerir. | `udid` (isteğe bağlı), `mode` (`snapshot`/`follow`), `duration`, `duration_seconds`, `bundle_id`, `predicate` (ham NSPredicate, `bundle_id`'yi geçersiz kılar), `level` (`default`/`info`/`debug`), `grep` |

### Önizleme aracı

| Araç | Ne yapar | Temel parametreler |
| --- | --- | --- |
| `ios_sim_preview` | Simülatörde canlı SwiftUI önizleme sıcak yeniden yükleme: `start` (varsayılan) paketi doğrular, eklenti önbelleğinde tek kullanımlık bir ana uygulama üretir (asla paketinizin içinde değil), paketi simülatör için dylib olarak derler, ana uygulamayı kurup başlatır ve kaynakları izler — her düzenleme yeniden derlenir ve yeniden başlatmadan sıcak değişimle uygulanır (~2–5 sn). Derleyici hataları son iyi önizlemeyi korur ve `status` üzerinden görünür; aynı anda tek oturum. | `packagePath` (`start` için zorunlu), `udid`, `action` (`start`/`status`/`stop`), `previewFilter` (önizleme adları üzerinde büyük/küçük harfe duyarsız alt dize) |

### Hata ayıklama araçları

| Araç | Ne yapar | Temel parametreler |
| --- | --- | --- |
| `ios_sim_processes` | Bir simülatörün çalışan uygulama süreçlerini kendi launchd'sinden listeler (ana makineden görünen pid, ad, bundle id) — backtrace/sızıntılar için pid kaynağıdır; fiziksel cihaz udid'i verilirse onun yerine devicectl üzerinden telefonun süreçlerini listeler. | `udid` (isteğe bağlı), `filter` (ad/bundle id üzerinde büyük/küçük harfe duyarsız alt dize) |
| `ios_sim_backtrace` | Tek atımlık toplu LLDB (bağlan → iş parçacığı backtrace'i → ayrıl, asla etkileşimli değil); çıktı ~200 satırla sınırlı, ana iş parçacığı önce, hedef her zaman sürdürüldüğü doğrulanmış. macOS bağlanmayı reddettiğinde (Geliştirici Modu kapalı), Xcode'un `sample` motoruna (askıya almayan) düşer ve etkinleştirme ipucunu bildirir. Yalnızca simülatörler — fiziksel cihazlar nedeniyle birlikte reddedilir. | `udid` (isteğe bağlı), `pid` / `bundle_id`, `all_threads` (varsayılan true) |
| `ios_sim_leaks` | Xcode'un `leaks` aracıyla sızıntı analizi yapar: `summary` (sızıntı sayısı, toplam sızan bayt, ilk ~30 tür) veya `memgraph` (Xcode Instruments'ta açılacak bir `.memgraph` çıktısı, burada asla ayrıştırılmaz). Tarama sırasında uygulama askıya alınır ve her zaman sürdürülür. Yalnızca simülatörler. | `udid` (isteğe bağlı), `pid` / `bundle_id`, `mode` (`summary`/`memgraph`) |
| `ios_sim_app_info` | Kurulu uygulamanın bilgileri: uygulama paket yolu, yazılabilir veri kabı ve Info.plist değerleri — simülatörde `simctl appinfo` (ile birlikte `get_app_container` yedeği), USB telefonda `devicectl` üzerinden; eksik uygulamalar için `installed: false` ve `ios_sim_list_apps`'i işaret eden bir `note`. | `udid` (isteğe bağlı), `bundle_id` (zorunlu) |

## Görüntüleme yüzeyleri

- **Kenar çubuğu paneli — “iOS 模拟器”.** Canlı görünüm kalıcı bir sağ panelde yaşar (sohbeti kenara iten sabit bir dock veya dar görünüm alanlarında ortalanmış bir kaplama). Canlı MJPEG akışını işler ve video üzerinde doğrudan tıkla-dokun ile sürükle-hareket kabul eder; düğmeleri üzerine gelince araç ipucu taşıyan bir simge çubuğu (Home, ekran görüntüsü, döndür, yenile) vardır. Boyut denetimleri **适应** (panel genişliğine sığdır), cihazın mantıksal genişliğinin **50–125%** yakınlaştırması ve cihazın kısa kenarını ölçen **S / M / L** hazır ayarları sunar (dikey genişlik; yatayda cihaz fiziksel boyutunu koruyacak şekilde ölçeklenir). Çerçeve stilleri **无框 / 边框 / 真机框** (çerçevesiz / kenarlık / gerçekçi cihaz gövdesi) ve orantılı köşe yarıçapıdır. Cihaz yataya döndüğünde panel otomatik olarak rahat bir boyuta genişler ve geri döndüğünde genişliğinizi geri getirir — bu sırada yapılan elle sürükleme her zaman kazanır. Sol kenardaki tutamaç paneli daha geniş/dar çeker (en çok 960 px; çift tıklama varsayılan genişliğe sıfırlar). USB ile bağlı bir iPhone akış hedefi olduğunda aynı panel telefonun WebDriverAgent MJPEG akışını aynı denetimlerle gösterir.
- **Kompakt sohbet kartları.** Araç sonuçları satır içi görsel olmadan tek satırlık kartlar olarak işlenir: birleşik **“iOS 模拟器”** başlığı, bir eylem alt etiketi (Başlat / Ekran görüntüsü / Etkileşim / Derle ve Çalıştır / WebDriverAgent'ı Başlat), cihaz adı, durum rozeti ve “kenar çubuğunda aç” ipucu. Satıra tıklamak paneli açar; düğmelere, bağlantılara veya canlı çerçevenin kendisine tıklamak asla tetiklemez.
- **Girişin üstünde durum kapsülü.** Panel kapalıyken ve bir akış çevrimiçiyken, besteleyicinin üstünde küçük yeşil noktalı bir hap (`<device>` · 实时) belirir ve tıklanınca paneli açar. Oturumla sınırlıdır: yalnızca geçerli sohbette simülatör sonuçları bağlıyken işlenir ve yoklar; onlarsız bir oturuma geçince durur.
- **Standart mod ve Code Modu.** Standart oturumlar ana makinenin yansıttığı `presentationMeta`'yı kullanır. İç içe Code Modu (PTC) gönderimleri asla meta taşımaz, bu yüzden istemci kalıcı sonuç JSON'undan aynı meta'yı yeniden kurar — panel, kartlar ve kapsül her iki modda da çalışır.

## Güvenlik

- Tarayıcı asla serve-sim'in bağlantı noktasıyla konuşmaz. Her bayt, DSH web sunucusu kaynağından eklentiye ait `/_dsh/dsh-ios/*` rotaları üzerinden geçer: `/stream/<token>` (MJPEG vekili), `/screenshot/<token>` (önbellekli PNG), `/ws?token=…` (HID kontrol aktarıcısı), ayrıca `/grant`, `/capture` ve `/status` uç noktaları.
- Belirteçler, süresi 10 dakika içinde dolan ve her DSH evine özel bir anahtarla imzalanan HMAC-SHA256 yetenekleridir (`base64url(payload).base64url(mac)`; anahtar: `<DSH_HOME>/cache/dsh-ios/stream-access.key`, 0600, atomik oluşturulur).
- Her rota, herhangi bir yetenek denetlenmeden önce bir loopback/güvenilir taşıma çiti uygular: loopback eş adresi, loopback `Host` (DNS yeniden bağlama reddedilir) ve Fetch-Metadata/Origin denetimleri. Ekran görüntüsü rotası yalnızca eklenti önbellek dizinindeki dosyaları sunar (sembolik bağlantılar reddedilir, `realpath` kapsamı).
- serve-sim yalnızca loopback üzerinde, ayrılmış bir bağlantı noktası aralığında (3181–3244) ön plan alt süreci olarak çalışır, böylece kullanıcının 3100 numaralı bağlantı noktasındaki kendi serve-sim'ine asla dokunulmaz; `--host` asla kullanılmaz..
- **Yetim evlat edinme/geri alma** — önceki bir DSH ana makinesi zarif olmayan şekilde öldürüldüyse ve serve-sim yardımcısı hayatta kaldıysa, aynı cihaz evlat edinilir (yetimin el sıkışması yetkilidir); farklı bir cihazın yuvasına çöreklenmiş eski bir yardımcı `serve-sim -k` ile geri alınır ve bir kez yeniden başlatılır.
- **Keep-alive + boşta durdurma** — çöken bir akış arka planda yeniden başlar (~5 sn gecikme); sıfır tüketiciyle akış 5 dakika sonra otomatik durur. Kasıtlı durdurmalar asla engellenmez. (Gerçek cihaz çalıştırıcısı bilinçli olarak boşta toplamadan muaftır: onu yeniden başlatmak dakikalar süren bir `xcodebuild` yeniden derlemesine mal olur.)

## Gereksinimler

- **Tam Xcode'lu macOS** — yalnızca Command Line Tools yetmez. `xcodebuild`, `xcrun simctl` ve simülatör çalışma zamanlarının tümü Xcode ile gelir.
- **Xcode'da en az bir iOS simülatörü çalışma zamanı** kurulu olmalı.
- **Panel için DSH ≥ 0.1.0-rc.6 ve web paketi**. Başsız (headless) profiller de çalışır: 22 aracın tümü normal çalışır, yalnızca canlı görünüm olmaz.
- **macOS olmayan ana makineler**: eklenti yüklenir ve 22 aracın tümü kaydolur, ama her çağrı açıklayıcı bir hata döndürür (`iOS Simulator requires macOS with Xcode …`).
- **serve-sim** bu eklentinin npm bağımlılığı olarak gelir, bu yüzden gerçek kurulumlarda yerel olarak çözümlenir; `npx -y serve-sim` yedeği geliştirme ağaçlarını kapsar (ilk kullanım ağ gerektirir).
- **AXe** (isteğe bağlı — yalnızca AXe destekli araçlar gerektirir: `ios_sim_ui_tree` / `ios_sim_tap_element`, ayrıca simülatörde `ios_sim_ui_rows` / `ios_sim_tap_row`): `brew install cameroncooke/axe/axe`, veya eklentinin sabitlenmiş sürümü (v1.8.0, SHA-256 doğrulamalı) `~/Library/Caches/dsh-ios/bin` içine otomatik indirmesine izin verin. `DSH_IOS_AXE_BIN` çözümlemeyi geçersiz kılar; `DSH_IOS_AXE_OFFLINE=1` indirmeyi devre dışı bırakır.
- **Vision OCR** (isteğe bağlı — yalnızca `ios_sim_find_text` / `ios_sim_tap_text` gerektirir): eklenti ilk kullanımda paketli `assets/ocr.swift` dosyasını `swiftc` ile `~/Library/Caches/dsh-ios/bin/ocr` içine derler (zh-Hans + en-US tanıma).
- **lldb bağlanması macOS Geliştirici Modu gerektirir**: bir kez `sudo DevToolsSecurity -enable` çalıştırın. O zamana kadar `ios_sim_backtrace` Xcode'un `sample` motorunu (askıya almayan) kullanır ve `ios_sim_leaks` etkinleştirme ipucuyla düşer.. İlk WDA derlemesi imzalı bir WebDriverAgentRunner kurar: istendiğinde cihazda sertifikasına güvenin ve ücretsiz ekip imzalama profili dolduğunda (7 günlük ömür) `ios_real_start_wda`'yı yeniden çalıştırın.

## DSH'ye Kurulum

```sh
dsh plugin --profile web add @zseven-w/dsh-ios@latest
dsh web
```

## Hızlı başlangıç

Tipik bir ilk sohbet:

1. **Cihazları keşfedin** — “Kullanılabilir simülatörleri listele.” → `ios_sim_devices`.
2. **Başlatın** — “iPhone 17 Pro'yu başlat.” → `ios_sim_boot`. Akış başlar ve **“iOS 模拟器” paneli** açılır: cihaz kenar çubuğunda canlıdır. (Yeniden açmak için herhangi bir simülatör kartı satırına veya girişin üstündeki durum hapına tıklayın.)
3. **Videoda dokunun** — panelde doğrudan dokunun veya sürükleyin; veya ajanın arayüzü yönetmesine izin verin: “Ayarlar'ı aç, sonra General'e dokun.” → `ios_sim_interact` (kimlik tabanlı dokunuşlar için `ios_sim_ui_tree` + `ios_sim_tap_element`; metin tabanlı dokunuşlar için `ios_sim_find_text` + `ios_sim_tap_text`; liste/akış uygulamaları için `ios_sim_ui_rows` + `ios_sim_tap_row`).
4. **Uygulamanızı derleyip çalıştırın** — “/path/to/MyApp.xcodeproj'u derleyip çalıştır.” → `ios_sim_build_run`. Tam derleme dakikalar sürer; tamamlandığında uygulama simülatörde başlar ve onu panelde canlı izlersiniz.
5. **Önizleme sıcak yeniden yükleme** — “/path/to/MyPackage'ın SwiftUI önizlemelerini göster.” → `ios_sim_preview start`. Bir kaynak dosyayı düzenleyin; önizleme çalışan simülatöre ~2–5 sn içinde sıcak değişimle uygulanır — yeniden başlatma yok.
6. **Gerçek bir iPhone'u yönetin** — telefonu USB (veri kablosu) ile bağlayın, kilidini açın, sonra “Telefonda WebDriverAgent'ı başlat.” → `ios_real_start_wda`. Panel telefonun canlı akışına geçer ve her araç onun `realDevices` udid'ini kabul eder; bir çağrı başarısız olduğunda panelin durumundaki kodlu nedeni okuyun (`device-locked`, `cert-untrusted`, `profile-expired`, `tunnel-failed`, `device-unplugged`).

## Sorun giderme

- **Backtrace lldb yerine `sample` kullanıyor veya leaks kısıtlı incelemeden şikâyet ediyor** — macOS Geliştirici Modu kapalı. Bir kez `sudo DevToolsSecurity -enable` çalıştırıp yeniden deneyin. O zamana kadar araçlar temiz şekilde düşer: `ios_sim_backtrace` Xcode'un `sample`'ına (sembolleştirilmiş, askıya almayan) geçer ve `ios_sim_leaks` etkinleştirme ipucunu bildirir.
- **`ios_sim_ui_tree` / `ios_sim_tap_element` AXe gerektirir** — `brew install cameroncooke/axe/axe` ile kurun veya eklentinin ilk kullanımda sabitlenmiş sürümü indirmesine izin verin (github.com'a ağ gerekir). Hata mesajı her zaman tam kurulum ipucunu içerir; `DSH_IOS_AXE_BIN=/path/to/axe` çözümlemeyi geçersiz kılar. Satır araçları (`ios_sim_ui_rows` / `ios_sim_tap_row`) simülatörde de AXe gerektirir.
- **`ios_sim_find_text` / `ios_sim_tap_text` OCR yardımcısının eksik olduğunu bildiriyor** — ilk kullanım `swiftc` (Xcode gerekir) ile paketli `assets/ocr.swift` dosyasını `~/Library/Caches/dsh-ios/bin/ocr` içine derler; hata tam yolu ve ipucunu içerir.
- **`ios_sim_ui_rows` satır bulamıyor** — sonuç nedenini söyler: derinlik çok sığ (`max_depth`'i artırın; telefonda her derin anlık görüntü ~15–25 sn tutar), liste ekranı değil, veya derin okumadan sonra gerçekten erişilebilirlik bilgisi yok. Sığ bir okuma asla “erişilebilirlik eksik” diye yanlış bildirilmez.
- **iOS 26.2 simülatörlerinde `ios_sim_leaks`** — iOS 26.2 çalışma zamanlarında, Geliştirici Modu açık olsa bile Xcode'un `leaks` aracı simülatör süreçlerini inceleyemeyip `Failed to get DYLD info` veya minimal-corpse gibi ölümcül tanılarla başarısız olabilir. Araç temiz şekilde düşer: ham tanıyı alırsınız, hedef her zaman sürdürüldüğü doğrulanır ve hiçbir şey asılı kalmaz. Eklenti tarafında çözüm yok — bu olduğunda `mode: "memgraph"` veya farklı bir çalışma zamanı deneyin..
- **Akış kendiliğinden duruyor** — bu boşta politikasıdır, çökme değil: sıfır tüketiciyle (panel kapalı, bağlı kart yok, etkin rota yok) akış 5 dakika sonra durur ve bir sonraki araç çağrısında veya panel açılışında yeniden başlar. Çöken bir akış ~5 saniye içinde arka planda yeniden başlar.

## Geliştirme

```sh
pnpm install
pnpm run build      # ana makine tsc + istemci paketi → lib/
pnpm run typecheck
```

`scripts/` altındaki duman testleri derlenmiş `lib/` çıktısını sınar (simülatör başlatan veya USB telefonla konuşan bölümler yalnızca macOS; o bölümleri atlamak için `DSH_IOS_SMOKE_SKIP_SIM=1` ayarlayın):

| Betik | Neyi kapsar |
| --- | --- |
| `node scripts/dev-smoke.mjs` | Sim ana makinesi: ikili çözümleme, akış başlatma, kontrol, keep-alive, dispose. |
| `node scripts/dev-tools-smoke.mjs [--full-build]` | Gerçek bir simülatöre karşı temel araçlar (ayrıca `--full-build` ile gerçek derleme). |
| `node scripts/dev-routes-smoke.mjs` | İmzalı web rotaları: grant, akış vekili, ekran görüntüsü, ws aktarıcısı, çitler, süre dolumu. |
| `node scripts/dev-card-smoke.mjs` | İstemci kartları: statik SSR (`<img>` yok), status/capture sözleşmesi, canlıya yakın ağ bölümü. |
| `node scripts/dev-panel-smoke.mjs` | Panel bileşenleri, boyut modları, çerçeve stilleri, dock/tetikleyici/kapsül mantığı (yalnızca statik). |
| `node scripts/dev-logs-smoke.mjs` | `ios_sim_logs` snapshot/follow, filtreler, sınırlar, süreç toplama. |
| `node scripts/dev-uitree-smoke.mjs` | UI ağacı araçları: AXe çözümleme/indirme hattı, seçiciler, gerçek simülatörde ağaç ve dokunuş. |
| `node scripts/dev-debug-smoke.mjs` | Hata ayıklama araçları: süreçler, backtrace (lldb + sample), sızıntılar, uygulama bilgisi. |
| `node scripts/dev-preview-smoke.mjs` | Önizleme sıcak yeniden yükleme: başlatma, düzenleme → yeniden başlatmadan sıcak değişim, hata kurtarma, durdurma. |
| `node scripts/dev-orphan-smoke.mjs` | Zarif olmayan ana makine ölümünden sonra yetim serve-sim'in evlat edinilmesi/geri alınması. |
| `node scripts/dev-ocr-smoke.mjs` | Vision-OCR araçları: yardımcı çözümleme, swiftc derleme önbelleği, tanıma hattı, tap-text yönlendirmesi. |
| `node scripts/dev-wda-smoke.mjs` | WebDriverAgent ana makinesi: `ServerURLHere` ayrıştırma, hata sınıflandırma, tüneller, keep-alive (sahte; isteğe bağlı canlı geçiş). |
| `node scripts/dev-realdevice-smoke.mjs` | USB ile bağlı iPhone'a karşı `xcrun devicectl` — araçların kullandığı birebir kod yolları. |
| `node scripts/dev-realstart-smoke.mjs` | `/real-start` rotası: çit, kodlu reddetmeler, derleme/başlatma kapısı (statik). |
| `node scripts/dev-realtools-smoke.mjs` | `ios_sim_screenshot` / `ios_sim_interact` / `ios_sim_ui_tree` / `ios_sim_tap_element` gerçek cihaz arka uçları ve `ios_real_start_wda`. |

## Ekosistem

- [DSH Crew](https://github.com/ZSeven-W/dsh-crew) — Claude Code / Codex üzerinden DSH ajanlarına iş dağıtın
- [DSH Noema](https://github.com/ZSeven-W/dsh-noema) — DSH için uzun süreli bellek
- [DSH OpenPencil](https://github.com/ZSeven-W/dsh-openpencil) — `.op` tasarım belgelerini sohbet içinde inceleyin ve düzenleyin

## Teşekkürler &amp; lisans

- [serve-sim](https://github.com/EvanBacon/serve-sim) — Evan Bacon — simülatör akış motoru (Apache-2.0; paketli çalışma zamanı bağımlılığı).
- [AXe](https://github.com/cameroncooke/AXe) — Cameron Cooke — UI ağacı araçlarının arkasındaki erişilebilirlik CLI'ı (MIT).
- [WebDriverAgent](https://github.com/appium/WebDriverAgent) — eklentinin gerçek cihazlarda derleyip başlattığı WebDriver sunucusu (BSD lisanslı).
- Mimari, Codex'in “Build iOS Apps” eklentisinden esinlenmiştir; SwiftUI önizleme motoru, kamuya açık belgelenen yaklaşımın temiz oda (clean-room) yeniden gerçeklemesidir — hiçbir Codex kodu kopyalanmamıştır.
- Bildirimlerin tamamı için [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) dosyasına bakın.

**Lisans**: MIT
