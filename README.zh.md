<h1 align="center">DSH iOS 模拟器</h1>

<p align="center">
  <strong>在 DeepSeek Harness 对话里嵌入一台实时、可交互的 iOS 模拟器。</strong><br />
  <sub>14 个智能体工具 &bull; 侧边栏实时 MJPEG 面板 &bull; 直接在画面上点按、拖拽、按 Home 键 &bull; SwiftUI 预览热重载</sub>
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh.md"><b>简体中文</b></a>
</p>

<p align="center">
  <sub>当前插件版本：<code>0.1.0-rc.1</code> &bull; 已随 DSH <code>0.1.0-rc.6</code> 验证 &bull; rc 说明：尚未发布到 npm —— 见<a href="#安装到-dsh">安装</a></sub>
</p>

<!-- 头图占位 —— 侧边栏实时“iOS 模拟器”面板与对话中紧凑工具卡片的截图，稍后补充。 -->

## 为什么选择 DSH iOS 模拟器

DSH iOS 模拟器让智能体在对话里拥有一台真正的 iOS 模拟器，也让你亲眼看到画面。智能体可以启动设备、用 Xcode 工程或 Swift 包构建并运行 App、驱动界面、读取统一日志，还能检查进程、调用栈与内存泄漏；与此同时，设备的实时画面会渲染在常驻的侧边栏面板里，你可以在视频上直接点按、拖拽、旋转、按 Home 键。整个过程不用图片内容块，也没有录屏文件——视觉数据只会通过 DSH webserver 签发的限时 URL 进入界面。

| | |
| --- | --- |
| 🖥️ **对话里的实时模拟器** | 已启动设备的 serve-sim MJPEG 画面，经签名后的 `/_dsh/dsh-ios/*` 路由代理进常驻的右侧面板——浏览器永远不会接触 serve-sim 的端口。 |
| 🛠️ **14 个智能体工具** | 设备列表、启动/关闭、截图、交互、构建运行、统一日志、基于 AXe 的 UI 树与按元素点击、SwiftUI 预览热重载、进程列表、调用栈、泄漏分析、App 信息。 |
| 👆 **可交互面板** | 在实时画面上点按、拖拽；Home / 旋转 / 截图 / 刷新图标工具栏（悬停提示）；尺寸模式（适应 · 50–125% · S/M/L）；边框样式（无框 / 边框 / 真机框）；拖拽调宽上限 960px、双击复位；横屏自动加宽。 |
| 🔐 **仅回环的传输** | serve-sim 只绑定 127.0.0.1 的专属端口段；每条路由都要求回环对端、回环 `Host` 与 Fetch-Metadata/Origin 校验；HMAC 能力令牌 10 分钟内过期。 |
| ⚡ **SwiftUI 预览热重载** | `ios_sim_preview` 在包之外生成一次性宿主 App，把你的预览编译成 dylib，编辑后无需重启即可热替换进正在运行的模拟器（约 2–5 秒）。 |
| 🧭 **语义化 UI 自动化** | `ios_sim_ui_tree` 导出无障碍元素树（基于 AXe）；`ios_sim_tap_element` 按标签或标识符点击元素，而不是猜坐标。 |

## 工具

全部 14 个工具在任何主机上都会注册，且只返回纯 JSON——视觉数据只通过 `presentationMeta` + 签名路由进入界面，绝不以图片块形式返回。非 macOS 主机（或 serve-sim 无法解析）上工具仍然注册，但调用时会返回明确的错误；唯一的例外是 `ios_sim_preview` 的 `status`，它在任何主机上都会如实返回 `{ running: false }`。

### 核心模拟器工具

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `ios_sim_devices` | 列出这台 Mac 上可用的模拟器设备（udid、名称、运行时、状态）以及哪些已启动。 | — |
| `ios_sim_boot` | 启动指定设备并开始其 serve-sim 实时推流；推流在对话期间保持存活，面板可以实时展示模拟器。 | `udid`（必填——udid 或设备名称） |
| `ios_sim_shutdown` | 关闭指定设备；若推流目标正是该设备，则同时停止推流。 | `udid`（必填） |
| `ios_sim_screenshot` | 截取一张 PNG，返回简短的 JSON 摘要（路径、字节数、尺寸、设备）；图片在卡片/面板中渲染，绝不会以图片块形式返回。 | `udid`（可选——默认取正在推流的设备，其次取第一个已启动的模拟器） |
| `ios_sim_interact` | 与正在推流的模拟器交互：在 0..1 归一化坐标上点按、输入文字（美式键盘）、按下硬件按键（`home`、`lock`、`volumeUp`…）或发送触摸手势；操作稳定后（约 300 毫秒）附带一张新截图展示效果。 | `action`（必填——`tap`/`type`/`button`/`gesture`），`x`/`y`、`text`、`name`、`json` |
| `ios_sim_build_run` | 为模拟器构建 `.xcodeproj`、`.xcworkspace` 或 Swift 包，安装生成的 `.app` 并启动；构建失败时返回过滤后的 `xcodebuild` 报错尾部。完整构建通常需要几分钟。 | `projectPath`（必填）、`scheme`、`udid`（推流设备 → 已启动设备 → 最新运行时 iPhone，会自动启动）、`configuration`（默认 `Debug`） |

### UI 树工具（基于 AXe）

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `ios_sim_ui_tree` | 导出前台 App 的无障碍元素树（标签、标识符、取值、以点为单位的 frame）以及屏幕尺寸（点）；输出上限约 40 KB（超出时裁掉最深层级，并置 `truncated` + 提示）。 | `udid`（可选）、`max_depth`、`filter`（对标签/标识符/类型做不区分大小写的子串匹配） |
| `ios_sim_tap_element` | 按身份点击元素——先精确匹配，再做不区分大小写的子串匹配（`identifier`/`label`）；嵌套重复元素折叠为同一个目标，若有多个不同元素匹配则逐一列出候选。点击通过 AXe HID 落在元素中心，随后约 300 毫秒截一张效果图。 | `udid`（可选）、`identifier`、`label` |

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
| `ios_sim_processes` | 从模拟器自身的 launchd 列出其运行中的 App 进程（宿主机可见的 pid、进程名、bundle id）——backtrace/leaks 的 pid 来源。 | `udid`（可选）、`filter`（对进程名/bundle id 做不区分大小写的子串匹配） |
| `ios_sim_backtrace` | 一次性批量 LLDB（attach → thread backtrace → detach，绝非常驻会话）；输出上限约 200 行、主线程在前，目标进程必定被验证已恢复运行。当 macOS 拒绝 attach（开发者模式未开启）时，回退到 Xcode 的 `sample` 引擎（不挂起进程）并给出开启提示。 | `udid`（可选）、`pid` / `bundle_id`、`all_threads`（默认 true） |
| `ios_sim_leaks` | 用 Xcode 的 `leaks` 工具分析泄漏：`summary`（泄漏数、泄漏总字节、前约 30 种泄漏类型）或 `memgraph`（生成 `.memgraph` 工件，用 Xcode Instruments 打开，插件绝不解析）。扫描期间 App 会被挂起，但之后必定恢复。 | `udid`（可选）、`pid` / `bundle_id`、`mode`（`summary`/`memgraph`） |
| `ios_sim_app_info` | 通过 `simctl appinfo`（附 `get_app_container` 回退）读取已安装 App 的信息：App 包路径、可写数据容器、Info.plist 关键字段；未安装时返回 `installed: false`。 | `udid`（可选）、`bundle_id`（必填） |

## 展示面

- **侧边栏面板——“iOS 模拟器”。** 实时画面位于常驻的右侧面板（固定停靠、把对话区让开；窄视口下退化为居中浮层）。面板渲染实时 MJPEG 画面，支持在视频上直接点按、拖拽手势，并有图标工具栏（Home、截图、旋转、刷新），按钮带悬停提示。尺寸控制提供**适应**（铺满面板宽度）、**50–125%**（按设备逻辑宽度缩放）以及 **S / M / L** 预设（按设备短边定尺寸；横屏时按显示比例缩放，保持设备物理大小）。边框样式为**无框 / 边框 / 真机框**（frameless / bezel / 逼真的 CSS 机身），圆角按比例计算。设备旋转为横屏时面板自动加宽到舒适尺寸，转回竖屏时恢复你原来的宽度——横屏期间你手动拖过宽度则以你的选择为准。左侧边缘的把手可以拖宽/收窄面板（上限 960px；双击恢复默认宽度）。
- **紧凑对话卡片。** 工具结果渲染为单行卡片，不含任何内联图片：统一的**“iOS 模拟器”**标题 + 操作副标签（启动 / 截图 / 交互 / 构建运行）+ 设备名 + 状态徽标 + “在侧边栏打开”提示。点击卡片所在行即可打开面板；点击按钮、链接或实时画面本身不会触发。
- **输入框上方的状态胶囊。** 面板关闭且推流在线时，输入框上方会出现一个绿点小胶囊（`<设备名> · 实时`），点击即可打开面板。它受会话门控：只有当当前会话里挂载着模拟器结果时才渲染并轮询，切换到没有结果的会话即自动隐藏。
- **标准模式与 Code 模式。** 标准会话使用宿主下发的 `presentationMeta`；Code 模式（PTC）的嵌套调用不会携带 meta，客户端会从结果中的完整 JSON 重建出完全一致的 meta——面板、卡片和状态胶囊在两种模式下都能工作。

## 安全

- 浏览器永远不会接触 serve-sim 的端口。所有流量都经由 DSH webserver 源站上的 `/_dsh/dsh-ios/*` 路由：`/stream/<token>`（MJPEG 代理）、`/screenshot/<token>`（缓存 PNG）、`/ws?token=…`（HID 控制转发），以及 `/grant`、`/capture`、`/status` 端点。
- 令牌是 HMAC-SHA256 能力凭证（`base64url(payload).base64url(mac)`），10 分钟内过期，用每个 DSH 主目录私有的密钥签名（`<DSH_HOME>/cache/dsh-ios/stream-access.key`，0600，原子创建）。
- 每条路由在检查任何能力之前先应用回环/可信传输围栏：回环对端地址、回环 `Host`（拒绝 DNS 重绑定）、Fetch-Metadata/Origin 校验。截图路由只提供插件缓存目录内的文件（拒绝符号链接，并做 `realpath` 包含性校验）。
- serve-sim 以前台子进程方式运行，仅绑定回环地址的专属端口段（3181–3244），绝不会动用户自己在 3100 端口上的 serve-sim；从不使用 `--host`。
- **孤儿进程收养/回收**——若上一个 DSH 宿主被异常杀死、其 serve-sim 子进程存活了下来：同一设备会被直接收养（孤儿进程的握手信息视为权威）；若残留进程占用槽位却服务着别的设备，则通过 `serve-sim -k` 回收并重试一次。
- **保活与空闲停止**——推流崩溃后约 5 秒会在后台自动重启；当没有消费者时，空闲 5 分钟自动停止。主动停止绝不会被保活逻辑对抗。

## 环境要求

- **macOS + 完整版 Xcode**——仅装 Command Line Tools 不够。`xcodebuild`、`xcrun simctl` 和模拟器运行时都随 Xcode 提供。
- **Xcode 中至少安装一个 iOS 模拟器运行时**。
- **DSH ≥ 0.1.0-rc.6 且使用 Web 版**，才能显示面板。无头（headless）配置下插件同样可用：14 个工具照常工作，只是没有实时画面。
- **非 macOS 主机**：插件依然能加载，14 个工具也会注册，但每次调用都会返回明确的错误信息（`iOS Simulator requires macOS with Xcode …`）。
- **serve-sim** 作为本插件的 npm 依赖随包安装，正式安装时会从本地解析；开发目录则回退到 `npx -y serve-sim`（首次使用需要联网）。
- **AXe**（可选——只有 `ios_sim_ui_tree` / `ios_sim_tap_element` 需要）：`brew install cameroncooke/axe/axe`，或让插件自动下载固定版本（v1.8.0，校验 SHA-256）到 `~/Library/Caches/dsh-ios/bin`。`DSH_IOS_AXE_BIN` 可覆盖解析结果；`DSH_IOS_AXE_OFFLINE=1` 可禁用下载。
- **lldb attach 需要 macOS 开发者模式**：执行一次 `sudo DevToolsSecurity -enable`。在此之前 `ios_sim_backtrace` 会改用 Xcode 的 `sample` 引擎（不挂起进程），`ios_sim_leaks` 会带着开启提示降级运行。

## 安装到 DSH

```sh
dsh plugin --profile <name> add @zseven-w/dsh-ios
dsh web
```

> **rc 说明**——`0.1.0-rc.1` 尚未发布到 npm。发布前请安装打包好的 tarball：
>
> ```sh
> npm pack                                   # 在本仓库内执行 → dsh-ios-0.1.0-rc.1.tgz
> dsh plugin --profile <name> add /path/to/dsh-ios-0.1.0-rc.1.tgz
> dsh web
> ```

## 快速开始

一次典型的对话流程：

1. **发现设备**——“列出可用的模拟器。” → `ios_sim_devices`。
2. **启动**——“启动 iPhone 17 Pro。” → `ios_sim_boot`。推流开始，**“iOS 模拟器”面板**随之打开：设备在侧边栏里实时显示。（点击任意模拟器卡片所在行，或输入框上方的状态胶囊，即可重新打开。）
3. **在画面上点按**——直接在面板上点按、拖拽；或让智能体驱动界面：“打开设置，然后点 General。” → `ios_sim_interact`（想按元素身份点击就用 `ios_sim_ui_tree` + `ios_sim_tap_element`）。
4. **构建并运行你的 App**——“构建并运行 /path/to/MyApp.xcodeproj。” → `ios_sim_build_run`。完整构建需要几分钟；完成后 App 会在模拟器里启动，你可以在面板里实时观看。
5. **预览热重载**——“显示 /path/to/MyPackage 的 SwiftUI 预览。” → `ios_sim_preview start`。修改源码后，预览会在约 2–5 秒内热替换进正在运行的模拟器——无需重启。

## 疑难排查

- **backtrace 用的是 `sample` 而不是 lldb，或 leaks 提示受限检查**——macOS 开发者模式未开启。执行一次 `sudo DevToolsSecurity -enable` 后重试。在此之前工具会平滑降级：`ios_sim_backtrace` 回退到 Xcode 的 `sample`（已符号化、不挂起进程），`ios_sim_leaks` 会给出开启提示。
- **`ios_sim_ui_tree` / `ios_sim_tap_element` 需要 AXe**——用 `brew install cameroncooke/axe/axe` 安装，或让插件在首次使用时自动下载固定版本（需要能访问 github.com）。错误信息里始终附带完整的安装提示；`DSH_IOS_AXE_BIN=/path/to/axe` 可覆盖解析结果。
- **iOS 26.2 模拟器上的 `ios_sim_leaks` 怪癖**——在 iOS 26.2 运行时上，即使开发者模式已开启，Xcode 的 `leaks` 也可能无法分析模拟器进程，报出 `Failed to get DYLD info` 或 minimal-corpse 之类的致命诊断。工具会平滑降级：你能看到原始诊断，目标进程必定被验证恢复，不会卡住。插件侧没有修复办法——遇到时试试 `mode: "memgraph"` 或换一个运行时。
- **推流自己停了**——这是空闲策略，不是崩溃：没有消费者（面板关闭、没有挂载的卡片、没有活跃路由）时，推流会在 5 分钟后停止，并在下一次工具调用或打开面板时重启。崩溃的推流则会在约 5 秒内于后台自动重启。

## 开发

```sh
pnpm install
pnpm run build      # 宿主 tsc + 客户端打包 → lib/
pnpm run typecheck
```

`scripts/` 下的冒烟测试会验证编译产物 `lib/`（需要启动模拟器的部分仅限 macOS；设置 `DSH_IOS_SMOKE_SKIP_SIM=1` 可跳过这些部分）：

| 脚本 | 覆盖内容 |
| --- | --- |
| `node scripts/dev-smoke.mjs` | 模拟器宿主：二进制解析、推流启动、控制、保活、dispose。 |
| `node scripts/dev-tools-smoke.mjs [--full-build]` | 在真实模拟器上验证六个核心工具（加 `--full-build` 还会执行一次真实构建）。 |
| `node scripts/dev-routes-smoke.mjs` | 签名 Web 路由：grant、推流代理、截图、ws 转发、围栏、过期。 |
| `node scripts/dev-card-smoke.mjs` | 客户端卡片：静态 SSR（断言无 `<img>`）、status/capture 契约、近实时的网络部分。 |
| `node scripts/dev-panel-smoke.mjs` | 面板组件、尺寸模式、边框样式、停靠/触发/胶囊逻辑（纯静态）。 |
| `node scripts/dev-logs-smoke.mjs` | `ios_sim_logs` 的 snapshot/follow、过滤器、上限、进程回收。 |
| `node scripts/dev-uitree-smoke.mjs` | UI 树工具：AXe 解析/下载管线、选择器、真实模拟器上的树与点击。 |
| `node scripts/dev-debug-smoke.mjs` | 调试工具：进程、调用栈（lldb + sample）、泄漏、App 信息。 |
| `node scripts/dev-preview-smoke.mjs` | 预览热重载：启动、编辑 → 不重启的热替换、错误恢复、停止。 |
| `node scripts/dev-orphan-smoke.mjs` | 宿主被异常杀死后孤儿 serve-sim 的收养/回收。 |

## 致谢与许可证

- [serve-sim](https://github.com/EvanBacon/serve-sim) —— Evan Bacon —— 模拟器推流引擎（Apache-2.0；随包安装的运行时依赖）。
- [AXe](https://github.com/cameroncooke/AXe) —— Cameron Cooke —— UI 树工具所依赖的无障碍 CLI（MIT）。
- 架构受 Codex 的 “Build iOS Apps” 插件启发；SwiftUI 预览引擎是对其公开文档所述方案的洁净室（clean-room）重实现，未复制任何 Codex 代码。
- 完整声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

**许可证**：MIT
