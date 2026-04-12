# 🏠 HA Smart Room Card

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/hacs/integration)
![version](https://img.shields.io/badge/version-1.0.0-blue)
![HA](https://img.shields.io/badge/Home%20Assistant-2023.1+-green)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

> 🇬🇧 **English version:** [README.md](README.md)

Card tùy chỉnh cho Home Assistant Lovelace — điều khiển toàn bộ phòng thông minh với cảm biến nhiệt độ & độ ẩm, điều khiển đa thiết bị (đèn, quạt, ổ cắm, điều hòa, TV), hiển thị công suất, cảm biến chuyển động & cửa, chế độ tự động tắt, gợi ý thông minh, biểu đồ môi trường và trình chỉnh sửa trực quan đầy đủ.

**Không cần plugin bổ sung. Hoạt động độc lập, cấu hình hoàn toàn qua giao diện chỉnh sửa tích hợp.**

---

## 📸 Xem trước

### 🖼️ Screenshot
![Preview](assets/preview.png)

### 🎛️ Visual Editor
![Editor Preview](assets/editor-preview.png)

---

## ✨ Tính năng (v1.0.0)

### 🎨 Hiển thị & Giao diện
- 🌡️ **Nhiệt độ & độ ẩm trực tiếp** — hiển thị cảm biến trong nhà theo thời gian thực kèm điểm thoải mái
- 🌤️ **So sánh trong/ngoài** — so sánh nhiệt độ & độ ẩm trong nhà với ngoài trời và đưa ra gợi ý thông minh
- 📊 **Thanh công suất** — hiển thị watt trực tiếp với thanh fill động cho ổ cắm
- 🚪 **Cảm biến cửa & chuyển động** — hiển thị trạng thái đóng/mở cửa và có/không có người trong phòng
- ❄️ **Điều khiển điều hòa** — tích hợp điều khiển đầy đủ climate entity
- 📈 **Biểu đồ môi trường** — lịch sử nhiệt độ và công suất
- 🏆 **Điểm thoải mái** — tính và hiển thị điểm thoải mái dựa trên nhiệt độ + độ ẩm

### 🔌 Điều khiển đa thiết bị
- 💡 **Đèn chính** — thanh trượt độ sáng, bật/tắt
- ✨ **Đèn decor** — bật/tắt
- 🏮 **Đèn hiên** — bật/tắt
- 🌈 **Đèn RGB** — chọn effect + modal chọn màu
- 🌀 **Quạt** — popup tốc độ (5 cấp), animation quay
- 🔌 **Ổ cắm** — popup xác nhận trước khi bật/tắt, hiển thị công suất trực tiếp với thanh fill động
- 📺 **Smart TV** — thanh trượt âm lượng, panel điều khiển từ xa
- ➕ **Thêm thiết bị tùy chỉnh** — thêm không giới hạn thiết bị (đèn, RGB, quạt, ổ cắm, TV, cảm biến) qua editor

### 🤖 Chế độ Tự Động
- **Tự động tắt theo chuyển động** — khi phòng trống trong thời gian cấu hình, tất cả thiết bị đã chọn tự tắt
- **Đếm ngược trực tiếp** — hiển thị thời gian còn lại ngay trên card
- **Chuyển thủ công / tự động** — bật tắt trực tiếp từ header card
- **Đồng bộ qua HA helpers** — tùy chọn đồng bộ trạng thái tự động giữa các thiết bị qua `input_boolean` + `input_number`

### 💡 Thanh Gợi Ý Thông Minh
- Phân tích điều kiện phòng (nhiệt độ, độ ẩm, chuyển động, trạng thái cửa) và đưa ra gợi ý theo ngữ cảnh
- Ví dụ: *"Phòng nóng hơn ngoài trời — nên bật điều hòa"*, *"Phòng trống — đèn vẫn bật"*

### 🎨 Tùy Chỉnh Giao Diện
- **16 preset gradient nền** — Default, Night, Sunset, Forest, Aurora, Desert, Ocean, Cherry, Volcano, Galaxy, Ice, Olive, Slate, Rose, Teal, Custom
- **Màu tùy chỉnh** — gradient nền, màu nhấn, màu chữ
- **Độ trong suốt nền** — thanh trượt điều chỉnh alpha

### 🌐 11 Ngôn Ngữ
- 🇻🇳 Tiếng Việt / 🇬🇧 English / 🇩🇪 Deutsch / 🇫🇷 Français / 🇳🇱 Nederlands
- 🇵🇱 Polski / 🇸🇪 Svenska / 🇭🇺 Magyar / 🇨🇿 Čeština / 🇮🇹 Italiano / 🇵🇹 Português

### 🎛️ Trình Chỉnh Sửa Trực Quan
- Quản lý thiết bị đầy đủ: thêm, xóa, sắp xếp lại, đổi tên thiết bị
- Chọn entity, override icon MDI cho từng thiết bị
- Cài đặt tự động hóa: độ trễ, chọn thiết bị, đồng bộ helper
- Toggle hiển thị: bật/tắt điểm thoải mái, biểu đồ, thanh gợi ý, nút tự động
- Ngôn ngữ, nền, màu sắc — tất cả trong UI, không cần sửa YAML

---

## 📦 Cài Đặt

### Cách 1 — HACS (khuyến nghị)

**Bước 1:** Thêm Custom Repository vào HACS:

[![Open HACS Repository](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=doanlong1412&repository=ha-smart-room-card&category=plugin)

> Nếu nút không hoạt động:
> **HACS → Frontend → ⋮ → Custom repositories**
> → URL: `https://github.com/doanlong1412/ha-smart-room-card` → Type: **Dashboard** → Add

**Bước 2:** Tìm **HA Smart Room Card** → **Install**

**Bước 3:** Hard-reload trình duyệt (`Ctrl+Shift+R`)

---

### Cách 2 — Thủ công

1. Tải [`ha-smart-room-card.js`](https://github.com/doanlong1412/ha-smart-room-card/releases/latest)
2. Sao chép vào `/config/www/ha-smart-room-card.js`
3. Vào **Settings → Dashboards → Resources** → **Add resource**:
   ```
   URL:  /local/ha-smart-room-card.js
   Type: JavaScript module
   ```
4. Hard-reload trình duyệt (`Ctrl+Shift+R`)

---

## ⚙️ Cấu Hình Card

### Bước 1 — Thêm card vào dashboard

```yaml
type: custom:ha-smart-room-card
```

Sau khi thêm, nhấn **✏️ Edit** để mở Config Editor — không cần sửa YAML thủ công.

### Bước 2 — Ví dụ YAML đầy đủ

```yaml
type: custom:ha-smart-room-card
language: vi
room_title: Phòng làm việc
background_preset: default
bg_alpha: 91
show_score: true
show_graph: true
show_smart_bar: true
show_auto_mode: true
auto_delay_min: 5
sync_mode: local          # local | helpers

# Cảm biến
temp_entity: sensor.nhiet_do_phong
humi_entity: sensor.do_am_phong
power_entity: sensor.cong_suat_phong
door_entity: binary_sensor.cam_bien_cua
motion_entity: binary_sensor.cam_bien_chuyen_dong
temp_out_entity: sensor.nhiet_do_ngoai_troi
humi_out_entity: sensor.do_am_ngoai_troi

# Thiết bị
den_entity: light.den_chinh
decor_entity: light.den_decor
hien_entity: light.den_hien
rgb_entity: light.den_rgb
quat_entity: fan.quat_tran        # hỗ trợ fan.* hoặc switch.*
ocam_entity: switch.o_cam
ocam_power_entity: sensor.cong_suat_o_cam   # tùy chọn: sensor công suất ổ cắm
tv_entity: media_player.smart_tv
tv_remote_entity: remote.remote_tv
ac_entity: climate.dieu_hoa

# Tự động tắt
auto_off_entities:
  - den
  - decor
  - rgb
  - hien
  - quat
  - ocam
  - ac

# Tùy chọn — đồng bộ chế độ tự động qua HA helpers (sync_mode: helpers)
helper_bool: input_boolean.hsrc_auto_mode
helper_num: input_number.hsrc_no_motion_since
```

### Bảng các key cấu hình

| Key | Kiểu | Mặc định | Mô tả |
|-----|------|----------|-------|
| `language` | string | `vi` | Ngôn ngữ giao diện (`vi`, `en`, `de`, `fr`, `nl`, `pl`, `sv`, `hu`, `cs`, `it`, `pt`) |
| `room_title` | string | `Smart Room` | Tên phòng hiển thị trên header |
| `background_preset` | string | `default` | Preset gradient nền |
| `bg_alpha` | number | `91` | Độ trong suốt nền (0–100) |
| `show_score` | bool | `true` | Hiển thị điểm thoải mái |
| `show_graph` | bool | `true` | Hiển thị biểu đồ môi trường |
| `show_smart_bar` | bool | `true` | Hiển thị thanh gợi ý thông minh |
| `show_auto_mode` | bool | `true` | Hiển thị nút chế độ tự động |
| `auto_delay_min` | number | `5` | Số phút không có người trước khi tự tắt |
| `sync_mode` | string | `local` | `local` = chỉ localStorage, `helpers` = đồng bộ qua HA helpers |
| `temp_entity` | entity | — | Cảm biến nhiệt độ trong phòng |
| `humi_entity` | entity | — | Cảm biến độ ẩm trong phòng |
| `power_entity` | entity | — | Cảm biến công suất (hiện trên card ổ cắm) |
| `door_entity` | entity | — | Binary sensor cửa |
| `motion_entity` | entity | — | Binary sensor chuyển động |
| `temp_out_entity` | entity | — | Cảm biến nhiệt độ ngoài trời |
| `humi_out_entity` | entity | — | Cảm biến độ ẩm ngoài trời |
| `den_entity` | entity | — | Entity đèn chính |
| `decor_entity` | entity | — | Entity đèn decor |
| `hien_entity` | entity | — | Entity đèn hiên |
| `rgb_entity` | entity | — | Entity đèn RGB |
| `quat_entity` | entity | — | Entity quạt (`fan.*` hoặc `switch.*`) |
| `ocam_entity` | entity | — | Entity switch ổ cắm |
| `ocam_power_entity` | entity | — | Cảm biến công suất ổ cắm (tùy chọn) |
| `tv_entity` | entity | — | Entity media player TV |
| `tv_remote_entity` | entity | — | Entity remote TV |
| `ac_entity` | entity | — | Entity climate điều hòa |
| `helper_bool` | entity | `input_boolean.hsrc_auto_mode` | Helper đồng bộ chế độ tự động |
| `helper_num` | entity | `input_number.hsrc_no_motion_since` | Helper lưu timestamp chuyển động |

---

## 🤖 Helpers Tự Động (tùy chọn)

Để đồng bộ chế độ tự động giữa nhiều thiết bị/trình duyệt, tạo các helper sau trong HA:

```yaml
# configuration.yaml  (hoặc tạo qua Settings → Helpers)
input_boolean:
  hsrc_auto_mode:
    name: HSRC Auto Mode

input_number:
  hsrc_no_motion_since:
    name: HSRC No Motion Since
    min: 0
    max: 9999999999999
    step: 1
    mode: box
```

Sau đó đặt `sync_mode: helpers` trong config card.

---

## 🖥️ Tương Thích

| | |
|---|---|
| Home Assistant | 2023.1+ |
| Lovelace | Dashboard mặc định & tùy chỉnh |
| Thiết bị | Mobile & Desktop |
| Phụ thuộc | Không — hoàn toàn độc lập |
| Trình duyệt | Chrome, Firefox, Safari, Edge |

---

## 📋 Lịch Sử Thay Đổi

### v1.0.0
- 🚀 Phát hành chính thức với tên **HA Smart Room Card**
- 🔌 Hỗ trợ sensor công suất ổ cắm — thêm trường `ocam_power_entity` trong editor và card
- 🌀 Hỗ trợ entity quạt domain `fan.*` — picker chấp nhận cả `fan.*` lẫn `switch.*`
- 🛠️ Sửa lỗi nút "Thêm thiết bị" không hiện ngay trong editor
- 🛠️ Sửa lỗi listener tích lũy khi re-render danh sách thiết bị
- ➕ Hỗ trợ thêm thiết bị không giới hạn qua editor (đèn, RGB, quạt, ổ cắm, TV, cảm biến)
- 🔌 Thiết bị ổ cắm thêm mới hiển thị thanh công suất khi có cảm biến
- 🌐 Hỗ trợ 11 ngôn ngữ

---

## 📄 Giấy Phép

MIT License — miễn phí sử dụng, chỉnh sửa và phân phối.
Nếu bạn thấy hữu ích, hãy ⭐ **star repo** nhé!

---

## 🙏 Credits

Thiết kế và phát triển bởi **[@doanlong1412](https://github.com/doanlong1412)** từ 🇻🇳 Việt Nam.
