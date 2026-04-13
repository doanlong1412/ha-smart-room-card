# 🏠 HA Smart Room Card

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/hacs/integration)
![version](https://img.shields.io/badge/version-1.1.0-blue)
![HA](https://img.shields.io/badge/Home%20Assistant-2023.1+-green)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

> 🇻🇳 **Phiên bản tiếng Việt:** [README_vi.md](README_vi.md)

A custom Home Assistant Lovelace card for full smart room control — sensors, multi-device control, power graph, auto-off automation, and a complete visual editor. No plugins required.

---

## 📸 Preview


### 🎬 Demo
![Demo](assets/preview.gif)

### 🖼️ Screenshot
![Preview](assets/preview.png)

### 🎛️ Visual Editor
![Editor Preview](assets/editor-preview.png)

---

## ✨ What's New in v1.1.0

### 🧠 HA Smart Room Integration — the big upgrade
The headline feature of v1.1. Instead of running automation logic inside the browser, the card now connects to a custom HA integration that runs **server-side on Home Assistant**. This means:

- ✅ Auto-off works **even when the browser is closed**
- ✅ State syncs **instantly across all devices** (phone, tablet, desktop)
- ✅ No manual helper creation — the integration manages everything automatically
- ✅ One-time setup, then it just works

> **This is now the recommended sync mode.** Legacy `local` and `helpers` modes are still supported.

### Other improvements in v1.1
- 🔄 Smarter pending state handling — UI no longer flickers when toggling auto mode
- 🧩 Safe 8-second disconnect timer — switching dashboards no longer triggers accidental unregister
- 🐛 Various stability fixes for multi-card dashboards

---

## ✨ Full Feature List

### 🎨 Display & Interface
- 🌡️ **Live temperature & humidity** with comfort score (emoji + colour)
- 🌤️ **Indoor/outdoor comparison** — contextual suggestions (open window, turn on AC, take umbrella...)
- 📊 **Power consumption bar** — live watt display on outlet card
- 🚪 **Door & motion sensors** — state shown in header
- 📈 **6-hour environment graph** — temperature + power history with AC/door/motion timeline
- 🏆 **Comfort score** — calculated from temp, humidity, fan & AC state

### 🔌 Multi-Device Control
- 💡 **Main light** — brightness slider + toggle
- ✨ **Decor light** — toggle
- 🏮 **Porch light** — toggle
- 🌈 **RGB light** — effect selector + colour picker modal
- 🌀 **Fan** — 5-speed popup + spin animation
- 🔌 **Outlet** — confirm popup + live power bar
- 📺 **Smart TV** — volume slider + remote panel
- ❄️ **Air conditioner** — full climate entity control
- ➕ **Unlimited custom devices** — add any device type via the visual editor

### 🤖 Auto-Off Automation
- Turns off selected devices after X minutes of no motion
- Live countdown displayed on card
- Manual / Auto toggle button in header
- **3 sync modes:** Local · HA Helpers · HA Integration *(recommended)*

### 🎨 Visual Customisation
- 16 background presets: Default, Night, Sunset, Forest, Aurora, Desert, Ocean, Cherry, Volcano, Galaxy, Ice, Olive, Slate, Rose, Teal, Custom
- Custom gradient colours + transparency slider

### 🌐 Multi-language (11 languages)
🇻🇳 Vietnamese · 🇬🇧 English · 🇩🇪 Deutsch · 🇫🇷 Français · 🇳🇱 Nederlands · 🇵🇱 Polski · 🇸🇪 Svenska · 🇭🇺 Magyar · 🇨🇿 Čeština · 🇮🇹 Italiano · 🇵🇹 Português

### 🎛️ Visual Config Editor
- Add, remove, reorder, rename devices — no YAML needed
- Per-device entity picker + MDI icon override
- All display options, automation settings, and colours configurable in-UI

---

## 📦 Installation

### Part 1 — Install the Card (this repo)

**Step 1:** Add to HACS:

[![Open HACS Repository](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=doanlong1412&repository=ha-smart-room-card&category=plugin)

> If the button doesn't work:
> **HACS → Frontend → ⋮ → Custom repositories**
> URL: `https://github.com/doanlong1412/ha-smart-room-card` → Type: **Dashboard** → Add

**Step 2:** Search **HA Smart Room Card** → Install

**Step 3:** Hard-reload browser (`Ctrl+Shift+R`)

---

#### Manual install (alternative)
1. Download [`ha-smart-room-card.js`](https://github.com/doanlong1412/ha-smart-room-card/releases/latest)
2. Copy to `/config/www/ha-smart-room-card.js`
3. Go to **Settings → Dashboards → Resources → Add resource**:
   ```
   URL:  /local/ha-smart-room-card.js
   Type: JavaScript module
   ```
4. Hard-reload browser

---

### Part 2 — Install the Integration *(recommended for auto-off)*

The **HA Smart Room Integration** lives in a separate repository and makes automation run server-side — working 24/7 regardless of whether the browser is open.

> 📖 **Full installation guide:** [github.com/doanlong1412/ha-smart-room](https://github.com/doanlong1412/ha-smart-room)

**Quick steps:**

**Step 1:** In HACS, go to **Integrations → ⋮ → Custom repositories**

Add:
```
URL:  https://github.com/doanlong1412/ha-smart-room
Type: Integration
```

**Step 2:** Search **HA Smart Room** → **Install** → **Restart Home Assistant**

**Step 3:** Go to **Settings → Devices & Services → Add Integration** → search **HA Smart Room** → complete setup

**Step 4:** In the card editor, go to **Automation → Sync mode → 🧠 HA Smart Room Integration** → Save

The card automatically registers each room with the integration. Auto-off now runs entirely on the server.

---

## ⚙️ Configuration

### Quick start
```yaml
type: custom:ha-smart-room-card
```
Add the card, then click **✏️ Edit** — everything is configurable in the UI.

### Full YAML example

```yaml
type: custom:ha-smart-room-card
language: en
room_title: Office
background_preset: default
bg_alpha: 91
show_score: true
show_graph: true
show_env_hint: true
show_auto_mode: true
show_timeline: true
auto_delay_min: 5
sync_mode: integration      # integration | helpers | local

# Sensors
temp_entity: sensor.room_temperature
humi_entity: sensor.room_humidity
power_entity: sensor.room_power
door_entity: binary_sensor.room_door
motion_entity: binary_sensor.room_motion
temp_out_entity: sensor.outdoor_temperature
humi_out_entity: sensor.outdoor_humidity

# Devices
den_entity: light.main_light
decor_entity: light.decor_light
hien_entity: light.porch_light
rgb_entity: light.rgb_strip
quat_entity: fan.ceiling_fan
ocam_entity: switch.outlet
ocam_power_entity: sensor.outlet_power
tv_entity: media_player.smart_tv
tv_remote_entity: remote.tv_remote
ac_entity: climate.air_conditioner

# Auto-off device list
auto_off_entities:
  - den
  - decor
  - rgb
  - hien
  - quat
  - ocam
  - ac
```

### Config reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `language` | string | `vi` | UI language (`vi` `en` `de` `fr` `nl` `pl` `sv` `hu` `cs` `it` `pt`) |
| `room_title` | string | `Smart Room` | Room name shown in header |
| `background_preset` | string | `default` | Background gradient preset |
| `bg_alpha` | number | `91` | Background transparency (0–100) |
| `show_score` | bool | `true` | Show comfort score |
| `show_graph` | bool | `true` | Show environment graph |
| `show_env_hint` | bool | `true` | Show indoor/outdoor comparison bar |
| `show_auto_mode` | bool | `true` | Show auto-off button |
| `show_timeline` | bool | `true` | Show AC/door/motion event timeline |
| `auto_delay_min` | number | `5` | Minutes of no motion before auto-off |
| `sync_mode` | string | `integration` | `integration` · `helpers` · `local` |
| `temp_entity` | entity | — | Indoor temperature sensor |
| `humi_entity` | entity | — | Indoor humidity sensor |
| `power_entity` | entity | — | Power sensor |
| `door_entity` | entity | — | Door binary sensor |
| `motion_entity` | entity | — | Motion binary sensor |
| `temp_out_entity` | entity | — | Outdoor temperature sensor |
| `humi_out_entity` | entity | — | Outdoor humidity sensor |
| `den_entity` | entity | — | Main light |
| `decor_entity` | entity | — | Decor light |
| `hien_entity` | entity | — | Porch light |
| `rgb_entity` | entity | — | RGB light |
| `quat_entity` | entity | — | Fan (`fan.*` or `switch.*`) |
| `ocam_entity` | entity | — | Outlet switch |
| `ocam_power_entity` | entity | — | Outlet power sensor (optional) |
| `tv_entity` | entity | — | Smart TV media player |
| `tv_remote_entity` | entity | — | TV remote |
| `ac_entity` | entity | — | Air conditioner climate entity |
| `helper_bool` | entity | — | `input_boolean` for helpers sync mode |
| `helper_num` | entity | — | `input_number` for helpers sync mode |

---

## 🤖 Sync Mode Details

### 🧠 Integration mode *(recommended)*
Requires the [HA Smart Room Integration](https://github.com/doanlong1412/ha-smart-room). Automation runs server-side — works 24/7 regardless of browser state. The card auto-registers each room on first save.

### 🔘 Helpers mode
Works across devices without the integration. Requires two helpers:

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

Set `sync_mode: helpers` and assign both helpers in the card editor.

### 💾 Local mode
State saved in browser `localStorage` only. Simplest option — no setup needed, but doesn't sync across devices and stops when the browser closes.

---

## 🖥️ Compatibility

| | |
|---|---|
| Home Assistant | 2023.1+ |
| Lovelace | Default & custom dashboards |
| Devices | Mobile & Desktop |
| Dependencies | None (card standalone) |
| Integration | Optional — [ha-smart-room](https://github.com/doanlong1412/ha-smart-room) |
| Browsers | Chrome, Firefox, Safari, Edge |

---

## 📋 Changelog

### v1.1.0 — *(current)*
- 🧠 **HA Smart Room Integration** support — server-side automation, runs without browser
- 🔄 Pending state guard — no UI flicker when toggling auto mode
- 🧩 Safe 8-second disconnect timer — switching dashboards no longer unregisters the room
- 🐛 Stability fixes for multi-card dashboards
- 🌐 Full integration mode UI in visual editor with step-by-step setup guide

### v1.0.0
- 🚀 Initial internal release
- Multi-device control, comfort score, 6h graph, smart hints
- 11 languages, 16 background presets, visual editor
- Auto-off with local & helpers sync

---

## 📄 License

MIT — free to use, modify, and distribute. If you find this useful, please ⭐ **star the repo**!

---

## 🙏 Credits

Designed and developed by **[@doanlong1412](https://github.com/doanlong1412)** from 🇻🇳 Vietnam.
Follow on TikTok: [@long.1412](https://www.tiktok.com/@long.1412)
