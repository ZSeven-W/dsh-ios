<p align="center">
  <img src="./docs/images/dsh-ios-logo.png" alt="DSH iOS" width="120" />
</p>

<h1 align="center">DSH iOS 模擬器</h1>

<p align="center">
  <strong>在 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 對話裡嵌入一台即時、可互動的 iOS 模擬器——USB 連接的真機 iPhone 同樣支援。</strong><br />
  <sub>22 個智慧代理工具 &bull; 側邊欄即時 MJPEG 面板 &bull; 模擬器與 USB 真機 &bull; 清單/資訊流列級操作 &bull; SwiftUI 預覽熱重載</sub>
</p>

<p align="center">
  <sub>npm: <code>@zseven-w/dsh-ios</code> &middot; 目前外掛程式版本：<code>0.1.0-rc.3</code> &middot; 已在 DSH <code>0.1.1-rc.1</code> 驗證</sub>
</p>

<p align="center">
  <a href="./README.md">English</a> &middot; <a href="./README.zh.md">简体中文</a> &middot; <b>繁體中文</b> &middot; <a href="./README.ja.md">日本語</a> &middot; <a href="./README.ko.md">한국어</a> &middot; <a href="./README.fr.md">Français</a> &middot; <a href="./README.es.md">Español</a> &middot; <a href="./README.de.md">Deutsch</a> &middot; <a href="./README.pt.md">Português</a> &middot; <a href="./README.ru.md">Русский</a> &middot; <a href="./README.hi.md">हिन्दी</a> &middot; <a href="./README.tr.md">Türkçe</a> &middot; <a href="./README.th.md">ไทย</a> &middot; <a href="./README.vi.md">Tiếng Việt</a> &middot; <a href="./README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <sub>npm: <code>@zseven-w/dsh-ios</code> &middot; 目前外掛版本: <code>0.1.0-rc.3</code> &middot; 已在 DSH <code>0.1.1-rc.1</code> 驗證</sub>
</p>

<br />

<p align="center">
  <img src="./docs/images/dsh-ios-overview.png" alt="DSH iOS Simulator — a real iPhone inside the conversation" width="100%" />
</p>
<p align="center"><sub>在 DSH 對話中直接操作實機 —— 左側是 Agent 的工具呼叫，右側是即時裝置面板</sub></p>

## 為什麼選擇 DSH iOS 模擬器

DSH iOS 模擬器讓智慧代理在對話裡擁有一台真正的 iOS 模擬器，也讓你親眼看到畫面。智慧代理可以啟動裝置、用 Xcode 專案或 Swift 套件建置並執行 App、按無障礙身份或 OCR 文字驅動介面、讀取統一記錄檔，還能檢查處理程序、呼叫堆疊與記憶體洩漏；與此同時，裝置的即時畫面會渲染在常駐的側邊欄面板裡，你可以在影片上直接點按、拖曳、旋轉、按 Home 鍵。同樣的操作也能作用於 USB 連接的真機 iPhone：外掛程式會在手機上建置並啟動 WebDriverAgent，把控制與畫面連接埠經回送通道轉送，把裝置畫面投進同一套面板、卡片與工具。整個過程不用圖片內容塊，也沒有錄影檔案——視覺資料只會透過 DSH webserver 簽章的限時 URL 進入介面。

| | |
| --- | --- |
| 🖥️ **對話裡的即時模擬器** | 已啟動裝置的 serve-sim MJPEG 畫面，經簽章後的 `/_dsh/dsh-ios/*` 路由代理進常駐的右側面板——瀏覽器永遠不會接觸 serve-sim 的連接埠。 |
| 📱 **USB 真機 iPhone** | `ios_real_start_wda` 在已連接的手機上建置並啟動 WebDriverAgent，把控制（REST）與畫面（MJPEG）連接埠經回送通道轉送；同一套面板、工具、卡片與狀態膠囊即可驅動真機。裝置必須處於解鎖狀態，真機帳號上的每一次點按都受外掛程式的「先識別、再點按」規則約束。 |
| 🛠️ **22 個智慧代理工具** | 裝置清單、啟動/關閉、截圖、互動、建置執行、統一記錄檔、基於 AXe 的 UI 樹與按元素點擊、清單/資訊流列級操作、Vision OCR 找字/點字、SwiftUI 預覽熱重載、處理程序清單、呼叫堆疊、洩漏分析、App 資訊。 |
| 👆 **可互動面板** | 在即時畫面上點按、拖曳；Home / 旋轉 / 截圖 / 重新整理圖示工具列（懸停提示）；尺寸模式（适应 · 50–125% · S/M/L）；外框樣式（无框 / 边框 / 真机框）；拖曳調寬上限 960px、雙擊重設；橫向畫面自動加寬。 |
| 🧾 **清單與資訊流列** | `ios_sim_ui_rows` 把深層無障礙快照轉成帶索引、標籤與通用解析計數器的列；`ios_sim_tap_row` 在列內按相對座標點按，並用計數器符合預期的 ±1 變化驗證操作是否生效——這是清單類 App 唯一可靠的確認方式。 |
| 🔐 **僅回送的傳輸** | serve-sim 只綁定 127.0.0.1 的專屬連接埠段；每條路由都要求回送對端、回送 `Host` 與 Fetch-Metadata/Origin 驗證；HMAC 能力權杖 10 分鐘內過期。。 |
| ⚡ **SwiftUI 預覽熱重載** | `ios_sim_preview` 在套件之外產生一次性宿主 App，把你的預覽編譯成 dylib，編輯後無需重啟即可熱替換進正在執行的模擬器（約 2–5 秒）。 |
| 🧭 **語意化 UI 自動化** | `ios_sim_ui_tree` 匯出無障礙元素樹（基於 AXe），`ios_sim_tap_element` 按標籤或識別碼點擊；當元素樹為空或退化時，`ios_sim_find_text` 直接對螢幕做 OCR，`ios_sim_tap_text` 點擊命中的文字——按身份或按文字點擊，而不是猜座標。 |

## 工具

全部 22 個工具在任何主機上都會註冊，且只回傳純 JSON——視覺資料只透過 `presentationMeta` + 簽章路由進入介面，絕不以圖片塊形式回傳。模擬器 udid 自動走 simctl/serve-sim，真機 udid 自動走 WebDriverAgent。非 macOS 主機（或 serve-sim 無法解析）上工具仍然註冊，但呼叫時會回傳明確的錯誤；唯一的例外是 `ios_sim_preview` 的 `status`，它在任何主機上都會如實回傳 `{ running: false }`。

### 核心模擬器工具

| 工具 | 作用 | 關鍵參數 |
| --- | --- | --- |
| `ios_sim_devices` | 列出這台 Mac 上可用的 iOS 模擬器裝置（udid、名稱、執行時期、狀態）以及哪些已啟動，另外在 `realDevices` 裡列出 USB 連接的真機 iPhone（udid、名稱、osVersion、model、state、developerMode）。先用它發現要傳給其他工具的 udid 或名稱。 | — |
| `ios_sim_boot` | 啟動指定裝置並開始其 serve-sim 即時推流；推流在對話期間保持存活，面板可以即時顯示模擬器。 | `udid`（必填——udid 或裝置名稱） |
| `ios_sim_shutdown` | 關閉指定裝置；若推流目標正是該裝置，則同時停止推流。 | `udid`（必填） |
| `ios_sim_screenshot` | 擷取一張 PNG，回傳簡短的 JSON 摘要（路徑、位元組數、尺寸、裝置）；圖片在卡片/面板中渲染，絕不會以圖片塊形式回傳。正在推流的模擬器與 USB 連接的真機（經 WebDriverAgent）都可以截。 | `udid`（可選——預設取正在推流的裝置，其次取第一個已啟動的模擬器） |
| `ios_sim_interact` | 與正在推流的裝置互動——模擬器或 USB 真機均可：在 0..1 歸一化座標上點按、輸入文字（模擬器為美式鍵盤）、按下硬體按鍵（`home`、`lock`、`volumeUp`…）、捲動或傳送觸控手勢；操作穩定後（約 300 毫秒）附帶一張新截圖展示效果。 | `action`（必填——`tap`/`type`/`button`/`gesture`/`scroll`），`x`/`y`、`text`、`name`、`json` |
| `ios_sim_list_apps` | 列出模擬器或已連接真機上**已安裝**的 App（bundle id、顯示名稱、版本、是否系統 App）——第三方 App 的 bundle id 無法猜測，先列出它，或給 `ios_sim_launch_app` 傳 `name`。列舉失敗會拋錯（例如「裝置目前無法透過 CoreDevice 存取」）而不是回傳空清單，所以 `count: 0` 一定意味著裝置上確實沒有匹配的 App。 | `udid`（可選）、`query`（對顯示名稱與 bundle id 同時做不區分大小寫的子字串匹配，支援中文）、`include_system`（預設 false） |
| `ios_sim_launch_app` | 啟動已安裝的 App（模擬器或已連接真機均可）：既可以傳 `bundleId`，也可以傳 `name`（對顯示名稱做不區分大小寫的子字串匹配，走同一套列舉邏輯，支援中文）。兩者只能給其一；啟動失敗或名稱有歧義時，錯誤裡會直接給出下一步該怎麼做（從原始碼建置請用 `ios_sim_build_run`）。 | `bundleId` 或 `name`（二選一）、`udid`、`relaunch` |
| `ios_sim_build_run` | 為模擬器建置 `.xcodeproj`、`.xcworkspace` 或 Swift 套件，安裝產生的 `.app` 並啟動；真機 udid 則改為在手機上建置、安裝並啟動（需要 Apple Development 簽章）。建置失敗時回傳過濾後的 `xcodebuild` 報錯尾部。完整建置通常需要幾分鐘。 | `projectPath`（必填）、`scheme`、`udid`（推流裝置 → 已啟動裝置 → 最新執行時期 iPhone，會自動啟動）、`configuration`（預設 `Debug`） |
| `ios_real_start_wda` | 在 USB 連接的真機 iPhone 上啟動 WebDriverAgent（WDA）——僅限真機，絕不用於模擬器。若已有 WDA 在回應則直接接管，否則執行 `xcodebuild` 建置/啟動（冷建置可能耗時數分鐘），然後等待 WDA 就緒並回傳即時面板所用的控制/MJPEG 連接埠。當 `ios_sim_screenshot` / `ios_sim_interact` / `ios_sim_ui_tree` / `ios_sim_tap_element` 報告該裝置 WDA 未執行時，先呼叫本工具。 | `udid`（必填——來自 `ios_sim_devices.realDevices` 的真機 udid） |

### UI 樹工具（基於 AXe）

| 工具 | 作用 | 關鍵參數 |
| --- | --- | --- |
| `ios_sim_ui_tree` | 匯出最前方 App 的無障礙元素樹（標籤、識別碼、取值、以點為單位的 frame）以及螢幕尺寸（點）——模擬器走 AXe，USB 真機走 WebDriverAgent（真機預設限制快照深度：繁忙 App 的不限深快照實測約 32 秒 / 751 KB，限深後約 2 秒）；輸出上限約 40 KB（超出時裁掉最深層級，並置 `truncated` + 提示）。 | `udid`（可選）、`max_depth`、`filter`（對標籤/識別碼/類型做不區分大小寫的子字串匹配） |
| `ios_sim_tap_element` | 按身份點擊元素——先精確匹配，再做不區分大小寫的子字串匹配（`identifier`/`label`）；巢狀重複元素摺疊為同一個目標，若有多個不同元素匹配則逐一列出候選。點擊落在元素中心（模擬器走 AXe HID，真機走 WebDriverAgent），隨後約 300 毫秒截一張效果圖；傳 `expect_text` / `expect_gone` 則點擊與驗證合併為一次往返（`expected.matched`）。 | `udid`（可選）、`identifier`、`label`、`expect_text`、`expect_gone` |

### 清單與資訊流列

清單/資訊流類 App 把每條內容聚合進一個無障礙 Cell——標籤裡包含整條摘要與全部計數器（「57 回复。18 喜欢。592 次查看」），沒有可以匹配的逐控制項子按鈕，而且這些列只有在深層快照裡才會出現。下面兩個工具把這種結構暴露為「列」，並在列內操作。

| 工具 | 作用 | 關鍵參數 |
| --- | --- | --- |
| `ios_sim_ui_rows` | 把最前方 App 可見的清單/資訊流列讀成「列」而不是原始樹：每一列包含索引、以點為單位的 frame、聚合標籤，以及從標籤裡通用解析出的計數器（數字 + 分類詞，如 `57 回复` → 回复=57，中文或英文——不內建任何 App 詞彙）。列只有在深層快照裡才出現：真機上預設 `max_depth` 為 60，每次呼叫約 15–25 秒 / ~0.5 MB（WDA 序列處理請求）——先考慮廉價的觀察手段（`ios_sim_find_text` / `ios_sim_ui_tree`）。計數器按啟發式解析、鍵值可原樣回傳：給 `ios_sim_tap_row.expect_count` 傳鍵時務必與清單完全一致。找不到列時結果會說明原因（深度太淺 / 不是清單頁 / 深度讀取後確實沒有無障礙資訊）——淺讀絕不會被報告成「該 App 沒有無障礙資訊」；螢幕外的列會被排除並計入 `omittedOffscreen`。 | `udid`（可選）、`max_depth`（僅真機生效；預設 60） |
| `ios_sim_tap_row` | 在一條可見清單列內按相對位置點按（列由 `ios_sim_ui_rows` 報告：0 基索引；x/y 為該列 frame 的比例——0 = 左/上邊緣，1 = 右/下邊緣，預設 0.5 = 中心），模擬器走 AXe、USB 真機走 WebDriverAgent。列的 frame 來自一次全新的樹讀取，絕不猜測絕對螢幕座標；索引越界直接失敗（絕不截斷收攏）。安全閘：傳 `expect_count={key,delta}` 時工具會重新讀取列標籤，校驗計數器恰好變化 +1/−1（`countCheck.verified`）；若鍵不在該列解析出的計數器裡，點按會在執行前被拒絕——真機上的點按絕不是試探。不傳 `expect_count` 時點按仍會執行（明確的相對位置本身就是定位），但不會有任何驗證。 | `udid`（可選）、`index`（必填）、`x`、`y`（0..1 比例）、`max_depth`、`expect_count`（`{key, delta}`） |

### OCR 工具（Vision）

| 工具 | 作用 | 關鍵參數 |
| --- | --- | --- |
| `ios_sim_find_text` | 用外掛程式編譯的 Vision 助手對已啟動模擬器或 USB 真機的目前螢幕做 OCR（識別準確，zh-Hans + en-US，首次使用由 `swiftc` 編譯進 `~/Library/Caches/dsh-ios/bin/ocr`）。適用於無障礙樹為空或退化、文字以圖形渲染（角標數字、嵌進圖片的價格）或需要獨立核對螢幕內容的場景。先擷取一張新截圖，再回傳 `{device, size, items:[{text, confidence, rect}]}`——rect 是以裝置點為單位的框（原點在左上），按信心度排序，輸出上限約 40 KB（`truncated` 表示丟掉了信心度最低的尾部；可用 `query` 收窄或調高 `min_confidence`）。 | `udid`（可選）、`query`（不區分大小寫的子字串）、`min_confidence`（預設 0.3） |
| `ios_sim_tap_text` | 對目前螢幕做 OCR 並點按最佳文字匹配的中心——沿用與 `ios_sim_tap_element` 相同的「先精確、再忽略大小寫包含、多候選報歧義」規則，適用於無障礙樹看不到的文字（無 a11y 的 App、角標數字、嵌進圖片的文字）。真機上透過 WebDriverAgent 落在裝置絕對座標；模擬器上經 serve-sim 控制以歸一化座標下發（先呼叫 `ios_sim_boot`）。約 300 毫秒後附一張新截圖展示效果；傳 `expect_text` / `expect_gone` 則點擊與驗證合併為一次往返（`expected.matched`）。在真機上每一次點按都有真實後果——絕不靠點按來試探一個未識別的控制項。 | `udid`（可選）、`query`（必填）、`min_confidence`、`expect_text`、`expect_gone` |
| `ios_sim_wait_for` | 等待某段文字在螢幕上出現或消失：重用 `ios_sim_find_text` 的截圖+OCR 流程輪詢，直到條件成立或逾時（預設 8 秒，上限 60 秒）。逾時是正常的 `matched:false` 結果，絕不擲錯——一次呼叫取代手動循環 find_text（實機上每輪約 1.2 秒）。命中時 `item` 帶回 OCR 文字、信心值與裝置點座標框。 | `udid`（選填）、`text`（必填）、`mode`（`appear`/`disappear`）、`timeout_ms`、`min_confidence` |

### 記錄檔工具

| 工具 | 作用 | 關鍵參數 |
| --- | --- | --- |
| `ios_sim_logs` | 從裝置統一記錄檔讀取 App 執行時期的輸出：`snapshot`（`log show --last <duration>`，預設 2m）或 `follow`（有界即時擷取 `duration_seconds`，預設 10 秒、上限 60——絕不會掛起不回傳）。輸出上限約 300 行 / 30 KB，並附收窄提示。 | `udid`（可選）、`mode`（`snapshot`/`follow`）、`duration`、`duration_seconds`、`bundle_id`、`predicate`（原始 NSPredicate，優先於 `bundle_id`）、`level`（`default`/`info`/`debug`）、`grep` |

### 預覽工具

| 工具 | 作用 | 關鍵參數 |
| --- | --- | --- |
| `ios_sim_preview` | 在模擬器裡即時熱重載 SwiftUI 預覽：`start`（預設）驗證套件、在外掛程式快取裡產生一次性宿主 App（絕不會寫進你的套件）、把套件編譯為模擬器 dylib、安裝並啟動宿主、然後監聽原始碼——每次編輯都會重新建置並熱替換，無需重啟（約 2–5 秒）。編譯錯誤不會殺死工作階段：宿主保留最後一次成功的預覽，錯誤尾部透過 `status` 回傳；同一時間只能執行一個預覽工作階段。 | `packagePath`（`start` 時必填）、`udid`、`action`（`start`/`status`/`stop`）、`previewFilter`（對預覽名稱做不區分大小寫的子字串匹配） |

### 偵錯工具

| 工具 | 作用 | 關鍵參數 |
| --- | --- | --- |
| `ios_sim_processes` | 從模擬器自身的 launchd 列出其執行中的 App 處理程序（主機可見的 pid、處理程序名稱、bundle id）——backtrace/leaks 的 pid 來源；真機 udid 則改經 devicectl 列出手機上的處理程序。 | `udid`（可選）、`filter`（對處理程序名稱/bundle id 做不區分大小寫的子字串匹配） |
| `ios_sim_backtrace` | 一次性批次 LLDB（attach → thread backtrace → detach，絕非常駐工作階段）；輸出上限約 200 行、主執行緒在前，目標處理程序必定被驗證已恢復執行。當 macOS 拒絕 attach（開發者模式未開啟）時，回退到 Xcode 的 `sample` 引擎（不掛起處理程序）並給出開啟提示。僅支援模擬器——真機會被明確拒絕並說明原因。 | `udid`（可選）、`pid` / `bundle_id`、`all_threads`（預設 true） |
| `ios_sim_leaks` | 用 Xcode 的 `leaks` 工具分析洩漏：`summary`（洩漏數、洩漏總位元組、前約 30 種洩漏類型）或 `memgraph`（產生 `.memgraph` 工件，用 Xcode Instruments 開啟，外掛程式絕不解析）。掃描期間 App 會被掛起，但之後必定恢復。僅支援模擬器。 | `udid`（可選）、`pid` / `bundle_id`、`mode`（`summary`/`memgraph`） |
| `ios_sim_app_info` | 讀取已安裝 App 的資訊：App 套件路徑、可寫資料容器、Info.plist 關鍵欄位——模擬器走 `simctl appinfo`（附 `get_app_container` 回退），USB 真機走 `devicectl`；未安裝時回傳 `installed: false`，並在 `note` 中提示改用 `ios_sim_list_apps`。 | `udid`（可選）、`bundle_id`（必填） |

## 顯示面

- **側邊欄面板——「iOS 模拟器」。** 即時畫面位於常駐的右側面板（固定停靠、把對話區讓開；窄視窗下退化為居中浮層）。面板渲染即時 MJPEG 畫面，支援在影片上直接點按、拖曳手勢，並有圖示工具列（Home、截圖、旋轉、重新整理），按鈕帶懸停提示。尺寸控制提供**适应**（鋪滿面板寬度）、**50–125%**（按裝置邏輯寬度縮放）以及 **S / M / L** 預設（按裝置短邊定尺寸；橫向時按顯示比例縮放，保持裝置實體大小）。外框樣式為**无框 / 边框 / 真机框**（frameless / bezel / 逼真的裝置外殼），圓角按比例計算。裝置旋轉為橫向時面板自動加寬到舒適尺寸，轉回直向時恢復你原來的寬度——橫向期間你手動拖過寬度則以你的選擇為準。左側邊緣的把手可以拖寬/收窄面板（上限 960px；雙擊恢復預設寬度）。當推流目標是 USB 連接的 iPhone 時，同一個面板顯示手機經 WebDriverAgent 的 MJPEG 畫面，操作方式完全一致。
- **緊湊對話卡片。** 工具結果渲染為單列卡片，不含任何內聯圖片：統一的**「iOS 模拟器」**標題 + 操作副標籤（啟動 / 截圖 / 互動 / 建置執行 / 啟動 WebDriverAgent）+ 裝置名稱 + 狀態徽章 + 「在側邊欄開啟」提示。點擊卡片所在列即可開啟面板；點擊按鈕、連結或即時畫面本身不會觸發。
- **輸入框上方的狀態膠囊。** 面板關閉且推流線上時，輸入框上方會出現一個綠點小膠囊（`<裝置名稱> · 实时`），點擊即可開啟面板。它受工作階段門控：只有當目前工作階段裡掛載著模擬器結果時才渲染並輪詢，切換到沒有結果的工作階段即自動隱藏。
- **標準模式與 Code 模式。** 標準工作階段使用主機下發的 `presentationMeta`；Code 模式（PTC）的巢狀呼叫不會攜帶 meta，用戶端會從結果中的完整 JSON 重建出完全一致的 meta——面板、卡片和狀態膠囊在兩種模式下都能工作。

## 安全

- 瀏覽器永遠不會接觸 serve-sim 的連接埠。所有流量都經由 DSH webserver 源站上的 `/_dsh/dsh-ios/*` 路由：`/stream/<token>`（MJPEG 代理）、`/screenshot/<token>`（快取 PNG）、`/ws?token=…`（HID 控制轉送），以及 `/grant`、`/capture`、`/status` 端點。
- 權杖是 HMAC-SHA256 能力憑證（`base64url(payload).base64url(mac)`），10 分鐘內過期，用每個 DSH 主目錄私有的金鑰簽章（`<DSH_HOME>/cache/dsh-ios/stream-access.key`，0600，原子建立）。
- 每條路由在檢查任何能力之前先套用回送/可信傳輸圍欄：回送對端位址、回送 `Host`（拒絕 DNS 重綁定）、Fetch-Metadata/Origin 驗證。截圖路由只提供外掛程式快取目錄內的檔案（拒絕符號連結，並做 `realpath` 包含性驗證）。
- serve-sim 以前景子處理程序方式執行，僅綁定回送位址的專屬連接埠段（3181–3244），絕不會動使用者自己在 3100 連接埠上的 serve-sim；從不使用 `--host`。。
- **孤兒處理程序收養/回收**——若上一個 DSH 主機被異常殺死、其 serve-sim 子處理程序存活了下來：同一裝置會被直接收養（孤兒處理程序的握手資訊視為權威）；若殘留處理程序占用槽位卻服務著別的裝置，則透過 `serve-sim -k` 回收並重試一次。
- **保活與閒置停止**——推流崩潰後約 5 秒會在背景自動重啟；當沒有消費者時，閒置 5 分鐘自動停止。主動停止絕不會被保活邏輯對抗。（真機 runner 有意豁免閒置回收：重啟它意味著一次數分鐘的 `xcodebuild` 重新建置。）

## 環境需求

- **macOS + 完整版 Xcode**——僅裝 Command Line Tools 不夠。`xcodebuild`、`xcrun simctl` 和模擬器執行時期都隨 Xcode 提供。
- **Xcode 中至少安裝一個 iOS 模擬器執行時期**。
- **DSH ≥ 0.1.0-rc.6 且使用 Web 版**，才能顯示面板。無頭（headless）設定下外掛程式同樣可用：22 個工具照常工作，只是沒有即時畫面。
- **非 macOS 主機**：外掛程式依然能載入，22 個工具也會註冊，但每次呼叫都會回傳明確的錯誤訊息（`iOS Simulator requires macOS with Xcode …`）。
- **serve-sim** 作為本外掛程式的 npm 依賴隨套件安裝，正式安裝時會從本地解析；開發目錄則回退到 `npx -y serve-sim`（首次使用需要連網）。
- **AXe**（可選——只有基於 AXe 的工具需要：`ios_sim_ui_tree` / `ios_sim_tap_element`，以及模擬器上的 `ios_sim_ui_rows` / `ios_sim_tap_row`）：`brew install cameroncooke/axe/axe`，或讓外掛程式自動下載固定版本（v1.8.0，驗證 SHA-256）到 `~/Library/Caches/dsh-ios/bin`。`DSH_IOS_AXE_BIN` 可覆蓋解析結果；`DSH_IOS_AXE_OFFLINE=1` 可停用下載。
- **Vision OCR**（可選——只有 `ios_sim_find_text` / `ios_sim_tap_text` 需要）：外掛程式首次使用時用 `swiftc` 把內建的 `assets/ocr.swift` 編譯到 `~/Library/Caches/dsh-ios/bin/ocr`（識別 zh-Hans + en-US）。
- **lldb attach 需要 macOS 開發者模式**：執行一次 `sudo DevToolsSecurity -enable`。在此之前 `ios_sim_backtrace` 會改用 Xcode 的 `sample` 引擎（不掛起處理程序），`ios_sim_leaks` 會帶著開啟提示降級執行。。首次 WDA 建置會安裝簽章的 WebDriverAgentRunner：按提示在裝置上信任其憑證；免費團隊簽章描述檔 7 天過期後需重新執行 `ios_real_start_wda`。

## 安裝到 DSH

```sh
dsh plugin --profile web add @zseven-w/dsh-ios@latest
dsh web
```

## 快速開始

一次典型的對話流程：

1. **發現裝置**——「列出可用的模擬器。」 → `ios_sim_devices`。
2. **啟動**——「啟動 iPhone 17 Pro。」 → `ios_sim_boot`。推流開始，**「iOS 模拟器」面板**隨之開啟：裝置在側邊欄裡即時顯示。（點擊任意模擬器卡片所在列，或輸入框上方的狀態膠囊，即可重新開啟。）
3. **在畫面上點按**——直接在面板上點按、拖曳；或讓智慧代理驅動介面：「開啟設定，然後點 General。」 → `ios_sim_interact`（按元素身份點擊用 `ios_sim_ui_tree` + `ios_sim_tap_element`；按文字點擊用 `ios_sim_find_text` + `ios_sim_tap_text`；清單/資訊流 App 用 `ios_sim_ui_rows` + `ios_sim_tap_row`）。
4. **建置並執行你的 App**——「建置並執行 /path/to/MyApp.xcodeproj。」 → `ios_sim_build_run`。完整建置需要幾分鐘；完成後 App 會在模擬器裡啟動，你可以在面板裡即時觀看。
5. **預覽熱重載**——「顯示 /path/to/MyPackage 的 SwiftUI 預覽。」 → `ios_sim_preview start`。修改原始碼後，預覽會在約 2–5 秒內熱替換進正在執行的模擬器——無需重啟。
6. **驅動真機 iPhone**——用 USB 資料傳輸線連接手機並解鎖，然後說「在手機上啟動 WebDriverAgent。」 → `ios_real_start_wda`。面板切到手機的即時畫面，所有工具都接受其 `realDevices` 裡的 udid；呼叫失敗時讀面板狀態裡的編碼原因（`device-locked`、`cert-untrusted`、`profile-expired`、`tunnel-failed`、`device-unplugged`）。

## 疑難排解

- **backtrace 用的是 `sample` 而不是 lldb，或 leaks 提示受限檢查**——macOS 開發者模式未開啟。執行一次 `sudo DevToolsSecurity -enable` 後重試。在此之前工具會平滑降級：`ios_sim_backtrace` 回退到 Xcode 的 `sample`（已符號化、不掛起處理程序），`ios_sim_leaks` 會給出開啟提示。
- **`ios_sim_ui_tree` / `ios_sim_tap_element` 需要 AXe**——用 `brew install cameroncooke/axe/axe` 安裝，或讓外掛程式在首次使用時自動下載固定版本（需要能存取 github.com）。錯誤訊息裡始終附帶完整的安裝提示；`DSH_IOS_AXE_BIN=/path/to/axe` 可覆蓋解析結果。列工具（`ios_sim_ui_rows` / `ios_sim_tap_row`）在模擬器上同樣需要 AXe。
- **`ios_sim_find_text` / `ios_sim_tap_text` 報告缺少 OCR 助手**——首次使用會用 `swiftc`（需要 Xcode）把內建的 `assets/ocr.swift` 編譯到 `~/Library/Caches/dsh-ios/bin/ocr`；錯誤訊息裡帶具體路徑與提示。
- **`ios_sim_ui_rows` 找不到列**——結果會說明原因：深度太淺（調大 `max_depth`；真機上每次更深快照約 15–25 秒）、不是清單頁，或深度讀取後確實沒有無障礙資訊。淺讀絕不會被誤報為「缺少無障礙支援」。
- **iOS 26.2 模擬器上的 `ios_sim_leaks` 怪癖**——在 iOS 26.2 執行時期上，即使開發者模式已開啟，Xcode 的 `leaks` 也可能無法分析模擬器處理程序，報出 `Failed to get DYLD info` 或 minimal-corpse 之類的致命診斷。工具會平滑降級：你能看到原始診斷，目標處理程序必定被驗證恢復，不會卡住。外掛程式側沒有修復辦法——遇到時試試 `mode: "memgraph"` 或換一個執行時期。。
- **推流自己停了**——這是閒置策略，不是崩潰：沒有消費者（面板關閉、沒有掛載的卡片、沒有活躍路由）時，推流會在 5 分鐘後停止，並在下一次工具呼叫或開啟面板時重啟。崩潰的推流則會在約 5 秒內於背景自動重啟。

## 開發

```sh
pnpm install
pnpm run build      # 主機 tsc + 用戶端打包 → lib/
pnpm run typecheck
```

`scripts/` 下的煙霧測試會驗證編譯產物 `lib/`（需要啟動模擬器或連接真機 USB 的部分僅限 macOS；設定 `DSH_IOS_SMOKE_SKIP_SIM=1` 可跳過這些部分）：

| 腳本 | 覆蓋內容 |
| --- | --- |
| `node scripts/dev-smoke.mjs` | 模擬器主機：二進位解析、推流啟動、控制、保活、dispose。 |
| `node scripts/dev-tools-smoke.mjs [--full-build]` | 在真實模擬器上驗證核心工具（加 `--full-build` 還會執行一次真實建置）。 |
| `node scripts/dev-routes-smoke.mjs` | 簽章 Web 路由：grant、推流代理、截圖、ws 轉送、圍欄、過期。 |
| `node scripts/dev-card-smoke.mjs` | 用戶端卡片：靜態 SSR（斷言無 `<img>`）、status/capture 契約、近即時的網路部分。 |
| `node scripts/dev-panel-smoke.mjs` | 面板元件、尺寸模式、外框樣式、停靠/觸發/膠囊邏輯（純靜態）。 |
| `node scripts/dev-logs-smoke.mjs` | `ios_sim_logs` 的 snapshot/follow、篩選器、上限、處理程序回收。 |
| `node scripts/dev-uitree-smoke.mjs` | UI 樹工具：AXe 解析/下載管線、選擇器、真實模擬器上的樹與點擊。 |
| `node scripts/dev-debug-smoke.mjs` | 偵錯工具：處理程序、呼叫堆疊（lldb + sample）、洩漏、App 資訊。 |
| `node scripts/dev-preview-smoke.mjs` | 預覽熱重載：啟動、編輯 → 不重啟的熱替換、錯誤恢復、停止。 |
| `node scripts/dev-orphan-smoke.mjs` | 主機被異常殺死後孤兒 serve-sim 的收養/回收。 |
| `node scripts/dev-ocr-smoke.mjs` | Vision-OCR 工具：助手解析、swiftc 編譯快取、識別管線、tap-text 路由。 |
| `node scripts/dev-wda-smoke.mjs` | WebDriverAgent 主機：`ServerURLHere` 解析、失敗分類、通道、保活（mock；可選實測）。 |
| `node scripts/dev-realdevice-smoke.mjs` | 對 USB 連接的 iPhone 執行 `xcrun devicectl`——工具所用的真實程式碼路徑。 |
| `node scripts/dev-realstart-smoke.mjs` | `/real-start` 路由：圍欄、編碼拒絕、建置/啟動門控（純靜態）。 |
| `node scripts/dev-realtools-smoke.mjs` | `ios_sim_screenshot` / `ios_sim_interact` / `ios_sim_ui_tree` / `ios_sim_tap_element` 的真機後端，以及 `ios_real_start_wda`。 |

## 生態

- [DSH Crew](https://github.com/ZSeven-W/dsh-crew) — 從 Claude Code / Codex 把任務派給 DSH agent
- [DSH Noema](https://github.com/ZSeven-W/dsh-noema) — DSH 的長期記憶
- [DSH OpenPencil](https://github.com/ZSeven-W/dsh-openpencil) — 在對話中檢視與編輯 `.op` 設計文件

## 致謝與授權

- [serve-sim](https://github.com/EvanBacon/serve-sim) —— Evan Bacon —— 模擬器推流引擎（Apache-2.0；隨套件安裝的執行時期依賴）。
- [AXe](https://github.com/cameroncooke/AXe) —— Cameron Cooke —— UI 樹工具所依賴的無障礙 CLI（MIT）。
- [WebDriverAgent](https://github.com/appium/WebDriverAgent) —— 外掛程式在真機上建置並啟動的 WebDriver 伺服器（BSD 授權）。
- 架構受 Codex 的「Build iOS Apps」外掛啟發；SwiftUI 預覽引擎是對其公開文件所述方案的潔淨室（clean-room）重實作，未複製任何 Codex 程式碼。
- 完整聲明見 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

**授權條款**：MIT
