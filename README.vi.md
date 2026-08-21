<p align="center">
  <img src="./docs/images/dsh-ios-logo.png" alt="DSH iOS" width="120" />
</p>

<h1 align="center">DSH Trình mô phỏng iOS</h1>

<p align="center">
  <strong>Trình mô phỏng iOS trực tiếp, có thể tương tác ngay trong cuộc hội thoại <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> — cùng iPhone thật của bạn qua USB.</strong><br />
  <sub>22 công cụ agent &bull; bảng bên MJPEG trực tiếp &bull; trình mô phỏng &amp; iPhone thật qua USB &bull; thao tác hàng danh sách/bảng tin &bull; hot reload bản xem trước SwiftUI</sub>
</p>

<p align="center">
  <sub>npm: <code>@zseven-w/dsh-ios</code> &middot; Bản phát hành plugin hiện tại: <code>0.1.0-rc.3</code> &middot; Đã kiểm thử với DSH <code>0.1.1-rc.1</code></sub>
</p>

<p align="center">
  <a href="./README.md">English</a> &middot; <a href="./README.zh.md">简体中文</a> &middot; <a href="./README.zh-TW.md">繁體中文</a> &middot; <a href="./README.ja.md">日本語</a> &middot; <a href="./README.ko.md">한국어</a> &middot; <a href="./README.fr.md">Français</a> &middot; <a href="./README.es.md">Español</a> &middot; <a href="./README.de.md">Deutsch</a> &middot; <a href="./README.pt.md">Português</a> &middot; <a href="./README.ru.md">Русский</a> &middot; <a href="./README.hi.md">हिन्दी</a> &middot; <a href="./README.tr.md">Türkçe</a> &middot; <a href="./README.th.md">ไทย</a> &middot; <b>Tiếng Việt</b> &middot; <a href="./README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <sub>npm: <code>@zseven-w/dsh-ios</code> &middot; Phiên bản plugin hiện tại: <code>0.1.0-rc.3</code> &middot; Đã kiểm thử với DSH <code>0.1.1-rc.1</code></sub>
</p>

<br />

<p align="center">
  <img src="./docs/images/dsh-ios-overview.png" alt="DSH iOS Simulator — a real iPhone inside the conversation" width="100%" />
</p>
<p align="center"><sub>Một chiếc iPhone thật được điều khiển ngay trong cuộc hội thoại DSH — lệnh gọi công cụ ở bên trái, bảng thiết bị trực tiếp ở bên phải</sub></p>

## Vì sao chọn DSH Trình mô phỏng iOS

DSH Trình mô phỏng iOS trao cho agent một trình mô phỏng iOS thật ngay trong cuộc hội thoại — và trao cho bạn các pixel. Agent có thể khởi động thiết bị, build và chạy dự án Xcode hoặc gói Swift, điều khiển UI theo định danh trợ năng hoặc văn bản OCR, đọc nhật ký hợp nhất, đồng thời kiểm tra tiến trình, backtrace và rò rỉ bộ nhớ, trong khi luồng trực tiếp của thiết bị hiển thị trong một bảng bên cố định nơi bạn có thể chạm, kéo, xoay và bấm Home ngay trên video. Các động từ tương tự cũng hoạt động trên iPhone thật kết nối qua USB: plugin build và khởi chạy WebDriverAgent trên điện thoại, tạo đường hầm cho cổng điều khiển và cổng màn hình qua loopback, rồi truyền thiết bị vào cùng bảng, thẻ và công cụ đó. Không có khối ảnh, không có tệp ghi màn hình: các byte hình ảnh chỉ đến được UI qua các URL có chữ ký và hết hạn do máy chủ web DSH cung cấp.

| | |
| --- | --- |
| 🖥️ **Trình mô phỏng trực tiếp trong hội thoại** | Luồng MJPEG serve-sim của thiết bị đã khởi động, được proxy qua các tuyến `/_dsh/dsh-ios/*` có chữ ký vào bảng bên phải cố định — trình duyệt không bao giờ chạm vào cổng của serve-sim. |
| 📱 **iPhone thật qua USB** | `ios_real_start_wda` build và khởi chạy WebDriverAgent trên điện thoại đã kết nối, tạo đường hầm cho cổng điều khiển (REST) và cổng màn hình (MJPEG) qua loopback; bảng, công cụ, thẻ và viên trạng thái đó sau đó điều khiển điện thoại. Thiết bị phải được mở khóa, và mọi cú chạm trên tài khoản thật đều bị ràng buộc bởi quy tắc “nhận diện trước, chạm sau” của plugin. |
| 🛠️ **22 công cụ agent** | Thiết bị, khởi động/tắt, ảnh chụp màn hình, tương tác, build và chạy, nhật ký hợp nhất, cây UI dựa trên AXe và chạm theo phần tử, thao tác hàng danh sách/bảng tin, tìm/chạm văn bản bằng Vision OCR, hot reload bản xem trước SwiftUI, tiến trình, backtrace, rò rỉ, thông tin ứng dụng. |
| 👆 **Bảng tương tác** | Chạm và kéo trên video trực tiếp; thanh biểu tượng Home / xoay / chụp màn hình / làm mới với chú giải khi rê chuột; chế độ kích thước (适应 · 50–125% · S/M/L); kiểu khung (无框 / 边框 / 真机框); kéo đổi kích thước đến 960 px với nhấp đúp để đặt lại; tự mở rộng khi nằm ngang. |
| 🧾 **Hàng danh sách và bảng tin** | `ios_sim_ui_rows` biến ảnh chụp trợ năng sâu thành các hàng có chỉ mục với nhãn và bộ đếm được phân tích tổng quát; `ios_sim_tap_row` chạm bên trong một hàng tại tọa độ tương đối và xác minh hành động bằng thay đổi ±1 như kỳ vọng của bộ đếm — xác nhận đáng tin cậy duy nhất mà ứng dụng dạng danh sách cung cấp. |
| 🔐 **Vận chuyển chỉ qua loopback** | serve-sim chỉ gắn với 127.0.0.1 trong dải cổng riêng; mọi tuyến đều yêu cầu một đầu loopback, `Host` loopback và kiểm tra Fetch-Metadata/Origin; năng lực HMAC hết hạn trong vòng 10 phút.. |
| ⚡ **Hot reload bản xem trước SwiftUI** | `ios_sim_preview` tạo một ứng dụng chủ dùng một lần bên ngoài gói của bạn, build các bản xem trước thành dylib và hoán đổi nóng các chỉnh sửa vào trình mô phỏng đang chạy mà không cần khởi chạy lại (~2–5 giây). |
| 🧭 **Tự động hóa UI theo ngữ nghĩa** | `ios_sim_ui_tree` kết xuất cây trợ năng (dựa trên AXe) và `ios_sim_tap_element` chạm theo nhãn hoặc mã định danh; khi cây rỗng hoặc suy biến, `ios_sim_find_text` OCR màn hình và `ios_sim_tap_text` chạm vào văn bản khớp — chạm theo định danh và văn bản thay vì đoán tọa độ. |

## Công cụ

Cả 22 công cụ đều được đăng ký trên mọi máy chủ và chỉ trả về JSON thuần — các byte hình ảnh chỉ đến UI qua `presentationMeta` + các tuyến có chữ ký, không bao giờ dưới dạng khối ảnh. udid trình mô phỏng đi qua simctl/serve-sim; udid thiết bị vật lý tự động đi qua WebDriverAgent. Trên máy chủ không phải macOS (hoặc khi không phân giải được serve-sim) các công cụ vẫn được đăng ký nhưng thất bại với lỗi giải thích; ngoại lệ duy nhất là `status` của `ios_sim_preview`, nó báo trung thực `{ running: false }` trên mọi máy chủ.

### Công cụ mô phỏng cốt lõi

| Công cụ | Chức năng | Tham số chính |
| --- | --- | --- |
| `ios_sim_devices` | Liệt kê các thiết bị trình mô phỏng iOS có trên máy Mac này (udid, tên, runtime, trạng thái) và thiết bị nào đã khởi động, cùng mọi iPhone vật lý kết nối USB trong `realDevices` (udid, tên, osVersion, model, state, developerMode). Dùng nó để tìm udid hoặc tên để truyền cho các công cụ khác. | — |
| `ios_sim_boot` | Khởi động một thiết bị và bắt đầu luồng serve-sim trực tiếp của nó; luồng duy trì suốt cuộc hội thoại để bảng có thể hiển thị trình mô phỏng trực tiếp. | `udid` (bắt buộc — udid hoặc tên thiết bị) |
| `ios_sim_shutdown` | Tắt một thiết bị; dừng luồng khi luồng nhắm vào thiết bị đó. | `udid` (bắt buộc) |
| `ios_sim_screenshot` | Chụp một PNG và trả về tóm tắt JSON ngắn (đường dẫn, byte, kích thước, thiết bị); ảnh hiển thị trong thẻ/bảng, không bao giờ là khối ảnh. Hoạt động trên trình mô phỏng đang truyền và trên điện thoại kết nối USB qua WebDriverAgent. | `udid` (tùy chọn — thiết bị đang truyền, nếu không thì trình mô phỏng đã khởi động đầu tiên) |
| `ios_sim_interact` | Tương tác với thiết bị đang truyền — trình mô phỏng hoặc điện thoại USB: chạm tại tọa độ chuẩn hóa 0..1, gõ văn bản (bàn phím Mỹ trên trình mô phỏng), bấm nút phần cứng (`home`, `lock`, `volumeUp`…), cuộn hoặc gửi cử chỉ chạm; sau khi hành động ổn định (~300 ms), một ảnh chụp mới cho thấy hiệu quả. | `action` (bắt buộc — `tap`/`type`/`button`/`gesture`/`scroll`), `x`/`y`, `text`, `name`, `json` |
| `ios_sim_list_apps` | Liệt kê các ứng dụng ĐÃ CÀI trên trình mô phỏng đã khởi động hoặc điện thoại đã kết nối (bundle id, tên hiển thị, phiên bản, cờ hệ thống) — bundle id của ứng dụng bên thứ ba không thể đoán được, vì vậy hãy liệt kê trước hoặc truyền `name` cho `ios_sim_launch_app`. Việc liệt kê THẤT BẠI sẽ ném lỗi (ví dụ “thiết bị không thể truy cập qua CoreDevice”) thay vì trả về danh sách rỗng, nên `count: 0` luôn nghĩa là thiết bị thật sự không có ứng dụng khớp. | `udid` (tùy chọn), `query` (chuỗi con không phân biệt hoa thường trên tên hiển thị VÀ bundle id, gồm cả CJK), `include_system` (mặc định false) |
| `ios_sim_launch_app` | Khởi chạy một ứng dụng đã cài trên trình mô phỏng đã khởi động hoặc điện thoại đã kết nối — theo `bundleId`, hoặc theo `name` (chuỗi con tên hiển thị không phân biệt hoa thường, được phân giải qua cùng cơ chế liệt kê, gồm cả CJK). Chính xác một trong hai; lỗi khởi chạy và tên mơ hồ đều trả về việc cần làm tiếp theo (`ios_sim_build_run` dùng để build từ mã nguồn). | `bundleId` hoặc `name` (chính xác một), `udid`, `relaunch` |
| `ios_sim_build_run` | Build một `.xcodeproj`, `.xcworkspace` hoặc gói Swift cho trình mô phỏng, cài đặt `.app` đã tạo và khởi chạy nó; truyền udid thiết bị vật lý để build, cài đặt và khởi chạy trên điện thoại (cần ký Apple Development). Khi thất bại, kết quả chứa phần đuôi lỗi `xcodebuild` đã lọc. Bản build đầy đủ mất vài phút. | `projectPath` (bắt buộc), `scheme`, `udid` (đang truyền → đã khởi động → iPhone runtime mới nhất, sẽ được khởi động), `configuration` (mặc định `Debug`) |
| `ios_real_start_wda` | Khởi động WebDriverAgent (WDA) trên iPhone vật lý kết nối USB — chỉ thiết bị thật, không bao giờ là trình mô phỏng. Nhận một WDA đang chạy khi nó phản hồi; nếu không thì chạy build/khởi chạy `xcodebuild` (bản build nguội mất vài phút), rồi chờ đến khi WDA báo sẵn sàng và trả về các cổng điều khiển/MJPEG mà bảng trực tiếp dùng. Chạy công cụ này trước khi `ios_sim_screenshot` / `ios_sim_interact` / `ios_sim_ui_tree` / `ios_sim_tap_element` báo WDA chưa chạy cho thiết bị đó. | `udid` (bắt buộc — udid thiết bị vật lý từ `ios_sim_devices.realDevices`) |

### Công cụ cây UI (dựa trên AXe)

| Công cụ | Chức năng | Tham số chính |
| --- | --- | --- |
| `ios_sim_ui_tree` | Kết xuất cây phần tử trợ năng của ứng dụng nằm trước nhất (nhãn, mã định danh, giá trị, frame theo điểm thiết bị) cùng kích thước màn hình theo điểm — AXe trên trình mô phỏng, WebDriverAgent trên điện thoại USB (ở đó độ sâu bị giới hạn theo mặc định: ảnh chụp không giới hạn của ứng dụng bận rộn đo được ~32 giây / 751 KB, có giới hạn ~2 giây); đầu ra bị giới hạn ~40 KB (các tầng sâu nhất bị cắt tỉa, đặt `truncated` + gợi ý). | `udid` (tùy chọn), `max_depth`, `filter` (chuỗi con không phân biệt hoa thường trên nhãn/mã định danh/loại) |
| `ios_sim_tap_element` | Chạm một phần tử theo định danh — khớp chính xác trước, rồi chuỗi con không phân biệt hoa thường trên `identifier`/`label`; các bản sao lồng nhau được gộp thành một mục tiêu, các khớp mơ hồ liệt kê mọi ứng viên. Cú chạm rơi vào tâm phần tử (AXe HID trên trình mô phỏng, WebDriverAgent trên điện thoại), rồi ảnh chụp sau ~300 ms cho thấy hiệu quả; truyền `expect_text` / `expect_gone` thì cú chạm cùng xác minh của nó trở thành một vòng khứ hồi (`expected.matched`). | `udid` (tùy chọn), `identifier`, `label`, `expect_text`, `expect_gone` |

### Hàng danh sách &amp; bảng tin

Các ứng dụng danh sách/bảng tin gộp mỗi mục vào một ô trợ năng mà nhãn chứa toàn bộ tóm tắt và mọi bộ đếm (“57 回复。18 喜欢。592 次查看”) — không có nút con theo từng điều khiển để khớp, và các ô hàng chỉ xuất hiện ở ảnh chụp sâu. Hai công cụ này phơi bày cấu trúc đó thành các hàng và hành động bên trong một hàng.

| Công cụ | Chức năng | Tham số chính |
| --- | --- | --- |
| `ios_sim_ui_rows` | Đọc các hàng danh sách/bảng tin hiển thị của ứng dụng nằm trước nhất thành hàng thay vì cây thô: mỗi hàng báo chỉ mục, frame theo điểm, nhãn gộp và các bộ đếm được phân tích từ nhãn đó (số + từ phân loại, ví dụ `57 回复` → 回复=57, tiếng Trung hoặc tiếng Anh — không mã cứng từ vựng ứng dụng nào). Các hàng chỉ xuất hiện ở ảnh chụp sâu: trên điện thoại `max_depth` mặc định là 60, tốn ~15–25 giây / ~0.5 MB mỗi lần gọi (WDA xử lý yêu cầu tuần tự) — hãy dùng các công cụ quan sát rẻ trước (`ios_sim_find_text` / `ios_sim_ui_tree`). Bộ đếm được phân tích theo heuristic và khóa đi-về nguyên vẹn: truyền khóa cho `ios_sim_tap_row.expect_count` đúng như danh sách đã liệt kê. Khi không tìm thấy hàng, kết quả nêu lý do (độ sâu quá nông / không phải màn hình danh sách / thật sự không có thông tin trợ năng sau khi đọc sâu) — việc đọc nông không bao giờ bị báo là “ứng dụng không có thông tin trợ năng”; các hàng ngoài màn hình bị loại và đếm là `omittedOffscreen`. | `udid` (tùy chọn), `max_depth` (chỉ điện thoại; mặc định 60) |
| `ios_sim_tap_row` | Chạm tại vị trí tương đối bên trong một hàng danh sách hiển thị (hàng do `ios_sim_ui_rows` báo: chỉ mục gốc 0; x/y là phân số của frame hàng đó — 0 = cạnh trái/trên, 1 = phải/dưới, mặc định 0.5 = tâm) trên trình mô phỏng (AXe) hoặc điện thoại USB (WebDriverAgent). Frame hàng đến từ một lần đọc cây MỚI, nên không đoán tọa độ màn hình tuyệt đối; chỉ mục ngoài phạm vi THẤT BẠI (không bao giờ bị kẹp). Cổng an toàn: với `expect_count={key,delta}`, công cụ xác minh hành động bằng cách đọc lại nhãn hàng và kiểm tra bộ đếm dịch chuyển đúng +1/−1 (`countCheck.verified`); nếu khóa không nằm trong các bộ đếm đã phân tích của hàng, cú chạm bị TỪ CHỐI trước khi xảy ra — cú chạm trên thiết bị thật không bao giờ là thăm dò. Không có `expect_count`, cú chạm vẫn xảy ra (vị trí tương đối hàng rõ ràng CHÍNH LÀ định danh) nhưng không gì được xác minh. | `udid` (tùy chọn), `index` (bắt buộc), `x`, `y` (phân số 0..1), `max_depth`, `expect_count` (`{key, delta}`) |

### Công cụ OCR (Vision)

| Công cụ | Chức năng | Tham số chính |
| --- | --- | --- |
| `ios_sim_find_text` | OCR màn hình HIỆN TẠI của trình mô phỏng đã khởi động hoặc điện thoại USB bằng trợ thủ Vision do plugin biên dịch (nhận dạng chính xác, zh-Hans + en-US, được `swiftc` biên dịch vào `~/Library/Caches/dsh-ios/bin/ocr` ở lần dùng đầu). Dùng khi cây trợ năng rỗng hoặc suy biến, cho văn bản vẽ dạng đồ họa (số huy hiệu, giá in trong ảnh), hoặc để xác minh độc lập những gì trên màn hình. Chụp một ảnh mới và trả về `{device, size, items:[{text, confidence, rect}]}` — rect là các hộp điểm thiết bị (gốc trên-trái), sắp theo độ tin cậy, đầu ra giới hạn ~40 KB (`truncated` bỏ phần đuôi độ tin cậy thấp nhất; thu hẹp bằng `query` hoặc tăng `min_confidence`). | `udid` (tùy chọn), `query` (chuỗi con không phân biệt hoa thường), `min_confidence` (mặc định 0.3) |
| `ios_sim_tap_text` | OCR màn hình HIỆN TẠI và chạm vào tâm của khớp văn bản tốt nhất — cùng quy tắc chính xác → chứa không phân biệt hoa thường → danh sách ứng viên khi mơ hồ như `ios_sim_tap_element`, cho văn bản mà cây trợ năng không thấy (ứng dụng không có a11y, số huy hiệu, văn bản in trong ảnh). Trên điện thoại, cú chạm rơi vào điểm tuyệt đối của thiết bị qua WebDriverAgent; trên trình mô phỏng đang truyền, nó được gửi chuẩn hóa qua điều khiển serve-sim (chạy `ios_sim_boot` trước). Sau ~300 ms, ảnh chụp mới cho thấy hiệu quả; truyền `expect_text` / `expect_gone` thì cú chạm cùng xác minh của nó trở thành một vòng khứ hồi (`expected.matched`). Trên thiết bị THẬT, mọi cú chạm đều có hậu quả thật — đừng bao giờ chạm một điều khiển không rõ danh tính để dò xem nó làm gì. | `udid` (tùy chọn), `query` (bắt buộc), `min_confidence`, `expect_text`, `expect_gone` |
| `ios_sim_wait_for` | Chờ đến khi một đoạn văn bản xuất hiện hoặc biến mất trên màn hình, thăm dò cùng pipeline chụp+OCR của `ios_sim_find_text` cho tới khi điều kiện đúng hoặc hết thời gian (mặc định 8 giây, tối đa 60 giây). Hết giờ là câu trả lời bình thường `matched:false`, không bao giờ là lỗi — một lần gọi thay cho vòng lặp find_text thủ công (~1,2 giây mỗi vòng trên iPhone thật). Khi khớp, `item` mang văn bản OCR, độ tin cậy và khung chữ nhật theo điểm của thiết bị. | `udid` (tuỳ chọn), `text` (bắt buộc), `mode` (`appear`/`disappear`), `timeout_ms`, `min_confidence` |

### Công cụ nhật ký

| Công cụ | Chức năng | Tham số chính |
| --- | --- | --- |
| `ios_sim_logs` | Đọc những gì ứng dụng trình mô phỏng in ra từ nhật ký hợp nhất của thiết bị: `snapshot` (`log show --last <duration>`, mặc định 2m) hoặc `follow` (bắt trực tiếp có giới hạn trong `duration_seconds`, mặc định 10, tối đa 60 — không bao giờ là luồng treo). Đầu ra giới hạn ~300 dòng / 30 KB kèm gợi ý thu hẹp. | `udid` (tùy chọn), `mode` (`snapshot`/`follow`), `duration`, `duration_seconds`, `bundle_id`, `predicate` (NSPredicate thô, ghi đè `bundle_id`), `level` (`default`/`info`/`debug`), `grep` |

### Công cụ bản xem trước

| Công cụ | Chức năng | Tham số chính |
| --- | --- | --- |
| `ios_sim_preview` | Hot reload bản xem trước SwiftUI, trực tiếp trong trình mô phỏng: `start` (mặc định) kiểm tra gói, tạo một ứng dụng chủ dùng một lần trong bộ đệm của plugin (không bao giờ bên trong gói của bạn), build gói thành dylib cho trình mô phỏng, cài đặt và khởi chạy ứng dụng chủ, rồi theo dõi mã nguồn — mỗi lần chỉnh sửa đều build lại và hoán đổi nóng mà không khởi chạy lại (~2–5 giây). Lỗi biên dịch giữ lại bản xem trước tốt cuối cùng và hiện qua `status`; mỗi lúc chỉ một phiên. | `packagePath` (bắt buộc cho `start`), `udid`, `action` (`start`/`status`/`stop`), `previewFilter` (chuỗi con không phân biệt hoa thường trên tên bản xem trước) |

### Công cụ gỡ lỗi

| Công cụ | Chức năng | Tham số chính |
| --- | --- | --- |
| `ios_sim_processes` | Liệt kê các tiến trình ứng dụng đang chạy của một trình mô phỏng từ launchd của chính nó (pid máy chủ thấy được, tên, bundle id) — nguồn pid cho backtrace/rò rỉ; udid thiết bị vật lý thì liệt kê tiến trình của điện thoại qua devicectl. | `udid` (tùy chọn), `filter` (chuỗi con không phân biệt hoa thường trên tên/bundle id) |
| `ios_sim_backtrace` | LLDB theo lô một lần (gắn → backtrace luồng → gỡ, không bao giờ tương tác); đầu ra giới hạn ~200 dòng, luồng chính trước, mục tiêu luôn được xác minh là đã tiếp tục. Khi macOS từ chối gắn (Chế độ nhà phát triển tắt), suy giảm xuống công cụ `sample` của Xcode (không treo) và báo gợi ý bật. Chỉ trình mô phỏng — thiết bị vật lý bị từ chối kèm lý do. | `udid` (tùy chọn), `pid` / `bundle_id`, `all_threads` (mặc định true) |
| `ios_sim_leaks` | Phân tích rò rỉ bằng công cụ `leaks` của Xcode: `summary` (số chỗ rò rỉ, tổng byte rò rỉ, ~30 loại hàng đầu) hoặc `memgraph` (tạo tác `.memgraph` để mở trong Xcode Instruments, không bao giờ được phân tích ở đây). Ứng dụng bị treo trong lúc quét và luôn được tiếp tục. Chỉ trình mô phỏng. | `udid` (tùy chọn), `pid` / `bundle_id`, `mode` (`summary`/`memgraph`) |
| `ios_sim_app_info` | Thông tin ứng dụng đã cài: đường dẫn app bundle, vùng chứa dữ liệu ghi được và các giá trị Info.plist — qua `simctl appinfo` (kèm dự phòng `get_app_container`) trên trình mô phỏng, qua `devicectl` trên điện thoại USB; `installed: false` kèm `note` chỉ đến `ios_sim_list_apps` cho ứng dụng thiếu. | `udid` (tùy chọn), `bundle_id` (bắt buộc) |

## Bề mặt hiển thị

- **Bảng bên — “iOS 模拟器”.** Khung nhìn trực tiếp nằm trong bảng bên phải cố định (một dock cố định đẩy cuộc hội thoại sang bên, hoặc lớp phủ giữa trên khung nhìn hẹp). Nó hiển thị luồng MJPEG trực tiếp và nhận nhấp-để-chạm cùng kéo-để-ra-cử-chỉ ngay trên video, với thanh biểu tượng (Home, chụp màn hình, xoay, làm mới) có chú giải khi rê chuột. Các điều khiển kích thước gồm **适应** (vừa chiều rộng bảng), thu phóng **50–125%** chiều rộng logic của thiết bị, và các cài đặt sẵn **S / M / L** định cỡ cạnh ngắn của thiết bị (chiều rộng dọc; khi nằm ngang, tỉ lệ sao cho thiết bị giữ kích thước vật lý). Các kiểu khung là **无框 / 边框 / 真机框** (không khung / viền / vỏ thiết bị thực tế) với bán kính góc tỉ lệ. Khi thiết bị xoay sang nằm ngang, bảng tự mở rộng đến kích thước thoải mái và khôi phục chiều rộng của bạn khi xoay lại — kéo tay trong khoảng đó luôn thắng. Tay cầm cạnh trái kéo bảng rộng/hẹp hơn (tối đa 960 px; nhấp đúp đặt lại chiều rộng mặc định). Khi iPhone kết nối USB là mục tiêu luồng, cùng bảng đó hiển thị luồng MJPEG WebDriverAgent của điện thoại với cùng các điều khiển.
- **Thẻ hội thoại gọn.** Kết quả công cụ hiển thị dưới dạng thẻ một dòng, không có ảnh nội tuyến: tiêu đề thống nhất **“iOS 模拟器”**, nhãn phụ hành động (Khởi động / Chụp màn hình / Tương tác / Build và chạy / Khởi động WebDriverAgent), tên thiết bị, huy hiệu trạng thái và gợi ý “mở trong bảng bên”. Nhấp vào hàng sẽ mở bảng; nhấp vào nút, liên kết hay chính frame trực tiếp không bao giờ kích hoạt nó.
- **Viên trạng thái phía trên khung nhập.** Khi bảng đóng và luồng đang trực tuyến, một viên nhỏ chấm xanh (`<device>` · 实时) xuất hiện phía trên khung soạn thảo và mở bảng khi nhấp. Nó gắn với phiên: chỉ hiển thị và thăm dò khi cuộc hội thoại hiện tại có gắn kết quả trình mô phỏng, và dừng khi bạn chuyển sang phiên không có chúng.
- **Chế độ chuẩn và Chế độ Code.** Phiên chuẩn dùng `presentationMeta` do máy chủ chiếu. Các dispatch lồng của Chế độ Code (PTC) không bao giờ mang meta, nên máy khách dựng lại meta giống hệt từ JSON kết quả bền vững — bảng, thẻ và viên trạng thái hoạt động ở cả hai chế độ.

## Bảo mật

- Trình duyệt không bao giờ nói chuyện với cổng của serve-sim. Mọi byte đi qua nguồn gốc máy chủ web DSH bằng các tuyến `/_dsh/dsh-ios/*` thuộc plugin: `/stream/<token>` (proxy MJPEG), `/screenshot/<token>` (PNG đã đệm), `/ws?token=…` (rơ-le điều khiển HID), cùng các điểm cuối `/grant`, `/capture` và `/status`.
- Token là các năng lực HMAC-SHA256 (`base64url(payload).base64url(mac)`) hết hạn trong vòng 10 phút, ký bằng khóa riêng cho từng thư mục chính DSH (`<DSH_HOME>/cache/dsh-ios/stream-access.key`, 0600, tạo nguyên tử).
- Mọi tuyến đều áp hàng rào vận chuyển loopback/đáng tin trước khi xét bất kỳ năng lực nào: địa chỉ đầu loopback, `Host` loopback (từ chối DNS-rebinding) và kiểm tra Fetch-Metadata/Origin. Tuyến ảnh chụp chỉ phục vụ các tệp trong thư mục đệm của plugin (từ chối liên kết tượng trưng, kiểm tra phạm vi bằng `realpath`).
- serve-sim chạy như tiến trình con nền trước chỉ trên loopback, trong dải cổng riêng (3181–3244), nên serve-sim riêng của người dùng trên cổng 3100 không bao giờ bị đụng đến; `--host` không bao giờ được dùng..
- **Nhận nuôi/thu hồi mồ côi** — nếu máy chủ DSH trước bị giết không sạch sẽ và trợ thủ serve-sim của nó sống sót, cùng thiết bị đó được nhận nuôi (cái bắt tay của tiến trình mồ côi có thẩm quyền); một trợ thủ cũ chiếm khe của thiết bị khác bị thu hồi qua `serve-sim -k` và khởi chạy lại một lần.
- **Keep-alive + dừng khi nhàn rỗi** — luồng gặp sự cố tự khởi động lại nền (~5 giây trễ); khi không có người tiêu thụ, luồng tự dừng sau 5 phút. Việc dừng có chủ đích không bao giờ bị chống lại. (Bộ chạy thiết bị thật cố ý được miễn thu hoạch khi nhàn rỗi: khởi động lại nó tốn một lần build `xcodebuild` kéo dài nhiều phút.)

## Yêu cầu

- **macOS với Xcode đầy đủ** — không chỉ Command Line Tools. `xcodebuild`, `xcrun simctl` và các runtime trình mô phỏng đều đi kèm Xcode.
- **Ít nhất một runtime trình mô phỏng iOS** được cài trong Xcode.
- **DSH ≥ 0.1.0-rc.6 kèm gói web** cho bảng. Hồ sơ headless cũng hoạt động: cả 22 công cụ chạy bình thường, chỉ thiếu khung nhìn trực tiếp.
- **Máy chủ không phải macOS**: plugin vẫn tải và cả 22 công cụ vẫn đăng ký, nhưng mọi lần gọi đều trả về lỗi giải thích (`iOS Simulator requires macOS with Xcode …`).
- **serve-sim** đi kèm như phụ thuộc npm của plugin này, nên được phân giải cục bộ ở các bản cài thật; phương án dự phòng `npx -y serve-sim` bao phủ cây phát triển (lần dùng đầu cần mạng).
- **AXe** (tùy chọn — chỉ các công cụ dựa trên AXe cần: `ios_sim_ui_tree` / `ios_sim_tap_element`, cùng `ios_sim_ui_rows` / `ios_sim_tap_row` trên trình mô phỏng): `brew install cameroncooke/axe/axe`, hoặc để plugin tự tải bản phát hành được ghim (v1.8.0, xác minh SHA-256) vào `~/Library/Caches/dsh-ios/bin`. `DSH_IOS_AXE_BIN` ghi đè phân giải; `DSH_IOS_AXE_OFFLINE=1` tắt tải xuống.
- **Vision OCR** (tùy chọn — chỉ `ios_sim_find_text` / `ios_sim_tap_text` cần): plugin biên dịch `assets/ocr.swift` đi kèm bằng `swiftc` ở lần dùng đầu vào `~/Library/Caches/dsh-ios/bin/ocr` (nhận dạng zh-Hans + en-US).
- **Gắn lldb cần Chế độ nhà phát triển của macOS**: chạy `sudo DevToolsSecurity -enable` một lần. Trước đó `ios_sim_backtrace` dùng công cụ `sample` của Xcode (không treo) và `ios_sim_leaks` suy giảm kèm gợi ý bật.. Bản build WDA đầu tiên cài một WebDriverAgentRunner đã ký: tin cậy chứng chỉ của nó trên thiết bị khi được nhắc, và chạy lại `ios_real_start_wda` khi hồ sơ ký nhóm miễn phí hết hạn (thời hạn 7 ngày).

## Cài đặt vào DSH

```sh
dsh plugin --profile web add @zseven-w/dsh-ios@latest
dsh web
```

## Bắt đầu nhanh

Một cuộc hội thoại đầu tiên điển hình:

1. **Khám phá thiết bị** — “Liệt kê các trình mô phỏng có sẵn.” → `ios_sim_devices`.
2. **Khởi động** — “Khởi động iPhone 17 Pro.” → `ios_sim_boot`. Luồng bắt đầu và **bảng “iOS 模拟器”** mở ra: thiết bị hiển thị trực tiếp trong bảng bên. (Nhấp vào hàng thẻ trình mô phỏng bất kỳ, hoặc viên trạng thái phía trên khung nhập, để mở lại.)
3. **Chạm trên video** — chạm hoặc kéo trực tiếp trên bảng; hoặc để agent điều khiển UI: “Mở Cài đặt, rồi chạm General.” → `ios_sim_interact` (hoặc `ios_sim_ui_tree` + `ios_sim_tap_element` cho chạm theo định danh; `ios_sim_find_text` + `ios_sim_tap_text` cho chạm theo văn bản; `ios_sim_ui_rows` + `ios_sim_tap_row` cho ứng dụng danh sách/bảng tin).
4. **Build và chạy ứng dụng của bạn** — “Build và chạy /path/to/MyApp.xcodeproj.” → `ios_sim_build_run`. Bản build đầy đủ mất vài phút; khi hoàn tất, ứng dụng khởi chạy trên trình mô phỏng và bạn xem trực tiếp trong bảng.
5. **Hot reload bản xem trước** — “Hiển thị các bản xem trước SwiftUI của /path/to/MyPackage.” → `ios_sim_preview start`. Sửa một tệp mã nguồn và bản xem trước được hoán đổi nóng vào trình mô phỏng đang chạy trong ~2–5 giây — không khởi chạy lại.
6. **Điều khiển iPhone thật** — cắm điện thoại qua USB (cáp dữ liệu), mở khóa, rồi “Khởi động WebDriverAgent trên điện thoại.” → `ios_real_start_wda`. Bảng chuyển sang luồng trực tiếp của điện thoại và mọi công cụ chấp nhận udid trong `realDevices` của nó; khi lời gọi thất bại, đọc lý do mã hóa từ trạng thái của bảng (`device-locked`, `cert-untrusted`, `profile-expired`, `tunnel-failed`, `device-unplugged`).

## Khắc phục sự cố

- **Backtrace dùng `sample` thay vì lldb, hoặc leaks kêu ca về kiểm tra bị hạn chế** — Chế độ nhà phát triển của macOS đang tắt. Chạy `sudo DevToolsSecurity -enable` một lần rồi thử lại. Trước đó các công cụ suy giảm gọn gàng: `ios_sim_backtrace` dự phòng sang `sample` của Xcode (đã biểu tượng hóa, không treo) và `ios_sim_leaks` báo gợi ý bật.
- **`ios_sim_ui_tree` / `ios_sim_tap_element` cần AXe** — cài bằng `brew install cameroncooke/axe/axe`, hoặc để plugin tải bản phát hành được ghim ở lần dùng đầu (cần mạng tới github.com). Thông báo lỗi luôn kèm gợi ý cài đặt đầy đủ; `DSH_IOS_AXE_BIN=/path/to/axe` ghi đè phân giải. Các công cụ hàng (`ios_sim_ui_rows` / `ios_sim_tap_row`) cũng cần AXe trên trình mô phỏng.
- **`ios_sim_find_text` / `ios_sim_tap_text` báo thiếu trợ thủ OCR** — lần dùng đầu sẽ dùng `swiftc` (cần Xcode) biên dịch `assets/ocr.swift` đi kèm vào `~/Library/Caches/dsh-ios/bin/ocr`; lỗi kèm đường dẫn và gợi ý chính xác.
- **`ios_sim_ui_rows` không tìm thấy hàng** — kết quả nêu lý do: độ sâu quá nông (tăng `max_depth`; trên điện thoại mỗi ảnh chụp sâu hơn tốn ~15–25 giây), không phải màn hình danh sách, hoặc thật sự không có thông tin trợ năng sau khi đọc sâu. Việc đọc nông không bao giờ bị báo nhầm là thiếu trợ năng.
- **`ios_sim_leaks` trên trình mô phỏng iOS 26.2** — trên runtime iOS 26.2, `leaks` của Xcode có thể không kiểm tra được tiến trình trình mô phỏng với các chẩn đoán nghiêm trọng như `Failed to get DYLD info` hoặc lỗi minimal-corpse, kể cả khi đã bật Chế độ nhà phát triển. Công cụ suy giảm gọn gàng: bạn nhận được chẩn đoán thô, mục tiêu luôn được xác minh là đã tiếp tục, và không gì bị treo. Không có cách sửa phía plugin — khi gặp, hãy thử `mode: "memgraph"` hoặc một runtime khác..
- **Luồng tự dừng** — đó là chính sách nhàn rỗi, không phải sự cố: khi không có người tiêu thụ (bảng đóng, không thẻ nào được gắn, không tuyến nào hoạt động), luồng dừng sau 5 phút và khởi động lại ở lần gọi công cụ tiếp theo hoặc khi mở bảng. Luồng gặp sự cố khởi động lại nền trong ~5 giây.

## Phát triển

```sh
pnpm install
pnpm run build      # tsc máy chủ + gói máy khách → lib/
pnpm run typecheck
```

Các kiểm thử khói trong `scripts/` luyện `lib/` đã build (chỉ macOS cho các phần khởi động trình mô phỏng hoặc nói chuyện với điện thoại USB; đặt `DSH_IOS_SMOKE_SKIP_SIM=1` để bỏ qua các phần đó):

| Kịch bản | Phạm vi kiểm tra |
| --- | --- |
| `node scripts/dev-smoke.mjs` | Máy chủ mô phỏng: phân giải nhị phân, khởi động luồng, điều khiển, keep-alive, dispose. |
| `node scripts/dev-tools-smoke.mjs [--full-build]` | Các công cụ cốt lõi trên trình mô phỏng thật (kèm một bản build thật với `--full-build`). |
| `node scripts/dev-routes-smoke.mjs` | Các tuyến web có chữ ký: grant, proxy luồng, ảnh chụp, rơ-le ws, hàng rào, hết hạn. |
| `node scripts/dev-card-smoke.mjs` | Thẻ máy khách: SSR tĩnh (không có `<img>`), hợp đồng status/capture, phần mạng gần trực tiếp. |
| `node scripts/dev-panel-smoke.mjs` | Thành phần bảng, chế độ kích thước, kiểu khung, logic dock/kích hoạt/viên (chỉ tĩnh). |
| `node scripts/dev-logs-smoke.mjs` | snapshot/follow của `ios_sim_logs`, bộ lọc, giới hạn, thu hoạch tiến trình. |
| `node scripts/dev-uitree-smoke.mjs` | Công cụ cây UI: phân giải/đường ống tải AXe, bộ chọn, cây và chạm trên trình mô phỏng thật. |
| `node scripts/dev-debug-smoke.mjs` | Công cụ gỡ lỗi: tiến trình, backtrace (lldb + sample), rò rỉ, thông tin ứng dụng. |
| `node scripts/dev-preview-smoke.mjs` | Hot reload bản xem trước: khởi động, chỉnh sửa → hoán đổi nóng không khởi chạy lại, phục hồi lỗi, dừng. |
| `node scripts/dev-orphan-smoke.mjs` | Nhận nuôi/thu hồi serve-sim mồ côi sau khi máy chủ bị giết không sạch sẽ. |
| `node scripts/dev-ocr-smoke.mjs` | Công cụ Vision-OCR: phân giải trợ thủ, đệm biên dịch swiftc, đường ống nhận dạng, định tuyến tap-text. |
| `node scripts/dev-wda-smoke.mjs` | Máy chủ WebDriverAgent: phân tích `ServerURLHere`, phân loại thất bại, đường hầm, keep-alive (mô phỏng; vòng trực tiếp tùy chọn). |
| `node scripts/dev-realdevice-smoke.mjs` | `xcrun devicectl` trên iPhone kết nối USB — đúng các đường dẫn mã mà công cụ dùng. |
| `node scripts/dev-realstart-smoke.mjs` | Tuyến `/real-start`: hàng rào, từ chối mã hóa, chốt build/khởi chạy (tĩnh). |
| `node scripts/dev-realtools-smoke.mjs` | Backend thiết bị thật của `ios_sim_screenshot` / `ios_sim_interact` / `ios_sim_ui_tree` / `ios_sim_tap_element` cùng `ios_real_start_wda`. |

## Hệ sinh thái

- [DSH Crew](https://github.com/ZSeven-W/dsh-crew) — giao việc cho agent DSH từ Claude Code / Codex
- [DSH Noema](https://github.com/ZSeven-W/dsh-noema) — bộ nhớ dài hạn cho DSH
- [DSH OpenPencil](https://github.com/ZSeven-W/dsh-openpencil) — xem và chỉnh sửa tài liệu thiết kế `.op` ngay trong hội thoại

## Ghi nhận &amp; giấy phép

- [serve-sim](https://github.com/EvanBacon/serve-sim) — Evan Bacon — công cụ truyền phát trình mô phỏng (Apache-2.0; phụ thuộc runtime đi kèm).
- [AXe](https://github.com/cameroncooke/AXe) — Cameron Cooke — CLI trợ năng đứng sau các công cụ cây UI (MIT).
- [WebDriverAgent](https://github.com/appium/WebDriverAgent) — máy chủ WebDriver mà plugin build và khởi chạy trên thiết bị thật (giấy phép BSD).
- Kiến trúc lấy cảm hứng từ plugin “Build iOS Apps” của Codex; công cụ bản xem trước SwiftUI là bản triển khai lại phòng sạch (clean-room) của cách tiếp cận được công bố công khai — không sao chép mã Codex nào.
- Xem [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) để có các thông báo đầy đủ.

**Giấy phép**: MIT
