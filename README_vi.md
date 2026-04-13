# 🏠 HA Smart Room Card

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/hacs/integration)
![version](https://img.shields.io/badge/version-1.1.0-blue)
![HA](https://img.shields.io/badge/Home%20Assistant-2023.1+-green)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

> 🇬🇧 **English version:** [README.md](README.md)

Card tùy chỉnh cho Home Assistant Lovelace — điều khiển toàn bộ phòng thông minh với cảm biến, đa thiết bị, biểu đồ công suất, tự động hóa và trình chỉnh sửa trực quan đầy đủ. Không cần plugin bổ sung.

---

## 📸 Xem trước


### 🎬 Demo
![Demo](assets/preview.gif)

### 🖼️ Screenshot
![Preview](assets/preview.png)

### 🎛️ Visual Editor
![Editor Preview](assets/editor-preview.png)

---

## ✨ Điểm mới trong v1.1.0

### 🧠 HA Smart Room Integration — nâng cấp lớn nhất
Tính năng trọng tâm của v1.1. Thay vì chạy logic tự động hóa trong browser, card kết nối với một custom integration chạy **trực tiếp trên server Home Assistant**. Điều này có nghĩa là:

- ✅ Tự động tắt hoạt động **kể cả khi đóng trình duyệt**
- ✅ Đồng bộ trạng thái **ngay lập tức trên mọi thiết bị** (điện thoại, máy tính bảng, laptop)
- ✅ Không cần tạo helper thủ công — integration tự quản lý
- ✅ Cài đặt một lần, dùng mãi mãi

> **Đây là chế độ đồng bộ được khuyến nghị.** Các chế độ `local` và `helpers` vẫn được hỗ trợ.

### Các cải tiến khác trong v1.1
- 🔄 Xử lý trạng thái chờ thông minh hơn — UI không còn nhấp nháy khi bật/tắt chế độ tự động
- 🧩 Timer ngắt kết nối 8 giây an toàn — chuyển dashboard không còn gây unregister nhầm
- 🐛 Nhiều fix ổn định cho dashboard có nhiều card

---

## ✨ Toàn bộ tính năng

### 🎨 Hiển thị & Giao diện
- 🌡️ **Nhiệt độ & độ ẩm trực tiếp** kèm điểm thoải mái (emoji + màu sắc theo điều kiện)
- 🌤️ **So sánh trong/ngoài** — gợi ý thông minh (mở cửa, bật điều hòa, mang ô...)
- 📊 **Thanh công suất** — hiển thị watt trực tiếp trên card ổ cắm
- 🚪 **Cảm biến cửa & chuyển động** — trạng thái hiện trên header
- 📈 **Biểu đồ 6 giờ** — lịch sử nhiệt độ + công suất kèm timeline bật/tắt ĐH, cửa, chuyển động
- 🏆 **Điểm thoải mái** — tính theo nhiệt độ, độ ẩm, trạng thái quạt & điều hòa

### 🔌 Điều khiển đa thiết bị
- 💡 **Đèn chính** — thanh trượt độ sáng + bật/tắt
- ✨ **Đèn decor** — bật/tắt
- 🏮 **Đèn hiên** — bật/tắt
- 🌈 **Đèn RGB** — chọn effect + modal chọn màu
- 🌀 **Quạt** — popup 5 cấp tốc độ + animation quay
- 🔌 **Ổ cắm** — popup xác nhận + thanh công suất trực tiếp
- 📺 **Smart TV** — thanh trượt âm lượng + panel điều khiển từ xa
- ❄️ **Điều hòa** — điều khiển đầy đủ climate entity
- ➕ **Thêm thiết bị không giới hạn** — thêm bất kỳ loại thiết bị nào qua editor

### 🤖 Tự Động Hóa
- Tự động tắt thiết bị đã chọn sau X phút không phát hiện chuyển động
- Đếm ngược trực tiếp hiển thị trên card
- Nút chuyển Thủ công / Tự động ngay trên header
- **3 chế độ đồng bộ:** Local · HA Helpers · HA Integration *(khuyến nghị)*

### 🎨 Tùy Chỉnh Giao Diện
- 16 preset nền: Default, Night, Sunset, Forest, Aurora, Desert, Ocean, Cherry, Volcano, Galaxy, Ice, Olive, Slate, Rose, Teal, Custom
- Tùy chỉnh màu gradient + thanh trượt độ trong suốt

### 🌐 11 Ngôn Ngữ
🇻🇳 Tiếng Việt · 🇬🇧 English · 🇩🇪 Deutsch · 🇫🇷 Français · 🇳🇱 Nederlands · 🇵🇱 Polski · 🇸🇪 Svenska · 🇭🇺 Magyar · 🇨🇿 Čeština · 🇮🇹 Italiano · 🇵🇹 Português

### 🎛️ Trình Chỉnh Sửa Trực Quan
- Thêm, xóa, sắp xếp lại, đổi tên thiết bị — không cần sửa YAML
- Chọn entity + override icon MDI cho từng thiết bị
- Tất cả cài đặt hiển thị, tự động hóa và màu sắc đều có thể chỉnh trong UI

---

## 📦 Cài Đặt

### Phần 1 — Cài Card (repo này)

**Bước 1:** Thêm vào HACS:

[![Open HACS Repository](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=doanlong1412&repository=ha-smart-room-card&category=plugin)

> Nếu nút không hoạt động:
> **HACS → Frontend → ⋮ → Custom repositories**
> URL: `https://github.com/doanlong1412/ha-smart-room-card` → Type: **Dashboard** → Add

**Bước 2:** Tìm **HA Smart Room Card** → **Install**

**Bước 3:** Hard-reload trình duyệt (`Ctrl+Shift+R`)

---

#### Cài thủ công (thay thế)
1. Tải [`ha-smart-room-card.js`](https://github.com/doanlong1412/ha-smart-room-card/releases/latest)
2. Sao chép vào `/config/www/ha-smart-room-card.js`
3. Vào **Settings → Dashboards → Resources → Add resource**:
   ```
   URL:  /local/ha-smart-room-card.js
   Type: JavaScript module
   ```
4. Hard-reload trình duyệt

---

### Phần 2 — Cài Integration *(khuyến nghị để tự động hóa)*

**HA Smart Room Integration** nằm ở một repository riêng và giúp tự động hóa chạy server-side — hoạt động 24/7 dù trình duyệt đóng hay mở.

> 📖 **Hướng dẫn cài đặt đầy đủ:** [github.com/doanlong1412/ha-smart-room](https://github.com/doanlong1412/ha-smart-room)

**Các bước nhanh:**

**Bước 1:** Trong HACS, vào **Integrations → ⋮ → Custom repositories**

Thêm:
```
URL:  https://github.com/doanlong1412/ha-smart-room
Type: Integration
```

**Bước 2:** Tìm **HA Smart Room** → **Install** → **Restart Home Assistant**

**Bước 3:** Vào **Settings → Devices & Services → Add Integration** → tìm **HA Smart Room** → làm theo hướng dẫn

**Bước 4:** Trong editor của card, vào **Tự động hóa → Chế độ đồng bộ → 🧠 HA Smart Room Integration** → Lưu

Card sẽ tự đăng ký từng phòng với integration. Từ đây, tự động tắt chạy hoàn toàn trên server.

---

## ⚙️ Cấu Hình Card

### Bắt đầu nhanh
```yaml
type: custom:ha-smart-room-card
```
Thêm card vào dashboard, nhấn **✏️ Edit** — tất cả có thể cấu hình trong giao diện.

### Ví dụ YAML đầy đủ

```yaml
type: custom:ha-smart-room-card
language: vi
room_title: Phòng làm việc
background_preset: default
bg_alpha: 91
show_score: true
show_graph: true
show_env_hint: true
show_auto_mode: true
show_timeline: true
auto_delay_min: 5
sync_mode: integration      # integration | helpers | local

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
ocam_power_entity: sensor.cong_suat_o_cam
tv_entity: media_player.smart_tv
tv_remote_entity: remote.remote_tv
ac_entity: climate.dieu_hoa

# Danh sách thiết bị tự động tắt
auto_off_entities:
  - den
  - decor
  - rgb
  - hien
  - quat
  - ocam
  - ac
```

### Bảng key cấu hình

| Key | Kiểu | Mặc định | Mô tả |
|-----|------|----------|-------|
| `language` | string | `vi` | Ngôn ngữ (`vi` `en` `de` `fr` `nl` `pl` `sv` `hu` `cs` `it` `pt`) |
| `room_title` | string | `Smart Room` | Tên phòng hiển thị trên header |
| `background_preset` | string | `default` | Preset gradient nền |
| `bg_alpha` | number | `91` | Độ trong suốt nền (0–100) |
| `show_score` | bool | `true` | Hiện điểm thoải mái |
| `show_graph` | bool | `true` | Hiện biểu đồ môi trường |
| `show_env_hint` | bool | `true` | Hiện thanh so sánh nhiệt độ trong/ngoài |
| `show_auto_mode` | bool | `true` | Hiện nút tự động tắt |
| `show_timeline` | bool | `true` | Hiện timeline bật/tắt ĐH, cửa, chuyển động |
| `auto_delay_min` | number | `5` | Số phút không có người trước khi tự tắt |
| `sync_mode` | string | `integration` | `integration` · `helpers` · `local` |
| `temp_entity` | entity | — | Cảm biến nhiệt độ trong phòng |
| `humi_entity` | entity | — | Cảm biến độ ẩm trong phòng |
| `power_entity` | entity | — | Cảm biến công suất |
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
| `helper_bool` | entity | — | `input_boolean` cho chế độ helpers |
| `helper_num` | entity | — | `input_number` cho chế độ helpers |

---

## 🤖 Chi Tiết 3 Chế Độ Đồng Bộ

### 🧠 Integration mode *(khuyến nghị)*
Yêu cầu cài [HA Smart Room Integration](https://github.com/doanlong1412/ha-smart-room). Tự động hóa chạy server-side — hoạt động 24/7 dù trình duyệt đóng hay mở. Card tự đăng ký từng phòng khi lưu lần đầu.

### 🔘 Helpers mode
Hoạt động trên nhiều thiết bị mà không cần integration. Yêu cầu tạo 2 helper thủ công:

```yaml
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

Đặt `sync_mode: helpers` và chọn 2 helper này trong editor của card.

### 💾 Local mode
Trạng thái lưu trong `localStorage` của trình duyệt. Đơn giản nhất — không cần cài gì thêm, nhưng không đồng bộ giữa các thiết bị và không hoạt động khi đóng trình duyệt.

---

## 🖥️ Tương Thích

| | |
|---|---|
| Home Assistant | 2023.1+ |
| Lovelace | Dashboard mặc định & tùy chỉnh |
| Thiết bị | Mobile & Desktop |
| Phụ thuộc | Không (card hoạt động độc lập) |
| Integration | Tùy chọn — [ha-smart-room](https://github.com/doanlong1412/ha-smart-room) |
| Trình duyệt | Chrome, Firefox, Safari, Edge |

---

## 📋 Lịch Sử Thay Đổi

### v1.1.0 — *(hiện tại)*
- 🧠 Hỗ trợ **HA Smart Room Integration** — tự động hóa server-side, hoạt động không cần trình duyệt
- 🔄 Bảo vệ trạng thái chờ — UI không nhấp nháy khi bật/tắt chế độ tự động
- 🧩 Timer ngắt kết nối 8 giây an toàn — chuyển dashboard không còn unregister nhầm
- 🐛 Nhiều fix ổn định cho dashboard nhiều card
- 🌐 Giao diện integration mode trong editor kèm hướng dẫn từng bước

### v1.0.0
- 🚀 Phát hành nội bộ ban đầu
- Điều khiển đa thiết bị, điểm thoải mái, biểu đồ 6h, gợi ý thông minh
- 11 ngôn ngữ, 16 preset nền, visual editor
- Tự động tắt với đồng bộ local & helpers

---

## 📄 Giấy Phép

MIT — miễn phí sử dụng, chỉnh sửa và phân phối. Nếu thấy hữu ích, hãy ⭐ **star repo** nhé!

---

## 🙏 Credits

Thiết kế và phát triển bởi **[@doanlong1412](https://github.com/doanlong1412)** từ 🇻🇳 Việt Nam.
Theo dõi TikTok: [@long.1412](https://www.tiktok.com/@long.1412)
