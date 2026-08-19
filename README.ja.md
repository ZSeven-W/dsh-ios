<p align="center">
  <img src="./docs/images/dsh-ios-logo.png" alt="DSH iOS" width="120" />
</p>

<h1 align="center">DSH iOS シミュレータ</h1>

<p align="center">
  <strong><a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> の会話の中に、ライブで操作可能な iOS シミュレータを組み込む——USB 接続の実機 iPhone にも対応。</strong><br />
  <sub>21 個のエージェントツール &bull; ライブ MJPEG サイドバーパネル &bull; シミュレータと USB 実機 &bull; リスト/フィードの行操作 &bull; SwiftUI プレビューのホットリロード</sub>
</p>

<p align="center">
  <sub>npm: <code>@zseven-w/dsh-ios</code> &middot; 現在のプラグインリリース: <code>0.1.0-rc.1</code> &middot; DSH <code>0.1.0-rc.6</code> で動作確認済み</sub>
</p>

<p align="center">
  <a href="./README.md">English</a> &middot; <a href="./README.zh.md">简体中文</a> &middot; <a href="./README.zh-TW.md">繁體中文</a> &middot; <b>日本語</b> &middot; <a href="./README.ko.md">한국어</a> &middot; <a href="./README.fr.md">Français</a> &middot; <a href="./README.es.md">Español</a> &middot; <a href="./README.de.md">Deutsch</a> &middot; <a href="./README.pt.md">Português</a> &middot; <a href="./README.ru.md">Русский</a> &middot; <a href="./README.hi.md">हिन्दी</a> &middot; <a href="./README.tr.md">Türkçe</a> &middot; <a href="./README.th.md">ไทย</a> &middot; <a href="./README.vi.md">Tiếng Việt</a> &middot; <a href="./README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <sub>rc: <code>0.1.0-rc.1</code> はまだ npm に公開されていません —— <a href="#dsh-にインストール">インストール</a> を参照</sub>
</p>

<br />

<p align="center">
  <img src="./docs/images/dsh-ios-overview.png" alt="DSH iOS Simulator — a real iPhone inside the conversation" width="100%" />
</p>
<p align="center"><sub>DSH の会話からそのまま実機を操作 — 左はエージェントのツール呼び出し、右はライブデバイスパネル</sub></p>

## DSH iOS シミュレータを使う理由

DSH iOS シミュレータは、エージェントに会話の中の本物の iOS シミュレータを渡し、その画面をあなたにも届けます。エージェントはデバイスの起動、Xcode プロジェクトや Swift パッケージのビルドと実行、アクセシビリティ識別子や OCR テキストによる UI 操作、統合ログの読み取り、プロセス・バックトレース・リークの調査ができ、その間ずっとデバイスのライブ映像が常駐サイドバーパネルに描画されます。パネルでは動画の上で直接タップ、ドラッグ、回転、ホームボタン押下ができます。同じ操作は USB 接続の実機 iPhone でも機能します。プラグインは電話機上で WebDriverAgent をビルドして起動し、制御ポートと画面ポートをループバック経由でトンネリングして、デバイスを同じパネル・カード・ツールに映します。画像ブロックも画面録画ファイルもありません——視覚データは DSH ウェブサーバーが署名して発行する有効期限付き URL を通してのみ UI に届きます。

| | |
| --- | --- |
| 🖥️ **会話の中のライブシミュレータ** | 起動中のデバイスの serve-sim MJPEG ストリームを、署名付きの `/_dsh/dsh-ios/*` ルート経由で常駐の右側パネルにプロキシします——ブラウザが serve-sim のポートに直接触れることはありません。 |
| 📱 **USB 接続の実機 iPhone** | `ios_real_start_wda` は接続された電話機上で WebDriverAgent をビルド・起動し、制御（REST）と画面（MJPEG）のポートをループバック経由でトンネリングします。同じパネル・ツール・カード・ステータスカプセルでそのまま実機を操作できます。デバイスはロック解除されている必要があり、実機アカウントへのタップはすべてプラグインの「識別してからタップ」ルールでガードされます。 |
| 🛠️ **21 個のエージェントツール** | デバイス一覧、起動/シャットダウン、スクリーンショット、操作、ビルド＆実行、統合ログ、AXe ベースの UI ツリーと要素タップ、リスト/フィードの行操作、Vision OCR の検索/タップ、SwiftUI プレビューのホットリロード、プロセス、バックトレース、リーク、アプリ情報。 |
| 👆 **操作可能なパネル** | ライブ映像の上でタップ＆ドラッグ。ホバーツールチップ付きの Home / 回転 / スクリーンショット / 更新アイコンツールバー、サイズモード（适应 · 50–125% · S/M/L）、フレームスタイル（无框 / 边框 / 真机框）、最大 960 px のドラッグリサイズとダブルクリックでのリセット、横向き時の自動拡幅。 |
| 🧾 **リストとフィードの行** | `ios_sim_ui_rows` は深いアクセシビリティスナップショットを、ラベルと汎用的にパースされたカウンター付きのインデックス行に変換します。`ios_sim_tap_row` は行内の相対座標をタップし、カウンターが期待どおり ±1 変化したことで操作を検証します——リスト型アプリで唯一信頼できる確認手段です。 |
| 🔐 **ループバック限定の転送** | serve-sim は専用ポート範囲の 127.0.0.1 にのみバインドします。全ルートでループバックピア、ループバック `Host`、Fetch-Metadata/Origin チェックが必須で、HMAC ケーパビリティは 10 分で失効します。。 |
| ⚡ **SwiftUI プレビューのホットリロード** | `ios_sim_preview` はあなたのパッケージの外に使い捨てのホストアプリを生成し、プレビューを dylib としてビルドして、編集内容を再起動なしで実行中のシミュレータにホットスワップします（約 2–5 秒）。 |
| 🧭 **意味ベースの UI 自動化** | `ios_sim_ui_tree` はアクセシビリティツリーをダンプし（AXe ベース）、`ios_sim_tap_element` はラベルまたは識別子でタップします。ツリーが空または縮退しているときは `ios_sim_find_text` が画面を OCR し、`ios_sim_tap_text` が一致したテキストをタップします——座標の推測ではなく、識別子ベース/テキストベースのタップです。 |

## ツール

21 個のツールはすべてどのホストでも登録され、プレーンな JSON のみを返します——視覚データは `presentationMeta` + 署名付きルートを通してのみ UI に届き、画像ブロックとして返ることは決してありません。シミュレータの udid は simctl/serve-sim を経由し、実機の udid は自動的に WebDriverAgent を経由します。非 macOS ホスト（または serve-sim が解決できない環境）でもツールは登録されたままですが、呼び出すと説明付きのエラーを返します。唯一の例外は `ios_sim_preview` の `status` で、どのホストでも正直に `{ running: false }` を返します。

### コアシミュレータツール

| ツール | 機能 | 主なパラメータ |
| --- | --- | --- |
| `ios_sim_devices` | この Mac で利用できる iOS シミュレータデバイス（udid、名前、ランタイム、状態）と起動中のものを一覧表示し、さらに USB 接続の実機 iPhone を `realDevices`（udid、名前、osVersion、model、state、developerMode）として返します。他のツールに渡す udid や名前を探すために最初に使います。 | — |
| `ios_sim_boot` | デバイスを起動し、その serve-sim ライブストリームを開始します。ストリームは会話の間ずっと維持されるため、パネルでシミュレータをライブ表示できます。 | `udid`（必須——udid またはデバイス名） |
| `ios_sim_shutdown` | デバイスをシャットダウンします。ストリームの対象がそのデバイスの場合はストリームも停止します。 | `udid`（必須） |
| `ios_sim_screenshot` | PNG を撮影し、小さな JSON サマリー（パス、バイト数、寸法、デバイス）を返します。画像はカード/パネルに描画され、画像ブロックとして返ることはありません。ストリーム配信中のシミュレータと、USB 接続の実機（WebDriverAgent 経由）の両方で使えます。 | `udid`（省略可——デフォルトはストリーム配信中のデバイス、次に最初の起動済みシミュレータ） |
| `ios_sim_interact` | ストリーム配信中のデバイス（シミュレータまたは USB 実機）を操作します。0..1 の正規化座標へのタップ、テキスト入力（シミュレータは US キーボード）、ハードウェアボタン（`home`、`lock`、`volumeUp`…）の押下、スクロール、タッチジェスチャの送信が可能で、操作が落ち着いた後（約 300 ms）に新しいスクリーンショットで結果を示します。 | `action`（必須——`tap`/`type`/`button`/`gesture`/`scroll`）、`x`/`y`、`text`、`name`、`json` |
| `ios_sim_list_apps` | 起動中のシミュレータまたは接続された実機に**インストール済み**のアプリを一覧表示します（バンドル ID、表示名、バージョン、システムアプリかどうか）——サードパーティアプリのバンドル ID は推測できないので、まず一覧表示するか、`ios_sim_launch_app` に `name` を渡します。一覧表示が失敗した場合は空リストを返すのではなくエラーを投げるので（例:「デバイスに CoreDevice から到達できません」）、`count: 0` は常に「本当に一致するアプリがない」ことを意味します。 | `udid`（省略可）、`query`（表示名とバンドル ID の両方に対する大文字小文字を区別しない部分一致、日本語・中国語含む）、`include_system`（デフォルト false） |
| `ios_sim_launch_app` | インストール済みのアプリを起動中のシミュレータまたは接続された実機で起動します——`bundleId` か `name`（同じ一覧ロジックで解決される、表示名への大文字小文字を区別しない部分一致、日本語・中国語含む）のどちらかで指定します。二つのうち必ず一方だけを渡します。起動失敗や名前の曖昧さは、次に何をすべきかを含めて返ります（ソースからビルドするには `ios_sim_build_run`）。 | `bundleId` か `name`（どちらか一方）、`udid`、`relaunch` |
| `ios_sim_build_run` | `.xcodeproj`、`.xcworkspace`、または Swift パッケージをシミュレータ向けにビルドし、生成された `.app` をインストールして起動します。実機の udid を渡すと、代わりに電話機上でビルド・インストール・起動します（Apple Development 署名が必要）。失敗時はフィルタ済みの `xcodebuild` エラー末尾が返ります。フルビルドには数分かかります。 | `projectPath`（必須）、`scheme`、`udid`（ストリーム配信中 → 起動済み → 最新ランタイムの iPhone。起動も行います）、`configuration`（デフォルト `Debug`） |
| `ios_real_start_wda` | USB 接続の実機 iPhone で WebDriverAgent（WDA）を起動します——実機専用で、シミュレータでは使えません。すでに応答中の WDA があればそれを引き継ぎ、なければ `xcodebuild` のビルド/起動を実行し（コールドビルドは数分）、WDA が準備完了を報告するまで待って、ライブパネルが使用する制御/MJPEG ポートを返します。`ios_sim_screenshot` / `ios_sim_interact` / `ios_sim_ui_tree` / `ios_sim_tap_element` がそのデバイスで WDA が動いていないと報告したら、最初にこれを実行します。 | `udid`（必須——`ios_sim_devices.realDevices` の実機 udid） |

### UI ツリーツール（AXe ベース）

| ツール | 機能 | 主なパラメータ |
| --- | --- | --- |
| `ios_sim_ui_tree` | 最前面アプリのアクセシビリティ要素ツリー（ラベル、識別子、値、ポイント単位のフレーム）と画面サイズ（ポイント）をダンプします——シミュレータは AXe、USB 実機は WebDriverAgent を使用（実機ではデフォルトで深さが制限されます。忙しいアプリの無制限スナップショットは実測で約 32 秒 / 751 KB、制限時は約 2 秒）。出力は約 40 KB が上限です（超過時は深い階層を刈り込み、`truncated` + ヒントを設定）。 | `udid`（省略可）、`max_depth`、`filter`（ラベル/識別子/型に対する大文字小文字を区別しない部分一致） |
| `ios_sim_tap_element` | 要素を識別子でタップします——まず完全一致、次に `identifier`/`label` への大文字小文字を区別しない部分一致。入れ子の重複は 1 つのターゲットにまとまり、曖昧な一致は候補をすべて列挙します。タップは要素の中心に着地し（シミュレータは AXe HID、実機は WebDriverAgent）、約 300 ms 後にスクリーンショットで結果を示します。`expect_text` / `expect_gone` を渡すと、タップと検証が 1 回のラウンドトリップになります（`expected.matched`）。 | `udid`（省略可）、`identifier`、`label`、`expect_text`、`expect_gone` |

### リストとフィードの行

リスト/フィード系アプリは各項目を 1 つのアクセシビリティセルにまとめ、そのラベルに要約全体とすべてのカウンターを含めます（「57 回复。18 喜欢。592 次查看」）。個別コントロールの子ボタンは存在せず、行セルは深いスナップショットでしか現れません。次の 2 つのツールはこの構造を行として公開し、行の内側で操作します。

| ツール | 機能 | 主なパラメータ |
| --- | --- | --- |
| `ios_sim_ui_rows` | 最前面アプリの可視リスト/フィード行を、生のツリーではなく行として読み取ります。各行はインデックス、ポイント単位のフレーム、集約されたラベル、そしてそのラベルから汎用的にパースされたカウンター（数値 + 分類語。例: `57 回复` → 回复=57。中国語または英語——アプリ固有の語彙はハードコードされていません）を報告します。行は深いスナップショットでしか現れません。実機ではデフォルトの `max_depth` は 60 で、1 回の呼び出しに約 15–25 秒 / 約 0.5 MB かかります（WDA はリクエストを直列処理します）。まず軽量な観測手段（`ios_sim_find_text` / `ios_sim_ui_tree`）を検討してください。カウンターはヒューリスティックにパースされ、キーはそのまま往復できます。`ios_sim_tap_row.expect_count` に渡すキーは、一覧表示されたとおり正確に渡してください。行が見つからない場合、結果は理由を示します（深さが足りない / リスト画面ではない / 深く読んでも本当にアクセシビリティ情報がない）。浅い読み取りが「アプリにアクセシビリティ情報がない」と報告されることは決してありません。画面外の行は除外され、`omittedOffscreen` として数えられます。 | `udid`（省略可）、`max_depth`（実機のみ。デフォルト 60） |
| `ios_sim_tap_row` | 可視リストの 1 行の内側を相対位置でタップします（行は `ios_sim_ui_rows` が報告。0 始まりのインデックス、x/y はその行のフレームに対する割合——0 = 左/上端、1 = 右/下端、デフォルト 0.5 = 中心）。シミュレータは AXe、USB 実機は WebDriverAgent を使用します。行のフレームは新しいツリー読み取りから得るため、絶対画面座標の推測は行いません。範囲外のインデックスは失敗します（クランプはしません）。安全ガード: `expect_count={key,delta}` を渡すと、行ラベルを再読み取りしてカウンターがちょうど +1/−1 変化したことを検証します（`countCheck.verified`）。キーがその行のパース済みカウンターに含まれない場合、タップは実行前に拒否されます——実機へのタップは決してプローブではありません。`expect_count` なしでもタップは実行されます（明示的な行内相対位置自体が識別です）が、検証は行われません。 | `udid`（省略可）、`index`（必須）、`x`、`y`（0..1 の割合）、`max_depth`、`expect_count`（`{key, delta}`） |

### OCR ツール（Vision）

| ツール | 機能 | 主なパラメータ |
| --- | --- | --- |
| `ios_sim_find_text` | 起動中のシミュレータまたは USB 実機の現在の画面を、プラグインがコンパイルした Vision ヘルパーで OCR します（高精度認識、zh-Hans + en-US。初回使用時に `swiftc` で `~/Library/Caches/dsh-ios/bin/ocr` にコンパイル）。アクセシビリティツリーが空または縮退している場合、テキストが画像として描画されている場合（バッジの数字、画像に焼き込まれた価格）、画面内容を独立に検証したい場合に使います。新しいスクリーンショットを撮り、`{device, size, items:[{text, confidence, rect}]}` を返します——rect はデバイスポイント単位のボックス（原点は左上）で、信頼度順にソートされ、出力上限は約 40 KB です（`truncated` は信頼度最低の末尾を落としたことを示します。`query` で絞るか `min_confidence` を上げてください）。 | `udid`（省略可）、`query`（大文字小文字を区別しない部分一致）、`min_confidence`（デフォルト 0.3） |
| `ios_sim_tap_text` | 現在の画面を OCR し、最良のテキスト一致の中心をタップします——`ios_sim_tap_element` と同じ「完全一致 → 大文字小文字を区別しない包含 → 候補リストで曖昧さを報告」ルールを、アクセシビリティツリーから見えないテキスト（a11y のないアプリ、バッジの数字、画像に焼き込まれたテキスト）に適用します。実機では WebDriverAgent 経由でデバイス絶対座標にタップが着地します。ストリーム配信中のシミュレータでは serve-sim 制御経由で正規化座標として送信されます（先に `ios_sim_boot` を実行）。約 300 ms 後に新しいスクリーンショットで結果を示します。`expect_text` / `expect_gone` を渡すと、タップと検証が 1 回のラウンドトリップになります（`expected.matched`）。実機ではすべてのタップに現実の結果が伴います——正体不明のコントロールを、動作を確かめるためにタップしてはいけません。 | `udid`（省略可）、`query`（必須）、`min_confidence`、`expect_text`、`expect_gone` |

### ログツール

| ツール | 機能 | 主なパラメータ |
| --- | --- | --- |
| `ios_sim_logs` | シミュレータのアプリが出力する内容をデバイスの統合ログから読み取ります。`snapshot`（`log show --last <duration>`、デフォルト 2m）または `follow`（`duration_seconds` の有界ライブキャプチャ。デフォルト 10、最大 60——ハングし続けることはありません）。出力は約 300 行 / 30 KB が上限で、絞り込みのヒントが付きます。 | `udid`（省略可）、`mode`（`snapshot`/`follow`）、`duration`、`duration_seconds`、`bundle_id`、`predicate`（生の NSPredicate。`bundle_id` より優先）、`level`（`default`/`info`/`debug`）、`grep` |

### プレビューツール

| ツール | 機能 | 主なパラメータ |
| --- | --- | --- |
| `ios_sim_preview` | シミュレータ内でライブに動く SwiftUI プレビューのホットリロード。`start`（デフォルト）はパッケージを検証し、プラグインキャッシュに使い捨てのホストアプリを生成し（あなたのパッケージ内には決して書き込みません）、パッケージをシミュレータ向け dylib としてビルドし、ホストをインストール・起動して、ソースを監視します——編集のたびに再ビルドして再起動なしでホットスワップします（約 2–5 秒）。コンパイルエラーでも最後に成功したプレビューは維持され、エラー末尾は `status` から確認できます。同時に動くプレビューセッションは 1 つだけです。 | `packagePath`（`start` では必須）、`udid`、`action`（`start`/`status`/`stop`）、`previewFilter`（プレビュー名への大文字小文字を区別しない部分一致） |

### デバッグツール

| ツール | 機能 | 主なパラメータ |
| --- | --- | --- |
| `ios_sim_processes` | 1 台のシミュレータの実行中アプリプロセスを、そのシミュレータ自身の launchd から一覧表示します（ホストから見える pid、名前、バンドル ID）——バックトレース/リークの pid の取得元です。実機の udid を渡すと、代わりに devicectl 経由で電話機のプロセスを一覧表示します。 | `udid`（省略可）、`filter`（名前/バンドル ID への大文字小文字を区別しない部分一致） |
| `ios_sim_backtrace` | ワンショットのバッチ LLDB（attach → thread backtrace → detach。対話的にはなりません）。出力は約 200 行が上限でメインスレッドが先頭、対象プロセスは必ず再開されたことが検証されます。macOS が attach を拒否した場合（開発者モードがオフ）は、Xcode の `sample` エンジン（サスペンドしない）にフォールバックし、有効化のヒントを報告します。シミュレータ専用——実機は理由付きで拒否されます。 | `udid`（省略可）、`pid` / `bundle_id`、`all_threads`（デフォルト true） |
| `ios_sim_leaks` | Xcode の `leaks` ツールでリークを解析します。`summary`（リーク数、リーク総バイト数、上位約 30 タイプ）または `memgraph`（Xcode Instruments で開く `.memgraph` アーティファクト。ここで解析されることはありません）。スキャン中アプリはサスペンドされますが、必ず再開されます。シミュレータ専用。 | `udid`（省略可）、`pid` / `bundle_id`、`mode`（`summary`/`memgraph`） |
| `ios_sim_app_info` | インストール済みアプリの情報: アプリバンドルパス、書き込み可能なデータコンテナ、Info.plist の値——シミュレータでは `simctl appinfo`（`get_app_container` フォールバック付き）、USB 実機では `devicectl` 経由。未インストールの場合は `installed: false` と、`ios_sim_list_apps` を案内する `note` を返します。 | `udid`（省略可）、`bundle_id`（必須） |

## 表示面

- **サイドバーパネル——「iOS 模拟器」。** ライブ映像は常駐の右側パネルに表示されます（会話を押しのける固定ドック。狭いビューポートでは中央のオーバーレイ）。パネルはライブ MJPEG ストリームを描画し、動画の上でのクリックでタップ、ドラッグでジェスチャを直接受け付けます。アイコンツールバー（Home、スクリーンショット、回転、更新）のボタンにはホバーツールチップが付きます。サイズコントロールは**适应**（パネル幅にフィット）、**50–125%**（デバイスの論理幅に対するズーム）、**S / M / L** プリセット（デバイスの短辺を基準にサイズ決定。横向きではデバイスの物理サイズが保たれるよう拡大縮小します）。フレームスタイルは**无框 / 边框 / 真机框**（フレームなし / ベゼル / 実機風の筐体）で、角丸は比例して計算されます。デバイスが横向きに回転するとパネルは快適なサイズまで自動的に広がり、縦に戻ると元の幅を復元します——その間に行った手動ドラッグは常に優先されます。左端のハンドルでパネルを広げたり狭めたりできます（最大 960 px。ダブルクリックでデフォルト幅にリセット）。USB 接続の iPhone がストリーム対象の場合、同じパネルが電話機の WebDriverAgent MJPEG ストリームを同じコントロールで表示します。
- **コンパクトな会話カード。** ツール結果はインライン画像なしの 1 行カードとして描画されます。統一された**「iOS 模拟器」**タイトル、アクションサブラベル（起動 / スクリーンショット / 操作 / ビルド＆実行 / WebDriverAgent 起動）、デバイス名、ステータスバッジ、「サイドバーで開く」キュー。行をクリックするとパネルが開きます。ボタン、リンク、ライブフレーム自体のクリックでは開きません。
- **入力欄の上のステータスカプセル。** パネルが閉じていてストリームがオンラインの間、入力欄の上に緑ドットの小さなピル（`<device>` · 实时）が表示され、クリックでパネルが開きます。セッションゲート付きで、現在の会話にシミュレータ結果がマウントされている間だけ描画・ポーリングされ、それがないセッションに切り替えると停止します。
- **標準モードと Code モード。** 標準セッションはホストが投影する `presentationMeta` を使います。ネストした Code モード（PTC）のディスパッチは meta を運ばないため、クライアントは永続化された結果 JSON から同一の meta を再構築します——パネル、カード、カプセルは両方のモードで機能します。

## セキュリティ

- ブラウザが serve-sim のポートと直接通信することはありません。すべてのバイトは DSH ウェブサーバーのオリジンにあるプラグイン所有の `/_dsh/dsh-ios/*` ルートを通ります。`/stream/<token>`（MJPEG プロキシ）、`/screenshot/<token>`（キャッシュ済み PNG）、`/ws?token=…`（HID 制御リレー）、さらに `/grant`、`/capture`、`/status` エンドポイントです。
- トークンは HMAC-SHA256 ケーパビリティ（`base64url(payload).base64url(mac)`）で 10 分以内に失効し、DSH ホームごとの鍵（`<DSH_HOME>/cache/dsh-ios/stream-access.key`、0600、原子的に作成）で署名されます。
- すべてのルートはケーパビリティを確認する前にループバック/信頼済み転送ガードを適用します。ループバックのピアアドレス、ループバック `Host`（DNS リバインディングは拒否）、Fetch-Metadata/Origin チェックです。スクリーンショットルートはプラグインキャッシュディレクトリ内のファイルのみを配信します（シンボリックリンクは拒否、`realpath` による包含チェック）。
- serve-sim はループバックのみで専用ポート範囲（3181–3244）のフォアグラウンド子プロセスとして動くため、ユーザー自身のポート 3100 の serve-sim には決して触れません。`--host` は使いません。。同じ署名付きルートのガードの内側にあり、ブラウザが通信するのは依然として DSH ウェブサーバーのオリジンだけです。
- **孤児プロセスの引き取り/回収**——以前の DSH ホストが正常終了せずに殺され、その serve-sim ヘルパーが生き残った場合、同じデバイスは引き取られます（孤児のハンドシェイクが正とみなされます）。別のデバイスのスロットに居座る古いヘルパーは `serve-sim -k` で回収され、一度だけ再起動されます。
- **キープアライブ + アイドル停止**——クラッシュしたストリームはバックグラウンドで再起動します（約 5 秒後）。コンシューマがゼロになると、ストリームは 5 分後に自動停止します。意図的な停止が妨げられることはありません。（実機ランナーは意図的にアイドル回収の対象外です。再起動には数分の `xcodebuild` 再ビルドがかかるためです。）

## 要件

- **フル Xcode が入った macOS**——Command Line Tools だけでは不十分です。`xcodebuild`、`xcrun simctl`、シミュレータランタイムはすべて Xcode に同梱されています。
- **Xcode に iOS シミュレータランタイムが少なくとも 1 つ**インストールされていること。
- **パネルには DSH ≥ 0.1.0-rc.6 と Web バンドル**が必要です。ヘッドレスプロファイルでも動作します。21 個のツールはすべて通常どおり機能し、ライブ映像だけがありません。
- **非 macOS ホスト**: プラグインはロードされ 21 個のツールも登録されますが、呼び出しはすべて説明付きのエラーを返します（`iOS Simulator requires macOS with Xcode …`）。
- **serve-sim** はこのプラグインの npm 依存関係として同梱されるため、実際のインストールではローカルで解決されます。開発ツリーでは `npx -y serve-sim` フォールバックがカバーします（初回使用はネットワークが必要）。
- **AXe**（省略可——AXe ベースのツールだけが必要とします: `ios_sim_ui_tree` / `ios_sim_tap_element`、およびシミュレータ上の `ios_sim_ui_rows` / `ios_sim_tap_row`）: `brew install cameroncooke/axe/axe`、またはプラグインに固定リリース（v1.8.0、SHA-256 検証済み）を `~/Library/Caches/dsh-ios/bin` へ自動ダウンロードさせます。`DSH_IOS_AXE_BIN` で解決結果を上書きできます。`DSH_IOS_AXE_OFFLINE=1` でダウンロードを無効化できます。
- **Vision OCR**（省略可——`ios_sim_find_text` / `ios_sim_tap_text` だけが必要とします）: プラグインは初回使用時に同梱の `assets/ocr.swift` を `swiftc` で `~/Library/Caches/dsh-ios/bin/ocr` にコンパイルします（zh-Hans + en-US 認識）。
- **lldb attach には macOS の開発者モードが必要**です。`sudo DevToolsSecurity -enable` を一度実行してください。それまでは `ios_sim_backtrace` が Xcode の `sample` エンジン（サスペンドしない）を使い、`ios_sim_leaks` は有効化のヒント付きで縮退動作します。
- **実機 iPhone**——画面がロック解除された USB 接続の iPhone（ロック画面では WebDriverAgent を起動できません。。最初の WDA ビルドでは署名済みの WebDriverAgentRunner がインストールされます。プロンプトに従ってデバイスで証明書を信頼し、無料チームの署名プロファイルが失効したら（7 日間の有効期間）`ios_real_start_wda` を再実行してください。

## DSH にインストール

```sh
dsh plugin --profile web add @zseven-w/dsh-ios@latest
dsh web
```

> **rc ノート**——`0.1.0-rc.1` はまだ npm に公開されていません。公開までは、パックした tarball をインストールしてください。
>
> ```sh
> npm pack                                   # このリポジトリ内で実行 → dsh-ios-0.1.0-rc.1.tgz
> dsh plugin --profile web add /path/to/dsh-ios-0.1.0-rc.1.tgz
> dsh web
> ```

## クイックスタート

典型的な最初の会話:

1. **デバイスを探す**——「利用できるシミュレータを一覧表示して。」 → `ios_sim_devices`。
2. **起動**——「iPhone 17 Pro を起動して。」 → `ios_sim_boot`。ストリームが始まり、**「iOS 模拟器」パネル**が開きます。デバイスがサイドバーにライブ表示されます。（任意のシミュレータカードの行、または入力欄の上のステータスピルをクリックすると再び開きます。）
3. **動画の上でタップ**——パネル上で直接タップまたはドラッグします。エージェントに UI を操作させることもできます。「設定を開いて、General をタップして。」 → `ios_sim_interact`（識別子ベースのタップは `ios_sim_ui_tree` + `ios_sim_tap_element`、テキストベースのタップは `ios_sim_find_text` + `ios_sim_tap_text`、リスト/フィード系アプリは `ios_sim_ui_rows` + `ios_sim_tap_row`）。
4. **アプリをビルド＆実行**——「/path/to/MyApp.xcodeproj をビルドして実行して。」 → `ios_sim_build_run`。フルビルドには数分かかります。完了するとアプリがシミュレータで起動し、パネルでライブに確認できます。
5. **プレビューのホットリロード**——「/path/to/MyPackage の SwiftUI プレビューを表示して。」 → `ios_sim_preview start`。ソースファイルを編集すると、実行中のシミュレータに約 2–5 秒でホットスワップされます——再起動は不要です。
6. **実機 iPhone を操作する**——USB（データケーブル）で電話機を接続してロック解除し、「電話機で WebDriverAgent を起動して。」 → `ios_real_start_wda`。パネルは電話機のライブストリームに切り替わり、すべてのツールがその `realDevices` の udid を受け付けます。呼び出しが失敗したら、パネルのステータスからコード化された理由を読んでください（`device-locked`、`cert-untrusted`、`profile-expired`、`tunnel-failed`、`device-unplugged`）。

## トラブルシューティング

- **バックトレースが lldb ではなく `sample` を使う、または leaks が制限付き検査を警告する**——macOS の開発者モードがオフです。`sudo DevToolsSecurity -enable` を一度実行して再試行してください。それまではツールはきれいに縮退動作します。`ios_sim_backtrace` は Xcode の `sample`（シンボル化済み、サスペンドしない）にフォールバックし、`ios_sim_leaks` は有効化のヒントを報告します。
- **`ios_sim_ui_tree` / `ios_sim_tap_element` には AXe が必要**——`brew install cameroncooke/axe/axe` でインストールするか、初回使用時にプラグインに固定リリースをダウンロードさせます（github.com へのネットワークが必要）。エラーメッセージには常に完全なインストールのヒントが含まれます。`DSH_IOS_AXE_BIN=/path/to/axe` で解決結果を上書きできます。行ツール（`ios_sim_ui_rows` / `ios_sim_tap_row`）もシミュレータ上では AXe が必要です。
- **`ios_sim_find_text` / `ios_sim_tap_text` が OCR ヘルパー欠落を報告する**——初回使用時に `swiftc`（Xcode が必要）が同梱の `assets/ocr.swift` を `~/Library/Caches/dsh-ios/bin/ocr` にコンパイルします。エラーには正確なパスとヒントが含まれます。
- **`ios_sim_ui_rows` が行を見つけない**——結果が理由を示します。深さが足りない（`max_depth` を上げてください。実機では深いスナップショットごとに約 15–25 秒かかります）、リスト画面ではない、または深く読んでも本当にアクセシビリティ情報がない。浅い読み取りが「アクセシビリティ欠落」と誤報告されることはありません。
- **iOS 26.2 シミュレータでの `ios_sim_leaks`**——iOS 26.2 ランタイムでは、開発者モードが有効でも Xcode の `leaks` がシミュレータプロセスを検査できず、`Failed to get DYLD info` や minimal-corpse のような致命的な診断を出すことがあります。ツールはきれいに縮退します。生の診断が返り、対象プロセスは必ず再開が検証され、ハングしません。プラグイン側での修正方法はありません——発生したら `mode: "memgraph"` または別のランタイムを試してください。
- **実機の呼び出しがコード化されたステータスで失敗する**——パネルのステータスは推測ではなく原因を示します。`device-locked`（電話機のロックを解除。。
- **ストリームが勝手に止まる**——それはクラッシュではなくアイドルポリシーです。コンシューマがゼロ（パネルが閉じている、カードがマウントされていない、アクティブなルートがない）になると、ストリームは 5 分後に停止し、次のツール呼び出しやパネルを開く操作で再開します。クラッシュしたストリームは約 5 秒以内にバックグラウンドで再起動します。

## 開発

```sh
pnpm install
pnpm run build      # ホスト tsc + クライアントバンドル → lib/
pnpm run typecheck
```

`scripts/` のスモークテストはビルド済みの `lib/` を検証します（シミュレータを起動したり USB 接続の電話機と通信したりする部分は macOS のみ。`DSH_IOS_SMOKE_SKIP_SIM=1` を設定するとそれらの部分をスキップします）:

| スクリプト | カバー内容 |
| --- | --- |
| `node scripts/dev-smoke.mjs` | Sim ホスト: バイナリ解決、ストリーム起動、制御、キープアライブ、破棄。 |
| `node scripts/dev-tools-smoke.mjs [--full-build]` | 実シミュレータに対するコアツール（`--full-build` 付きなら実ビルドも実行）。 |
| `node scripts/dev-routes-smoke.mjs` | 署名付き Web ルート: grant、ストリームプロキシ、スクリーンショット、ws リレー、ガード、失効。 |
| `node scripts/dev-card-smoke.mjs` | クライアントカード: 静的 SSR（`<img>` なしの検証）、status/capture 契約、ほぼライブのネットワーク部分。 |
| `node scripts/dev-panel-smoke.mjs` | パネルコンポーネント、サイズモード、フレームスタイル、ドック/トリガー/カプセルのロジック（静的のみ）。 |
| `node scripts/dev-logs-smoke.mjs` | `ios_sim_logs` の snapshot/follow、フィルタ、上限、プロセス回収。 |
| `node scripts/dev-uitree-smoke.mjs` | UI ツリーツール: AXe の解決/ダウンロードパイプライン、セレクタ、実シミュレータでのツリーとタップ。 |
| `node scripts/dev-debug-smoke.mjs` | デバッグツール: プロセス、バックトレース（lldb + sample）、リーク、アプリ情報。 |
| `node scripts/dev-preview-smoke.mjs` | プレビューのホットリロード: 開始、編集 → 再起動なしのホットスワップ、エラー回復、停止。 |
| `node scripts/dev-orphan-smoke.mjs` | ホストが異常終了した後の孤児 serve-sim の引き取り/回収。 |
| `node scripts/dev-ocr-smoke.mjs` | Vision-OCR ツール: ヘルパー解決、swiftc コンパイルキャッシュ、認識パイプライン、tap-text ルーティング。 |
| `node scripts/dev-wda-smoke.mjs` | WebDriverAgent ホスト: `ServerURLHere` パース、失敗分類、トンネル、キープアライブ（モック。任意のライブ実行）。 |
| `node scripts/dev-realdevice-smoke.mjs` | USB 接続の iPhone に対する `xcrun devicectl`——ツールが使うそのままのコードパス。 |
| `node scripts/dev-realstart-smoke.mjs` | `/real-start` ルート: ガード、コード化された拒否、ビルド/起動ゲーティング（静的）。 |
| `node scripts/dev-realtools-smoke.mjs` | `ios_sim_screenshot` / `ios_sim_interact` / `ios_sim_ui_tree` / `ios_sim_tap_element` の実機バックエンド、および `ios_real_start_wda`。 |

## エコシステム

- [DSH Crew](https://github.com/ZSeven-W/dsh-crew) — Claude Code / Codex から DSH エージェントに作業を委譲
- [DSH Noema](https://github.com/ZSeven-W/dsh-noema) — DSH の長期記憶
- [DSH OpenPencil](https://github.com/ZSeven-W/dsh-openpencil) — 会話の中で `.op` デザイン文書を閲覧・編集

## クレジットとライセンス

- [serve-sim](https://github.com/EvanBacon/serve-sim) —— Evan Bacon —— シミュレータストリーミングエンジン（Apache-2.0。同梱のランタイム依存関係）。
- [AXe](https://github.com/cameroncooke/AXe) —— Cameron Cooke —— UI ツリーツールを支えるアクセシビリティ CLI（MIT）。
- [WebDriverAgent](https://github.com/appium/WebDriverAgent) —— プラグインが実機上でビルド・起動する WebDriver サーバー（BSD ライセンス）。
- アーキテクチャは Codex の「Build iOS Apps」プラグインに触発されたものです。SwiftUI プレビューエンジンは、公開文書化されたアプローチのクリーンルーム再実装であり、Codex のコードは一切コピーされていません。
- 完全な通知は [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) を参照してください。

**ライセンス**: MIT
