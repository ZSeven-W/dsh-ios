<p align="center">
  <img src="./docs/images/dsh-ios-logo.png" alt="DSH iOS" width="120" />
</p>

<h1 align="center">DSH iOS 시뮬레이터</h1>

<p align="center">
  <strong><a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 대화 안의 실시간 인터랙티브 iOS 시뮬레이터 — USB로 연결한 실제 iPhone까지.</strong><br />
  <sub>21개 agent 도구 &bull; 실시간 MJPEG 사이드바 패널 &bull; 시뮬레이터 &amp; USB 연결 실제 iPhone &bull; 목록/피드 행 작업 &bull; SwiftUI 미리보기 핫 리로드</sub>
</p>

<p align="center">
  <sub>npm: <code>@zseven-w/dsh-ios</code> &middot; 현재 plugin 릴리스: <code>0.1.0-rc.1</code> &middot; DSH <code>0.1.0-rc.6</code>에서 테스트됨</sub>
</p>

<p align="center">
  <a href="./README.md">English</a> &middot;   <a href="./README.zh.md">简体中文</a> &middot;   <a href="./README.zh-TW.md">繁體中文</a> &middot;   <a href="./README.ja.md">日本語</a> &middot;   <b>한국어</b> &middot;   <a href="./README.fr.md">Français</a> &middot;   <a href="./README.es.md">Español</a> &middot;   <a href="./README.de.md">Deutsch</a> &middot;   <a href="./README.pt.md">Português</a> &middot;   <a href="./README.ru.md">Русский</a> &middot;   <a href="./README.hi.md">हिन्दी</a> &middot;   <a href="./README.tr.md">Türkçe</a> &middot;   <a href="./README.th.md">ไทย</a> &middot;   <a href="./README.vi.md">Tiếng Việt</a> &middot;   <a href="./README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <sub>rc: <code>0.1.0-rc.1</code>은 아직 npm에 게시되지 않았습니다 — <a href="#dsh에-설치">설치</a> 참조</sub>
</p>

<br />

<p align="center">
  <img src="./docs/images/dsh-ios-overview.png" alt="DSH iOS Simulator — a real iPhone inside the conversation" width="100%" />
</p>
<p align="center"><sub>DSH 대화 안에서 실제 기기를 조작 — 왼쪽은 에이전트의 도구 호출, 오른쪽은 실시간 디바이스 패널</sub></p>

## DSH iOS 시뮬레이터를 사용하는 이유

DSH iOS 시뮬레이터는 agent에게 대화 안의 진짜 iOS 시뮬레이터를 제공하고, 여러분에게는 그 픽셀을 그대로 보여 줍니다. agent는 기기를 부팅하고, Xcode 프로젝트나 Swift 패키지를 빌드·실행하고, 접근성 identity 또는 OCR 텍스트로 UI를 조작하고, 통합 로그를 읽고, 프로세스·백트레이스·누수를 검사할 수 있습니다. 그동안 기기의 실시간 스트림은 상시 사이드바 패널에 렌더링되므로, 여러분은 영상 위에서 바로 탭하고, 드래그하고, 회전하고, 홈 버튼을 누를 수 있습니다. 같은 동작은 USB로 연결한 실제 iPhone에서도 그대로 사용할 수 있습니다. plugin은 휴대폰에서 WebDriverAgent를 빌드·실행하고, 제어 및 화면 포트를 루프백으로 터널링한 뒤, 기기를 동일한 패널·카드·도구로 스트리밍합니다. 이미지 블록도 화면 녹화 파일도 없습니다. 시각 데이터는 DSH 웹서버가 제공하는 서명되고 만료되는 URL을 통해서만 UI에 도달합니다.

| | |
| --- | --- |
| 🖥️ **대화 속 실시간 시뮬레이터** | 부팅된 기기의 serve-sim MJPEG 스트림을 서명된 `/_dsh/dsh-ios/*` 라우트로 프록시해 상시 표시되는 오른쪽 패널에 전달합니다 — 브라우저는 serve-sim의 포트에 절대 접근하지 않습니다. |
| 📱 **USB 연결 실제 iPhone** | `ios_real_start_wda`가 연결된 휴대폰에서 WebDriverAgent를 빌드·실행하고 제어(REST) 및 화면(MJPEG) 포트를 루프백으로 터널링합니다. 이후 동일한 패널·도구·카드·상태 캡슐이 휴대폰을 조작합니다. 기기는 잠금 해제 상태여야 하며, 실제 계정에 대한 모든 탭은 plugin의 '탭 전 식별' 규칙에 의해 보호됩니다. |
| 🛠️ **21개 agent 도구** | 기기 목록, 부팅/종료, 스크린샷, 상호작용, 빌드 및 실행, 통합 로그, AXe 기반 UI 트리 + 요소별 탭, 목록/피드 행 작업, Vision OCR 찾기/탭, SwiftUI 미리보기 핫 리로드, 프로세스, 백트레이스, 누수 분석, 앱 정보. |
| 👆 **인터랙티브 패널** | 실시간 영상에서 탭·드래그, 홈/회전/스크린샷/새로고침 아이콘 툴바(호버 툴팁), 크기 모드(适应 · 50–125% · S/M/L), 프레임 스타일(无框 / 边框 / 真机框), 최대 960px까지 드래그 크기 조절 및 더블클릭 리셋, 가로 모드 자동 확장. |
| 🧾 **목록 및 피드 행** | `ios_sim_ui_rows`는 심층 접근성 스냅샷을 라벨과 범용적으로 파싱된 카운터가 있는 인덱스 행으로 변환합니다. `ios_sim_tap_row`는 행 내부의 상대 좌표를 탭하고, 카운터의 기대 ±1 변화로 동작을 검증합니다 — 목록 앱이 제공할 수 있는 유일하게 신뢰할 수 있는 확인 수단입니다. |
| 🔐 **루프백 전용 전송** | serve-sim은 전용 포트 범위에서 127.0.0.1에만 바인딩합니다. 모든 라우트는 루프백 피어, 루프백 `Host`, Fetch-Metadata/Origin 검사를 요구하며, HMAC capability는 10분 내에 만료됩니다. 실기기의 WebDriverAgent 제어/MJPEG 터널도 같은 펜스 아래의 루프백 `iproxy` 포워딩입니다. |
| ⚡ **SwiftUI 미리보기 핫 리로드** | `ios_sim_preview`는 패키지 밖에 일회용 호스트 앱을 생성하고, 미리보기를 dylib으로 빌드한 뒤, 재실행 없이 실행 중인 시뮬레이터에 수정 사항을 핫 스왑합니다(약 2–5초). |
| 🧭 **시맨틱 UI 자동화** | `ios_sim_ui_tree`가 접근성 트리(AXe 기반)를 덤프하고 `ios_sim_tap_element`가 라벨이나 identifier로 탭합니다. 트리가 비어 있거나 퇴화한 경우 `ios_sim_find_text`가 화면을 OCR하고 `ios_sim_tap_text`가 일치하는 텍스트를 탭합니다 — 좌표 추측이 아닌 identity·텍스트 기반 탭입니다. |

## 도구

21개 도구는 모두 모든 호스트에 등록되며 순수 JSON만 반환합니다. 시각 데이터는 `presentationMeta` + 서명된 라우트를 통해서만 UI에 도달하며, 이미지 블록으로는 절대 반환되지 않습니다. 시뮬레이터 udid는 자동으로 simctl/serve-sim을 거치고, 실기기 udid는 자동으로 WebDriverAgent를 거칩니다. macOS가 아닌 호스트(또는 serve-sim을 확인할 수 없는 경우)에서도 도구는 등록된 채로 남아 있지만, 호출하면 설명이 담긴 오류와 함께 실패합니다. 유일한 예외는 `ios_sim_preview`의 `status`로, 어느 호스트에서든 `{ running: false }`를 정직하게 보고합니다.

### 핵심 시뮬레이터 도구

| 도구 | 역할 | 주요 매개변수 |
| --- | --- | --- |
| `ios_sim_devices` | 이 Mac에서 사용할 수 있는 iOS 시뮬레이터 기기 목록(udid, 이름, 런타임, 상태)과 부팅된 기기를 나열하고, USB로 연결된 실제 iPhone도 `realDevices`(udid, name, osVersion, model, state, developerMode)로 함께 표시합니다. 다른 도구에 전달할 udid나 이름을 찾는 데 사용하세요. | — |
| `ios_sim_boot` | 기기를 부팅하고 실시간 serve-sim 스트림을 시작합니다. 스트림은 대화가 진행되는 동안 유지되어 패널이 시뮬레이터를 실시간으로 보여 줄 수 있습니다. | `udid` (필수 — udid 또는 기기 이름) |
| `ios_sim_shutdown` | 기기를 종료합니다. 스트림이 해당 기기를 대상으로 하고 있으면 함께 중지합니다. | `udid` (필수) |
| `ios_sim_screenshot` | PNG를 캡처하고 간단한 JSON 요약(경로, 바이트, 크기, 기기)을 반환합니다. 이미지는 카드/패널에 렌더링되며 이미지 블록으로는 절대 반환되지 않습니다. 스트리밍 중인 시뮬레이터와 USB로 연결된 휴대폰(WebDriverAgent 경유) 모두에서 동작합니다. | `udid` (선택 — 스트리밍 중인 기기, 없으면 첫 번째로 부팅된 기기) |
| `ios_sim_interact` | 스트리밍 중인 기기(시뮬레이터 또는 USB로 연결된 휴대폰)와 상호작용합니다. 0..1 정규화 좌표 탭, 텍스트 입력(시뮬레이터는 미국식 키보드), 하드웨어 버튼 누르기(`home`, `lock`, `volumeUp`…), 스크롤, 터치 제스처 전송이 가능하며, 동작이 안정된 뒤(약 300ms) 새 스크린샷으로 결과를 보여 줍니다. | `action` (필수 — `tap`/`type`/`button`/`gesture`/`scroll`), `x`/`y`, `text`, `name`, `json` |
| `ios_sim_list_apps` | 부팅된 시뮬레이터나 연결된 휴대폰에 **설치된** 앱을 나열합니다(bundle id, 표시 이름, 버전, 시스템 여부). 서드파티 bundle id는 추측할 수 없으므로 목록에서 확인하거나 `ios_sim_launch_app`에 `name`을 전달하세요. 목록 조회가 실패하면 빈 목록 대신 오류를 던지므로(예: "the device is not reachable by CoreDevice"), `count: 0`은 항상 기기에 일치하는 앱이 정말 없다는 뜻입니다. | `udid` (선택), `query` (표시 이름과 bundle id 모두에 대한 대소문자 무시 부분 문자열, CJK 포함), `include_system` (기본값 false) |
| `ios_sim_launch_app` | 부팅된 시뮬레이터나 연결된 휴대폰에서 설치된 앱을 실행합니다 — `bundleId`로 지정하거나 `name`(동일한 목록 조회로 해석되는, 표시 이름의 대소문자 무시 부분 문자열, CJK 포함)으로 지정합니다. 둘 중 정확히 하나만 사용해야 합니다. 실행 실패와 모호한 이름 모두 다음에 할 일이 함께 반환됩니다(소스에서 빌드하려면 `ios_sim_build_run`). | `bundleId` 또는 `name` (둘 중 하나), `udid`, `relaunch` |
| `ios_sim_build_run` | 시뮬레이터용으로 `.xcodeproj`, `.xcworkspace` 또는 Swift 패키지를 빌드하고, 빌드된 `.app`을 설치한 뒤 실행합니다. 실기기 udid를 전달하면 휴대폰에서 대신 빌드·설치·실행합니다(Apple Development 서명 필요). 실패하면 결과에 필터링된 `xcodebuild` 오류 후반부가 포함됩니다. 전체 빌드는 몇 분이 걸립니다. | `projectPath` (필수), `scheme`, `udid` (스트리밍 중인 기기 → 부팅된 기기 → 최신 런타임 iPhone 순으로, 선택된 기기가 부팅됨), `configuration` (기본값 `Debug`) |
| `ios_real_start_wda` | USB로 연결된 실제 iPhone에서 WebDriverAgent(WDA)를 시작합니다 — 실기기 전용이며 시뮬레이터에는 절대 사용하지 않습니다. 이미 실행 중인 WDA가 응답하면 그대로 사용하고, 그렇지 않으면 `xcodebuild` 빌드/실행을 수행합니다(콜드 빌드는 몇 분 소요). 그런 다음 WDA가 준비 상태를 보고할 때까지 기다렸다가, 실시간 패널이 스트리밍에 사용하는 제어/MJPEG 포트를 반환합니다. `ios_sim_screenshot` / `ios_sim_interact` / `ios_sim_ui_tree` / `ios_sim_tap_element`가 해당 기기에서 WDA가 실행 중이 아니라고 보고하면 이 도구를 먼저 실행하세요. | `udid` (필수 — `ios_sim_devices.realDevices`의 실기기 udid) |

### UI 트리 도구 (AXe 기반)

| 도구 | 역할 | 주요 매개변수 |
| --- | --- | --- |
| `ios_sim_ui_tree` | 최전면 앱의 접근성 요소 트리(라벨, identifier, 값, 기기 포인트 단위 frame)와 포인트 단위 화면 크기를 덤프합니다 — 시뮬레이터에서는 AXe, USB로 연결된 휴대폰에서는 WebDriverAgent를 사용합니다(휴대폰은 기본적으로 깊이 제한: 바쁜 앱의 무제한 스냅샷은 약 32초 / 751KB, 제한 시 약 2초). 출력은 약 40KB로 제한됩니다(가장 깊은 레벨을 잘라내고 `truncated` + 힌트 설정). | `udid` (선택), `max_depth`, `filter` (라벨/identifier/타입에 대한 대소문자 무시 부분 문자열) |
| `ios_sim_tap_element` | identity로 요소를 탭합니다 — 정확히 일치하는 항목을 먼저 찾고, 없으면 `identifier`/`label`에 대해 대소문자 무시 부분 문자열로 찾습니다. 중첩된 중복 요소는 하나의 대상으로 합쳐지고, 모호한 일치가 있으면 모든 후보를 나열합니다. 탭은 요소 중앙에 착지하며(시뮬레이터는 AXe HID, 휴대폰은 WebDriverAgent), 약 300ms 후 스크린샷으로 결과를 보여 줍니다. `expect_text` / `expect_gone`을 전달하면 탭과 검증이 한 번의 왕복으로 합쳐집니다(`expected.matched`). | `udid` (선택), `identifier`, `label`, `expect_text`, `expect_gone` |

### 목록 및 피드 행

목록/피드 앱은 각 항목을 하나의 접근성 셀로 합치는데, 그 라벨에는 전체 요약과 모든 카운터("57 回复。18 喜欢。592 次查看")가 들어 있습니다 — 매칭할 컨트롤별 하위 버튼이 없고, 행 셀은 심층 스냅샷에서만 나타납니다. 아래 두 도구는 이 구조를 '행'으로 노출하고 행 내부에서 동작합니다.

| 도구 | 역할 | 주요 매개변수 |
| --- | --- | --- |
| `ios_sim_ui_rows` | 최전면 앱의 보이는 목록/피드 행을 원시 트리 대신 행 단위로 읽습니다. 각 행은 인덱스, 포인트 단위 frame, 합쳐진 라벨, 그리고 라벨에서 파싱한 카운터(숫자 + 분류 토큰, 예: `57 回复` → 回复=57, 중국어 또는 영어 — 앱별 어휘는 하드코딩하지 않음)를 보고합니다. 행은 심층 스냅샷에서만 나타납니다. 휴대폰에서는 기본 `max_depth`가 60이고 호출당 약 15–25초 / ~0.5MB가 소요됩니다(WDA는 요청을 직렬로 처리) — 저렴한 관찰 도구(`ios_sim_find_text` / `ios_sim_ui_tree`)를 먼저 사용하세요. 카운터는 휴리스틱으로 파싱되며 키는 그대로 왕복합니다. `ios_sim_tap_row.expect_count`에는 목록에 표시된 그대로의 키를 전달하세요. 행을 찾지 못하면 결과에 이유가 표시됩니다(깊이가 너무 얕음 / 목록 화면이 아님 / 심층 읽기 후에도 정말 접근성 정보 없음). 얕은 읽기가 '앱에 접근성 정보가 없다'고 보고되는 일은 절대 없습니다. 화면 밖 행은 제외되고 `omittedOffscreen`으로 집계됩니다. | `udid` (선택), `max_depth` (휴대폰 전용; 기본값 60) |
| `ios_sim_tap_row` | 보이는 목록 행 하나의 내부 상대 위치를 탭합니다(`ios_sim_ui_rows`가 보고한 행: 0 기반 인덱스, x/y는 해당 행 frame의 비율 — 0 = 왼쪽/위쪽 가장자리, 1 = 오른쪽/아래쪽, 기본값 0.5 = 중앙). 시뮬레이터(AXe)와 USB로 연결된 휴대폰(WebDriverAgent) 모두에서 동작합니다. 행 frame은 새로 읽은 트리에서 가져오므로 절대 화면 좌표를 추측하지 않습니다. 범위를 벗어난 인덱스는 실패합니다(절대 잘라 맞추지 않음). 안전 장치: `expect_count={key,delta}`를 전달하면 도구가 행 라벨을 다시 읽어 카운터가 정확히 +1/−1만큼 변했는지 확인하여 동작을 검증합니다(`countCheck.verified`). 키가 해당 행의 파싱된 카운터에 없으면 탭은 실행되기 전에 거부됩니다 — 실기기 탭은 결코 탐색용이 아닙니다. `expect_count` 없이도 탭은 실행되지만(명시적인 행 기준 상대 위치 자체가 식별 수단) 아무것도 검증되지 않습니다. | `udid` (선택), `index` (필수), `x`, `y` (0..1 비율), `max_depth`, `expect_count` (`{key, delta}`) |

### OCR 도구 (Vision)

| 도구 | 역할 | 주요 매개변수 |
| --- | --- | --- |
| `ios_sim_find_text` | plugin이 컴파일한 Vision 헬퍼로, 부팅된 시뮬레이터나 USB로 연결된 휴대폰의 **현재** 화면을 OCR합니다(정확한 인식, zh-Hans + en-US, 첫 사용 시 `swiftc`로 `~/Library/Caches/dsh-ios/bin/ocr`에 컴파일). 접근성 트리가 비어 있거나 퇴화한 경우, 그래픽으로 렌더링된 텍스트(배지 숫자, 이미지에 박힌 가격)에, 또는 화면의 내용을 독립적으로 확인할 때 사용하세요. 새 스크린샷을 캡처하고 `{device, size, items:[{text, confidence, rect}]}`를 반환합니다 — rect는 기기 포인트 단위 박스(원점은 왼쪽 위)이며 신뢰도순으로 정렬되고 약 40KB로 제한됩니다(`truncated`는 신뢰도가 가장 낮은 꼬리를 버림; `query`로 좁히거나 `min_confidence`를 올리세요). | `udid` (선택), `query` (대소문자 무시 부분 문자열), `min_confidence` (기본값 0.3) |
| `ios_sim_tap_text` | **현재** 화면을 OCR하고 가장 잘 일치하는 텍스트의 중앙을 탭합니다 — `ios_sim_tap_element`와 동일한 '정확히 일치 → 대소문자 무시 포함 → 후보 목록 모호성' 규칙을 따르며, 접근성 트리가 볼 수 없는 텍스트(a11y가 없는 앱, 배지 숫자, 이미지에 박힌 텍스트)를 대상으로 합니다. 휴대폰에서는 WebDriverAgent를 통해 절대 기기 포인트에 탭이 착지하고, 스트리밍 중인 시뮬레이터에서는 serve-sim 제어를 통해 정규화된 좌표로 전송됩니다(먼저 `ios_sim_boot` 실행). 약 300ms 후 새 스크린샷으로 결과를 보여 줍니다. `expect_text` / `expect_gone`을 전달하면 탭과 검증이 한 번의 왕복으로 합쳐집니다(`expected.matched`). 실제 기기에서는 모든 탭에 실제 결과가 따릅니다 — 미식별 컨트롤이 무엇을 하는지 알아내려고 탭하는 일은 절대 하지 마세요. | `udid` (선택), `query` (필수), `min_confidence`, `expect_text`, `expect_gone` |

### 로그 도구

| 도구 | 역할 | 주요 매개변수 |
| --- | --- | --- |
| `ios_sim_logs` | 시뮬레이터 앱이 출력하는 내용을 기기 통합 로그에서 읽습니다. `snapshot`(`log show --last <duration>`, 기본값 2m) 또는 `follow`(`duration_seconds` 동안의 유한한 실시간 캡처, 기본값 10, 최대 60 — 절대 멈추지 않는 스트림이 아님). 출력은 약 300줄 / 30KB로 제한되며 좁히는 힌트가 함께 제공됩니다. | `udid` (선택), `mode` (`snapshot`/`follow`), `duration`, `duration_seconds`, `bundle_id`, `predicate` (원시 NSPredicate, `bundle_id`보다 우선), `level` (`default`/`info`/`debug`), `grep` |

### 미리보기 도구

| 도구 | 역할 | 주요 매개변수 |
| --- | --- | --- |
| `ios_sim_preview` | 시뮬레이터에서 실시간으로 동작하는 SwiftUI 미리보기 핫 리로드입니다. `start`(기본값)는 패키지를 검증하고, plugin 캐시에 일회용 호스트 앱을 생성하고(패키지 안에는 절대 생성하지 않음), 패키지를 시뮬레이터용 dylib으로 빌드하고, 호스트를 설치·실행한 뒤 소스를 감시합니다 — 편집할 때마다 재실행 없이 다시 빌드하고 핫 스왑합니다(약 2–5초). 컴파일 오류가 나면 마지막으로 성공한 미리보기를 유지하고 `status`를 통해 알려 줍니다. 한 번에 하나의 세션만 실행됩니다. | `packagePath` (`start`에 필수), `udid`, `action` (`start`/`status`/`stop`), `previewFilter` (미리보기 이름에 대한 대소문자 무시 부분 문자열) |

### 디버그 도구

| 도구 | 역할 | 주요 매개변수 |
| --- | --- | --- |
| `ios_sim_processes` | 시뮬레이터 하나의 실행 중인 앱 프로세스를 해당 시뮬레이터 자체 launchd에서 나열합니다(호스트에서 보이는 pid, 이름, bundle id) — 백트레이스/누수 분석의 pid 출처입니다. 실기기 udid를 전달하면 devicectl을 통해 휴대폰의 프로세스를 나열합니다. | `udid` (선택), `filter` (이름/bundle id에 대한 대소문자 무시 부분 문자열) |
| `ios_sim_backtrace` | 일회성 배치 LLDB(attach → 스레드 백트레이스 → detach, 대화형 아님)입니다. 출력은 약 200줄로 제한되며 메인 스레드가 먼저 나오고, 대상 프로세스는 항상 재개되었는지 확인됩니다. macOS가 attach를 거부하면(개발자 모드 꺼짐) 프로세스를 멈추지 않는 Xcode의 `sample` 엔진으로 저하되고 활성화 힌트를 보고합니다. 시뮬레이터 전용 — 실기기는 이유와 함께 거부됩니다. | `udid` (선택), `pid` / `bundle_id`, `all_threads` (기본값 true) |
| `ios_sim_leaks` | Xcode의 `leaks` 도구로 누수를 분석합니다. `summary`(누수 개수, 총 누수 바이트, 상위 약 30개 유형) 또는 `memgraph`(Xcode Instruments에서 열 수 있는 `.memgraph` 아티팩트, 여기서는 절대 파싱하지 않음)를 사용합니다. 스캔 중 앱은 일시 중지되며 항상 재개됩니다. 시뮬레이터 전용. | `udid` (선택), `pid` / `bundle_id`, `mode` (`summary`/`memgraph`) |
| `ios_sim_app_info` | 설치된 앱의 정보: 앱 번들 경로, 쓰기 가능한 데이터 컨테이너, Info.plist 값 — 시뮬레이터에서는 `simctl appinfo`(`get_app_container` 폴백 포함), USB로 연결된 휴대폰에서는 `devicectl`을 사용합니다. 앱이 없으면 `installed: false`와 함께 `ios_sim_list_apps`를 안내하는 `note`가 반환됩니다. | `udid` (선택), `bundle_id` (필수) |

## 표시 영역

- **사이드바 패널 — “iOS 模拟器”.** 실시간 화면은 상시 표시되는 오른쪽 패널(대화를 옆으로 밀어내는 고정 도크, 좁은 뷰포트에서는 중앙 오버레이)에 있습니다. 패널은 실시간 MJPEG 스트림을 렌더링하며 영상 위에서 바로 클릭 탭과 드래그 제스처를 받아들이고, 홈·스크린샷·회전·새로고침 아이콘 툴바의 버튼에는 호버 툴팁이 표시됩니다. 크기 컨트롤은 **适应**(패널 너비에 맞춤), 기기 논리 너비의 **50–125%** 확대/축소, 기기의 짧은 변을 기준으로 크기를 정하는 **S / M / L** 프리셋(세로 모드에서는 너비; 가로 모드에서는 기기의 물리적 크기가 유지되도록 스케일)을 제공합니다. 프레임 스타일은 **无框 / 边框 / 真机框**(프레임 없음 / 베젤 / 실제 기기 셸)이며 모서리 반경은 비례합니다. 기기가 가로로 회전하면 패널은 편안한 크기로 자동 확장되고, 다시 세로로 돌아오면 기존 너비를 복원합니다 — 그 사이에 사용자가 수동으로 드래그했다면 수동 너비가 항상 우선합니다. 왼쪽 가장자리 핸들로 패널을 넓히거나 좁힐 수 있습니다(최대 960px; 더블클릭하면 기본 너비로 리셋). USB로 연결된 iPhone이 스트림 대상일 때는 같은 패널이 동일한 컨트롤과 함께 휴대폰의 WebDriverAgent MJPEG 스트림을 표시합니다.
- **컴팩트 대화 카드.** 도구 결과는 인라인 이미지 없이 한 줄 카드로 렌더링됩니다. 통일된 **“iOS 模拟器”** 제목, 동작 서브 라벨(Boot / Screenshot / Interact / Build &amp; Run / Start WDA), 기기 이름, 상태 배지, '사이드바에서 열기' 안내로 구성됩니다. 행을 클릭하면 패널이 열리며, 버튼·링크·실시간 프레임 자체를 클릭해도 패널은 열리지 않습니다.
- **입력창 위의 상태 캡슐.** 패널이 닫혀 있고 스트림이 온라인일 때, 컴포저 위에 작은 초록 점 알약(`<기기> · 实时`)이 나타나며 클릭하면 패널이 열립니다. 세션 게이트가 적용되어, 현재 대화에 시뮬레이터 결과가 마운트된 동안에만 렌더링·폴링하며 결과가 없는 세션으로 전환하면 중지됩니다.
- **표준 모드와 Code 모드.** 표준 세션은 호스트가 투사한 `presentationMeta`를 사용합니다. 중첩된 Code 모드(PTC) 디스패치는 meta를 전달하지 않으므로, 클라이언트가 영구 결과 JSON에서 동일한 meta를 재구성합니다 — 패널, 카드, 캡슐 모두 두 모드에서 동작합니다.

## 보안

- 브라우저는 serve-sim의 포트와 절대 통신하지 않습니다. 모든 바이트는 plugin 소유의 `/_dsh/dsh-ios/*` 라우트를 통해 DSH 웹서버 오리진을 경유합니다: `/stream/<token>` (MJPEG 프록시), `/screenshot/<token>` (캐시된 PNG), `/ws?token=…` (HID 제어 릴레이), 그리고 `/grant`, `/capture`, `/status` 엔드포인트.
- 토큰은 HMAC-SHA256 capability(`base64url(payload).base64url(mac)`)로 10분 내에 만료되며, DSH 홈별 키(`<DSH_HOME>/cache/dsh-ios/stream-access.key`, 0600, 원자적으로 생성)로 서명됩니다.
- 모든 라우트는 capability를 확인하기 전에 루프백/신뢰 전송 펜스를 적용합니다: 루프백 피어 주소, 루프백 `Host`(DNS 리바인딩 거부), Fetch-Metadata/Origin 검사. 스크린샷 라우트는 plugin 캐시 디렉터리 안의 파일만 제공합니다(심볼릭 링크 거부, `realpath` 포함 여부 검사).
- serve-sim은 루프백에서만 전용 포트 범위(3181–3244)로 포그라운드 자식 프로세스로 실행되므로, 사용자 자신의 3100 포트 serve-sim은 절대 건드리지 않습니다. `--host`는 사용되지 않습니다.
- **실기기 전송** — WebDriverAgent 제어(REST, 기기 포트 8100)와 화면(MJPEG, 포트 9100) 터널은 USB 링크 위의 루프백 `iproxy` 포워딩입니다. 동일한 서명 라우트 펜스 뒤에 있으며, 브라우저는 여전히 DSH 웹서버 오리진과만 통신합니다.
- **고아 프로세스 인수/회수** — 이전 DSH 호스트가 정상 종료되지 못해 죽었는데 serve-sim 헬퍼가 살아남았다면, 같은 기기를 인수합니다(고아 프로세스의 핸드셰이크가 기준). 다른 기기의 슬롯을 차지한 낡은 헬퍼는 `serve-sim -k`로 회수하고 한 번 재실행합니다.
- **Keep-alive + 유휴 중지** — 크래시된 스트림은 백그라운드에서 재시작됩니다(약 5초 지연). 소비자가 0명이면 스트림은 5분 후 자동으로 중지됩니다. 의도적인 중지는 절대 되돌리지 않습니다. (실기기 러너는 의도적으로 유휴 회수에서 제외됩니다. 재시작에는 몇 분짜리 `xcodebuild` 재빌드가 필요하기 때문입니다.)

## 요구 사항

- **전체 Xcode가 설치된 macOS** — Command Line Tools만으로는 부족합니다. `xcodebuild`, `xcrun simctl`, 시뮬레이터 런타임은 모두 Xcode와 함께 제공됩니다.
- **Xcode에 iOS 시뮬레이터 런타임이 하나 이상** 설치되어 있어야 합니다.
- 패널에는 **웹 번들이 포함된 DSH ≥ 0.1.0-rc.6**이 필요합니다. 헤드리스 프로필에서도 사용할 수 있습니다. 21개 도구가 모두 정상적으로 동작하며, 실시간 화면만 제공되지 않습니다.
- **macOS가 아닌 호스트**: plugin은 로드되고 21개 도구가 모두 등록되지만, 모든 호출이 설명이 담긴 오류를 반환합니다(`iOS Simulator requires macOS with Xcode …`).
- **serve-sim**은 이 plugin의 npm 의존성으로 함께 배포되므로 실제 설치에서는 로컬로 해석됩니다. 개발 트리에서는 `npx -y serve-sim` 폴백이 사용됩니다(첫 사용 시 네트워크 필요).
- **AXe** (선택 — AXe 기반 도구에만 필요: `ios_sim_ui_tree` / `ios_sim_tap_element`, 그리고 시뮬레이터에서의 `ios_sim_ui_rows` / `ios_sim_tap_row`): `brew install cameroncooke/axe/axe`로 설치하거나, plugin이 고정 릴리스(v1.8.0, SHA-256 검증)를 `~/Library/Caches/dsh-ios/bin`에 자동 다운로드하게 하세요. `DSH_IOS_AXE_BIN`으로 해석 경로를 재정의할 수 있고, `DSH_IOS_AXE_OFFLINE=1`은 다운로드를 비활성화합니다.
- **Vision OCR** (선택 — `ios_sim_find_text` / `ios_sim_tap_text`에만 필요): plugin이 첫 사용 시 번들된 `assets/ocr.swift`를 `swiftc`로 `~/Library/Caches/dsh-ios/bin/ocr`에 컴파일합니다(zh-Hans + en-US 인식).
- **lldb attach**에는 macOS 개발자 모드가 필요합니다. `sudo DevToolsSecurity -enable`을 한 번 실행하세요. 그 전까지 `ios_sim_backtrace`는 Xcode의 `sample` 엔진(프로세스를 멈추지 않음)을 사용하고, `ios_sim_leaks`는 활성화 힌트와 함께 저하 동작합니다.
- **실제 iPhone** — USB로 연결되고 화면이 잠금 해제된 iPhone(잠긴 화면에서는 WebDriverAgent를 시작할 수 없습니다. 자동 잠금을 '안 함'으로 설정하는 것을 고려하세요), 데이터 전송이 가능한 USB 케이블(Wi-Fi 전용 페어링은 포트 포워딩을 전달할 수 없음), 기기에서 활성화된 개발자 모드, `~/Library/Caches/dsh-ios/wda/src`의 WebDriverAgent 체크아웃(plugin은 여기에서 `WebDriverAgentRunner` scheme을 빌드합니다 — 아무것도 다운로드하거나 클론하지 않음), USB 터널용 libimobiledevice의 `iproxy`(`brew install libimobiledevice`)가 필요합니다. 첫 WDA 빌드는 서명된 WebDriverAgentRunner를 설치합니다. 메시지가 표시되면 기기에서 인증서를 신뢰하고, 무료 팀 서명 프로필이 만료되면(수명 7일) `ios_real_start_wda`를 다시 실행하세요.

## DSH에 설치

```sh
dsh plugin --profile <name> add @zseven-w/dsh-ios
dsh web
```

> **rc 참고** — `0.1.0-rc.1`은 아직 npm에 게시되지 않았습니다. 게시 전까지는 패키징된 tarball을 설치하세요:
>
> ```sh
> npm pack                                   # in this repository → dsh-ios-0.1.0-rc.1.tgz
> dsh plugin --profile <name> add /path/to/dsh-ios-0.1.0-rc.1.tgz
> dsh web
> ```

## 빠른 시작

일반적인 첫 대화 흐름:

1. **기기 확인** — “사용 가능한 시뮬레이터를 나열해 줘.” → `ios_sim_devices`.
2. **부팅** — “iPhone 17 Pro를 부팅해 줘.” → `ios_sim_boot`. 스트림이 시작되고 **“iOS 模拟器” 패널**이 열립니다. 기기가 사이드바에 실시간으로 표시됩니다. (다시 열려면 아무 시뮬레이터 카드 행이나 입력창 위의 상태 알약을 클릭하세요.)
3. **영상에서 탭** — 패널에서 바로 탭하거나 드래그하거나, agent가 UI를 조작하게 합니다: “설정을 연 다음 일반을 탭하세요.” → `ios_sim_interact` (identity 기반 탭은 `ios_sim_ui_tree` + `ios_sim_tap_element`, 텍스트 기반 탭은 `ios_sim_find_text` + `ios_sim_tap_text`, 목록/피드 앱은 `ios_sim_ui_rows` + `ios_sim_tap_row`).
4. **앱 빌드 및 실행** — “/path/to/MyApp.xcodeproj를 빌드하고 실행해 줘.” → `ios_sim_build_run`. 전체 빌드는 몇 분이 걸리며, 완료되면 앱이 시뮬레이터에서 실행되고 패널에서 실시간으로 확인할 수 있습니다.
5. **미리보기 핫 리로드** — “/path/to/MyPackage의 SwiftUI 미리보기를 보여 줘.” → `ios_sim_preview start`. 소스 파일을 수정하면 재실행 없이 약 2–5초 내에 실행 중인 시뮬레이터에 미리보기가 핫 스왑됩니다.
6. **실제 iPhone 조작** — 휴대폰을 USB(데이터 케이블)로 연결하고 잠금을 해제한 뒤 “휴대폰에서 WebDriverAgent를 시작해 줘.” → `ios_real_start_wda`. 패널이 휴대폰의 실시간 스트림으로 전환되고 모든 도구가 휴대폰의 `realDevices` udid를 받아들입니다. 호출이 실패하면 패널 상태에서 코드화된 원인을 확인하세요(`device-locked`, `cert-untrusted`, `profile-expired`, `tunnel-failed`, `device-unplugged`).

## 문제 해결

- **백트레이스가 lldb 대신 `sample`을 사용하거나 leaks가 검사 제한을 불평하는 경우** — macOS 개발자 모드가 꺼져 있습니다. `sudo DevToolsSecurity -enable`을 한 번 실행하고 다시 시도하세요. 그 전까지 도구는 깔끔하게 저하 동작합니다. `ios_sim_backtrace`는 Xcode의 `sample`(심볼화, 프로세스 중단 없음)로 폴백하고, `ios_sim_leaks`는 활성화 힌트를 보고합니다.
- **`ios_sim_ui_tree` / `ios_sim_tap_element`에 AXe가 필요한 경우** — `brew install cameroncooke/axe/axe`로 설치하거나, plugin이 첫 사용 시 고정 릴리스를 다운로드하게 하세요(github.com 네트워크 필요). 오류 메시지에는 항상 전체 설치 힌트가 포함되어 있으며, `DSH_IOS_AXE_BIN=/path/to/axe`로 해석 경로를 재정의할 수 있습니다. 행 도구(`ios_sim_ui_rows` / `ios_sim_tap_row`)도 시뮬레이터에서는 AXe가 필요합니다.
- **`ios_sim_find_text` / `ios_sim_tap_text`가 OCR 헬퍼가 없다고 보고하는 경우** — 첫 사용 시 번들된 `assets/ocr.swift`를 `swiftc`로(Xcode 필요) `~/Library/Caches/dsh-ios/bin/ocr`에 컴파일합니다. 오류에는 정확한 경로와 힌트가 포함됩니다.
- **`ios_sim_ui_rows`가 행을 찾지 못하는 경우** — 결과에 이유가 표시됩니다: 깊이가 너무 얕음(`max_depth`를 올리세요. 휴대폰에서는 스냅샷 깊이를 올릴 때마다 약 15–25초 소요), 목록 화면이 아님, 또는 심층 읽기 후에도 정말 접근성 정보 없음. 얕은 읽기가 접근성 정보 부재로 잘못 보고되는 일은 절대 없습니다.
- **iOS 26.2 시뮬레이터에서의 `ios_sim_leaks`** — iOS 26.2 런타임에서는 개발자 모드가 활성화되어 있어도 Xcode의 `leaks`가 시뮬레이터 프로세스를 검사하지 못하고 `Failed to get DYLD info` 또는 minimal-corpse 같은 치명적 진단 오류를 낼 수 있습니다. 도구는 깔끔하게 저하 동작합니다: 원시 진단이 그대로 반환되고, 대상 프로세스는 항상 재개되었는지 확인되며, 아무것도 멈춰 있지 않습니다. plugin 쪽에서 고칠 수 있는 문제는 없습니다 — 증상이 나타나면 `mode: "memgraph"`나 다른 런타임을 시도하세요.
- **실기기 호출이 코드화된 상태로 실패하는 경우** — 패널의 상태가 추측 대신 원인을 알려 줍니다: `device-locked` (휴대폰 잠금 해제; 저절로 복구됨), `cert-untrusted` (기기에서 WebDriverAgent 인증서를 신뢰), `profile-expired` (무료 팀 서명은 7일 유효 — `ios_real_start_wda`를 다시 실행해 재빌드), `tunnel-failed` (USB 링크/iproxyd 확인), `device-unplugged` (데이터 전송 가능한 USB 케이블 사용 — Wi-Fi 전용 페어링은 포트 포워딩을 전달할 수 없음).
- **스트림이 저절로 멈추는 경우** — 크래시가 아니라 유휴 정책입니다. 소비자가 0명이면(패널 닫힘, 마운트된 카드 없음, 활성 라우트 없음) 스트림은 5분 후 중지되며, 다음 도구 호출이나 패널을 열 때 다시 시작됩니다. 크래시된 스트림은 약 5초 내에 백그라운드에서 재시작됩니다.

## 개발

```sh
pnpm install
pnpm run build      # host tsc + client bundle → lib/
pnpm run typecheck
```

`scripts/`의 smoke 테스트는 빌드된 `lib/`을 검증합니다(시뮬레이터를 부팅하거나 USB로 연결된 휴대폰과 통신하는 부분은 macOS 전용입니다. 해당 부분을 건너뛰려면 `DSH_IOS_SMOKE_SKIP_SIM=1`을 설정하세요):

| 스크립트 | 다루는 내용 |
| --- | --- |
| `node scripts/dev-smoke.mjs` | Sim 호스트: 바이너리 해석, 스트림 실행, 제어, keep-alive, dispose. |
| `node scripts/dev-tools-smoke.mjs [--full-build]` | 실제 시뮬레이터에 대한 핵심 도구(`--full-build`를 붙이면 실제 빌드 포함). |
| `node scripts/dev-routes-smoke.mjs` | 서명된 웹 라우트: grant, 스트림 프록시, 스크린샷, ws 릴레이, 펜스, 만료. |
| `node scripts/dev-card-smoke.mjs` | 클라이언트 카드: 정적 SSR(`<img>` 없음), status/capture 계약, 유사 실시간 네트워크 부분. |
| `node scripts/dev-panel-smoke.mjs` | 패널 컴포넌트, 크기 모드, 프레임 스타일, 도크/트리거/캡슐 로직(정적 전용). |
| `node scripts/dev-logs-smoke.mjs` | `ios_sim_logs` snapshot/follow, 필터, 제한, 프로세스 회수. |
| `node scripts/dev-uitree-smoke.mjs` | UI 트리 도구: AXe 해석/다운로드 파이프라인, 선택자, 실제 시뮬레이터 트리 + 탭. |
| `node scripts/dev-debug-smoke.mjs` | 디버그 도구: 프로세스, 백트레이스(lldb + sample), 누수 분석, 앱 정보. |
| `node scripts/dev-preview-smoke.mjs` | 미리보기 핫 리로드: 시작, 편집 → 재실행 없는 핫 스왑, 오류 복구, 중지. |
| `node scripts/dev-orphan-smoke.mjs` | 호스트가 정상 종료되지 못한 뒤의 고아 serve-sim 인수/회수. |
| `node scripts/dev-ocr-smoke.mjs` | Vision-OCR 도구: 헬퍼 해석, swiftc 컴파일 캐시, 인식 파이프라인, tap-text 라우팅. |
| `node scripts/dev-wda-smoke.mjs` | WebDriverAgent 호스트: `ServerURLHere` 파싱, 실패 분류, 터널, keep-alive(모킹됨; 선택적 실측 패스). |
| `node scripts/dev-realdevice-smoke.mjs` | USB로 연결된 iPhone에 대한 `xcrun devicectl` — 도구가 사용하는 정확한 코드 경로. |
| `node scripts/dev-realstart-smoke.mjs` | `/real-start` 라우트: 펜스, 코드화된 거부, 빌드/실행 게이팅(정적). |
| `node scripts/dev-realtools-smoke.mjs` | `ios_sim_screenshot` / `ios_sim_interact` / `ios_sim_ui_tree` / `ios_sim_tap_element`의 실기기 백엔드와 `ios_real_start_wda`. |

## 크레딧 및 라이선스

- [serve-sim](https://github.com/EvanBacon/serve-sim) — Evan Bacon — 시뮬레이터 스트리밍 엔진(Apache-2.0; 번들된 런타임 의존성).
- [AXe](https://github.com/cameroncooke/AXe) — Cameron Cooke — UI 트리 도구 뒤의 접근성 CLI(MIT).
- [WebDriverAgent](https://github.com/appium/WebDriverAgent) — plugin이 실기기에서 빌드·실행하는 WebDriver 서버(BSD 라이선스).
- 아키텍처는 Codex의 "Build iOS Apps" plugin에서 영감을 받았습니다. SwiftUI 미리보기 엔진은 공개 문서화된 접근 방식을 클린룸 방식으로 재구현한 것으로, Codex 코드는 전혀 복사되지 않았습니다.
- 전체 고지 사항은 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)를 참조하세요.

**라이선스**: MIT
