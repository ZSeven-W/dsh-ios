<p align="center">
  <img src="./docs/images/dsh-ios-logo.png" alt="DSH iOS" width="120" />
</p>

<h1 align="center">DSH iOS 模拟器</h1>

<p align="center">
  <strong>在 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 对话里嵌入一台实时、可交互的 iOS 模拟器——USB 连接的真机 iPhone 同样支持。</strong><br />
  <sub>22 个智能体工具 &bull; 侧边栏实时 MJPEG 面板 &bull; 模拟器与 USB 真机 &bull; 列表/信息流行级操作 &bull; SwiftUI 预览热重载</sub>
</p>

<p align="center">
  <sub>npm: <code>@zseven-w/dsh-ios</code> &middot; 当前插件版本：<code>0.1.0-rc.3</code> &middot; 已在 DSH <code>0.1.1-rc.1</code> 验证</sub>
</p>

<p align="center">
  <a href="./README.md">English</a> &middot; <b>简体中文</b> &middot; <a href="./README.zh-TW.md">繁體中文</a> &middot; <a href="./README.ja.md">日本語</a> &middot; <a href="./README.ko.md">한국어</a> &middot; <a href="./README.fr.md">Français</a> &middot; <a href="./README.es.md">Español</a> &middot; <a href="./README.de.md">Deutsch</a> &middot; <a href="./README.pt.md">Português</a> &middot; <a href="./README.ru.md">Русский</a> &middot; <a href="./README.hi.md">हिन्दी</a> &middot; <a href="./README.tr.md">Türkçe</a> &middot; <a href="./README.th.md">ไทย</a> &middot; <a href="./README.vi.md">Tiếng Việt</a> &middot; <a href="./README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <sub>npm: <code>@zseven-w/dsh-ios</code> &middot; 当前插件版本: <code>0.1.0-rc.3</code> &middot; 已在 DSH <code>0.1.1-rc.1</code> 验证</sub>
</p>

<br />

<p align="center">
  <img src="./docs/images/dsh-ios-overview.png" alt="DSH iOS Simulator — a real iPhone inside the conversation" width="100%" />
</p>
<p align="center"><sub>在 DSH 对话中直接操作真机 —— 左侧是 Agent 的工具调用，右侧是实时设备面板</sub></p>

## 为什么选择 DSH iOS 模拟器

DSH iOS 模拟器让智能体在对话里拥有一台真正的 iOS 模拟器，也让你亲眼看到画面。智能体可以启动设备、用 Xcode 工程或 Swift 包构建并运行 App、按无障碍身份或 OCR 文字驱动界面、读取统一日志，还能检查进程、调用栈与内存泄漏；与此同时，设备的实时画面会渲染在常驻的侧边栏面板里，你可以在视频上直接点按、拖拽、旋转、按 Home 键。同样的操作也能作用于 USB 连接的真机 iPhone：插件会在手机上构建并启动 WebDriverAgent，把控制与画面端口经回环隧道转发，把设备画面投进同一套面板、卡片与工具。整个过程不用图片内容块，也没有录屏文件——视觉数据只会通过 DSH webserver 签发的限时 URL 进入界面。

| | |
| --- | --- |
| 🖥️ **对话里的实时模拟器** | 已启动设备的 serve-sim MJPEG 画面，经签名后的 `/_dsh/dsh-ios/*` 路由代理进常驻的右侧面板——浏览器永远不会接触 serve-sim 的端口。 |
| 📱 **USB 真机 iPhone** | `ios_real_start_wda` 在已连接的手机上构建并启动 WebDriverAgent，把控制（REST）与画面（MJPEG）端口经回环隧道转发；同一套面板、工具、卡片与状态胶囊即可驱动真机。设备必须处于解锁状态，真机账户上的每一次点按都受插件的“先识别、再点按”规则约束。 |
| 🛠️ **22 个智能体工具** | 设备列表、启动/关闭、截图、交互、构建运行、统一日志、基于 AXe 的 UI 树与按元素点击、列表/信息流行级操作、Vision OCR 找字/点字、SwiftUI 预览热重载、进程列表、调用栈、泄漏分析、App 信息。 |
| 👆 **可交互面板** | 在实时画面上点按、拖拽；Home / 旋转 / 截图 / 刷新图标工具栏（悬停提示）；尺寸模式（适应 · 50–125% · S/M/L）；边框样式（无框 / 边框 / 真机框）；拖拽调宽上限 960px、双击复位；横屏自动加宽。 |
| 🧾 **列表与信息流行** | `ios_sim_ui_rows` 把深层无障碍快照转成带索引、标签与通用解析计数器的行；`ios_sim_tap_row` 在行内按相对坐标点按，并用计数器符合预期的 ±1 变化验证操作是否生效——这是列表类 App 唯一可靠的确认方式。 |
| 🔐 **仅回环的传输** | serve-sim 只绑定 127.0.0.1 的专属端口段；每条路由都要求回环对端、回环 `Host` 与 Fetch-Metadata/Origin 校验；HMAC 能力令牌 10 分钟内过期。。 |
| ⚡ **SwiftUI 预览热重载** | `ios_sim_preview` 在包之外生成一次性宿主 App，把你的预览编译成 dylib，编辑后无需重启即可热替换进正在运行的模拟器（约 2–5 秒）。 |
| 🧭 **语义化 UI 自动化** | `ios_sim_ui_tree` 导出无障碍元素树（基于 AXe），`ios_sim_tap_element` 按标签或标识符点击；当元素树为空或退化时，`ios_sim_find_text` 直接对屏幕做 OCR，`ios_sim_tap_text` 点击命中的文字——按身份或按文字点击，而不是猜坐标。 |

## 工具

全部 22 个工具在任何主机上都会注册，且只返回纯 JSON——视觉数据只通过 `presentationMeta` + 签名路由进入界面，绝不以图片块形式返回。模拟器 udid 自动走 simctl/serve-sim，真机 udid 自动走 WebDriverAgent。非 macOS 主机（或 serve-sim 无法解析）上工具仍然注册，但调用时会返回明确的错误；唯一的例外是 `ios_sim_preview` 的 `status`，它在任何主机上都会如实返回 `{ running: false }`。

### 核心模拟器工具

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `ios_sim_devices` | 列出这台 Mac 上可用的 iOS 模拟器设备（udid、名称、运行时、状态）以及哪些已启动，另外在 `realDevices` 里列出 USB 连接的真机 iPhone（udid、名称、osVersion、model、state、developerMode）。先用它发现要传给其他工具的 udid 或名称。 | — |
| `ios_sim_boot` | 启动指定设备并开始其 serve-sim 实时推流；推流在对话期间保持存活，面板可以实时展示模拟器。 | `udid`（必填——udid 或设备名称） |
| `ios_sim_shutdown` | 关闭指定设备；若推流目标正是该设备，则同时停止推流。 | `udid`（必填） |
| `ios_sim_screenshot` | 截取一张 PNG，返回简短的 JSON 摘要（路径、字节数、尺寸、设备）；图片在卡片/面板中渲染，绝不会以图片块形式返回。正在推流的模拟器与 USB 连接的真机（经 WebDriverAgent）都可以截。 | `udid`（可选——默认取正在推流的设备，其次取第一个已启动的模拟器） |
| `ios_sim_interact` | 与正在推流的设备交互——模拟器或 USB 真机均可：在 0..1 归一化坐标上点按、输入文字（模拟器为美式键盘）、按下硬件按键（`home`、`lock`、`volumeUp`…）、滚动或发送触摸手势；操作稳定后（约 300 毫秒）附带一张新截图展示效果。 | `action`（必填——`tap`/`type`/`button`/`gesture`/`scroll`），`x`/`y`、`text`、`name`、`json` |
| `ios_sim_list_apps` | 列出模拟器或已连接真机上**已安装**的 App（bundle id、显示名、版本、是否系统 App）——第三方 App 的 bundle id 无法猜测，先列出它，或给 `ios_sim_launch_app` 传 `name`。列举失败会抛错（例如“设备当前无法通过 CoreDevice 访问”）而不是返回空列表，所以 `count: 0` 一定意味着设备上确实没有匹配的 App。 | `udid`（可选）、`query`（对显示名与 bundle id 同时做不区分大小写的子串匹配，支持中文）、`include_system`（默认 false） |
| `ios_sim_launch_app` | 启动已安装的 App（模拟器或已连接真机均可）：既可以传 `bundleId`，也可以传 `name`（对显示名做不区分大小写的子串匹配，走同一套列举逻辑，支持中文）。两者只能给其一；启动失败或名称有歧义时，错误里会直接给出下一步该怎么做（从源码构建请用 `ios_sim_build_run`）。 | `bundleId` 或 `name`（二选一）、`udid`、`relaunch` |
| `ios_sim_build_run` | 为模拟器构建 `.xcodeproj`、`.xcworkspace` 或 Swift 包，安装生成的 `.app` 并启动；真机 udid 则改为在手机上构建、安装并启动（需要 Apple Development 签名）。构建失败时返回过滤后的 `xcodebuild` 报错尾部。完整构建通常需要几分钟。 | `projectPath`（必填）、`scheme`、`udid`（推流设备 → 已启动设备 → 最新运行时 iPhone，会自动启动）、`configuration`（默认 `Debug`） |
| `ios_real_start_wda` | 在 USB 连接的真机 iPhone 上启动 WebDriverAgent（WDA）——仅限真机，绝不用于模拟器。若已有 WDA 在响应则直接接管，否则执行 `xcodebuild` 构建/启动（冷构建可能耗时数分钟），然后等待 WDA 就绪并返回实时面板所用的控制/MJPEG 端口。当 `ios_sim_screenshot` / `ios_sim_interact` / `ios_sim_ui_tree` / `ios_sim_tap_element` 报告该设备 WDA 未运行时，先调用本工具。 | `udid`（必填——来自 `ios_sim_devices.realDevices` 的真机 udid） |

### UI 树工具（基于 AXe）

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `ios_sim_ui_tree` | 导出前台 App 的无障碍元素树（标签、标识符、取值、以点为单位的 frame）以及屏幕尺寸（点）——模拟器走 AXe，USB 真机走 WebDriverAgent（真机默认限制快照深度：繁忙 App 的不限深快照实测约 32 秒 / 751 KB，限深后约 2 秒）；输出上限约 40 KB（超出时裁掉最深层级，并置 `truncated` + 提示）。 | `udid`（可选）、`max_depth`、`filter`（对标签/标识符/类型做不区分大小写的子串匹配） |
| `ios_sim_tap_element` | 按身份点击元素——先精确匹配，再做不区分大小写的子串匹配（`identifier`/`label`）；嵌套重复元素折叠为同一个目标，若有多个不同元素匹配则逐一列出候选。点击落在元素中心（模拟器走 AXe HID，真机走 WebDriverAgent），随后约 300 毫秒截一张效果图；传 `expect_text` / `expect_gone` 则点击与验证合并为一次往返（`expected.matched`）。 | `udid`（可选）、`identifier`、`label`、`expect_text`、`expect_gone` |

### 列表与信息流行

列表/信息流类 App 把每条内容聚合进一个无障碍 Cell——标签里包含整条摘要与全部计数器（“57 回复。18 喜欢。592 次查看”），没有可以匹配的逐控件子按钮，而且这些行只有在深层快照里才会出现。下面两个工具把这种结构暴露为“行”，并在行内操作。

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `ios_sim_ui_rows` | 把前台 App 可见的列表/信息流行读成“行”而不是原始树：每一行包含索引、以点为单位的 frame、聚合标签，以及从标签里通用解析出的计数器（数字 + 分类词，如 `57 回复` → 回复=57，中文或英文——不内置任何 App 词汇）。行只有在深层快照里才出现：真机上默认 `max_depth` 为 60，每次调用约 15–25 秒 / ~0.5 MB（WDA 串行处理请求）——先考虑廉价的观察手段（`ios_sim_find_text` / `ios_sim_ui_tree`）。计数器按启发式解析、键值可原样回传：给 `ios_sim_tap_row.expect_count` 传键时务必与列表完全一致。找不到行时结果会说明原因（深度太浅 / 不是列表页 / 深度读取后确实没有无障碍信息）——浅读绝不会被报告成“该 App 没有无障碍信息”；屏幕外的行会被排除并计入 `omittedOffscreen`。 | `udid`（可选）、`max_depth`（仅真机生效；默认 60） |
| `ios_sim_tap_row` | 在一条可见列表行内按相对位置点按（行由 `ios_sim_ui_rows` 报告：0 基索引；x/y 为该行 frame 的比例——0 = 左/上边缘，1 = 右/下边缘，默认 0.5 = 中心），模拟器走 AXe、USB 真机走 WebDriverAgent。行的 frame 来自一次全新的树读取，绝不猜测绝对屏幕坐标；索引越界直接失败（绝不截断收拢）。安全闸：传 `expect_count={key,delta}` 时工具会重新读取行标签，校验计数器恰好变化 +1/−1（`countCheck.verified`）；若键不在该行解析出的计数器里，点按会在执行前被拒绝——真机上的点按绝不是试探。不传 `expect_count` 时点按仍会执行（明确的相对位置本身就是定位），但不会有任何验证。 | `udid`（可选）、`index`（必填）、`x`、`y`（0..1 比例）、`max_depth`、`expect_count`（`{key, delta}`） |

### OCR 工具（Vision）

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `ios_sim_find_text` | 用插件编译的 Vision 助手对已启动模拟器或 USB 真机的当前屏幕做 OCR（识别准确，zh-Hans + en-US，首次使用由 `swiftc` 编译进 `~/Library/Caches/dsh-ios/bin/ocr`）。适用于无障碍树为空或退化、文字以图形渲染（角标数字、嵌进图片的价格）或需要独立核对屏幕内容的场景。先截取一张新截图，再返回 `{device, size, items:[{text, confidence, rect}]}`——rect 是以设备点为单位的框（原点在左上），按置信度排序，输出上限约 40 KB（`truncated` 表示丢掉了置信度最低的尾部；可用 `query` 收窄或调高 `min_confidence`）。 | `udid`（可选）、`query`（不区分大小写的子串）、`min_confidence`（默认 0.3） |
| `ios_sim_tap_text` | 对当前屏幕做 OCR 并点按最佳文字匹配的中心——沿用与 `ios_sim_tap_element` 相同的“先精确、再忽略大小写包含、多候选报歧义”规则，适用于无障碍树看不到的文字（无 a11y 的 App、角标数字、嵌进图片的文字）。真机上通过 WebDriverAgent 落在设备绝对坐标；模拟器上经 serve-sim 控制以归一化坐标下发（先调用 `ios_sim_boot`）。约 300 毫秒后附一张新截图展示效果；传 `expect_text` / `expect_gone` 则点击与验证合并为一次往返（`expected.matched`）。在真机上每一次点按都有真实后果——绝不靠点按来试探一个未识别的控件。 | `udid`（可选）、`query`（必填）、`min_confidence`、`expect_text`、`expect_gone` |
| `ios_sim_wait_for` | 等待某段文字在屏幕上出现或消失：复用 `ios_sim_find_text` 的截图+OCR 流水线轮询，直到条件成立或超时（默认 8 秒，上限 60 秒）。超时是正常的 `matched:false` 结果，绝不抛错——一次调用替代手动循环 find_text（真机上每轮约 1.2 秒）。命中时 `item` 携带 OCR 文字、置信度与设备点坐标框。 | `udid`（可选）、`text`（必填）、`mode`（`appear`/`disappear`）、`timeout_ms`、`min_confidence` |

### 日志工具

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `ios_sim_logs` | 从设备统一日志读取 App 运行时的输出：`snapshot`（`log show --last <duration>`，默认 2m）或 `follow`（有界实时捕获 `duration_seconds`，默认 10 秒、上限 60——绝不会挂起不返回）。输出上限约 300 行 / 30 KB，并附收窄提示。 | `udid`（可选）、`mode`（`snapshot`/`follow`）、`duration`、`duration_seconds`、`bundle_id`、`predicate`（原始 NSPredicate，优先于 `bundle_id`）、`level`（`default`/`info`/`debug`）、`grep` |

### 预览工具

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `ios_sim_preview` | 在模拟器里实时热重载 SwiftUI 预览：`start`（默认）校验包、在插件缓存里生成一次性宿主 App（绝不会写进你的包）、把包编译为模拟器 dylib、安装并启动宿主、然后监听源码——每次编辑都会重新构建并热替换，无需重启（约 2–5 秒）。编译错误不会杀死会话：宿主保留最后一次成功的预览，错误尾部通过 `status` 返回；同一时间只能运行一个预览会话。 | `packagePath`（`start` 时必填）、`udid`、`action`（`start`/`status`/`stop`）、`previewFilter`（对预览名称做不区分大小写的子串匹配） |

### 调试工具

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `ios_sim_processes` | 从模拟器自身的 launchd 列出其运行中的 App 进程（宿主机可见的 pid、进程名、bundle id）——backtrace/leaks 的 pid 来源；真机 udid 则改经 devicectl 列出手机上的进程。 | `udid`（可选）、`filter`（对进程名/bundle id 做不区分大小写的子串匹配） |
| `ios_sim_backtrace` | 一次性批量 LLDB（attach → thread backtrace → detach，绝非常驻会话）；输出上限约 200 行、主线程在前，目标进程必定被验证已恢复运行。当 macOS 拒绝 attach（开发者模式未开启）时，回退到 Xcode 的 `sample` 引擎（不挂起进程）并给出开启提示。仅支持模拟器——真机会被明确拒绝并说明原因。 | `udid`（可选）、`pid` / `bundle_id`、`all_threads`（默认 true） |
| `ios_sim_leaks` | 用 Xcode 的 `leaks` 工具分析泄漏：`summary`（泄漏数、泄漏总字节、前约 30 种泄漏类型）或 `memgraph`（生成 `.memgraph` 工件，用 Xcode Instruments 打开，插件绝不解析）。扫描期间 App 会被挂起，但之后必定恢复。仅支持模拟器。 | `udid`（可选）、`pid` / `bundle_id`、`mode`（`summary`/`memgraph`） |
| `ios_sim_app_info` | 读取已安装 App 的信息：App 包路径、可写数据容器、Info.plist 关键字段——模拟器走 `simctl appinfo`（附 `get_app_container` 回退），USB 真机走 `devicectl`；未安装时返回 `installed: false`，并在 `note` 中提示改用 `ios_sim_list_apps`。 | `udid`（可选）、`bundle_id`（必填） |

## 展示面

- **侧边栏面板——“iOS 模拟器”。** 实时画面位于常驻的右侧面板（固定停靠、把对话区让开；窄视口下退化为居中浮层）。面板渲染实时 MJPEG 画面，支持在视频上直接点按、拖拽手势，并有图标工具栏（Home、截图、旋转、刷新），按钮带悬停提示。尺寸控制提供**适应**（铺满面板宽度）、**50–125%**（按设备逻辑宽度缩放）以及 **S / M / L** 预设（按设备短边定尺寸；横屏时按显示比例缩放，保持设备物理大小）。边框样式为**无框 / 边框 / 真机框**（frameless / bezel / 逼真的设备外壳），圆角按比例计算。设备旋转为横屏时面板自动加宽到舒适尺寸，转回竖屏时恢复你原来的宽度——横屏期间你手动拖过宽度则以你的选择为准。左侧边缘的把手可以拖宽/收窄面板（上限 960px；双击恢复默认宽度）。当推流目标是 USB 连接的 iPhone 时，同一个面板显示手机经 WebDriverAgent 的 MJPEG 画面，操作方式完全一致。
- **紧凑对话卡片。** 工具结果渲染为单行卡片，不含任何内联图片：统一的**“iOS 模拟器”**标题 + 操作副标签（启动 / 截图 / 交互 / 构建运行 / 启动 WebDriverAgent）+ 设备名 + 状态徽标 + “在侧边栏打开”提示。点击卡片所在行即可打开面板；点击按钮、链接或实时画面本身不会触发。
- **输入框上方的状态胶囊。** 面板关闭且推流在线时，输入框上方会出现一个绿点小胶囊（`<设备名> · 实时`），点击即可打开面板。它受会话门控：只有当当前会话里挂载着模拟器结果时才渲染并轮询，切换到没有结果的会话即自动隐藏。
- **标准模式与 Code 模式。** 标准会话使用宿主下发的 `presentationMeta`；Code 模式（PTC）的嵌套调用不会携带 meta，客户端会从结果中的完整 JSON 重建出完全一致的 meta——面板、卡片和状态胶囊在两种模式下都能工作。

## 安全

- 浏览器永远不会接触 serve-sim 的端口。所有流量都经由 DSH webserver 源站上的 `/_dsh/dsh-ios/*` 路由：`/stream/<token>`（MJPEG 代理）、`/screenshot/<token>`（缓存 PNG）、`/ws?token=…`（HID 控制转发），以及 `/grant`、`/capture`、`/status` 端点。
- 令牌是 HMAC-SHA256 能力凭证（`base64url(payload).base64url(mac)`），10 分钟内过期，用每个 DSH 主目录私有的密钥签名（`<DSH_HOME>/cache/dsh-ios/stream-access.key`，0600，原子创建）。
- 每条路由在检查任何能力之前先应用回环/可信传输围栏：回环对端地址、回环 `Host`（拒绝 DNS 重绑定）、Fetch-Metadata/Origin 校验。截图路由只提供插件缓存目录内的文件（拒绝符号链接，并做 `realpath` 包含性校验）。
- serve-sim 以前台子进程方式运行，仅绑定回环地址的专属端口段（3181–3244），绝不会动用户自己在 3100 端口上的 serve-sim；从不使用 `--host`。。
- **孤儿进程收养/回收**——若上一个 DSH 宿主被异常杀死、其 serve-sim 子进程存活了下来：同一设备会被直接收养（孤儿进程的握手信息视为权威）；若残留进程占用槽位却服务着别的设备，则通过 `serve-sim -k` 回收并重试一次。
- **保活与空闲停止**——推流崩溃后约 5 秒会在后台自动重启；当没有消费者时，空闲 5 分钟自动停止。主动停止绝不会被保活逻辑对抗。（真机 runner 有意豁免空闲回收：重启它意味着一次数分钟的 `xcodebuild` 重新构建。）

## 环境要求

- **macOS + 完整版 Xcode**——仅装 Command Line Tools 不够。`xcodebuild`、`xcrun simctl` 和模拟器运行时都随 Xcode 提供。
- **Xcode 中至少安装一个 iOS 模拟器运行时**。
- **DSH ≥ 0.1.0-rc.6 且使用 Web 版**，才能显示面板。无头（headless）配置下插件同样可用：22 个工具照常工作，只是没有实时画面。
- **非 macOS 主机**：插件依然能加载，22 个工具也会注册，但每次调用都会返回明确的错误信息（`iOS Simulator requires macOS with Xcode …`）。
- **serve-sim** 作为本插件的 npm 依赖随包安装，正式安装时会从本地解析；开发目录则回退到 `npx -y serve-sim`（首次使用需要联网）。
- **AXe**（可选——只有基于 AXe 的工具需要：`ios_sim_ui_tree` / `ios_sim_tap_element`，以及模拟器上的 `ios_sim_ui_rows` / `ios_sim_tap_row`）：`brew install cameroncooke/axe/axe`，或让插件自动下载固定版本（v1.8.0，校验 SHA-256）到 `~/Library/Caches/dsh-ios/bin`。`DSH_IOS_AXE_BIN` 可覆盖解析结果；`DSH_IOS_AXE_OFFLINE=1` 可禁用下载。
- **Vision OCR**（可选——只有 `ios_sim_find_text` / `ios_sim_tap_text` 需要）：插件首次使用时用 `swiftc` 把内置的 `assets/ocr.swift` 编译到 `~/Library/Caches/dsh-ios/bin/ocr`（识别 zh-Hans + en-US）。
- **lldb attach 需要 macOS 开发者模式**：执行一次 `sudo DevToolsSecurity -enable`。在此之前 `ios_sim_backtrace` 会改用 Xcode 的 `sample` 引擎（不挂起进程），`ios_sim_leaks` 会带着开启提示降级运行。。首次 WDA 构建会安装签名的 WebDriverAgentRunner：按提示在设备上信任其证书；免费团队签名描述文件 7 天过期后需重新运行 `ios_real_start_wda`。

## 安装到 DSH

```sh
dsh plugin --profile web add @zseven-w/dsh-ios@latest
dsh web
```

## 快速开始

一次典型的对话流程：

1. **发现设备**——“列出可用的模拟器。” → `ios_sim_devices`。
2. **启动**——“启动 iPhone 17 Pro。” → `ios_sim_boot`。推流开始，**“iOS 模拟器”面板**随之打开：设备在侧边栏里实时显示。（点击任意模拟器卡片所在行，或输入框上方的状态胶囊，即可重新打开。）
3. **在画面上点按**——直接在面板上点按、拖拽；或让智能体驱动界面：“打开设置，然后点 General。” → `ios_sim_interact`（按元素身份点击用 `ios_sim_ui_tree` + `ios_sim_tap_element`；按文字点击用 `ios_sim_find_text` + `ios_sim_tap_text`；列表/信息流 App 用 `ios_sim_ui_rows` + `ios_sim_tap_row`）。
4. **构建并运行你的 App**——“构建并运行 /path/to/MyApp.xcodeproj。” → `ios_sim_build_run`。完整构建需要几分钟；完成后 App 会在模拟器里启动，你可以在面板里实时观看。
5. **预览热重载**——“显示 /path/to/MyPackage 的 SwiftUI 预览。” → `ios_sim_preview start`。修改源码后，预览会在约 2–5 秒内热替换进正在运行的模拟器——无需重启。
6. **驱动真机 iPhone**——用 USB 数据线连接手机并解锁，然后说“在手机上启动 WebDriverAgent。” → `ios_real_start_wda`。面板切到手机的实时画面，所有工具都接受其 `realDevices` 里的 udid；调用失败时读面板状态里的编码原因（`device-locked`、`cert-untrusted`、`profile-expired`、`tunnel-failed`、`device-unplugged`）。

## 疑难排查

- **backtrace 用的是 `sample` 而不是 lldb，或 leaks 提示受限检查**——macOS 开发者模式未开启。执行一次 `sudo DevToolsSecurity -enable` 后重试。在此之前工具会平滑降级：`ios_sim_backtrace` 回退到 Xcode 的 `sample`（已符号化、不挂起进程），`ios_sim_leaks` 会给出开启提示。
- **`ios_sim_ui_tree` / `ios_sim_tap_element` 需要 AXe**——用 `brew install cameroncooke/axe/axe` 安装，或让插件在首次使用时自动下载固定版本（需要能访问 github.com）。错误信息里始终附带完整的安装提示；`DSH_IOS_AXE_BIN=/path/to/axe` 可覆盖解析结果。行工具（`ios_sim_ui_rows` / `ios_sim_tap_row`）在模拟器上同样需要 AXe。
- **`ios_sim_find_text` / `ios_sim_tap_text` 报告缺少 OCR 助手**——首次使用会用 `swiftc`（需要 Xcode）把内置的 `assets/ocr.swift` 编译到 `~/Library/Caches/dsh-ios/bin/ocr`；错误信息里带具体路径与提示。
- **`ios_sim_ui_rows` 找不到行**——结果会说明原因：深度太浅（调大 `max_depth`；真机上每次更深快照约 15–25 秒）、不是列表页，或深度读取后确实没有无障碍信息。浅读绝不会被误报为“缺少无障碍支持”。
- **iOS 26.2 模拟器上的 `ios_sim_leaks` 怪癖**——在 iOS 26.2 运行时上，即使开发者模式已开启，Xcode 的 `leaks` 也可能无法分析模拟器进程，报出 `Failed to get DYLD info` 或 minimal-corpse 之类的致命诊断。工具会平滑降级：你能看到原始诊断，目标进程必定被验证恢复，不会卡住。插件侧没有修复办法——遇到时试试 `mode: "memgraph"` 或换一个运行时。。
- **推流自己停了**——这是空闲策略，不是崩溃：没有消费者（面板关闭、没有挂载的卡片、没有活跃路由）时，推流会在 5 分钟后停止，并在下一次工具调用或打开面板时重启。崩溃的推流则会在约 5 秒内于后台自动重启。

## 开发

```sh
pnpm install
pnpm run build      # 宿主 tsc + 客户端打包 → lib/
pnpm run typecheck
```

`scripts/` 下的冒烟测试会验证编译产物 `lib/`（需要启动模拟器或连接真机 USB 的部分仅限 macOS；设置 `DSH_IOS_SMOKE_SKIP_SIM=1` 可跳过这些部分）：

| 脚本 | 覆盖内容 |
| --- | --- |
| `node scripts/dev-smoke.mjs` | 模拟器宿主：二进制解析、推流启动、控制、保活、dispose。 |
| `node scripts/dev-tools-smoke.mjs [--full-build]` | 在真实模拟器上验证核心工具（加 `--full-build` 还会执行一次真实构建）。 |
| `node scripts/dev-routes-smoke.mjs` | 签名 Web 路由：grant、推流代理、截图、ws 转发、围栏、过期。 |
| `node scripts/dev-card-smoke.mjs` | 客户端卡片：静态 SSR（断言无 `<img>`）、status/capture 契约、近实时的网络部分。 |
| `node scripts/dev-panel-smoke.mjs` | 面板组件、尺寸模式、边框样式、停靠/触发/胶囊逻辑（纯静态）。 |
| `node scripts/dev-logs-smoke.mjs` | `ios_sim_logs` 的 snapshot/follow、过滤器、上限、进程回收。 |
| `node scripts/dev-uitree-smoke.mjs` | UI 树工具：AXe 解析/下载管线、选择器、真实模拟器上的树与点击。 |
| `node scripts/dev-debug-smoke.mjs` | 调试工具：进程、调用栈（lldb + sample）、泄漏、App 信息。 |
| `node scripts/dev-preview-smoke.mjs` | 预览热重载：启动、编辑 → 不重启的热替换、错误恢复、停止。 |
| `node scripts/dev-orphan-smoke.mjs` | 宿主被异常杀死后孤儿 serve-sim 的收养/回收。 |
| `node scripts/dev-ocr-smoke.mjs` | Vision-OCR 工具：助手解析、swiftc 编译缓存、识别管线、tap-text 路由。 |
| `node scripts/dev-wda-smoke.mjs` | WebDriverAgent 宿主：`ServerURLHere` 解析、失败分类、隧道、保活（mock；可选实测）。 |
| `node scripts/dev-realdevice-smoke.mjs` | 对 USB 连接的 iPhone 执行 `xcrun devicectl`——工具所用的真实代码路径。 |
| `node scripts/dev-realstart-smoke.mjs` | `/real-start` 路由：围栏、编码拒绝、构建/启动门控（纯静态）。 |
| `node scripts/dev-realtools-smoke.mjs` | `ios_sim_screenshot` / `ios_sim_interact` / `ios_sim_ui_tree` / `ios_sim_tap_element` 的真机后端，以及 `ios_real_start_wda`。 |

## 生态

- [DSH Android](https://github.com/ZSeven-W/dsh-android) — 在对话中运行 Android 模拟器或 USB 真机，全部由 adb 驱动
- [DSH Crew](https://github.com/ZSeven-W/dsh-crew) — 从 Claude Code / Codex 把任务派给 DSH agent
- [DSH Noema](https://github.com/ZSeven-W/dsh-noema) — DSH 的长期记忆
- [DSH OpenPencil](https://github.com/ZSeven-W/dsh-openpencil) — 在对话中查看和编辑 `.op` 设计文档

## 致谢与许可证

- [serve-sim](https://github.com/EvanBacon/serve-sim) —— Evan Bacon —— 模拟器推流引擎（Apache-2.0；随包安装的运行时依赖）。
- [AXe](https://github.com/cameroncooke/AXe) —— Cameron Cooke —— UI 树工具所依赖的无障碍 CLI（MIT）。
- [WebDriverAgent](https://github.com/appium/WebDriverAgent) —— 插件在真机上构建并启动的 WebDriver 服务器（BSD 许可）。
- 架构受 Codex 的 “Build iOS Apps” 插件启发；SwiftUI 预览引擎是对其公开文档所述方案的洁净室（clean-room）重实现，未复制任何 Codex 代码。
- 完整声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

**许可证**：MIT
