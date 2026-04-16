class HASmartRoomCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hass = null;
    this._rgbColor = '#ff4444';
    this._rgbEffect = 'None';
    this._dragging = false;
    this._dragId = null;
    // Khôi phục chế độ tự động — từ localStorage (local) hoặc HA helpers (sync)
    // _useHelpers sẽ được xác định sau khi setConfig chạy; tạm đọc local trước
    this._cardId = 'hsrc_default';
    this._autoMode = false;
    // Flag: chưa đồng bộ lần đầu từ helper — sẽ force sync ngay khi hass + config sẵn sàng
    this._helperSynced = false;
  }

  // ─── Entity map ────────────────────────────────────────────────────────────
  // Dùng cached object thay vì object literal mới mỗi lần gọi,
  // để các mutation từ setConfig (extra devices) persist qua mọi caller.
  // Instance-level entity map: mỗi card có object riêng, không dùng chung static.
  _initEntities() {
    this._instanceEntities = {
      den: null, decor: null, rgb: null, hien: null,
      quat: null, ocam: null, ocamPower: null, tv: null, tvRemote: null,
      motion: null, temp: null, humi: null, power: null,
      door: null, tempOut: null, humiOut: null, ac: null,
    };
  }

  get ENTITIES() {
    if (!this._instanceEntities) this._initEntities();
    return this._instanceEntities;
  }

  static get ENTITIES() { return {}; }

  // ─── HASS setter ───────────────────────────────────────────────────────────
  set hass(hass) { return this._hassAsync(hass); }
  async _hassAsync(hass) {
    this._hass = hass;
    this._lastHass = hass; // lưu để dùng trong disconnectedCallback
    if (!this._rendered) {
      await this._render();
      this._rendered = true;
    } else {
      this._update();
    }
    // Đồng bộ autoMode từ HA helper (nếu dùng helper mode) sau lần render đầu
    // ── Integration mode: đọc state từ entities do integration quản lý ─────────
    if (this._useIntegration && this._rendered) {
      const intOn = this._readAutoModeFromIntegration();

      // _integrationPending: ta vừa ghi switch, chờ HA xác nhận state khớp
      // → chỉ tắt flag khi HA đã phản hồi đúng giá trị ta muốn
      if (this._integrationPending) {
        if (intOn === this._integrationPendingTarget) {
          // HA đã xác nhận → xoá flag, sync bình thường
          this._integrationPending = false;
          this._integrationPendingTarget = undefined;
        } else {
          // HA chưa cập nhật kịp → bỏ qua lần này, giữ nguyên UI
          const remaining = this._readCountdownFromIntegration();
          if (remaining !== null) this._updateAutoCountdown(remaining * 1000);
          return;
        }
      }

      if (!this._helperSynced || intOn !== this._autoMode) {
        this._helperSynced = true;
        this._autoMode = intOn;
        this._syncModeButtonUI();
        this._updateHeader();
        // Trong integration mode, engine JS chỉ cập nhật UI countdown
        // Logic thực tế (tắt thiết bị) do integration xử lý server-side
        if (this._autoMode) {
          this._autoEngineStart();
        } else {
          this._autoEngineStop();
        }
      }
      // Cập nhật UI countdown từ integration sensor
      const remaining = this._readCountdownFromIntegration();
      if (remaining !== null) {
        this._updateAutoCountdown(remaining * 1000);
      }
      return;
    }

    // ── Helper mode: đồng bộ auto mode từ input_boolean ──────────────────────
    if (this._useHelpers && this._rendered) {
      const helperOn = this._readAutoModeFromHelper();
      // Force sync lần đầu (bất kể giá trị có khác hay không)
      // hoặc khi helper thay đổi từ thiết bị khác
      if (!this._helperSynced || helperOn !== this._autoMode) {
        const wasAuto = this._autoMode;
        this._helperSynced = true;
        this._autoMode = helperOn;
        // Cập nhật UI nút bấm ngay lập tức
        this._syncModeButtonUI();
        this._updateHeader();
        // Khởi/dừng engine theo trạng thái mới
        if (this._autoMode) {
          // Vừa chuyển sang Tự động (từ thiết bị khác hoặc lần đầu load)
          // Reset đếm ngược để đồng bộ với thiết bị đã bấm nút
          this._autoFired = false;
          this._localMotionSince = null; // reset để tick tính lại từ HA last_changed
          // Không cần ghi helper ở đây — thiết bị đã bấm nút sẽ ghi, ta chỉ đọc
          this._autoEngineStart();
        } else {
          this._autoEngineStop();
        }
        return; // tránh double-start engine bên dưới
      }
    }
    // Khởi động engine nếu đang ở chế độ tự động
    if (this._autoMode) this._autoEngineStart();
  }

  setConfig(config) {
    this._config = config;
    // Ưu tiên room_title (field riêng của card) → title → room
    // KHÔNG dùng config.type vì nó luôn = 'custom:ha-smart-room-card'
    // → mọi card sẽ bị cùng room_id nếu không đặt title
    const roomName = config.room_title || config.title || config.room || '';
    const titleSlug = roomName
      ? roomName.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 30)
      : 'default';
    this._cardId = 'hsrc_' + titleSlug;
    this._autoMode = localStorage.getItem(this._cardId + '_auto') === '1';
    // Mặc định dùng integration nếu chưa từng chọn sync_mode
    if (!this._config.sync_mode) this._config = { ...this._config, sync_mode: 'integration' };
    this._initEntities();
    // Apply entity overrides from visual editor
    const E = this.ENTITIES;
    if (config.temp_entity)     E.temp     = config.temp_entity;
    if (config.humi_entity)     E.humi     = config.humi_entity;
    if (config.power_entity)    E.power    = config.power_entity;
    if (config.door_entity)     E.door     = config.door_entity;
    if (config.motion_entity)   E.motion   = config.motion_entity;
    if (config.temp_out_entity) E.tempOut  = config.temp_out_entity;
    if (config.humi_out_entity) E.humiOut  = config.humi_out_entity;
    if (config.den_entity)      E.den      = config.den_entity;
    if (config.decor_entity)    E.decor    = config.decor_entity;
    if (config.rgb_entity)      E.rgb      = config.rgb_entity;
    if (config.hien_entity)     E.hien     = config.hien_entity;
    if (config.quat_entity)     E.quat     = config.quat_entity;
    if (config.ocam_entity)       E.ocam      = config.ocam_entity;
    if (config.ocam_power_entity) E.ocamPower = config.ocam_power_entity;
    if (config.tv_entity)       E.tv       = config.tv_entity;
    if (config.tv_remote_entity)E.tvRemote = config.tv_remote_entity;
    if (config.ac_entity)       E.ac       = config.ac_entity;

    // Register extra device entities
    const extras = config.devices_extra || [];
    extras.forEach(d => {
      const ek = d.entityKey || (d.id + '_entity');
      if (config[ek]) E[d.id] = config[ek];
    });

    // Sync color vars when config changes
    if (this._rendered) this._syncRootColorVars();
    // Đăng ký phòng với integration nếu dùng integration mode
    if (this._rendered && this._useIntegration) {
      this._registerWithIntegration();
    }
    if (this._rendered) this._applyDisplayOptions();
    // If card is already rendered, re-render dev-row to reflect added/removed/reordered devices
    if (this._rendered && this.shadowRoot) {
      const devWrap = this.shadowRoot.querySelector('.dev-wrap');
      if (devWrap) {
        const parent = devWrap.parentNode;
        const tmp = document.createElement('div');
        tmp.innerHTML = this._tplDevRow();
        parent.replaceChild(tmp.firstElementChild, devWrap);
        this._bindExtraCardEvents();
      }
    }
  }

  getCardSize() { return 5; }

  // ─── Web Component lifecycle ───────────────────────────────────────────────
  connectedCallback() {
    // Card được gắn lại (chuyển dashboard quay lại) → huỷ timer unregister nếu đang đếm
    if (this._unregisterTimer) {
      clearTimeout(this._unregisterTimer);
      this._unregisterTimer = null;
      console.log('[HASmartRoom] Re-connected — cancelled pending unregister for', this._roomId);
    }
    // Nếu đã render rồi (quay lại từ dashboard khác) → re-register + force sync lại trạng thái nút
    if (this._rendered && this._useIntegration && this._hass) {
      // Reset flag để _hassAsync force-sync lại trạng thái nút từ switch entity
      this._helperSynced = false;
      this._registerWithIntegration().then(() => {
        // Sau khi register xong, đọc lại trạng thái từ HA entity
        const intOn = this._readAutoModeFromIntegration();
        this._autoMode = intOn;
        this._syncModeButtonUI();
        this._updateHeader();
        if (this._autoMode) this._autoEngineStart();
        else this._autoEngineStop();
      });
    }
  }

  disconnectedCallback() {
    // Dọn dẹp timer UI ngay lập tức
    if (this._graphTimer)  { clearInterval(this._graphTimer);  this._graphTimer  = null; }
    if (this._autoTimer)   { clearInterval(this._autoTimer);   this._autoTimer   = null; }

    // QUAN TRỌNG: KHÔNG unregister ngay — chuyển dashboard cũng gọi disconnectedCallback.
    // Dùng timer 8s: nếu card reconnect trong 8s (chuyển tab/dashboard) → huỷ timer, không xoá.
    // Chỉ thực sự unregister khi card bị xoá khỏi dashboard vĩnh viễn.
    if (this._useIntegration) {
      const hass = this._lastHass || this._hass;
      const roomId = this._roomId;
      if (this._unregisterTimer) clearTimeout(this._unregisterTimer);
      this._unregisterTimer = setTimeout(() => {
        this._unregisterTimer = null;
        if (!hass) return;
        try {
          hass.callService('ha_smart_room', 'unregister_room', { room_id: roomId });
          console.log('[HASmartRoom] Unregistered room (card removed):', roomId);
        } catch(e) {
          console.warn('[HASmartRoom] Failed to unregister room:', e);
        }
      }, 8000); // 8 giây — đủ để chuyển dashboard rồi quay lại mà không mất entities
      console.log('[HASmartRoom] Disconnected — pending unregister in 8s for', roomId);
    }
    this._lastHass = null;
  }

  // ─── Auto-off Engine ───────────────────────────────────────────────────────
  //
  // Thiết kế:
  //   • Khi motion → off  : lưu timestamp vào localStorage (persist qua reload/tắt card)
  //   • Khi motion → on   : huỷ đếm ngược, xoá timestamp
  //   • Mỗi giây          : kiểm tra còn bao lâu → nếu <= 0 → gọi turn_off thực
  //   • Thời gian đếm ngược: tất cả đều 5 phút (theo yêu cầu)
  //   • Hiển thị          : "X:XX còn lại" tụt dần trong offInner
  //

  // ─── Card-side i18n ────────────────────────────────────────────────────────
  get _ct() {
    const lang = (this._config && this._config.language) || 'vi';
    const T = {
      vi: {
        tempLabel: 'Nhiệt độ', humiLabel: 'Độ ẩm',
        doorOpen: 'Đang mở', doorClosed: 'Đóng',
        motionYes: 'Có người', motionNo: 'Không ai',
        btnManual: 'Thủ công', btnAuto: 'Tự động',
        modeManual: 'Đang hoạt động ở chế độ <b style="color:rgba(0,235,255,1)">thủ công</b>',
        modeAutoOptimal: 'Hệ thống vận hành tối ưu — không có đề xuất',
        motionPresent: 'Có người trong phòng — tất cả thiết bị giữ nguyên',
        motionCold: 'Nhiệt độ', motionColdSuffix: '°C — điều hòa sẽ giảm công suất',
        noDevice: 'Không có thiết bị nào đang bật',
        autoDone: 'Đã tắt tự động — phòng trống quá {min} phút',
        autoTimer: 'Tắt sau',
        chipDen: 'Đèn chính', chipDecor: 'Decor', chipHien: 'Đèn hiên',
        chipRgb: 'RGB', chipQuat: 'Quạt', chipOcam: 'Ổ cắm', chipAc: 'Điều hòa',
        envHotRoom: 'Trong phòng nóng hơn ngoài trời <b>{d}°C</b> — nên bật điều hòa',
        envWarmRoom: 'Nhiệt độ trong phòng cao hơn ngoài trời <b>{d}°C</b>',
        envCoolOut: 'Ngoài trời đang nóng hơn trong <b>{d}°C</b> — giữ cửa đóng để giữ mát',
        envWarmOut: 'Ngoài trời ấm hơn trong phòng <b>{d}°C</b>',
        envBalance: 'Nhiệt độ trong/ngoài cân bằng: trong <b>{ti}°C</b> · ngoài <b>{to}°C</b>',
        envHumiHigh: 'Độ ẩm trong phòng cao hơn ngoài trời <b>{d}%</b> — nên bật quạt thông gió',
        envHumiMid: 'Độ ẩm trong cao hơn ngoài <b>{d}%</b> — hơi ngột ngạt',
        envHumiOut: 'Ngoài trời ẩm hơn trong <b>{d}%</b> — mở cửa để lấy không khí',
        envHumiBalance: 'Độ ẩm trong/ngoài tương đương: <b>{hi}%</b> / <b>{ho}%</b>',
        envTempIn: 'Nhiệt độ trong phòng: <b>{t}°C</b>',
        envHumiIn: 'Độ ẩm trong phòng: <b>{h}%</b>',
        envLoading: 'Đang cập nhật dữ liệu cảm biến...',
        envHotRoomHigh: 'Phòng nóng hơn ngoài <b>{d}°C</b> — bật điều hòa ngay đi!',
        envHotRoomMid: 'Phòng ấm hơn ngoài <b>{d}°C</b> — cân nhắc bật điều hòa',
        envHotRoomLow: 'Trong phòng cao hơn ngoài <b>{d}°C</b>, không chênh lệch nhiều',
        envOutHeatwave: 'Ngoài đang <b>{t}°C</b> — ra ngoài dễ sốc nhiệt, nhớ <b>đội mũ & uống nước</b>!',
        envOutHot: 'Ngoài <b>{t}°C</b> đang rất nóng — ra ngoài nhớ <b>đội mũ, mặc áo chống nắng</b>',
        envOutWarmClose: 'Ngoài ấm hơn trong phòng <b>{d}°C</b> — giữ cửa đóng để duy trì mát',
        envOutWarm: 'Ngoài ấm hơn trong phòng <b>{d}°C</b>',
        envBalanced: 'Nhiệt độ trong/ngoài gần bằng nhau: <b>{ti}°C</b> / <b>{to}°C</b>',
        envRainyUmbrella: 'Ngoài trời <b>{h}%</b> ẩm — có thể đang mưa, <b>nhớ mang ô</b> nếu ra ngoài!',
        envRainyMaybe: 'Độ ẩm ngoài <b>{h}%</b> — trời có thể mưa, <b>mang ô theo</b> cho chắc',
        envOutHumidSweat: 'Ngoài ẩm <b>{h}%</b> — hơi nóng ẩm khi ra ngoài, chuẩn bị <b>khăn lau mồ hôi</b>',
        envInHumiHighClothes: 'Trong phòng ẩm hơn ngoài <b>{d}%</b> — nên <b>rút quần áo vào</b> nếu đang phơi',
        envInHumiMidVent: 'Trong ẩm hơn ngoài <b>{d}%</b> — mở cửa thông gió sẽ giúp giảm ẩm',
        envInDryHumid: 'Trong phòng khá khô (<b>{h}%</b>) — uống đủ nước, dùng máy tạo ẩm nếu có',
        envOutHumidClose: 'Ngoài ẩm hơn trong <b>{d}%</b> — đóng cửa để giữ không khí dễ chịu',
        envOutHumidLow: 'Ngoài ẩm hơn trong phòng <b>{d}%</b>',
        envOutHotHumid: 'Ngoài nóng ẩm: <b>{t}°C / {h}%</b> — ra ngoài cảm giác <b>rất bức bí</b>',
        envOutVeryDry: 'Ngoài trời đang rất khô (<b>{h}%</b>) — uống nước trước khi ra ngoài',
        envDangerHeat: 'Ngoài đang <b>{t}°C</b> — nguy cơ sốc nhiệt cao, hạn chế ra ngoài lúc này!',
        envHotHumidWarn: 'Ngoài nóng ẩm <b>{t}°C / {h}%</b> — mặc đồ thoáng, uống nhiều nước',
        envOutCold: 'Ngoài đang lạnh <b>{t}°C</b> — ra ngoài nhớ <b>mặc áo ấm</b>',
        envOutVeryCold: 'Ngoài rét <b>{t}°C</b> — mặc đủ ấm, quàng khăn khi ra ngoài!',
        envInVeryHumid: 'Trong phòng rất ẩm <b>{h}%</b> — cân nhắc bật quạt thông gió',
        envInVerydry: 'Không khí trong phòng khá khô <b>{h}%</b> — uống nước đầy đủ',
        hintFan: 'Cửa đóng, nhiệt cao — nên <b>bật quạt</b> để lưu thông khí',
        hintAc: 'Vẫn nóng <b>{t}°C</b> — nên bật điều hòa',
        hintDoorAc: 'Cửa mở + điều hòa bật — lãng phí điện, nên <b>đóng cửa</b>',
        hintOpenDoor: 'Ngoài mát hơn <b>{d}°C</b> — mở cửa thông gió tự nhiên',
        hintEmptyLight: 'Phòng trống — đèn vẫn bật, nên <b>tắt đèn</b>',
        hintEmptyFan: 'Phòng trống — quạt đang chạy, nên <b>tắt quạt</b>',
        hintEmptyAc: 'Không có người — điều hòa đang bật gây lãng phí',
        hintHumi: 'Độ ẩm <b>{h}%</b> — bật quạt để giảm ẩm',
        hintHotOut: 'Ngoài nóng hơn trong <b>{d}°C</b> — nên đóng cửa giữ mát',
        hintRgb: 'Đèn RGB bật nhưng phòng trống — có thể <b>tắt tiết kiệm</b>',
        graphTemp: 'Nhiệt độ (°C)', graphPwr: 'Công suất (W)', graphNow: 'Hiện tại',
        graphAcOn: '❄️ ĐH BẬT lúc', graphAcOff: '❄️ ĐH TẮT lúc',
        graphDoorOpen: '🚪 Cửa Mở lúc', graphDoorClose: '🚪 Cửa Đóng lúc', graphDoorChanged: '🚪 Cửa thay đổi',
        graphMotion: '🚶 Người lần cuối',
        tempVeryHot: '🔥 Nóng bức khủng khiếp!', tempHot: 'Nóng quá, nên bật quạt',
        tempWarm: 'Hơi ấm, cảm giác oi', tempOk: 'Thoải mái, dễ chịu 👌',
        tempCool: 'Mát mẻ, thích hợp làm việc',
        tempCold: 'Lạnh, nên mặc thêm áo', tempVeryCold: '🥶 Lạnh cóng, coi chừng!',
        humiStorm: '🌧️ Độ ẩm cực cao!', humiHigh: 'Độ ẩm rất cao',
        humiMid: 'Hơi ẩm, bình thường', humiOk: 'Độ ẩm lý tưởng 💧',
        humiDry: 'Hơi khô', humiVeryDry: '🏜️ Rất khô hanh',
        scoreLabels: ['Hoàn hảo!','Rất thoải mái','Dễ chịu','Tạm ổn','Hơi bí','Khó chịu','Ngột ngạt','Không thở được'],
        scoreReasons: { hot:'nóng', veryHot:'rất nóng', extremeHot:'cực nóng', slightHot:'hơi nóng',
          slightCold:'hơi lạnh', cold:'lạnh', humid:'ngột ngạt', veryHumid:'rất ẩm', dry:'khô hanh',
          noFan:'không có quạt/ĐH' },
        tvFanSpeed: '⚡ Tốc độ', fanLvl: ['Nhẹ','Thấp','Vừa','Cao','Tối đa'],
        fanPopupTitle: '⚡ Chọn tốc độ quạt',
        rbEffectColor: 'Màu sắc',
        rgbModalTitle: '🌈 Effect & Màu sắc',
        rgbColorLabel: 'MÀU SẮC', rgbCustom: 'Tùy chỉnh:',
        spTempLine: 'Trong: --°C · Ngoài: --°C',
        scoring: 'Đang tính...',
        fanRunning: 'Đang chạy',
        confirmOn: 'Đang TẮT — xác nhận để bật',
        confirmOff: 'Đang BẬT — xác nhận để tắt',
        confirmActionOn: 'BẬT',
        confirmActionOff: 'TẮT',
        confirmCancel: 'Huỷ',
        confirmDevFallback: 'ổ cắm',
        trendUp: 'Đang tăng',
        trendDown: 'Đang giảm',
        aspTitle: '⚙️ Cài đặt tự động tắt',
        aspDelayUnit: 'phút',
        aspDevTitle: '🔌 Thiết bị sẽ tắt',
        colorSensorHdr: '🌡 Cảm biến & Header',
        colorDevHdr: '💡 Thiết bị',
        colorTemp: '🌡 Màu nhiệt độ',
        colorHumi: '💧 Màu độ ẩm',
        colorScore: '⭐ Màu điểm phòng',
        colorDen: '💡 Đèn chính (bật)',
        colorRgb: '🌈 Đèn RGB (bật)',
        colorQuat: '🌀 Quạt (bật)',
        delDevTitle: 'Xóa thiết bị',
        rgbBtnLabel: 'Effect & Màu',
      },
      en: {
        tempLabel: 'Temperature', humiLabel: 'Humidity',
        doorOpen: 'Open', doorClosed: 'Closed',
        motionYes: 'Occupied', motionNo: 'Empty',
        btnManual: 'Manual', btnAuto: 'Auto',
        modeManual: 'Operating in <b style="color:rgba(0,235,255,1)">manual</b> mode',
        modeAutoOptimal: 'System running optimally — no suggestions',
        motionPresent: 'Someone in the room — all devices kept on',
        motionCold: 'Temperature', motionColdSuffix: '°C — AC will reduce power',
        noDevice: 'No devices are currently on',
        autoDone: 'Auto-off triggered — room empty for {min} min',
        autoTimer: 'Off in',
        chipDen: 'Main light', chipDecor: 'Decor', chipHien: 'Porch light',
        chipRgb: 'RGB', chipQuat: 'Fan', chipOcam: 'Outlet', chipAc: 'AC',
        envHotRoom: 'Room is hotter than outside by <b>{d}°C</b> — consider turning on AC',
        envWarmRoom: 'Room temperature is <b>{d}°C</b> higher than outside',
        envCoolOut: 'Outside is <b>{d}°C</b> hotter than inside — keep door closed to stay cool',
        envWarmOut: 'Outside is <b>{d}°C</b> warmer than inside',
        envBalance: 'Indoor/outdoor temp balanced: inside <b>{ti}°C</b> · outside <b>{to}°C</b>',
        envHumiHigh: 'Indoor humidity <b>{d}%</b> higher than outside — consider ventilation fan',
        envHumiMid: 'Indoor humidity <b>{d}%</b> higher than outside — slightly stuffy',
        envHumiOut: 'Outside <b>{d}%</b> more humid — open door for fresh air',
        envHumiBalance: 'Indoor/outdoor humidity balanced: <b>{hi}%</b> / <b>{ho}%</b>',
        envTempIn: 'Indoor temperature: <b>{t}°C</b>',
        envHumiIn: 'Indoor humidity: <b>{h}%</b>',
        envLoading: 'Loading sensor data...',
        envHotRoomHigh: 'Room is <b>{d}°C</b> hotter than outside — turn on AC now!',
        envHotRoomMid: 'Room is <b>{d}°C</b> warmer than outside — consider turning on AC',
        envHotRoomLow: 'Room is <b>{d}°C</b> warmer than outside, not a big difference',
        envOutHeatwave: 'Outside is <b>{t}°C</b> — risk of heat stroke, remember to <b>wear a hat & drink water</b>!',
        envOutHot: 'Outside is <b>{t}°C</b>, very hot — wear a <b>hat and sun-protective clothing</b>',
        envOutWarmClose: 'Outside is <b>{d}°C</b> warmer — keep door closed to maintain cool air',
        envOutWarm: 'Outside is <b>{d}°C</b> warmer than inside',
        envBalanced: 'Indoor/outdoor temps nearly equal: <b>{ti}°C</b> / <b>{to}°C</b>',
        envRainyUmbrella: 'Outside humidity <b>{h}%</b> — likely raining, <b>bring an umbrella</b>!',
        envRainyMaybe: 'Outside humidity <b>{h}%</b> — rain possible, <b>take an umbrella</b> just in case',
        envOutHumidSweat: 'Outside is <b>{h}%</b> humid — bring a <b>sweat towel</b> if heading out',
        envInHumiHighClothes: 'Inside <b>{d}%</b> more humid than outside — time to <b>bring laundry in</b>',
        envInHumiMidVent: 'Inside <b>{d}%</b> more humid — opening windows will help ventilate',
        envInDryHumid: 'Room is quite dry (<b>{h}%</b>) — stay hydrated, consider a humidifier',
        envOutHumidClose: 'Outside <b>{d}%</b> more humid — keep door closed for comfortable air',
        envOutHumidLow: 'Outside is <b>{d}%</b> more humid than inside',
        envOutHotHumid: 'Outside hot & humid: <b>{t}°C / {h}%</b> — will feel <b>very muggy</b> out there',
        envOutVeryDry: 'Outside air is very dry (<b>{h}%</b>) — drink water before heading out',
        envDangerHeat: 'Outside is <b>{t}°C</b> — high risk of heat stroke, avoid going out now!',
        envHotHumidWarn: 'Outside hot & humid <b>{t}°C / {h}%</b> — wear light clothes, drink plenty of water',
        envOutCold: 'Outside is cold at <b>{t}°C</b> — remember to <b>wear a jacket</b>',
        envOutVeryCold: 'Outside is freezing at <b>{t}°C</b> — wrap up warm, wear a scarf!',
        envInVeryHumid: 'Room is very humid <b>{h}%</b> — consider turning on a fan',
        envInVerydry: 'Room air is quite dry <b>{h}%</b> — drink enough water',
        hintFan: 'Door closed, heat rising — consider <b>turning on fan</b>',
        hintAc: 'Still hot at <b>{t}°C</b> — consider turning on AC',
        hintDoorAc: 'Door open + AC on — wasting energy, consider <b>closing door</b>',
        hintOpenDoor: 'Outside is <b>{d}°C</b> cooler — open door for natural ventilation',
        hintEmptyLight: 'Room empty — lights still on, consider <b>turning off lights</b>',
        hintEmptyFan: 'Room empty — fan still running, consider <b>turning off fan</b>',
        hintEmptyAc: 'No one in room — AC running is wasteful',
        hintHumi: 'Humidity <b>{h}%</b> — turn on fan to reduce humidity',
        hintHotOut: 'Outside is <b>{d}°C</b> hotter — consider closing door to stay cool',
        hintRgb: 'RGB light on but room empty — consider <b>turning off to save energy</b>',
        graphTemp: 'Temperature (°C)', graphPwr: 'Power (W)', graphNow: 'Now',
        graphAcOn: '❄️ AC ON at', graphAcOff: '❄️ AC OFF at',
        graphDoorOpen: '🚪 Door Opened at', graphDoorClose: '🚪 Door Closed at', graphDoorChanged: '🚪 Door changed',
        graphMotion: '🚶 Last motion',
        tempVeryHot: '🔥 Dangerously hot!', tempHot: 'Too hot, turn on fan',
        tempWarm: 'Slightly warm, feels stuffy', tempOk: 'Comfortable 👌',
        tempCool: 'Cool, great for working',
        tempCold: 'Cold, consider wearing more', tempVeryCold: '🥶 Very cold, be careful!',
        humiStorm: '🌧️ Extremely high humidity!', humiHigh: 'Very high humidity',
        humiMid: 'Slightly humid, normal', humiOk: 'Ideal humidity 💧',
        humiDry: 'Slightly dry', humiVeryDry: '🏜️ Very dry',
        scoreLabels: ['Perfect!','Very comfortable','Pleasant','Acceptable','Slightly stuffy','Uncomfortable','Stuffy','Can\'t breathe'],
        scoreReasons: { hot:'hot', veryHot:'very hot', extremeHot:'extremely hot', slightHot:'slightly hot',
          slightCold:'slightly cold', cold:'cold', humid:'stuffy', veryHumid:'very humid', dry:'dry',
          noFan:'no fan/AC' },
        tvFanSpeed: '⚡ Speed', fanLvl: ['Low','Level 2','Medium','High','Max'],
        fanPopupTitle: '⚡ Select fan speed',
        rbEffectColor: 'Color',
        rgbModalTitle: '🌈 Effect & Color',
        rgbColorLabel: 'COLORS', rgbCustom: 'Custom:',
        spTempLine: 'Inside: --°C · Outside: --°C',
        scoring: 'Calculating...',
        fanRunning: 'Running',
        confirmOn: 'Currently OFF — confirm to turn on',
        confirmOff: 'Currently ON — confirm to turn off',
        confirmActionOn: 'TURN ON',
        confirmActionOff: 'TURN OFF',
        confirmCancel: 'Cancel',
        confirmDevFallback: 'outlet',
        trendUp: 'Rising',
        trendDown: 'Falling',
        aspTitle: '⚙️ Auto-off settings',
        aspDelayUnit: 'min',
        aspDevTitle: '🔌 Devices to turn off',
        colorSensorHdr: '🌡 Sensors & Header',
        colorDevHdr: '💡 Devices',
        colorTemp: '🌡 Temperature color',
        colorHumi: '💧 Humidity color',
        colorScore: '⭐ Score color',
        colorDen: '💡 Main light (on)',
        colorRgb: '🌈 RGB light (on)',
        colorQuat: '🌀 Fan (on)',
        delDevTitle: 'Remove device',
        rgbBtnLabel: 'Effect & Color',
      },
      de: {
        tempLabel: 'Temperatur', humiLabel: 'Luftfeuchtigkeit',
        doorOpen: 'Offen', doorClosed: 'Geschlossen',
        motionYes: 'Anwesend', motionNo: 'Leer',
        btnManual: 'Manuell', btnAuto: 'Automatik',
        modeManual: 'Betrieb im <b style="color:rgba(0,235,255,1)">manuellen</b> Modus',
        modeAutoOptimal: 'System läuft optimal — keine Vorschläge',
        motionPresent: 'Person im Raum — alle Geräte bleiben an',
        motionCold: 'Temperatur', motionColdSuffix: '°C — Klimaanlage reduziert Leistung',
        noDevice: 'Kein Gerät ist eingeschaltet',
        autoDone: 'Auto-Aus ausgelöst — Raum leer seit {min} Min.',
        autoTimer: 'Aus in',
        chipDen: 'Hauptlicht', chipDecor: 'Deko', chipHien: 'Außenlicht',
        chipRgb: 'RGB', chipQuat: 'Ventilator', chipOcam: 'Steckdose', chipAc: 'Klima',
        envHotRoom: 'Raum ist <b>{d}°C</b> wärmer als draußen — Klimaanlage einschalten',
        envWarmRoom: 'Raumtemperatur ist <b>{d}°C</b> höher als außen',
        envCoolOut: 'Draußen ist <b>{d}°C</b> wärmer — Tür geschlossen halten',
        envWarmOut: 'Draußen ist <b>{d}°C</b> wärmer als innen',
        envBalance: 'Innen/Außen Temp. ausgeglichen: innen <b>{ti}°C</b> · außen <b>{to}°C</b>',
        envHumiHigh: 'Luftfeuchtigkeit innen <b>{d}%</b> höher — Lüftung empfohlen',
        envHumiMid: 'Luftfeuchtigkeit innen <b>{d}%</b> höher — etwas stickig',
        envHumiOut: 'Draußen <b>{d}%</b> feuchter — Tür öffnen für Frischluft',
        envHumiBalance: 'Innen/Außen Feuchtigkeit ausgeglichen: <b>{hi}%</b> / <b>{ho}%</b>',
        envTempIn: 'Raumtemperatur: <b>{t}°C</b>',
        envHumiIn: 'Raumfeuchtigkeit: <b>{h}%</b>',
        envLoading: 'Sensordaten werden geladen...',
        envHotRoomHigh: 'Zimmer ist <b>{d}°C</b> wärmer als draußen — Klimaanlage jetzt einschalten!',
        envHotRoomMid: 'Zimmer ist <b>{d}°C</b> wärmer — Klimaanlage erwägen',
        envHotRoomLow: 'Zimmer ist <b>{d}°C</b> wärmer als draußen, kein großer Unterschied',
        envOutHeatwave: 'Draußen <b>{t}°C</b> — Hitzschlag-Gefahr, bitte <b>Hut tragen & viel trinken</b>!',
        envOutHot: 'Draußen <b>{t}°C</b>, sehr heiß — <b>Hut und Sonnenschutzkleidung</b> tragen',
        envOutWarmClose: 'Draußen <b>{d}°C</b> wärmer — Tür geschlossen halten um Kühle zu bewahren',
        envOutWarm: 'Draußen <b>{d}°C</b> wärmer als drinnen',
        envBalanced: 'Innen/Außen fast gleich: <b>{ti}°C</b> / <b>{to}°C</b>',
        envRainyUmbrella: 'Außenluftfeuchtigkeit <b>{h}%</b> — wahrscheinlich Regen, <b>Regenschirm mitbringen</b>!',
        envRainyMaybe: 'Außenluftfeuchtigkeit <b>{h}%</b> — Regen möglich, <b>Schirm einpacken</b>',
        envOutHumidSweat: 'Draußen <b>{h}%</b> Luftfeuchtigkeit — <b>Schweißtuch</b> mitnehmen',
        envInHumiHighClothes: 'Innen <b>{d}%</b> feuchter — Zeit die <b>Wäsche reinzuholen</b>',
        envInHumiMidVent: 'Innen <b>{d}%</b> feuchter — Fenster öffnen hilft beim Lüften',
        envInDryHumid: 'Raum recht trocken (<b>{h}%</b>) — viel trinken, Luftbefeuchter erwägen',
        envOutHumidClose: 'Draußen <b>{d}%</b> feuchter — Tür geschlossen halten',
        envOutHumidLow: 'Draußen <b>{d}%</b> feuchter als drinnen',
        envOutHotHumid: 'Draußen heiß & schwül: <b>{t}°C / {h}%</b> — wird sich <b>sehr stickig</b> anfühlen',
        envOutVeryDry: 'Außenluft sehr trocken (<b>{h}%</b>) — vor dem Rausgehen trinken',
        envDangerHeat: 'Draußen <b>{t}°C</b> — hohes Hitzschlagrisiko, besser drinnen bleiben!',
        envHotHumidWarn: 'Draußen heiß & schwül <b>{t}°C / {h}%</b> — leichte Kleidung, viel trinken',
        envOutCold: 'Draußen kalt bei <b>{t}°C</b> — <b>Jacke</b> nicht vergessen',
        envOutVeryCold: 'Draußen eisig bei <b>{t}°C</b> — warm einpacken, Schal tragen!',
        envInVeryHumid: 'Sehr hohe Raumfeuchtigkeit <b>{h}%</b> — Ventilator einschalten',
        envInVerydry: 'Raumluft recht trocken <b>{h}%</b> — ausreichend trinken',
        hintFan: 'Tür geschlossen, Hitze steigt — <b>Ventilator einschalten</b>',
        hintAc: 'Noch heiß bei <b>{t}°C</b> — Klimaanlage einschalten',
        hintDoorAc: 'Tür offen + Klimaanlage an — Energieverschwendung, <b>Tür schließen</b>',
        hintOpenDoor: 'Draußen <b>{d}°C</b> kühler — Tür öffnen für natürliche Belüftung',
        hintEmptyLight: 'Raum leer — Licht noch an, <b>Licht ausschalten</b>',
        hintEmptyFan: 'Raum leer — Ventilator läuft noch, <b>ausschalten</b>',
        hintEmptyAc: 'Niemand im Raum — Klimaanlage läuft sinnlos',
        hintHumi: 'Luftfeuchtigkeit <b>{h}%</b> — Ventilator einschalten',
        hintHotOut: 'Draußen <b>{d}°C</b> heißer — Tür schließen zum Kühlen',
        hintRgb: 'RGB-Licht an, Raum leer — <b>zum Sparen ausschalten</b>',
        graphTemp: 'Temperatur (°C)', graphPwr: 'Leistung (W)', graphNow: 'Jetzt',
        graphAcOn: '❄️ Klima AN um', graphAcOff: '❄️ Klima AUS um',
        graphDoorOpen: '🚪 Tür geöffnet um', graphDoorClose: '🚪 Tür geschlossen um', graphDoorChanged: '🚪 Tür geändert',
        graphMotion: '🚶 Letzte Bewegung',
        tempVeryHot: '🔥 Extrem heiß!', tempHot: 'Zu heiß, Ventilator einschalten',
        tempWarm: 'Etwas warm, schwül', tempOk: 'Angenehm 👌',
        tempCool: 'Kühl, gut zum Arbeiten',
        tempCold: 'Kalt, wärmer anziehen', tempVeryCold: '🥶 Sehr kalt, Vorsicht!',
        humiStorm: '🌧️ Extrem hohe Luftfeuchtigkeit!', humiHigh: 'Sehr hohe Luftfeuchtigkeit',
        humiMid: 'Leicht feucht, normal', humiOk: 'Ideale Luftfeuchtigkeit 💧',
        humiDry: 'Leicht trocken', humiVeryDry: '🏜️ Sehr trocken',
        scoreLabels: ['Perfekt!','Sehr angenehm','Angenehm','Akzeptabel','Etwas stickig','Unangenehm','Stickig','Kaum atmbar'],
        scoreReasons: { hot:'heiß', veryHot:'sehr heiß', extremeHot:'extrem heiß', slightHot:'etwas heiß',
          slightCold:'etwas kalt', cold:'kalt', humid:'stickig', veryHumid:'sehr feucht', dry:'trocken',
          noFan:'kein Ventilator/Klima' },
        tvFanSpeed: '⚡ Geschwindigkeit', fanLvl: ['Niedrig','Stufe 2','Mittel','Hoch','Max'],
        fanPopupTitle: '⚡ Lüftergeschwindigkeit wählen',
        rbEffectColor: 'Farbe',
        rgbModalTitle: '🌈 Effekt & Farbe',
        rgbColorLabel: 'FARBEN', rgbCustom: 'Benutzerdefiniert:',
        spTempLine: 'Innen: --°C · Außen: --°C',
        scoring: 'Berechne...',
        fanRunning: 'Läuft',
        confirmOn: 'Aktuell AUS — bestätigen zum Einschalten',
        confirmOff: 'Aktuell AN — bestätigen zum Ausschalten',
        confirmActionOn: 'EINSCHALTEN',
        confirmActionOff: 'AUSSCHALTEN',
        confirmCancel: 'Abbrechen',
        confirmDevFallback: 'Steckdose',
        trendUp: 'Steigend',
        trendDown: 'Fallend',
        aspTitle: '⚙️ Auto-Aus Einstellungen',
        aspDelayUnit: 'Min',
        aspDevTitle: '🔌 Geräte ausschalten',
        colorSensorHdr: '🌡 Sensoren & Header',
        colorDevHdr: '💡 Geräte',
        colorTemp: '🌡 Temperaturfarbe',
        colorHumi: '💧 Feuchtigkeitsfarbe',
        colorScore: '⭐ Bewertungsfarbe',
        colorDen: '💡 Hauptlicht (an)',
        colorRgb: '🌈 RGB-Licht (an)',
        colorQuat: '🌀 Ventilator (an)',
        delDevTitle: 'Gerät entfernen',
        rgbBtnLabel: 'Effekt & Farbe',
      },
      fr: {
        tempLabel: 'Température', humiLabel: 'Humidité',
        doorOpen: 'Ouverte', doorClosed: 'Fermée',
        motionYes: 'Présence', motionNo: 'Vide',
        btnManual: 'Manuel', btnAuto: 'Auto',
        modeManual: 'Fonctionnement en mode <b style="color:rgba(0,235,255,1)">manuel</b>',
        modeAutoOptimal: 'Système optimal — aucune suggestion',
        motionPresent: 'Quelqu\'un dans la pièce — tous les appareils maintenus',
        motionCold: 'Température', motionColdSuffix: '°C — la climatisation réduira la puissance',
        noDevice: 'Aucun appareil allumé',
        autoDone: 'Extinction auto — pièce vide depuis {min} min',
        autoTimer: 'Éteint dans',
        chipDen: 'Lumière principale', chipDecor: 'Décor', chipHien: 'Lumière véranda',
        chipRgb: 'RGB', chipQuat: 'Ventilateur', chipOcam: 'Prise', chipAc: 'Clim',
        envHotRoom: 'Pièce <b>{d}°C</b> plus chaude que dehors — allumer la clim',
        envWarmRoom: 'Température intérieure <b>{d}°C</b> plus haute que dehors',
        envCoolOut: 'Dehors <b>{d}°C</b> plus chaud — garder la porte fermée',
        envWarmOut: 'Dehors <b>{d}°C</b> plus chaud qu\'à l\'intérieur',
        envBalance: 'Temp. intérieure/extérieure équilibrée: dedans <b>{ti}°C</b> · dehors <b>{to}°C</b>',
        envHumiHigh: 'Humidité intérieure <b>{d}%</b> plus élevée — ventilation recommandée',
        envHumiMid: 'Humidité intérieure <b>{d}%</b> plus élevée — légèrement étouffant',
        envHumiOut: 'Dehors <b>{d}%</b> plus humide — ouvrir la porte',
        envHumiBalance: 'Humidité int./ext. équilibrée: <b>{hi}%</b> / <b>{ho}%</b>',
        envTempIn: 'Température intérieure: <b>{t}°C</b>',
        envHumiIn: 'Humidité intérieure: <b>{h}%</b>',
        envLoading: 'Chargement des données capteurs...',
        envHotRoomHigh: 'La pièce est <b>{d}°C</b> plus chaude — allumez la clim maintenant!',
        envHotRoomMid: 'La pièce est <b>{d}°C</b> plus chaude — pensez à la climatisation',
        envHotRoomLow: 'La pièce est <b>{d}°C</b> plus chaude, différence légère',
        envOutHeatwave: 'Dehors <b>{t}00b0C</b> — risque de coup de chaleur, <b>chapeau &amp; eau</b>!',
        envOutHot: 'Dehors <b>{t}°C</b>, très chaud — <b>chapeau et vêtements anti-UV</b> recommandés',
        envOutWarmClose: 'Dehors <b>{d}°C</b> plus chaud — gardez la porte fermée pour rester au frais',
        envOutWarm: 'Dehors <b>{d}°C</b> plus chaud qu’à l’intérieur',
        envBalanced: 'Températures intérieure/extérieure presque égales: <b>{ti}°C</b> / <b>{to}°C</b>',
        envRainyUmbrella: 'Humidité extérieure <b>{h}%</b> — il pleut probablement, <b>prenez un parapluie</b>!',
        envRainyMaybe: 'Humidité extérieure <b>{h}%</b> — pluie possible, <b>emportez un parapluie</b>',
        envOutHumidSweat: 'Dehors <b>{h}%</b> d’humidité — prenez une <b>serviette</b> si vous sortez',
        envInHumiHighClothes: 'Intérieur <b>{d}%</b> plus humide — pensez à <b>rentrer le linge</b>',
        envInHumiMidVent: 'Intérieur <b>{d}%</b> plus humide — ouvrir les fenêtres aide à ventiler',
        envInDryHumid: 'Pièce assez sèche (<b>{h}%</b>) — hydratez-vous, pensez à un humidificateur',
        envOutHumidClose: 'Dehors <b>{d}%</b> plus humide — gardez la porte fermée',
        envOutHumidLow: 'Dehors <b>{d}%</b> plus humide qu’à l’intérieur',
        envOutHotHumid: 'Dehors chaud et humide: <b>{t}°C / {h}%</b> — sensation de <b>chaleur étouffante</b>',
        envOutVeryDry: 'Air extérieur très sec (<b>{h}%</b>) — buvez avant de sortir',
        envDangerHeat: 'Dehors <b>{t}°C</b> — risque élevé de coup de chaleur, évitez de sortir!',
        envHotHumidWarn: 'Dehors chaud et humide <b>{t}°C / {h}%</b> — vêtements légers, buvez beaucoup',
        envOutCold: 'Dehors froid à <b>{t}°C</b> — n’oubliez pas votre <b>veste</b>',
        envOutVeryCold: 'Dehors glacial à <b>{t}°C</b> — habillez-vous chaudement, portez une écharpe!',
        envInVeryHumid: 'Pièce très humide <b>{h}%</b> — envisagez d’allumer un ventilateur',
        envInVerydry: 'Air intérieur assez sec <b>{h}%</b> — buvez suffisamment',
        hintFan: 'Porte fermée, chaleur élevée — <b>allumer le ventilateur</b>',
        hintAc: 'Encore chaud à <b>{t}°C</b> — allumer la climatisation',
        hintDoorAc: 'Porte ouverte + clim allumée — gaspillage, <b>fermer la porte</b>',
        hintOpenDoor: 'Dehors <b>{d}°C</b> plus frais — ouvrir pour ventilation naturelle',
        hintEmptyLight: 'Pièce vide — lumières encore allumées, <b>éteindre</b>',
        hintEmptyFan: 'Pièce vide — ventilateur encore en marche, <b>éteindre</b>',
        hintEmptyAc: 'Personne dans la pièce — la clim tourne pour rien',
        hintHumi: 'Humidité <b>{h}%</b> — allumer le ventilateur',
        hintHotOut: 'Dehors <b>{d}°C</b> plus chaud — fermer la porte pour rester au frais',
        hintRgb: 'Lumière RGB allumée, pièce vide — <b>éteindre pour économiser</b>',
        graphTemp: 'Température (°C)', graphPwr: 'Puissance (W)', graphNow: 'Maintenant',
        graphAcOn: '❄️ Clim ALLUMÉE à', graphAcOff: '❄️ Clim ÉTEINTE à',
        graphDoorOpen: '🚪 Porte ouverte à', graphDoorClose: '🚪 Porte fermée à', graphDoorChanged: '🚪 Porte changée',
        graphMotion: '🚶 Dernier mouvement',
        tempVeryHot: '🔥 Chaleur extrême!', tempHot: 'Trop chaud, allumer le ventilateur',
        tempWarm: 'Légèrement chaud, étouffant', tempOk: 'Confortable 👌',
        tempCool: 'Frais, idéal pour travailler',
        tempCold: 'Froid, s\'habiller plus chaudement', tempVeryCold: '🥶 Très froid, attention!',
        humiStorm: '🌧️ Humidité extrêmement élevée!', humiHigh: 'Humidité très élevée',
        humiMid: 'Légèrement humide, normal', humiOk: 'Humidité idéale 💧',
        humiDry: 'Légèrement sec', humiVeryDry: '🏜️ Très sec',
        scoreLabels: ['Parfait!','Très confortable','Agréable','Acceptable','Légèrement étouffant','Inconfortable','Étouffant','Irrespirable'],
        scoreReasons: { hot:'chaud', veryHot:'très chaud', extremeHot:'extrêmement chaud', slightHot:'légèrement chaud',
          slightCold:'légèrement froid', cold:'froid', humid:'étouffant', veryHumid:'très humide', dry:'sec',
          noFan:'pas de ventilateur/clim' },
        tvFanSpeed: '⚡ Vitesse', fanLvl: ['Faible','Niveau 2','Moyen','Élevé','Max'],
        fanPopupTitle: '⚡ Choisir la vitesse du ventilateur',
        rbEffectColor: 'Couleur',
        rgbModalTitle: '🌈 Effet & Couleur',
        rgbColorLabel: 'COULEURS', rgbCustom: 'Personnalisé:',
        spTempLine: 'Intérieur: --°C · Extérieur: --°C',
        scoring: 'Calcul...',
        fanRunning: 'En marche',
        confirmOn: 'Actuellement ÉTEINT — confirmer pour allumer',
        confirmOff: 'Actuellement ALLUMÉ — confirmer pour éteindre',
        confirmActionOn: 'ALLUMER',
        confirmActionOff: 'ÉTEINDRE',
        confirmCancel: 'Annuler',
        confirmDevFallback: 'prise',
        trendUp: 'En hausse',
        trendDown: 'En baisse',
        aspTitle: '⚙️ Paramètres auto-extinction',
        aspDelayUnit: 'min',
        aspDevTitle: '🔌 Appareils à éteindre',
        colorSensorHdr: '🌡 Capteurs & En-tête',
        colorDevHdr: '💡 Appareils',
        colorTemp: '🌡 Couleur température',
        colorHumi: '💧 Couleur humidité',
        colorScore: '⭐ Couleur score',
        colorDen: '💡 Lumière principale (allumée)',
        colorRgb: '🌈 Lumière RGB (allumée)',
        colorQuat: '🌀 Ventilateur (allumé)',
        delDevTitle: 'Supprimer appareil',
        rgbBtnLabel: 'Effet & Couleur',
      },
      nl: {
        tempLabel: 'Temperatuur', humiLabel: 'Luchtvochtigheid',
        doorOpen: 'Open', doorClosed: 'Gesloten',
        motionYes: 'Aanwezig', motionNo: 'Leeg',
        btnManual: 'Handmatig', btnAuto: 'Automatisch',
        modeManual: 'Werkend in <b style="color:rgba(0,235,255,1)">handmatige</b> modus',
        modeAutoOptimal: 'Systeem loopt optimaal — geen suggesties',
        motionPresent: 'Iemand in de kamer — alle apparaten blijven aan',
        motionCold: 'Temperatuur', motionColdSuffix: '°C — airco vermindert vermogen',
        noDevice: 'Geen apparaten aan',
        autoDone: 'Auto-uit — kamer {min} min leeg',
        autoTimer: 'Uit over',
        chipDen: 'Hoofdlamp', chipDecor: 'Decorlamp', chipHien: 'Portieeklamp',
        chipRgb: 'RGB', chipQuat: 'Ventilator', chipOcam: 'Stopcontact', chipAc: 'Airco',
        envHotRoom: 'Kamer is <b>{d}°C</b> warmer dan buiten — zet airco aan',
        envWarmRoom: 'Kamertemperatuur is <b>{d}°C</b> hoger dan buiten',
        envCoolOut: 'Buiten <b>{d}°C</b> warmer — deur dicht houden',
        envWarmOut: 'Buiten <b>{d}°C</b> warmer dan binnen',
        envBalance: 'Binnen/buiten temperatuur gelijk: binnen <b>{ti}°C</b> · buiten <b>{to}°C</b>',
        envHumiHigh: 'Binnenvochtigheid <b>{d}%</b> hoger — ventilatie aanbevolen',
        envHumiMid: 'Binnenvochtigheid <b>{d}%</b> hoger — licht benauwd',
        envHumiOut: 'Buiten <b>{d}%</b> vochtiger — deur openen voor frisse lucht',
        envHumiBalance: 'Binnen/buiten vochtigheid gelijk: <b>{hi}%</b> / <b>{ho}%</b>',
        envTempIn: 'Binnentemperatuur: <b>{t}°C</b>',
        envHumiIn: 'Binnenvochtigheid: <b>{h}%</b>',
        envLoading: 'Sensorgegevens laden...',
        envHotRoomHigh: 'Kamer is <b>{d}°C</b> warmer — zet de airco nu aan!',
        envHotRoomMid: 'Kamer is <b>{d}°C</b> warmer — overweeg de airco',
        envHotRoomLow: 'Kamer is <b>{d}°C</b> warmer, klein verschil',
        envOutHeatwave: 'Buiten <b>{t}°C</b> — gevaar voor hitteberoerte, <b>draag een hoed & drink water</b>!',
        envOutHot: 'Buiten <b>{t}°C</b>, erg warm — draag een <b>hoed en zonbeschermende kleding</b>',
        envOutWarmClose: 'Buiten <b>{d}°C</b> warmer — houd de deur dicht om koel te blijven',
        envOutWarm: 'Buiten <b>{d}°C</b> warmer dan binnen',
        envBalanced: 'Binnen/buiten bijna gelijk: <b>{ti}°C</b> / <b>{to}°C</b>',
        envRainyUmbrella: 'Buitenvochtigheid <b>{h}%</b> — waarschijnlijk regen, <b>neem een paraplu</b>!',
        envRainyMaybe: 'Buitenvochtigheid <b>{h}%</b> — kans op regen, <b>paraplu meenemen</b>',
        envOutHumidSweat: 'Buiten <b>{h}%</b> vochtig — neem een <b>zweetthanddoek</b> mee',
        envInHumiHighClothes: 'Binnen <b>{d}%</b> vochtiger — tijd om <b>de was binnen te halen</b>',
        envInHumiMidVent: 'Binnen <b>{d}%</b> vochtiger — raam openen helpt ventileren',
        envInDryHumid: 'Kamer vrij droog (<b>{h}%</b>) — drink genoeg, overweeg luchtbevochtiger',
        envOutHumidClose: 'Buiten <b>{d}%</b> vochtiger — houd deur dicht voor comfortabele lucht',
        envOutHumidLow: 'Buiten <b>{d}%</b> vochtiger dan binnen',
        envOutHotHumid: 'Buiten warm & vochtig: <b>{t}°C / {h}%</b> — voelt <b>erg benauwd</b> aan buiten',
        envOutVeryDry: 'Buitenlucht erg droog (<b>{h}%</b>) — drink voor je naar buiten gaat',
        envDangerHeat: 'Buiten <b>{t}°C</b> — hoog risico op hitteberoerte, blijf liever binnen!',
        envHotHumidWarn: 'Buiten warm & vochtig <b>{t}°C / {h}%</b> — lichte kleding, veel drinken',
        envOutCold: 'Buiten koud bij <b>{t}°C</b> — vergeet je <b>jas</b> niet',
        envOutVeryCold: 'Buiten ijzig bij <b>{t}°C</b> — warm aankleden, sjaal dragen!',
        envInVeryHumid: 'Kamer erg vochtig <b>{h}%</b> — overweeg ventilator aan te zetten',
        envInVerydry: 'Kamerlucht vrij droog <b>{h}%</b> — drink voldoende',
        hintFan: 'Deur dicht, hitte stijgt — <b>ventilator aanzetten</b>',
        hintAc: 'Nog steeds heet bij <b>{t}°C</b> — airco aanzetten',
        hintDoorAc: 'Deur open + airco aan — verspilling, <b>deur sluiten</b>',
        hintOpenDoor: 'Buiten <b>{d}°C</b> koeler — deur openen voor natuurlijke ventilatie',
        hintEmptyLight: 'Kamer leeg — lichten nog aan, <b>uitschakelen</b>',
        hintEmptyFan: 'Kamer leeg — ventilator draait nog, <b>uitschakelen</b>',
        hintEmptyAc: 'Niemand in kamer — airco loopt voor niets',
        hintHumi: 'Vochtigheid <b>{h}%</b> — ventilator aanzetten',
        hintHotOut: 'Buiten <b>{d}°C</b> heter — deur sluiten om koel te blijven',
        hintRgb: 'RGB-lamp aan, kamer leeg — <b>uitschakelen om te besparen</b>',
        graphTemp: 'Temperatuur (°C)', graphPwr: 'Vermogen (W)', graphNow: 'Nu',
        graphAcOn: '❄️ Airco AAN om', graphAcOff: '❄️ Airco UIT om',
        graphDoorOpen: '🚪 Deur geopend om', graphDoorClose: '🚪 Deur gesloten om', graphDoorChanged: '🚪 Deur gewijzigd',
        graphMotion: '🚶 Laatste beweging',
        tempVeryHot: '🔥 Gevaarlijk heet!', tempHot: 'Te heet, ventilator aanzetten',
        tempWarm: 'Licht warm, benauwd', tempOk: 'Comfortabel 👌',
        tempCool: 'Koel, ideaal om te werken',
        tempCold: 'Koud, warmer aankleden', tempVeryCold: '🥶 Erg koud, pas op!',
        humiStorm: '🌧️ Extreem hoge luchtvochtigheid!', humiHigh: 'Zeer hoge luchtvochtigheid',
        humiMid: 'Licht vochtig, normaal', humiOk: 'Ideale luchtvochtigheid 💧',
        humiDry: 'Licht droog', humiVeryDry: '🏜️ Zeer droog',
        scoreLabels: ['Perfect!','Zeer comfortabel','Aangenaam','Acceptabel','Licht benauwd','Oncomfortabel','Benauwd','Nauwelijks ademhalen'],
        scoreReasons: { hot:'heet', veryHot:'erg heet', extremeHot:'extreem heet', slightHot:'licht heet',
          slightCold:'licht koud', cold:'koud', humid:'benauwd', veryHumid:'erg vochtig', dry:'droog',
          noFan:'geen ventilator/airco' },
        tvFanSpeed: '⚡ Snelheid', fanLvl: ['Laag','Niveau 2','Gemiddeld','Hoog','Max'],
        fanPopupTitle: '⚡ Ventilatorsnelheid kiezen',
        rbEffectColor: 'Kleur',
        rgbModalTitle: '🌈 Effect & Kleur',
        rgbColorLabel: 'KLEUREN', rgbCustom: 'Aangepast:',
        spTempLine: 'Binnen: --°C · Buiten: --°C',
        scoring: 'Berekenen...',
        fanRunning: 'Loopt',
        confirmOn: 'Momenteel UIT — bevestigen om in te schakelen',
        confirmOff: 'Momenteel AAN — bevestigen om uit te schakelen',
        confirmActionOn: 'INSCHAKELEN',
        confirmActionOff: 'UITSCHAKELEN',
        confirmCancel: 'Annuleren',
        confirmDevFallback: 'stopcontact',
        trendUp: 'Stijgend',
        trendDown: 'Dalend',
        aspTitle: '⚙️ Auto-uit instellingen',
        aspDelayUnit: 'min',
        aspDevTitle: '🔌 Apparaten uitschakelen',
        colorSensorHdr: '🌡 Sensoren & Header',
        colorDevHdr: '💡 Apparaten',
        colorTemp: '🌡 Temperatuurkleur',
        colorHumi: '💧 Vochtigheidskleur',
        colorScore: '⭐ Scorecolor',
        colorDen: '💡 Hoofdlamp (aan)',
        colorRgb: '🌈 RGB-lamp (aan)',
        colorQuat: '🌀 Ventilator (aan)',
        delDevTitle: 'Apparaat verwijderen',
        rgbBtnLabel: 'Effect & Kleur',
      },
      pl: {
        tempLabel: 'Temperatura', humiLabel: 'Wilgotność',
        doorOpen: 'Otwarte', doorClosed: 'Zamknięte',
        motionYes: 'Obecny', motionNo: 'Puste',
        btnManual: 'Ręczny', btnAuto: 'Auto',
        modeManual: 'Działanie w trybie <b style="color:rgba(0,235,255,1)">ręcznym</b>',
        modeAutoOptimal: 'System działa optymalnie — brak sugestii',
        motionPresent: 'Ktoś w pokoju — wszystkie urządzenia pozostają włączone',
        motionCold: 'Temperatura', motionColdSuffix: '°C — klimatyzacja zmniejszy moc',
        noDevice: 'Żadne urządzenie nie jest włączone',
        autoDone: 'Auto-wyłączenie — pokój pusty przez {min} min',
        autoTimer: 'Wyłączenie za',
        chipDen: 'Główne światło', chipDecor: 'Dekor', chipHien: 'Światło wejście',
        chipRgb: 'RGB', chipQuat: 'Wentylator', chipOcam: 'Gniazdo', chipAc: 'Klima',
        envHotRoom: 'Pokój cieplejszy o <b>{d}°C</b> niż na zewnątrz — włącz klimatyzację',
        envWarmRoom: 'Temperatura w pokoju <b>{d}°C</b> wyższa niż na zewnątrz',
        envCoolOut: 'Na zewnątrz <b>{d}°C</b> cieplej — trzymaj drzwi zamknięte',
        envWarmOut: 'Na zewnątrz <b>{d}°C</b> cieplej niż w środku',
        envBalance: 'Temperatura wewn./zewn. zrównoważona: wewnątrz <b>{ti}°C</b> · zewnątrz <b>{to}°C</b>',
        envHumiHigh: 'Wilgotność wewnętrzna <b>{d}%</b> wyższa — zalecana wentylacja',
        envHumiMid: 'Wilgotność wewnętrzna <b>{d}%</b> wyższa — lekko duszno',
        envHumiOut: 'Na zewnątrz <b>{d}%</b> bardziej wilgotno — otwórz drzwi',
        envHumiBalance: 'Wilgotność wewn./zewn. zrównoważona: <b>{hi}%</b> / <b>{ho}%</b>',
        envTempIn: 'Temperatura wewnętrzna: <b>{t}°C</b>',
        envHumiIn: 'Wilgotność wewnętrzna: <b>{h}%</b>',
        envLoading: 'Ładowanie danych czujników...',
        envHotRoomHigh: 'Pokój jest <b>{d}°C</b> cieplejszy — włącz klimatyzację teraz!',
        envHotRoomMid: 'Pokój jest <b>{d}°C</b> cieplejszy — rozważ klimatyzację',
        envHotRoomLow: 'Pokój jest <b>{d}°C</b> cieplejszy, niewielka różnica',
        envOutHeatwave: 'Na zewnątrz <b>{t}°C</b> — ryzyko udaru cieplnego, <b>noś czapkę i pij wodę</b>!',
        envOutHot: 'Na zewnątrz <b>{t}°C</b>, bardzo gorąco — <b>czapka i odzież UV</b> zalecane',
        envOutWarmClose: 'Na zewnątrz <b>{d}°C</b> cieplej — zamknij drzwi żeby utrzymać chłód',
        envOutWarm: 'Na zewnątrz <b>{d}°C</b> cieplej niż w środku',
        envBalanced: 'Temperatura wewn./zewn. prawie równa: <b>{ti}°C</b> / <b>{to}°C</b>',
        envRainyUmbrella: 'Wilgotność zewnętrzna <b>{h}%</b> — prawdopodobnie pada, <b>weź parasol</b>!',
        envRainyMaybe: 'Wilgotność zewnętrzna <b>{h}%</b> — możliwy deszcz, <b>weź parasol</b>',
        envOutHumidSweat: 'Na zewnątrz <b>{h}%</b> wilgotności — weź <b>ręcznik</b> na pot',
        envInHumiHighClothes: 'W środku <b>{d}%</b> wilgotniej — czas <b>zabrać pranie do domu</b>',
        envInHumiMidVent: 'W środku <b>{d}%</b> wilgotniej — otwarcie okna pomoże przewietrzyć',
        envInDryHumid: 'Pokój dość suchy (<b>{h}%</b>) — pij dużo wody, rozważ nawilżacz',
        envOutHumidClose: 'Na zewnątrz <b>{d}%</b> wilgotniej — zamknij drzwi',
        envOutHumidLow: 'Na zewnątrz <b>{d}%</b> wilgotniej niż w środku',
        envOutHotHumid: 'Na zewnątrz gorąco i wilgotno: <b>{t}°C / {h}%</b> — będzie się czuć <b>bardzo duszno</b>',
        envOutVeryDry: 'Powietrze zewnętrzne bardzo suche (<b>{h}%</b>) — pij wodę przed wyjściem',
        envDangerHeat: 'Na zewnątrz <b>{t}°C</b> — wysokie ryzyko udaru, lepiej zostań w środku!',
        envHotHumidWarn: 'Na zewnątrz gorąco i wilgotno <b>{t}°C / {h}%</b> — lekkie ubrania, dużo wody',
        envOutCold: 'Na zewnątrz zimno <b>{t}°C</b> — nie zapomnij <b>kurtki</b>',
        envOutVeryCold: 'Na zewnątrz mróz <b>{t}°C</b> — ubierz się ciepło, noś szalik!',
        envInVeryHumid: 'Pokój bardzo wilgotny <b>{h}%</b> — rozważ włączenie wentylatora',
        envInVerydry: 'Powietrze w pokoju dość suche <b>{h}%</b> — pij wystarczająco',
        hintFan: 'Drzwi zamknięte, wzrost ciepła — <b>włącz wentylator</b>',
        hintAc: 'Wciąż gorąco przy <b>{t}°C</b> — włącz klimatyzację',
        hintDoorAc: 'Drzwi otwarte + klimatyzacja włączona — marnotrawstwo, <b>zamknij drzwi</b>',
        hintOpenDoor: 'Na zewnątrz <b>{d}°C</b> chłodniej — otwórz drzwi dla naturalnej wentylacji',
        hintEmptyLight: 'Pokój pusty — światła wciąż włączone, <b>wyłącz</b>',
        hintEmptyFan: 'Pokój pusty — wentylator wciąż działa, <b>wyłącz</b>',
        hintEmptyAc: 'Nikt w pokoju — klimatyzacja pracuje bez sensu',
        hintHumi: 'Wilgotność <b>{h}%</b> — włącz wentylator',
        hintHotOut: 'Na zewnątrz <b>{d}°C</b> cieplej — zamknij drzwi aby zostać chłodnym',
        hintRgb: 'Światło RGB włączone, pokój pusty — <b>wyłącz aby oszczędzać</b>',
        graphTemp: 'Temperatura (°C)', graphPwr: 'Moc (W)', graphNow: 'Teraz',
        graphAcOn: '❄️ Klima WŁĄCZONA o', graphAcOff: '❄️ Klima WYŁĄCZONA o',
        graphDoorOpen: '🚪 Drzwi otwarte o', graphDoorClose: '🚪 Drzwi zamknięte o', graphDoorChanged: '🚪 Drzwi zmienione',
        graphMotion: '🚶 Ostatni ruch',
        tempVeryHot: '🔥 Niebezpiecznie gorąco!', tempHot: 'Za gorąco, włącz wentylator',
        tempWarm: 'Lekko ciepło, duszno', tempOk: 'Komfortowo 👌',
        tempCool: 'Chłodno, idealne do pracy',
        tempCold: 'Zimno, ubierz się cieplej', tempVeryCold: '🥶 Bardzo zimno, ostrożnie!',
        humiStorm: '🌧️ Ekstremalnie wysoka wilgotność!', humiHigh: 'Bardzo wysoka wilgotność',
        humiMid: 'Lekko wilgotno, normalne', humiOk: 'Idealna wilgotność 💧',
        humiDry: 'Lekko sucho', humiVeryDry: '🏜️ Bardzo sucho',
        scoreLabels: ['Idealnie!','Bardzo komfortowo','Przyjemnie','Akceptowalnie','Lekko duszno','Niekomfortowo','Duszno','Trudno oddychać'],
        scoreReasons: { hot:'gorąco', veryHot:'bardzo gorąco', extremeHot:'ekstremalnie gorąco', slightHot:'lekko gorąco',
          slightCold:'lekko zimno', cold:'zimno', humid:'duszno', veryHumid:'bardzo wilgotno', dry:'sucho',
          noFan:'brak wentylatora/klimy' },
        tvFanSpeed: '⚡ Prędkość', fanLvl: ['Niska','Poziom 2','Średnia','Wysoka','Max'],
        fanPopupTitle: '⚡ Wybierz prędkość wentylatora',
        rbEffectColor: 'Kolor',
        rgbModalTitle: '🌈 Efekt & Kolor',
        rgbColorLabel: 'KOLORY', rgbCustom: 'Niestandardowy:',
        spTempLine: 'Wewnątrz: --°C · Zewnątrz: --°C',
        scoring: 'Obliczam...',
        fanRunning: 'Działa',
        confirmOn: 'Aktualnie WYŁ — potwierdź, aby włączyć',
        confirmOff: 'Aktualnie WŁ — potwierdź, aby wyłączyć',
        confirmActionOn: 'WŁĄCZ',
        confirmActionOff: 'WYŁĄCZ',
        confirmCancel: 'Anuluj',
        confirmDevFallback: 'gniazdo',
        trendUp: 'Rosnący',
        trendDown: 'Malejący',
        aspTitle: '⚙️ Ustawienia auto-wyłączenia',
        aspDelayUnit: 'min',
        aspDevTitle: '🔌 Urządzenia do wyłączenia',
        colorSensorHdr: '🌡 Czujniki & Nagłówek',
        colorDevHdr: '💡 Urządzenia',
        colorTemp: '🌡 Kolor temperatury',
        colorHumi: '💧 Kolor wilgotności',
        colorScore: '⭐ Kolor wyniku',
        colorDen: '💡 Główne światło (włączone)',
        colorRgb: '🌈 Światło RGB (włączone)',
        colorQuat: '🌀 Wentylator (włączony)',
        delDevTitle: 'Usuń urządzenie',
        rgbBtnLabel: 'Efekt & Kolor',
      },
      sv: {
        tempLabel: 'Temperatur', humiLabel: 'Luftfuktighet',
        doorOpen: 'Öppen', doorClosed: 'Stängd',
        motionYes: 'Närvarande', motionNo: 'Tom',
        btnManual: 'Manuell', btnAuto: 'Auto',
        modeManual: 'Körs i <b style="color:rgba(0,235,255,1)">manuellt</b> läge',
        modeAutoOptimal: 'Systemet körs optimalt — inga förslag',
        motionPresent: 'Någon i rummet — alla enheter hålls på',
        motionCold: 'Temperatur', motionColdSuffix: '°C — AC minskar effekt',
        noDevice: 'Inga enheter är påslagna',
        autoDone: 'Auto-av — rummet tomt i {min} min',
        autoTimer: 'Av om',
        chipDen: 'Huvudljus', chipDecor: 'Dekorljus', chipHien: 'Verandaljus',
        chipRgb: 'RGB', chipQuat: 'Fläkt', chipOcam: 'Uttag', chipAc: 'AC',
        envHotRoom: 'Rummet är <b>{d}°C</b> varmare än ute — slå på AC',
        envWarmRoom: 'Rumstemperaturen är <b>{d}°C</b> högre än ute',
        envCoolOut: 'Ute är <b>{d}°C</b> varmare — håll dörren stängd',
        envWarmOut: 'Ute är <b>{d}°C</b> varmare än inne',
        envBalance: 'Inne/ute temperatur balanserad: inne <b>{ti}°C</b> · ute <b>{to}°C</b>',
        envHumiHigh: 'Inomhusfuktighet <b>{d}%</b> högre — ventilation rekommenderas',
        envHumiMid: 'Inomhusfuktighet <b>{d}%</b> högre — lite instängt',
        envHumiOut: 'Ute <b>{d}%</b> fuktigare — öppna dörren för frisk luft',
        envHumiBalance: 'Inne/ute fuktighet balanserad: <b>{hi}%</b> / <b>{ho}%</b>',
        envTempIn: 'Inomhustemperatur: <b>{t}°C</b>',
        envHumiIn: 'Inomhusfuktighet: <b>{h}%</b>',
        envLoading: 'Laddar sensordata...',
        envHotRoomHigh: 'Rummet är <b>{d}°C</b> varmare — slå på AC nu!',
        envHotRoomMid: 'Rummet är <b>{d}°C</b> varmare — överväg att slå på AC',
        envHotRoomLow: 'Rummet är <b>{d}°C</b> varmare, liten skillnad',
        envOutHeatwave: 'Ute är <b>{t}°C</b> — risk för värmeslag, kom ihåg <b>hatt & drick vatten</b>!',
        envOutHot: 'Ute <b>{t}°C</b>, mycket varmt — bär <b>hatt och solskyddskläder</b>',
        envOutWarmClose: 'Ute <b>{d}°C</b> varmare — håll dörren stängd för att behålla svalt',
        envOutWarm: 'Ute <b>{d}°C</b> varmare än inne',
        envBalanced: 'Inne/ute nästan lika: <b>{ti}°C</b> / <b>{to}°C</b>',
        envRainyUmbrella: 'Utomhusfuktighet <b>{h}%</b> — troligen regn, <b>ta med paraply</b>!',
        envRainyMaybe: 'Utomhusfuktighet <b>{h}%</b> — möjligt regn, <b>ta med paraply</b>',
        envOutHumidSweat: 'Ute <b>{h}%</b> fuktigt — ta med en <b>svetthandduk</b>',
        envInHumiHighClothes: 'Inne <b>{d}%</b> fuktigare — dags att <b>ta in tvätten</b>',
        envInHumiMidVent: 'Inne <b>{d}%</b> fuktigare — öppna fönster hjälper till att ventilera',
        envInDryHumid: 'Rummet ganska torrt (<b>{h}%</b>) — drick tillräckligt, överväg luftfuktare',
        envOutHumidClose: 'Ute <b>{d}%</b> fuktigare — håll dörren stängd',
        envOutHumidLow: 'Ute <b>{d}%</b> fuktigare än inne',
        envOutHotHumid: 'Ute varmt och fuktigt: <b>{t}°C / {h}%</b> — kommer kännas <b>väldigt kvavt</b>',
        envOutVeryDry: 'Utomhusluften mycket torr (<b>{h}%</b>) — drick vatten innan du går ut',
        envDangerHeat: 'Ute <b>{t}°C</b> — hög risk för värmeslag, undvik att gå ut!',
        envHotHumidWarn: 'Ute varmt och fuktigt <b>{t}°C / {h}%</b> — lätta kläder, drick mycket',
        envOutCold: 'Ute kallt vid <b>{t}°C</b> — glöm inte <b>jackan</b>',
        envOutVeryCold: 'Ute iskallt vid <b>{t}°C</b> — klä dig varmt, bär halsduk!',
        envInVeryHumid: 'Rummet mycket fuktigt <b>{h}%</b> — överväg att sätta på fläkt',
        envInVerydry: 'Rumsluften ganska torr <b>{h}%</b> — drick tillräckligt',
        hintFan: 'Dörr stängd, värmen stiger — <b>slå på fläkt</b>',
        hintAc: 'Fortfarande varmt vid <b>{t}°C</b> — slå på AC',
        hintDoorAc: 'Dörr öppen + AC på — slöseri, <b>stäng dörren</b>',
        hintOpenDoor: 'Ute är <b>{d}°C</b> svalare — öppna dörren för naturlig ventilation',
        hintEmptyLight: 'Rummet tomt — lampor fortfarande på, <b>stäng av</b>',
        hintEmptyFan: 'Rummet tomt — fläkt fortfarande igång, <b>stäng av</b>',
        hintEmptyAc: 'Ingen i rummet — AC körs i onödan',
        hintHumi: 'Fuktighet <b>{h}%</b> — slå på fläkt',
        hintHotOut: 'Ute är <b>{d}°C</b> varmare — stäng dörren för att hålla svalt',
        hintRgb: 'RGB-lampa på, rummet tomt — <b>stäng av för att spara</b>',
        graphTemp: 'Temperatur (°C)', graphPwr: 'Effekt (W)', graphNow: 'Nu',
        graphAcOn: '❄️ AC PÅ kl.', graphAcOff: '❄️ AC AV kl.',
        graphDoorOpen: '🚪 Dörr öppnad kl.', graphDoorClose: '🚪 Dörr stängd kl.', graphDoorChanged: '🚪 Dörr ändrad',
        graphMotion: '🚶 Senaste rörelse',
        tempVeryHot: '🔥 Farligt varmt!', tempHot: 'För varmt, slå på fläkt',
        tempWarm: 'Lite varmt, instängt', tempOk: 'Bekvämt 👌',
        tempCool: 'Svalt, perfekt för att arbeta',
        tempCold: 'Kallt, klä på dig mer', tempVeryCold: '🥶 Mycket kallt, var försiktig!',
        humiStorm: '🌧️ Extremt hög luftfuktighet!', humiHigh: 'Mycket hög luftfuktighet',
        humiMid: 'Lite fuktigt, normalt', humiOk: 'Idealisk luftfuktighet 💧',
        humiDry: 'Lite torrt', humiVeryDry: '🏜️ Mycket torrt',
        scoreLabels: ['Perfekt!','Mycket bekvämt','Trevligt','Acceptabelt','Lite instängt','Obekvämt','Instängt','Knappt andas'],
        scoreReasons: { hot:'varmt', veryHot:'mycket varmt', extremeHot:'extremt varmt', slightHot:'lite varmt',
          slightCold:'lite kallt', cold:'kallt', humid:'instängt', veryHumid:'mycket fuktigt', dry:'torrt',
          noFan:'ingen fläkt/AC' },
        tvFanSpeed: '⚡ Hastighet', fanLvl: ['Låg','Nivå 2','Medel','Hög','Max'],
        fanPopupTitle: '⚡ Välj fläkthastighet',
        rbEffectColor: 'Färg',
        rgbModalTitle: '🌈 Effekt & Färg',
        rgbColorLabel: 'FÄRGER', rgbCustom: 'Anpassad:',
        spTempLine: 'Inne: --°C · Ute: --°C',
        scoring: 'Beräknar...',
        fanRunning: 'Igång',
        confirmOn: 'För närvarande AV — bekräfta för att slå på',
        confirmOff: 'För närvarande PÅ — bekräfta för att stänga av',
        confirmActionOn: 'SLÅ PÅ',
        confirmActionOff: 'STÄNG AV',
        confirmCancel: 'Avbryt',
        confirmDevFallback: 'uttag',
        trendUp: 'Stigande',
        trendDown: 'Fallande',
        aspTitle: '⚙️ Inställningar för auto-av',
        aspDelayUnit: 'min',
        aspDevTitle: '🔌 Enheter att stänga av',
        colorSensorHdr: '🌡 Sensorer & Header',
        colorDevHdr: '💡 Enheter',
        colorTemp: '🌡 Temperaturfärg',
        colorHumi: '💧 Fuktighetsfärg',
        colorScore: '⭐ Poängfärg',
        colorDen: '💡 Huvudlampa (på)',
        colorRgb: '🌈 RGB-lampa (på)',
        colorQuat: '🌀 Fläkt (på)',
        delDevTitle: 'Ta bort enhet',
        rgbBtnLabel: 'Effekt & Färg',
      },
      hu: {
        tempLabel: 'Hőmérséklet', humiLabel: 'Páratartalom',
        doorOpen: 'Nyitva', doorClosed: 'Zárva',
        motionYes: 'Jelenlét', motionNo: 'Üres',
        btnManual: 'Kézi', btnAuto: 'Auto',
        modeManual: '<b style="color:rgba(0,235,255,1)">Kézi</b> módban működik',
        modeAutoOptimal: 'A rendszer optimálisan működik — nincs javaslat',
        motionPresent: 'Valaki a szobában — minden eszköz bekapcsolva marad',
        motionCold: 'Hőmérséklet', motionColdSuffix: '°C — a légkondicionáló csökkenti a teljesítményt',
        noDevice: 'Nincs bekapcsolt eszköz',
        autoDone: 'Auto-kikapcsolás — szoba {min} perce üres',
        autoTimer: 'Kikapcsol',
        chipDen: 'Fővilágítás', chipDecor: 'Dekor', chipHien: 'Tornác lámpa',
        chipRgb: 'RGB', chipQuat: 'Ventilátor', chipOcam: 'Aljzat', chipAc: 'Légkondicionáló',
        envHotRoom: 'A szoba <b>{d}°C</b>-kal melegebb mint kinn — kapcsolja be a légkondicionálót',
        envWarmRoom: 'A szoba hőmérséklete <b>{d}°C</b>-kal magasabb mint kinn',
        envCoolOut: 'Kinn <b>{d}°C</b>-kal melegebb — tartsa zárva az ajtót',
        envWarmOut: 'Kinn <b>{d}°C</b>-kal melegebb mint belül',
        envBalance: 'Belső/külső hőmérséklet kiegyensúlyozott: belül <b>{ti}°C</b> · kinn <b>{to}°C</b>',
        envHumiHigh: 'Belső páratartalom <b>{d}%</b>-kal magasabb — szellőztetés javasolt',
        envHumiMid: 'Belső páratartalom <b>{d}%</b>-kal magasabb — kissé fülledt',
        envHumiOut: 'Kinn <b>{d}%</b>-kal párásabb — nyissa ki az ajtót',
        envHumiBalance: 'Belső/külső páratartalom kiegyensúlyozott: <b>{hi}%</b> / <b>{ho}%</b>',
        envTempIn: 'Belső hőmérséklet: <b>{t}°C</b>',
        envHumiIn: 'Belső páratartalom: <b>{h}%</b>',
        envLoading: 'Érzékelő adatok betöltése...',
        envHotRoomHigh: 'A szoba <b>{d}°C</b>-kal melegebb — kapcsolja be a légkondicionálót!',
        envHotRoomMid: 'A szoba <b>{d}°C</b>-kal melegebb — fontolja meg a légkondicionálót',
        envHotRoomLow: 'A szoba <b>{d}°C</b>-kal melegebb, kis különbség',
        envOutHeatwave: 'Kinn <b>{t}°C</b> — hőguta veszélye, viseljen <b>kalapot és igyon vizet</b>!',
        envOutHot: 'Kinn <b>{t}°C</b>, nagyon meleg — <b>kalapot és napvédő ruhát</b> viseljen',
        envOutWarmClose: 'Kinn <b>{d}°C</b>-kal melegebb — tartsa zárva az ajtót a hűvösség megőrzéséhez',
        envOutWarm: 'Kinn <b>{d}°C</b>-kal melegebb mint belül',
        envBalanced: 'Belső/külső hőmérséklet közel egyenlő: <b>{ti}°C</b> / <b>{to}°C</b>',
        envRainyUmbrella: 'Kültéri páratartalom <b>{h}%</b> — valószínűleg esik, <b>vigyen esernyőt</b>!',
        envRainyMaybe: 'Kültéri páratartalom <b>{h}%</b> — lehetséges eső, <b>vigyen esernyőt</b>',
        envOutHumidSweat: 'Kinn <b>{h}%</b> páratartalom — vigyen <b>törölközőt</b> izzadáshoz',
        envInHumiHighClothes: 'Belül <b>{d}%</b>-kal párásabb — ideje <b>behozni a ruhát a szárítóról</b>',
        envInHumiMidVent: 'Belül <b>{d}%</b>-kal párásabb — ablak nyitása segít szellőztetni',
        envInDryHumid: 'A szoba elég száraz (<b>{h}%</b>) — igyon eleget, fontolja meg a párásítót',
        envOutHumidClose: 'Kinn <b>{d}%</b>-kal párásabb — tartsa zárva az ajtót',
        envOutHumidLow: 'Kinn <b>{d}%</b>-kal párásabb mint belül',
        envOutHotHumid: 'Kinn meleg és párás: <b>{t}°C / {h}%</b> — <b>nagyon nyomasztó</b> lesz odakinn',
        envOutVeryDry: 'A külső levegő nagyon száraz (<b>{h}%</b>) — igyon mielőtt kimegy',
        envDangerHeat: 'Kinn <b>{t}°C</b> — magas hőguta kockázat, inkább maradjon bent!',
        envHotHumidWarn: 'Kinn meleg és párás <b>{t}°C / {h}%</b> — könnyű ruha, sok folyadék',
        envOutCold: 'Kinn hideg <b>{t}°C</b> — ne felejtse el a <b>kabátot</b>',
        envOutVeryCold: 'Kinn fagyos <b>{t}°C</b> — öltözzön melegen, viseljen sálat!',
        envInVeryHumid: 'A szoba nagyon párás <b>{h}%</b> — fontolja meg a ventilátor bekapcsolását',
        envInVerydry: 'A szoba levegője elég száraz <b>{h}%</b> — igyon eleget',
        hintFan: 'Ajtó zárva, hő növekszik — <b>kapcsolja be a ventilátort</b>',
        hintAc: 'Még mindig meleg <b>{t}°C</b> — kapcsolja be a légkondicionálót',
        hintDoorAc: 'Ajtó nyitva + légkondicionáló be — pazarlás, <b>zárja be az ajtót</b>',
        hintOpenDoor: 'Kinn <b>{d}°C</b>-kal hűvösebb — nyissa ki az ajtót természetes szellőzéshez',
        hintEmptyLight: 'Üres szoba — lámpák még égnek, <b>kapcsolja ki</b>',
        hintEmptyFan: 'Üres szoba — ventilátor még megy, <b>kapcsolja ki</b>',
        hintEmptyAc: 'Nincs senki a szobában — a légkondicionáló feleslegesen megy',
        hintHumi: 'Páratartalom <b>{h}%</b> — kapcsolja be a ventilátort',
        hintHotOut: 'Kinn <b>{d}°C</b>-kal melegebb — zárja be az ajtót a hűvösség megőrzéséhez',
        hintRgb: 'RGB lámpa be, üres szoba — <b>kapcsolja ki energiatakarékosságból</b>',
        graphTemp: 'Hőmérséklet (°C)', graphPwr: 'Teljesítmény (W)', graphNow: 'Most',
        graphAcOn: '❄️ Légkondicionáló BE', graphAcOff: '❄️ Légkondicionáló KI',
        graphDoorOpen: '🚪 Ajtó nyitva', graphDoorClose: '🚪 Ajtó zárva', graphDoorChanged: '🚪 Ajtó változott',
        graphMotion: '🚶 Utolsó mozgás',
        tempVeryHot: '🔥 Veszélyesen meleg!', tempHot: 'Túl meleg, kapcsolja be a ventilátort',
        tempWarm: 'Kissé meleg, fülledt', tempOk: 'Kényelmes 👌',
        tempCool: 'Hűvös, ideális munkához',
        tempCold: 'Hideg, vegyen fel többet', tempVeryCold: '🥶 Nagyon hideg, vigyázzon!',
        humiStorm: '🌧️ Rendkívül magas páratartalom!', humiHigh: 'Nagyon magas páratartalom',
        humiMid: 'Kissé párás, normális', humiOk: 'Ideális páratartalom 💧',
        humiDry: 'Kissé száraz', humiVeryDry: '🏜️ Nagyon száraz',
        scoreLabels: ['Tökéletes!','Nagyon kényelmes','Kellemes','Elfogadható','Kissé fülledt','Kellemetlen','Fülledt','Alig lehet lélegezni'],
        scoreReasons: { hot:'meleg', veryHot:'nagyon meleg', extremeHot:'rendkívül meleg', slightHot:'kissé meleg',
          slightCold:'kissé hideg', cold:'hideg', humid:'fülledt', veryHumid:'nagyon párás', dry:'száraz',
          noFan:'nincs ventilátor/légkondicionáló' },
        tvFanSpeed: '⚡ Sebesség', fanLvl: ['Alacsony','2. szint','Közepes','Magas','Max'],
        fanPopupTitle: '⚡ Ventilátor sebesség kiválasztása',
        rbEffectColor: 'Szín',
        rgbModalTitle: '🌈 Effekt & Szín',
        rgbColorLabel: 'SZÍNEK', rgbCustom: 'Egyéni:',
        spTempLine: 'Belül: --°C · Kinn: --°C',
        scoring: 'Számítás...',
        fanRunning: 'Fut',
        confirmOn: 'Jelenleg KI — megerősítés a bekapcsoláshoz',
        confirmOff: 'Jelenleg BE — megerősítés a kikapcsoláshoz',
        confirmActionOn: 'BEKAPCSOL',
        confirmActionOff: 'KIKAPCSOL',
        confirmCancel: 'Mégse',
        confirmDevFallback: 'aljzat',
        trendUp: 'Emelkedő',
        trendDown: 'Csökkenő',
        aspTitle: '⚙️ Auto-kikapcsolás beállítások',
        aspDelayUnit: 'perc',
        aspDevTitle: '🔌 Kikapcsolandó eszközök',
        colorSensorHdr: '🌡 Érzékelők & Fejléc',
        colorDevHdr: '💡 Eszközök',
        colorTemp: '🌡 Hőmérséklet szín',
        colorHumi: '💧 Páratartalom szín',
        colorScore: '⭐ Pontszám szín',
        colorDen: '💡 Fővilágítás (be)',
        colorRgb: '🌈 RGB lámpa (be)',
        colorQuat: '🌀 Ventilátor (be)',
        delDevTitle: 'Eszköz eltávolítása',
        rgbBtnLabel: 'Effekt & Szín',
      },
      cs: {
        tempLabel: 'Teplota', humiLabel: 'Vlhkost',
        doorOpen: 'Otevřeno', doorClosed: 'Zavřeno',
        motionYes: 'Přítomnost', motionNo: 'Prázdno',
        btnManual: 'Ruční', btnAuto: 'Auto',
        modeManual: 'Provoz v <b style="color:rgba(0,235,255,1)">ručním</b> režimu',
        modeAutoOptimal: 'Systém běží optimálně — žádné návrhy',
        motionPresent: 'Někdo v místnosti — všechna zařízení zůstávají zapnutá',
        motionCold: 'Teplota', motionColdSuffix: '°C — klimatizace sníží výkon',
        noDevice: 'Žádné zařízení není zapnuté',
        autoDone: 'Auto-vypnutí — místnost prázdná {min} min',
        autoTimer: 'Vypnutí za',
        chipDen: 'Hlavní světlo', chipDecor: 'Dekor', chipHien: 'Světlo u vchodu',
        chipRgb: 'RGB', chipQuat: 'Ventilátor', chipOcam: 'Zásuvka', chipAc: 'Klima',
        envHotRoom: 'Místnost je o <b>{d}°C</b> teplejší než venku — zapněte klimatizaci',
        envWarmRoom: 'Teplota v místnosti je o <b>{d}°C</b> vyšší než venku',
        envCoolOut: 'Venku je o <b>{d}°C</b> teplejší — nechte dveře zavřené',
        envWarmOut: 'Venku je o <b>{d}°C</b> teplejší než uvnitř',
        envBalance: 'Teplota uvnitř/venku vyvážená: uvnitř <b>{ti}°C</b> · venku <b>{to}°C</b>',
        envHumiHigh: 'Vnitřní vlhkost o <b>{d}%</b> vyšší — doporučeno větrání',
        envHumiMid: 'Vnitřní vlhkost o <b>{d}%</b> vyšší — trochu dusno',
        envHumiOut: 'Venku o <b>{d}%</b> vlhčeji — otevřete dveře pro čerstvý vzduch',
        envHumiBalance: 'Vlhkost uvnitř/venku vyvážená: <b>{hi}%</b> / <b>{ho}%</b>',
        envTempIn: 'Vnitřní teplota: <b>{t}°C</b>',
        envHumiIn: 'Vnitřní vlhkost: <b>{h}%</b>',
        envLoading: 'Načítání dat senzorů...',
        envHotRoomHigh: 'Místnost je o <b>{d}°C</b> teplejší — zapněte klimatizaci hned!',
        envHotRoomMid: 'Místnost je o <b>{d}°C</b> teplejší — zvažte klimatizaci',
        envHotRoomLow: 'Místnost je o <b>{d}°C</b> teplejší, malý rozdíl',
        envOutHeatwave: 'Venku <b>{t}°C</b> — riziko úpalu, nezapomeňte na <b>klobouk a pití</b>!',
        envOutHot: 'Venku <b>{t}°C</b>, velmi horko — noste <b>klobouk a UV oblečení</b>',
        envOutWarmClose: 'Venku o <b>{d}°C</b> teplejší — zavřete dveře pro udržení chládku',
        envOutWarm: 'Venku o <b>{d}°C</b> teplejší než uvnitř',
        envBalanced: 'Teplota uvnitř/venku téměř stejná: <b>{ti}°C</b> / <b>{to}°C</b>',
        envRainyUmbrella: 'Venkovní vlhkost <b>{h}%</b> — pravděpodobně prší, <b>vezměte deštník</b>!',
        envRainyMaybe: 'Venkovní vlhkost <b>{h}%</b> — možný déšť, <b>vezměte deštník</b>',
        envOutHumidSweat: 'Venku <b>{h}%</b> vlhkosti — vezměte <b>ručník na pot</b>',
        envInHumiHighClothes: 'Uvnitř o <b>{d}%</b> vlhčeji — čas <b>přinést prádlo dovnitř</b>',
        envInHumiMidVent: 'Uvnitř o <b>{d}%</b> vlhčeji — otevření okna pomůže vyvětrat',
        envInDryHumid: 'Místnost dost suchá (<b>{h}%</b>) — pijte dost, zvažte zvlhčovač',
        envOutHumidClose: 'Venku o <b>{d}%</b> vlhčeji — zavřete dveře',
        envOutHumidLow: 'Venku o <b>{d}%</b> vlhčeji než uvnitř',
        envOutHotHumid: 'Venku horko a vlhko: <b>{t}°C / {h}%</b> — bude se cítit <b>velmi dusno</b>',
        envOutVeryDry: 'Venkovní vzduch velmi suchý (<b>{h}%</b>) — pijte před odchodem',
        envDangerHeat: 'Venku <b>{t}°C</b> — vysoké riziko úpalu, raději zůstaňte uvnitř!',
        envHotHumidWarn: 'Venku horko a vlhko <b>{t}°C / {h}%</b> — lehké oblečení, hodně pít',
        envOutCold: 'Venku chladno <b>{t}°C</b> — nezapomeňte <b>bundu</b>',
        envOutVeryCold: 'Venku mrazivo <b>{t}°C</b> — oblečte se teple, šálu na krk!',
        envInVeryHumid: 'Místnost velmi vlhká <b>{h}%</b> — zvažte zapnutí ventilátoru',
        envInVerydry: 'Vzduch v místnosti dost suchý <b>{h}%</b> — pijte dostatečně',
        hintFan: 'Dveře zavřené, teplo roste — <b>zapněte ventilátor</b>',
        hintAc: 'Stále horko při <b>{t}°C</b> — zapněte klimatizaci',
        hintDoorAc: 'Dveře otevřené + klimatizace zapnutá — plýtvání, <b>zavřete dveře</b>',
        hintOpenDoor: 'Venku o <b>{d}°C</b> chladněji — otevřete dveře pro přirozené větrání',
        hintEmptyLight: 'Místnost prázdná — světla stále svítí, <b>vypněte</b>',
        hintEmptyFan: 'Místnost prázdná — ventilátor stále běží, <b>vypněte</b>',
        hintEmptyAc: 'Nikdo v místnosti — klimatizace běží zbytečně',
        hintHumi: 'Vlhkost <b>{h}%</b> — zapněte ventilátor',
        hintHotOut: 'Venku o <b>{d}°C</b> teplejší — zavřete dveře pro chlad',
        hintRgb: 'RGB světlo zapnuté, místnost prázdná — <b>vypněte pro úsporu</b>',
        graphTemp: 'Teplota (°C)', graphPwr: 'Výkon (W)', graphNow: 'Nyní',
        graphAcOn: '❄️ Klima ZAPNUTA v', graphAcOff: '❄️ Klima VYPNUTA v',
        graphDoorOpen: '🚪 Dveře otevřeny v', graphDoorClose: '🚪 Dveře zavřeny v', graphDoorChanged: '🚪 Dveře změněny',
        graphMotion: '🚶 Poslední pohyb',
        tempVeryHot: '🔥 Nebezpečně horko!', tempHot: 'Příliš horko, zapněte ventilátor',
        tempWarm: 'Trochu teplo, dusno', tempOk: 'Komfortní 👌',
        tempCool: 'Chladno, ideální pro práci',
        tempCold: 'Chladno, oblékte se tepleji', tempVeryCold: '🥶 Velmi chladno, opatrně!',
        humiStorm: '🌧️ Extrémně vysoká vlhkost!', humiHigh: 'Velmi vysoká vlhkost',
        humiMid: 'Trochu vlhko, normální', humiOk: 'Ideální vlhkost 💧',
        humiDry: 'Trochu sucho', humiVeryDry: '🏜️ Velmi sucho',
        scoreLabels: ['Perfektní!','Velmi pohodlné','Příjemné','Přijatelné','Trochu dusno','Nepohodlné','Dusno','Sotva dýcháme'],
        scoreReasons: { hot:'horko', veryHot:'velmi horko', extremeHot:'extrémně horko', slightHot:'trochu horko',
          slightCold:'trochu chladno', cold:'chladno', humid:'dusno', veryHumid:'velmi vlhko', dry:'sucho',
          noFan:'žádný ventilátor/klima' },
        tvFanSpeed: '⚡ Rychlost', fanLvl: ['Nízká','Stupeň 2','Střední','Vysoká','Max'],
        fanPopupTitle: '⚡ Vybrat rychlost ventilátoru',
        rbEffectColor: 'Barva',
        rgbModalTitle: '🌈 Efekt & Barva',
        rgbColorLabel: 'BARVY', rgbCustom: 'Vlastní:',
        spTempLine: 'Uvnitř: --°C · Venku: --°C',
        scoring: 'Počítám...',
        fanRunning: 'Běží',
        confirmOn: 'Aktuálně VYPNUTO — potvrďte pro zapnutí',
        confirmOff: 'Aktuálně ZAPNUTO — potvrďte pro vypnutí',
        confirmActionOn: 'ZAPNOUT',
        confirmActionOff: 'VYPNOUT',
        confirmCancel: 'Zrušit',
        confirmDevFallback: 'zásuvka',
        trendUp: 'Stoupající',
        trendDown: 'Klesající',
        aspTitle: '⚙️ Nastavení auto-vypnutí',
        aspDelayUnit: 'min',
        aspDevTitle: '🔌 Zařízení k vypnutí',
        colorSensorHdr: '🌡 Senzory & Záhlaví',
        colorDevHdr: '💡 Zařízení',
        colorTemp: '🌡 Barva teploty',
        colorHumi: '💧 Barva vlhkosti',
        colorScore: '⭐ Barva skóre',
        colorDen: '💡 Hlavní světlo (zapnuto)',
        colorRgb: '🌈 RGB světlo (zapnuto)',
        colorQuat: '🌀 Ventilátor (zapnutý)',
        delDevTitle: 'Odebrat zařízení',
        rgbBtnLabel: 'Efekt & Barva',
      },
      it: {
        tempLabel: 'Temperatura', humiLabel: 'Umidità',
        doorOpen: 'Aperta', doorClosed: 'Chiusa',
        motionYes: 'Presenza', motionNo: 'Vuoto',
        btnManual: 'Manuale', btnAuto: 'Auto',
        modeManual: 'Funzionamento in modalità <b style="color:rgba(0,235,255,1)">manuale</b>',
        modeAutoOptimal: 'Sistema ottimale — nessun suggerimento',
        motionPresent: 'Qualcuno nella stanza — tutti i dispositivi rimangono accesi',
        motionCold: 'Temperatura', motionColdSuffix: '°C — il condizionatore ridurrà la potenza',
        noDevice: 'Nessun dispositivo acceso',
        autoDone: 'Spegnimento automatico — stanza vuota da {min} min',
        autoTimer: 'Spegne tra',
        chipDen: 'Luce principale', chipDecor: 'Decorazione', chipHien: 'Luce veranda',
        chipRgb: 'RGB', chipQuat: 'Ventilatore', chipOcam: 'Presa', chipAc: 'Condizionatore',
        envHotRoom: 'La stanza è <b>{d}°C</b> più calda fuori — accendi il condizionatore',
        envWarmRoom: 'La temperatura della stanza è <b>{d}°C</b> più alta fuori',
        envCoolOut: 'Fuori è <b>{d}°C</b> più caldo — tieni la porta chiusa',
        envWarmOut: 'Fuori è <b>{d}°C</b> più caldo che dentro',
        envBalance: 'Temp. interna/esterna bilanciata: dentro <b>{ti}°C</b> · fuori <b>{to}°C</b>',
        envHumiHigh: 'Umidità interna <b>{d}%</b> più alta — ventilazione consigliata',
        envHumiMid: 'Umidità interna <b>{d}%</b> più alta — leggermente soffocante',
        envHumiOut: 'Fuori <b>{d}%</b> più umido — apri la porta per aria fresca',
        envHumiBalance: 'Umidità int./est. bilanciata: <b>{hi}%</b> / <b>{ho}%</b>',
        envTempIn: 'Temperatura interna: <b>{t}°C</b>',
        envHumiIn: 'Umidità interna: <b>{h}%</b>',
        envLoading: 'Caricamento dati sensori...',
        envHotRoomHigh: 'La stanza è <b>{d}°C</b> più calda — accendi il condizionatore ora!',
        envHotRoomMid: 'La stanza è <b>{d}°C</b> più calda — considera di accendere il condizionatore',
        envHotRoomLow: 'La stanza è <b>{d}°C</b> più calda, piccola differenza',
        envOutHeatwave: 'Fuori <b>{t}°C</b> — rischio colpo di calore, ricorda <b>cappello e acqua</b>!',
        envOutHot: 'Fuori <b>{t}°C</b>, molto caldo — indossa <b>cappello e abbigliamento UV</b>',
        envOutWarmClose: 'Fuori <b>{d}°C</b> più caldo — tieni la porta chiusa per mantenere il fresco',
        envOutWarm: 'Fuori <b>{d}°C</b> più caldo che dentro',
        envBalanced: 'Temperatura interna/esterna quasi uguale: <b>{ti}°C</b> / <b>{to}°C</b>',
        envRainyUmbrella: 'Umidità esterna <b>{h}%</b> — probabilmente piove, <b>prendi l’ombrello</b>!',
        envRainyMaybe: 'Umidità esterna <b>{h}%</b> — possibile pioggia, <b>porta un ombrello</b>',
        envOutHumidSweat: 'Fuori <b>{h}%</b> umido — porta un <b>asciugamano</b> per il sudore',
        envInHumiHighClothes: 'Dentro <b>{d}%</b> più umido — è ora di <b>ritirare il bucato</b>',
        envInHumiMidVent: 'Dentro <b>{d}%</b> più umido — aprire le finestre aiuta a ventilare',
        envInDryHumid: 'Stanza abbastanza secca (<b>{h}%</b>) — idratati, considera un umidificatore',
        envOutHumidClose: 'Fuori <b>{d}%</b> più umido — tieni la porta chiusa',
        envOutHumidLow: 'Fuori <b>{d}%</b> più umido che dentro',
        envOutHotHumid: 'Fuori caldo e umido: <b>{t}°C / {h}%</b> — si sentirà <b>molto afoso</b>',
        envOutVeryDry: 'Aria esterna molto secca (<b>{h}%</b>) — bevi prima di uscire',
        envDangerHeat: 'Fuori <b>{t}°C</b> — alto rischio colpo di calore, evita di uscire!',
        envHotHumidWarn: 'Fuori caldo e umido <b>{t}°C / {h}%</b> — vestiti leggeri, bevi molto',
        envOutCold: 'Fuori freddo a <b>{t}°C</b> — non dimenticare la <b>giacca</b>',
        envOutVeryCold: 'Fuori gelido a <b>{t}°C</b> — vestiti bene, porta una sciarpa!',
        envInVeryHumid: 'Stanza molto umida <b>{h}%</b> — considera di accendere un ventilatore',
        envInVerydry: 'Aria della stanza abbastanza secca <b>{h}%</b> — bevi abbastanza',
        hintFan: 'Porta chiusa, calore in aumento — <b>accendi il ventilatore</b>',
        hintAc: 'Ancora caldo a <b>{t}°C</b> — accendi il condizionatore',
        hintDoorAc: 'Porta aperta + condizionatore acceso — spreco, <b>chiudi la porta</b>',
        hintOpenDoor: 'Fuori è <b>{d}°C</b> più fresco — apri la porta per ventilazione naturale',
        hintEmptyLight: 'Stanza vuota — luci ancora accese, <b>spegni</b>',
        hintEmptyFan: 'Stanza vuota — ventilatore ancora in funzione, <b>spegni</b>',
        hintEmptyAc: 'Nessuno nella stanza — il condizionatore funziona inutilmente',
        hintHumi: 'Umidità <b>{h}%</b> — accendi il ventilatore',
        hintHotOut: 'Fuori è <b>{d}°C</b> più caldo — chiudi la porta per restare fresco',
        hintRgb: 'Luce RGB accesa, stanza vuota — <b>spegni per risparmiare</b>',
        graphTemp: 'Temperatura (°C)', graphPwr: 'Potenza (W)', graphNow: 'Ora',
        graphAcOn: '❄️ Condiz. ACCESO alle', graphAcOff: '❄️ Condiz. SPENTO alle',
        graphDoorOpen: '🚪 Porta aperta alle', graphDoorClose: '🚪 Porta chiusa alle', graphDoorChanged: '🚪 Porta cambiata',
        graphMotion: '🚶 Ultimo movimento',
        tempVeryHot: '🔥 Pericolosamente caldo!', tempHot: 'Troppo caldo, accendi il ventilatore',
        tempWarm: 'Leggermente caldo, soffocante', tempOk: 'Comodo 👌',
        tempCool: 'Fresco, ideale per lavorare',
        tempCold: 'Freddo, indossa di più', tempVeryCold: '🥶 Molto freddo, attenzione!',
        humiStorm: '🌧️ Umidità estremamente alta!', humiHigh: 'Umidità molto alta',
        humiMid: 'Leggermente umido, normale', humiOk: 'Umidità ideale 💧',
        humiDry: 'Leggermente secco', humiVeryDry: '🏜️ Molto secco',
        scoreLabels: ['Perfetto!','Molto comodo','Piacevole','Accettabile','Leggermente soffocante','Scomodo','Soffocante','Non si respira'],
        scoreReasons: { hot:'caldo', veryHot:'molto caldo', extremeHot:'estremamente caldo', slightHot:'leggermente caldo',
          slightCold:'leggermente freddo', cold:'freddo', humid:'soffocante', veryHumid:'molto umido', dry:'secco',
          noFan:'nessun ventilatore/condizionatore' },
        tvFanSpeed: '⚡ Velocità', fanLvl: ['Bassa','Livello 2','Media','Alta','Max'],
        fanPopupTitle: '⚡ Seleziona velocità ventilatore',
        rbEffectColor: 'Colore',
        rgbModalTitle: '🌈 Effetto & Colore',
        rgbColorLabel: 'COLORI', rgbCustom: 'Personalizzato:',
        spTempLine: 'Interno: --°C · Esterno: --°C',
        scoring: 'Calcolo...',
        fanRunning: 'In funzione',
        confirmOn: 'Attualmente SPENTO — conferma per accendere',
        confirmOff: 'Attualmente ACCESO — conferma per spegnere',
        confirmActionOn: 'ACCENDI',
        confirmActionOff: 'SPEGNI',
        confirmCancel: 'Annulla',
        confirmDevFallback: 'presa',
        trendUp: 'In aumento',
        trendDown: 'In calo',
        aspTitle: '⚙️ Impostazioni auto-spegnimento',
        aspDelayUnit: 'min',
        aspDevTitle: '🔌 Dispositivi da spegnere',
        colorSensorHdr: '🌡 Sensori & Intestazione',
        colorDevHdr: '💡 Dispositivi',
        colorTemp: '🌡 Colore temperatura',
        colorHumi: '💧 Colore umidità',
        colorScore: '⭐ Colore punteggio',
        colorDen: '💡 Luce principale (accesa)',
        colorRgb: '🌈 Luce RGB (accesa)',
        colorQuat: '🌀 Ventilatore (acceso)',
        delDevTitle: 'Rimuovi dispositivo',
        rgbBtnLabel: 'Effetto & Colore',
      },
      pt: {
        tempLabel: 'Temperatura', humiLabel: 'Humidade',
        doorOpen: 'Aberta', doorClosed: 'Fechada',
        motionYes: 'Presença', motionNo: 'Vazio',
        btnManual: 'Manual', btnAuto: 'Auto',
        modeManual: 'A funcionar em modo <b style="color:rgba(0,235,255,1)">manual</b>',
        modeAutoOptimal: 'Sistema a funcionar otimamente — sem sugestões',
        motionPresent: 'Alguém no quarto — todos os dispositivos mantidos ligados',
        motionCold: 'Temperatura', motionColdSuffix: '°C — ar condicionado reduzirá a potência',
        noDevice: 'Nenhum dispositivo ligado',
        autoDone: 'Desligamento automático — quarto vazio há {min} min',
        autoTimer: 'Desliga em',
        chipDen: 'Luz principal', chipDecor: 'Decoração', chipHien: 'Luz varanda',
        chipRgb: 'RGB', chipQuat: 'Ventilador', chipOcam: 'Tomada', chipAc: 'Ar condicionado',
        envHotRoom: 'Quarto está <b>{d}°C</b> mais quente que lá fora — ligue o ar condicionado',
        envWarmRoom: 'Temperatura do quarto é <b>{d}°C</b> mais alta que lá fora',
        envCoolOut: 'Lá fora está <b>{d}°C</b> mais quente — mantenha a porta fechada',
        envWarmOut: 'Lá fora está <b>{d}°C</b> mais quente que dentro',
        envBalance: 'Temp. interior/exterior equilibrada: dentro <b>{ti}°C</b> · fora <b>{to}°C</b>',
        envHumiHigh: 'Humidade interior <b>{d}%</b> mais alta — ventilação recomendada',
        envHumiMid: 'Humidade interior <b>{d}%</b> mais alta — ligeiramente abafado',
        envHumiOut: 'Lá fora <b>{d}%</b> mais húmido — abra a porta para ar fresco',
        envHumiBalance: 'Humidade int./ext. equilibrada: <b>{hi}%</b> / <b>{ho}%</b>',
        envTempIn: 'Temperatura interior: <b>{t}°C</b>',
        envHumiIn: 'Humidade interior: <b>{h}%</b>',
        envLoading: 'A carregar dados dos sensores...',
        envHotRoomHigh: 'O quarto está <b>{d}°C</b> mais quente — liga o ar condicionado já!',
        envHotRoomMid: 'O quarto está <b>{d}°C</b> mais quente — considera ligar o ar condicionado',
        envHotRoomLow: 'O quarto está <b>{d}°C</b> mais quente, diferença pequena',
        envOutHeatwave: 'Lá fora <b>{t}°C</b> — risco de insolação, lembra de <b>usar chapéu e beber água</b>!',
        envOutHot: 'Lá fora <b>{t}°C</b>, muito quente — usa <b>chapéu e roupa de proteção solar</b>',
        envOutWarmClose: 'Lá fora <b>{d}°C</b> mais quente — mantém a porta fechada para manter o fresco',
        envOutWarm: 'Lá fora <b>{d}°C</b> mais quente que dentro',
        envBalanced: 'Temperatura interior/exterior quase igual: <b>{ti}°C</b> / <b>{to}°C</b>',
        envRainyUmbrella: 'Humidade exterior <b>{h}%</b> — provavelmente está a chover, <b>leva um guarda-chuva</b>!',
        envRainyMaybe: 'Humidade exterior <b>{h}%</b> — possível chuva, <b>leva um guarda-chuva</b>',
        envOutHumidSweat: 'Lá fora <b>{h}%</b> de humidade — leva uma <b>toalha</b> para o suor',
        envInHumiHighClothes: 'Dentro <b>{d}%</b> mais húmido — está na hora de <b>recolher a roupa</b>',
        envInHumiMidVent: 'Dentro <b>{d}%</b> mais húmido — abrir janelas ajuda a ventilar',
        envInDryHumid: 'Quarto bastante seco (<b>{h}%</b>) — hidrata-te, considera um humidificador',
        envOutHumidClose: 'Lá fora <b>{d}%</b> mais húmido — mantém a porta fechada',
        envOutHumidLow: 'Lá fora <b>{d}%</b> mais húmido que dentro',
        envOutHotHumid: 'Lá fora quente e húmido: <b>{t}°C / {h}%</b> — vai parecer <b>muito abafado</b>',
        envOutVeryDry: 'Ar exterior muito seco (<b>{h}%</b>) — bebe água antes de sair',
        envDangerHeat: 'Lá fora <b>{t}°C</b> — alto risco de insolação, evita sair agora!',
        envHotHumidWarn: 'Lá fora quente e húmido <b>{t}°C / {h}%</b> — roupa leve, bebe muito',
        envOutCold: 'Lá fora frio a <b>{t}°C</b> — não te esqueças do <b>casaco</b>',
        envOutVeryCold: 'Lá fora gelado a <b>{t}°C</b> — veste-te bem, usa um cachecol!',
        envInVeryHumid: 'Quarto muito húmido <b>{h}%</b> — considera ligar um ventilador',
        envInVerydry: 'Ar do quarto bastante seco <b>{h}%</b> — bebe o suficiente',
        hintFan: 'Porta fechada, calor a subir — <b>ligue o ventilador</b>',
        hintAc: 'Ainda quente a <b>{t}°C</b> — ligue o ar condicionado',
        hintDoorAc: 'Porta aberta + ar condicionado ligado — desperdício, <b>feche a porta</b>',
        hintOpenDoor: 'Lá fora está <b>{d}°C</b> mais fresco — abra a porta para ventilação natural',
        hintEmptyLight: 'Quarto vazio — luzes ainda ligadas, <b>desligue</b>',
        hintEmptyFan: 'Quarto vazio — ventilador ainda a funcionar, <b>desligue</b>',
        hintEmptyAc: 'Ninguém no quarto — ar condicionado a funcionar desnecessariamente',
        hintHumi: 'Humidade <b>{h}%</b> — ligue o ventilador',
        hintHotOut: 'Lá fora está <b>{d}°C</b> mais quente — feche a porta para manter o fresco',
        hintRgb: 'Luz RGB ligada, quarto vazio — <b>desligue para poupar energia</b>',
        graphTemp: 'Temperatura (°C)', graphPwr: 'Potência (W)', graphNow: 'Agora',
        graphAcOn: '❄️ AC LIGADO às', graphAcOff: '❄️ AC DESLIGADO às',
        graphDoorOpen: '🚪 Porta aberta às', graphDoorClose: '🚪 Porta fechada às', graphDoorChanged: '🚪 Porta alterada',
        graphMotion: '🚶 Último movimento',
        tempVeryHot: '🔥 Perigosamente quente!', tempHot: 'Muito quente, ligue o ventilador',
        tempWarm: 'Ligeiramente quente, abafado', tempOk: 'Confortável 👌',
        tempCool: 'Fresco, ideal para trabalhar',
        tempCold: 'Frio, vista mais roupa', tempVeryCold: '🥶 Muito frio, cuidado!',
        humiStorm: '🌧️ Humidade extremamente alta!', humiHigh: 'Humidade muito alta',
        humiMid: 'Ligeiramente húmido, normal', humiOk: 'Humidade ideal 💧',
        humiDry: 'Ligeiramente seco', humiVeryDry: '🏜️ Muito seco',
        scoreLabels: ['Perfeito!','Muito confortável','Agradável','Aceitável','Ligeiramente abafado','Desconfortável','Abafado','Mal se respira'],
        scoreReasons: { hot:'quente', veryHot:'muito quente', extremeHot:'extremamente quente', slightHot:'ligeiramente quente',
          slightCold:'ligeiramente frio', cold:'frio', humid:'abafado', veryHumid:'muito húmido', dry:'seco',
          noFan:'sem ventilador/ar condicionado' },
        tvFanSpeed: '⚡ Velocidade', fanLvl: ['Baixa','Nível 2','Média','Alta','Máx'],
        fanPopupTitle: '⚡ Selecionar velocidade do ventilador',
        rbEffectColor: 'Cor',
        rgbModalTitle: '🌈 Efeito & Cor',
        rgbColorLabel: 'CORES', rgbCustom: 'Personalizado:',
        spTempLine: 'Interior: --°C · Exterior: --°C',
        scoring: 'A calcular...',
        fanRunning: 'A funcionar',
        confirmOn: 'Atualmente DESLIGADO — confirmar para ligar',
        confirmOff: 'Atualmente LIGADO — confirmar para desligar',
        confirmActionOn: 'LIGAR',
        confirmActionOff: 'DESLIGAR',
        confirmCancel: 'Cancelar',
        confirmDevFallback: 'tomada',
        trendUp: 'A subir',
        trendDown: 'A descer',
        aspTitle: '⚙️ Definições de desligamento automático',
        aspDelayUnit: 'min',
        aspDevTitle: '🔌 Dispositivos a desligar',
        colorSensorHdr: '🌡 Sensores & Cabeçalho',
        colorDevHdr: '💡 Dispositivos',
        colorTemp: '🌡 Cor temperatura',
        colorHumi: '💧 Cor humidade',
        colorScore: '⭐ Cor pontuação',
        colorDen: '💡 Luz principal (ligada)',
        colorRgb: '🌈 Luz RGB (ligada)',
        colorQuat: '🌀 Ventilador (ligado)',
        delDevTitle: 'Remover dispositivo',
        rgbBtnLabel: 'Efeito & Cor',
      },
      sl: {
        tempLabel: 'Temperatura', humiLabel: 'Vlažnost',
        doorOpen: 'Odprto', doorClosed: 'Zaprto',
        motionYes: 'Zaznano gibanje', motionNo: 'Ni nikogar',
        btnManual: 'Ročno', btnAuto: 'Samodejno',
        modeManual: 'Deluje v <b style="color:rgba(0,235,255,1)">ročnem načinu</b>',
        modeAutoOptimal: 'Sistem deluje optimalno — ni predlogov',
        motionPresent: 'Oseba v prostoru — naprave ostanejo nespremenjene',
        motionCold: 'Temperatura', motionColdSuffix: '°C — klima bo zmanjšala moč',
        noDevice: 'Nobena naprava ni vklopljena',
        autoDone: 'Samodejno izklopljeno — soba prazna več kot {min} min',
        autoTimer: 'Izklop čez',
        chipDen: 'Glavna luč', chipDecor: 'Dekor', chipHien: 'Luč na terasi',
        chipRgb: 'RGB', chipQuat: 'Ventilator', chipOcam: 'Vtičnica', chipAc: 'Klima',
        envHotRoom: 'V sobi je za <b>{d}°C</b> topleje kot zunaj — priporočen vklop klime',
        envWarmRoom: 'Temperatura v sobi je za <b>{d}°C</b> višja kot zunaj',
        envCoolOut: 'Zunaj je za <b>{d}°C</b> topleje — zaprite okna za ohranjanje hladu',
        envWarmOut: 'Zunaj je za <b>{d}°C</b> topleje kot v sobi',
        envBalance: 'Temp. znotraj/zunaj izravnana: notri <b>{ti}°C</b> · zunaj <b>{to}°C</b>',
        envHumiHigh: 'Vlaga v sobi je za <b>{d}%</b> višja — vklopite prezračevanje',
        envHumiMid: 'Vlaga v sobi je za <b>{d}%</b> višja — nekoliko zatohlo',
        envHumiOut: 'Zunaj je za <b>{d}%</b> bolj vlažno — odprite okna za svež zrak',
        envHumiBalance: 'Vlaga znotraj/zunaj podobna: <b>{hi}%</b> / <b>{ho}%</b>',
        envTempIn: 'Temperatura v prostoru: <b>{t}°C</b>',
        envHumiIn: 'Vlažnost v prostoru: <b>{h}%</b>',
        envLoading: 'Posodabljanje podatkov senzorjev...',
        envHotRoomHigh: 'V sobi je za <b>{d}°C</b> topleje — takoj vklopite klimo!',
        envHotRoomMid: 'V sobi je za <b>{d}°C</b> topleje — razmislite o vklopu klime',
        envHotRoomLow: 'V sobi je za <b>{d}°C</b> topleje, ni velike razlike',
        envOutHeatwave: 'Zunaj je <b>{t}°C</b> — nevarnost toplotnega šoka, <b>pijte vodo in nosite pokrivalo</b>!',
        envOutHot: 'Zunaj je <b>{t}°C</b>, zelo vroče — ne pozabite na <b>zaščito pred soncem</b>',
        envOutWarmClose: 'Zunaj je za <b>{d}°C</b> topleje — zaprite okna za ohranjanje hladu',
        envOutWarm: 'Zunaj je za <b>{d}°C</b> topleje kot v sobi',
        envBalanced: 'Temperatura znotraj/zunaj skoraj enaka: <b>{ti}°C</b> / <b>{to}°C</b>',
        envRainyUmbrella: 'Zunanja vlaga je <b>{h}%</b> — verjetno dežuje, <b>vzemite dežnik</b>!',
        envRainyMaybe: 'Zunanja vlaga je <b>{h}%</b> — možen dež, <b>vzemite dežnik</b> za vsak primer',
        envOutHumidSweat: 'Zunanja vlaga je <b>{h}%</b> — soparno, pripravite <b>robčke za znoj</b>',
        envInHumiHighClothes: 'V sobi je za <b>{d}%</b> bolj vlažno — <b>pobranite perilo</b>, če se suši zunaj',
        envInHumiMidVent: 'Znotraj je za <b>{d}%</b> bolj vlažno — prezračite prostor',
        envInDryHumid: 'Znotraj je precej suho (<b>{h}%</b>) — pijte vodo ali uporabite vlažilnik',
        envOutHumidClose: 'Zunaj je za <b>{d}%</b> bolj vlažno — zaprite okna za prijeten zrak',
        envOutHumidLow: 'Zunaj je za <b>{d}%</b> bolj vlažno kot notri',
        envOutHotHumid: 'Zunaj je vroče in vlažno: <b>{t}°C / {h}%</b> — občutek <b>velike zatohlosti</b>',
        envOutVeryDry: 'Zunaj je zelo suho (<b>{h}%</b>) — pijte vodo pred odhodom',
        envDangerHeat: 'Zunaj je <b>{t}°C</b> — visoka nevarnost toplotnega udara, ne hodite ven!',
        envHotHumidWarn: 'Zunaj je vroče in vlažno <b>{t}°C / {h}%</b> — nosite lahka oblačila',
        envOutCold: 'Zunaj je hladno <b>{t}°C</b> — oblecite <b>topla oblačila</b>',
        envOutVeryCold: 'Zunaj je mrzlo <b>{t}°C</b> — toplo se oblecite in vzemite šal!',
        envInVeryHumid: 'V sobi je zelo vlažno <b>{h}%</b> — vklopite prezračevanje',
        envInVerydry: 'Zrak v sobi je precej suh <b>{h}%</b> — pijte dovolj vode',
        hintFan: 'Okna zaprta, visoka temp. — priporočljiv <b>vklop ventilatorja</b>',
        hintAc: 'Še vedno je vroče (<b>{t}°C</b>) — priporočljiv vklop klime',
        hintDoorAc: 'Okno odprto + klima vklopljena — potrata energije, <b>zaprite okno</b>',
        hintOpenDoor: 'Zunaj je za <b>{d}°C</b> hladneje — odprite okna za naravno hlajenje',
        hintEmptyLight: 'Soba je prazna — luč še gori, <b>ugasnite luč</b>',
        hintEmptyFan: 'Soba je prazna — ventilator še dela, <b>izklopite ga</b>',
        hintEmptyAc: 'Ni nikogar — klima deluje po nepotrebnem',
        hintHumi: 'Vlaga je <b>{h}%</b> — vklopite ventilator za zmanjšanje vlage',
        hintHotOut: 'Zunaj je za <b>{d}°C</b> topleje — zaprite okna za ohranjanje hladu',
        hintRgb: 'RGB luč gori v prazni sobi — <b>izklopite za varčevanje</b>',
        graphTemp: 'Temperatura (°C)', graphPwr: 'Moč (W)', graphNow: 'Trenutno',
        graphAcOn: '❄️ Klima VKLOP ob', graphAcOff: '❄️ Klima IZKLOP ob',
        graphDoorOpen: '🚪 Vrata ODPRTA ob', graphDoorClose: '🚪 Vrata ZAPRTA ob', graphDoorChanged: '🚪 Sprememba vrat',
        graphMotion: '🚶 Zadnje gibanje',
        tempVeryHot: '🔥 Nevzdržno vroče!', tempHot: 'Vroče, vklopite ventilator',
        tempWarm: 'Toplo, občutek sopare', tempOk: 'Prijetno in udobno 👌',
        tempCool: 'Sveže, primerno za delo',
        tempCold: 'Hladno, oblecite se', tempVeryCold: '🥶 Zelo mrzlo, pazite!',
        humiStorm: '🌧️ Izjemno visoka vlaga!', humiHigh: 'Zelo visoka vlaga',
        humiMid: 'Nekoliko vlažno, normalno', humiOk: 'Idealna vlažnost 💧',
        humiDry: 'Nekoliko suho', humiVeryDry: '🏜️ Zelo suho',
        scoreLabels: ['Popolno!','Zelo udobno','Prijetno','V redu','Zatohlo','Neprijetno','Zelo zatohlo','Težko dihanje'],
        scoreReasons: { hot:'vroče', veryHot:'zelo vroče', extremeHot:'izjemno vroče', slightHot:'nekoliko vroče',
          slightCold:'nekoliko hladno', cold:'hladno', humid:'zatohlo', veryHumid:'zelo vlažno', dry:'suho',
          noFan:'brez ventilatorja/klime' },
        tvFanSpeed: '⚡ Hitrost', fanLvl: ['Nežno','Nizko','Srednje','Visoko','Maksimalno'],
        fanPopupTitle: '⚡ Izberi hitrost ventilatorja',
        rbEffectColor: 'Barva',
        rgbModalTitle: '🌈 Učinki in barve',
        rgbColorLabel: 'BARVA', rgbCustom: 'Po meri:',
        spTempLine: 'Notri: --°C · Zunaj: --°C',
        scoring: 'Računanje...',
        fanRunning: 'Deluje',
        confirmOn: 'Izklopljeno — potrdi za vklop',
        confirmOff: 'Vklopljeno — potrdi za izklop',
        confirmActionOn: 'VKLOP',
        confirmActionOff: 'IZKLOP',
        confirmCancel: 'Prekliči',
        confirmDevFallback: 'vtičnica',
        trendUp: 'Narašča',
        trendDown: 'Pada',
        aspTitle: '⚙️ Nastavitve samodejnega izklopa',
        aspDelayUnit: 'min',
        aspDevTitle: '🔌 Naprave za izklop',
        colorSensorHdr: '🌡 Senzorji in glava',
        colorDevHdr: '💡 Naprave',
        colorTemp: '🌡 Barva temperature',
        colorHumi: '💧 Barva vlage',
        colorScore: '⭐ Barva ocene prostora',
        colorDen: '💡 Glavna luč (vklop)',
        colorRgb: '🌈 RGB luč (vklop)',
        colorQuat: '🌀 Ventilator (vklop)',
        delDevTitle: 'Izbriši napravo',
        rgbBtnLabel: 'Učinki in barve',
      },
    };
    return T[lang] || T.vi;
  }

  _getAutoDelayMs() { return ((this._config && this._config.auto_delay_min) || 5) * 60 * 1000; }
  static get LS_KEY()         { return 'hsrc_no_motion_since'; }
  static get LS_KEY_MODE()    { return 'hsrc_auto_mode'; }
  get _lsKey()     { return (this._cardId || 'hsrc_default') + '_motion'; }
  get _lsKeyMode() { return (this._cardId || 'hsrc_default') + '_auto'; }

  // ─── Integration mode: dùng ha_smart_room integration làm brain ─────────────
  get _useIntegration() {
    return !!(this._config && this._config.sync_mode === 'integration');
  }

  // Room ID cho integration (dùng cardId đã slugified)
  get _roomId() { return this._cardId || 'hsrc_default'; }

  // Entity IDs exposed by the integration.
  // HA generates entity_id from the entity *name* (not unique_id).
  // Python sets name = "{room_title} Auto Off" etc., then HA slugifies it.
  // We slugify the room_title the same way to reconstruct the correct entity_id.
  // Entity IDs khớp với Python: dùng room_id (cardId) — phải trùng với _attr_name trong Python
  // Python: _attr_name = f"{coord.room_id}_auto_off" → HA tạo switch.{room_id}_auto_off
  _intAutoSwitchId()   { return `switch.${this._roomId}_auto_off`; }
  _intDelayNumberId()  { return `number.${this._roomId}_auto_off_delay`; }
  _intStatusId()       { return `sensor.${this._roomId}_status`; }
  _intCountdownId()    { return `sensor.${this._roomId}_countdown`; }

  // Đọc auto mode từ integration entity
  _readAutoModeFromIntegration() {
    if (!this._hass) return false;
    const s = this._hass.states[this._intAutoSwitchId()];
    return s ? s.state === 'on' : false;
  }

  // Ghi auto mode lên integration entity
  async _writeAutoModeToIntegration(on) {
    if (!this._hass) {
      console.warn('[HASmartRoom] _writeAutoModeToIntegration: _hass is null!');
      return;
    }
    const switchId = this._intAutoSwitchId();
    // Kiểm tra entity có tồn tại không
    const entityExists = !!this._hass.states[switchId];
    console.log('[HASmartRoom] writeAutoMode:', on ? 'ON' : 'OFF',
      '| entity:', switchId,
      '| exists:', entityExists,
      '| room_id:', this._roomId);
    if (!entityExists) {
      console.warn('[HASmartRoom] Switch entity chưa tồn tại trên HA — cần register_room trước');
    }
    // Đặt flag + target để hass setter không reset _autoMode trước khi HA xác nhận
    this._integrationPending = true;
    this._integrationPendingTarget = on;
    try {
      await this._hass.callService(
        'switch', on ? 'turn_on' : 'turn_off',
        { entity_id: switchId }
      );
      console.log('[HASmartRoom] callService switch done, waiting for HA confirm...');
    } catch(e) {
      // Nếu lỗi → xoá flag để không bị treo mãi
      this._integrationPending = false;
      this._integrationPendingTarget = undefined;
      console.error('[HASmartRoom] callService switch FAILED:', e);
    }
  }

  // Đọc countdown còn lại từ integration sensor (seconds)
  _readCountdownFromIntegration() {
    if (!this._hass) return null;
    const s = this._hass.states[this._intCountdownId()];
    return s ? (parseFloat(s.state) || 0) : null;
  }

  // Đọc status từ integration sensor
  _readStatusFromIntegration() {
    if (!this._hass) return 'idle';
    const s = this._hass.states[this._intStatusId()];
    return s ? s.state : 'idle';
  }

  // Đăng ký phòng với integration (gọi mỗi khi config thay đổi)
  async _registerWithIntegration() {
    if (!this._hass || !this._useIntegration) return;
    const cfg = this._config || {};
    const E   = this.ENTITIES;

    // Build danh sách device entities để integration tắt
    const allowed = cfg.auto_off_entities || ['den','decor','rgb','hien','quat','ocam','ac'];
    const deviceEntities = [];
    const entityMap = {
      den:   E.den,   decor: E.decor, rgb:  E.rgb,
      hien:  E.hien,  quat:  E.quat,  ocam: E.ocam, ac: E.ac,
    };
    for (const [id, eid] of Object.entries(entityMap)) {
      if (eid && allowed.includes(id)) deviceEntities.push(eid);
    }
    // Thêm extra devices
    const extras = cfg.devices_extra || [];
    for (const d of extras) {
      if (allowed.includes(d.id) && E[d.id]) deviceEntities.push(E[d.id]);
    }

    const payload = {
      room_id:         this._roomId,
      room_title:      cfg.room_title || cfg.title || 'Smart Room',
      delay_min:       parseInt(cfg.auto_delay_min || 5, 10),  // phải là integer
      motion_entity:   E.motion || '',
      device_entities: deviceEntities,
    };
    // Retry tối đa 3 lần — HA có thể chưa sẵn sàng ngay sau khi load
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this._hass.callService('ha_smart_room', 'register_room', payload);
        console.log('[HASmartRoom] Registered room with integration:', this._roomId, '(attempt', attempt + ')');
        this._integrationRegistered = true;
        return;
      } catch(e) {
        console.warn('[HASmartRoom] register_room attempt', attempt, 'failed:', e.message || e);
        if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
    console.error('[HASmartRoom] register_room failed after 3 attempts — check integration is loaded');
  }

  // ─── Helper mode: đọc/ghi state qua HA input_boolean + input_number ────────
  get _useHelpers() {
    return !!(this._config && this._config.sync_mode === 'helpers');
  }

  _helperBoolId() { return (this._config && this._config.helper_bool) || 'input_boolean.hsrc_auto_mode'; }
  _helperNumId()  { return (this._config && this._config.helper_num)  || 'input_number.hsrc_no_motion_since'; }

  // Đọc autoMode từ HA helper
  _readAutoModeFromHelper() {
    if (!this._hass) return false;
    const s = this._hass.states[this._helperBoolId()];
    return s ? s.state === 'on' : false;
  }

  // Ghi autoMode lên HA helper
  _writeAutoModeToHelper(on) {
    if (!this._hass) return;
    this._hass.callService('input_boolean', on ? 'turn_on' : 'turn_off',
      { entity_id: this._helperBoolId() });
  }

  // Đọc timestamp mất motion (trả về ms hoặc null)
  // Helper mode: dùng last_changed của HA entity làm nguồn thời gian chuẩn,
  // tránh lệch giữa các thiết bị do đồng hồ client khác nhau.
  // value=1 → đang đếm ngược, value=0 → không đếm
  _readNoMotionSince() {
    if (this._useHelpers) {
      if (!this._hass) return null;
      const s = this._hass.states[this._helperNumId()];
      if (!s) return null;
      const v = parseFloat(s.state);
      if (v <= 0) return null;
      // Dùng last_changed từ HA server (UTC chuẩn) thay vì timestamp client
      return s.last_changed ? new Date(s.last_changed).getTime() : null;
    } else {
      const v = localStorage.getItem(this._lsKey);
      return v ? parseInt(v, 10) : null;
    }
  }

  // Ghi trạng thái đang đếm ngược lên HA helper
  // value=1 = bắt đầu đếm (HA sẽ ghi last_changed = thời điểm này)
  // value=0 = dừng đếm
  _writeNoMotionSince(ms) {
    if (this._useHelpers) {
      if (!this._hass) return;
      // Ghi value=1 để HA cập nhật last_changed → dùng làm mốc thời gian chuẩn
      this._hass.callService('input_number', 'set_value',
        { entity_id: this._helperNumId(), value: 1 });
    } else {
      localStorage.setItem(this._lsKey, ms.toString());
    }
  }

  // Xoá trạng thái đếm ngược
  _clearNoMotionSince() {
    this._localMotionSince = null; // reset local fallback timestamp
    if (this._useHelpers) {
      if (!this._hass) return;
      this._hass.callService('input_number', 'set_value',
        { entity_id: this._helperNumId(), value: 0 });
    } else {
      localStorage.removeItem(this._lsKey);
    }
  }

  // Trả về Date.now() đã được căn chỉnh theo đồng hồ HA server.
  // HA entity last_changed/last_updated là UTC từ server — nếu đồng hồ client lệch,
  // cần bù offset để elapsed tính đúng trên mọi thiết bị.
  // Offset = (last_updated_client_parse - Date.now_client) tại thời điểm nhận state.
  // Tính 1 lần và cache; tự refresh nếu hass state thay đổi.
  _getHAAlignedNow() {
    if (!this._hass) return Date.now();
    // Lấy một entity bất kỳ có last_updated để ước lượng offset server-client
    const helperState = this._hass.states[this._helperNumId()];
    const anyState = helperState || Object.values(this._hass.states)[0];
    if (!anyState || !anyState.last_updated) return Date.now();
    // last_updated là ISO string từ HA server (UTC chuẩn)
    // So sánh với Date.now() để tính offset: serverTime = Date.now() + offset
    // Nhưng ta không biết delay network. Thay vào đó:
    // Dùng last_updated làm anchor: elapsed = (haServerNow) - since
    // haServerNow ≈ last_updated_of_any_recently_changed_entity
    // Cách đơn giản nhất: track last_updated string thay đổi → update anchor
    const lu = anyState.last_updated;
    if (lu !== this._haAnchorStr) {
      this._haAnchorStr = lu;
      this._haAnchorServer = new Date(lu).getTime();
      this._haAnchorClient = Date.now();
    }
    if (!this._haAnchorClient) return Date.now();
    // offset = server_time_at_anchor - client_time_at_anchor
    const offset = this._haAnchorServer - this._haAnchorClient;
    return Date.now() + offset;
  }

  // Cập nhật class CSS của 2 nút Thủ công / Tự động theo _autoMode hiện tại
  _syncModeButtonUI() {
    if (!this.shadowRoot) return;
    const btnM = this.shadowRoot.getElementById('btn-manual');
    const btnA = this.shadowRoot.getElementById('btn-auto-mode');
    if (btnM) btnM.className = this._autoMode ? 'btn-manual' : 'btn-manual btn-manual-active';
    if (btnA) btnA.className = this._autoMode ? 'btn-auto-mode btn-auto-active' : 'btn-auto-mode';
  }

  _autoEngineStart() {
    if (this._autoEngineTimer) return; // đã chạy rồi
    this._autoEngineTimer = setInterval(() => this._autoEngineTick(), 1000);
  }

  _autoEngineStop() {
    if (this._autoEngineTimer) { clearInterval(this._autoEngineTimer); this._autoEngineTimer = null; }
  }

  _autoEngineTick() {
    if (!this._hass) return;

    // Integration mode: engine chỉ cập nhật UI từ integration sensors
    // Toàn bộ logic tắt thiết bị do integration xử lý server-side
    if (this._useIntegration) {
      const status    = this._readStatusFromIntegration();
      const remaining = this._readCountdownFromIntegration();

      if (status === 'occupied') {
        // Có người — hiện trạng thái bình thường, xóa countdown
        this._updateAutoCountdown(0);
      } else if (status === 'countdown' && remaining !== null) {
        // Đang đếm ngược — cập nhật UI
        this._updateAutoCountdown(remaining * 1000);
      } else if (status === 'triggered') {
        // Vừa tắt xong
        this._updateAutoCountdown(0);
      }
      // status === 'idle': không làm gì — tránh reset countdown đang chạy
      return;
    }

    // Helper mode: đồng bộ _autoMode từ HA mỗi tick
    if (this._useHelpers) {
      const helperOn = this._readAutoModeFromHelper();
      if (helperOn !== this._autoMode) {
        this._autoMode = helperOn;
        this._syncModeButtonUI();
        this._updateHeader();
        if (!this._autoMode) {
          // Vừa chuyển sang Thủ công từ thiết bị khác — dừng engine
          this._autoEngineStop();
          return;
        } else {
          // Vừa chuyển sang Tự động từ thiết bị khác — reset local timestamp
          // Tick tiếp theo sẽ đọc last_changed từ HA làm mốc
          this._autoFired = false;
          this._localMotionSince = null;
        }
      }
      if (!this._autoMode) return;
    } else {
      if (!this._autoMode) return;
    }

    const motion = this._isOn('motion');

    if (motion) {
      // Có người → xoá timestamp, reset
      if (this._readNoMotionSince() !== null) {
        this._clearNoMotionSince();
        this._autoFired = false;
      }
      return;
    }

    // Không có người — ghi nhận lần đầu mất motion
    if (this._useHelpers) {
      const s = this._hass.states[this._helperNumId()];
      const v = s ? parseFloat(s.state) : 0;
      if (v <= 0) {
        // Helper chưa có → ta là thiết bị đầu tiên phát hiện, ghi value=1
        // HA sẽ cập nhật last_changed ngay → các tick sau đọc được
        this._writeNoMotionSince(1);
        // Dùng local làm fallback cho đến khi HA phản hồi
        if (!this._localMotionSince) {
          this._localMotionSince = Date.now();
          this._autoFired = false;
        }
      } else {
        // Helper đã có (value=1) — thiết bị khác đã ghi mốc thời gian
        // Không set _localMotionSince → sẽ dùng last_changed từ HA bên dưới
      }
    } else {
      if (!this._localMotionSince) {
        this._writeNoMotionSince(1);
        this._localMotionSince = Date.now();
        this._autoFired = false;
      }
    }

    // Tính remaining từ mốc thời gian đáng tin cậy nhất:
    // helper mode  → last_changed của HA entity (chuẩn UTC server, mọi thiết bị giống nhau)
    // local mode   → _localMotionSince (đồng hồ thiết bị này)
    let since;
    if (this._useHelpers) {
      since = this._readNoMotionSince(); // trả về new Date(last_changed).getTime()
      if (!since) since = this._localMotionSince; // fallback ngắn trong khi HA chưa phản hồi
    } else {
      since = this._localMotionSince;
    }
    if (!since) return; // chưa có mốc → bỏ qua tick này

    // Tính elapsed: nếu helper mode, bù offset giữa đồng hồ HA server và client
    // để mọi thiết bị (dù đồng hồ lệch) đều tính cùng kết quả
    const now = this._useHelpers ? this._getHAAlignedNow() : Date.now();
    const elapsed = now - since;
    const remaining = this._getAutoDelayMs() - elapsed;

    if (remaining <= 0 && !this._autoFired) {
      this._autoFired = true;
      this._executeAutoOff();
    }

    // Cập nhật UI đếm ngược
    this._updateAutoCountdown(remaining > 0 ? remaining : 0);
  }

  _executeAutoOff() {
    if (!this._hass) return;
    const E = this.ENTITIES;
    // Danh sách entity id nào sẽ tắt — đọc từ config, mặc định tất cả
    const allowed = (this._config && this._config.auto_off_entities) || ['den','decor','rgb','hien','quat','ocam','ac'];

    const tryOff = (id, domain) => {
      if (!allowed.includes(id)) return;
      if (domain === 'climate') {
        const s = this._state(id);
        const on = s && s.state !== 'off' && s.state !== 'unavailable';
        if (on) this._hass.callService('climate', 'turn_off', { entity_id: E[id] });
      } else {
        if (this._isOn(id)) this._hass.callService(domain, 'turn_off', { entity_id: E[id] });
      }
    };

    tryOff('den',   'light');
    tryOff('decor', (E.decor||'').split('.')[0] || 'switch');
    tryOff('rgb',   'light');
    tryOff('hien',  (E.hien||'').split('.')[0] || 'switch');
    tryOff('quat',  (E.quat||'').split('.')[0] || 'fan');
    tryOff('ocam',  'switch');
    tryOff('ac',    'climate');

    console.log('[HASmartRoom] Auto-off executed — no motion for', this._getAutoDelayMs()/60000, 'minutes');
  }

  _updateAutoCountdown(remainingMs) {
    if (!this._autoMode) return;
    const offInner = this.shadowRoot.getElementById('sp-off-inner');
    if (!offInner) return;

    const motion = this._isOn('motion');
    if (motion) {
      // Có người quay lại → xóa đếm ngược ngay lập tức
      offInner.dataset.cdlast = '';
      offInner.dataset.last   = '';
      offInner.innerHTML = `<div class="sp-scroll-item" style="color:rgba(150,210,255,0.8)">✅ ${this._ct.motionPresent}</div>`;
      if (this._autoCountdownRotate) { clearInterval(this._autoCountdownRotate); this._autoCountdownRotate = null; }
      return;
    }

    const mins = Math.floor(remainingMs / 60000);
    const secs = Math.floor((remainingMs % 60000) / 1000);
    const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;

    const acState = this._state('ac');
    const acOn = acState && acState.state !== 'off' && acState.state !== 'unavailable';
    const anyOn = this._isOn('den') || this._isOn('decor') || this._isOn('rgb') ||
                  this._isOn('hien') || this._isOn('quat') || this._isOn('ocam') || acOn;

    if (!anyOn) {
      const noDevHtml = `<div class="sp-scroll-item" style="color:rgba(255,255,255,0.25)">✅ ${this._ct.noDevice}</div>`;
      if (offInner.dataset.cdlast !== noDevHtml) {
        offInner.dataset.cdlast = noDevHtml;
        offInner.innerHTML = noDevHtml;
      }
      return;
    }

    if (remainingMs <= 0) {
      const doneHtml = `<div class="sp-scroll-item" style="color:rgba(255,100,100,0.9)">⚡ ${this._ct.autoDone.replace('{min}', Math.round(this._getAutoDelayMs()/60000))}</div>`;
      if (offInner.dataset.cdlast !== doneHtml) {
        offInner.dataset.cdlast = doneHtml;
        offInner.innerHTML = doneHtml;
      }
      return;
    }

    // Danh sách chip: chỉ hiện thiết bị đang bật VÀ có trong auto_off_entities
    const autoOffList = (this._config && this._config.auto_off_entities) || ['den','decor','rgb','hien','quat','ocam','ac'];
    // Map mặc định id → [icon, label] cho các thiết bị default
    const _defaultChipMap = {
      den:   ['💡', this._ct.chipDen],
      decor: ['✨', this._ct.chipDecor],
      hien:  ['🏮', this._ct.chipHien],
      rgb:   ['🌈', this._ct.chipRgb],
      quat:  ['🌀', this._ct.chipQuat],
      ocam:  ['🔌', this._ct.chipOcam],
      ac:    ['❄️', this._ct.chipAc],
    };
    const chips = [];
    // Default devices
    for (const [id, [ico, name]] of Object.entries(_defaultChipMap)) {
      if (!autoOffList.includes(id)) continue;
      if (id === 'ac') {
        if (acOn) chips.push([ico, name]);
      } else {
        if (this._isOn(id)) chips.push([ico, name]);
      }
    }
    // Extra devices từ config (nếu có)
    const _extras = (this._config && this._config.devices_extra) || [];
    for (const dev of _extras) {
      if (!autoOffList.includes(dev.id)) continue;
      if (this._isOn(dev.id)) {
        const label = (dev.label || dev.id).replace(/^[\p{Emoji}\s]+/u, '').trim();
        chips.push(['🔆', label]);
      }
    }

    if (chips.length === 0) return;

    // Hủy rotate timer (không cần nữa)
    if (this._autoCountdownRotate) { clearInterval(this._autoCountdownRotate); this._autoCountdownRotate = null; }

    const chipHtml = chips.map(([ico, name]) =>
      `<span class="acd-chip">${ico} ${name}</span>`
    ).join('');

    const newHtml = `<div class="acd-wrap"><div class="acd-timer">⏱️ ${this._ct.autoTimer} <b>${timeStr}</b></div><div class="acd-chips">${chipHtml}</div></div>`;

    const cacheKey = timeStr + '|' + chips.map(c => c[1]).join(',');
    if (offInner.dataset.cdlast !== cacheKey) {
      offInner.dataset.cdlast = cacheKey;
      offInner.innerHTML = newHtml;
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────
  _state(id) {
    const eid = this.ENTITIES[id];
    return eid && this._hass ? this._hass.states[eid] : null;
  }

  _isOn(id) {
    const s = this._state(id);
    if (!s) return false;
    return s.state === 'on';
  }

  _attr(id, attr) {
    const s = this._state(id);
    return s ? s.attributes[attr] : null;
  }

  _brightness(id) {
    // returns 0-100
    const b = this._attr(id, 'brightness');
    return b != null ? Math.round(b / 2.55) : 0;
  }

  _callService(domain, service, data) {
    this._hass.callService(domain, service, data);
  }

  _toggle(entityId) {
    if (!entityId || !this._hass) return;
    const domain = entityId.split('.')[0];
    const isOn = this._hass.states[entityId]?.state === 'on';
    const service = isOn ? 'turn_off' : 'turn_on';
    const svcDomain = domain === 'binary_sensor' ? 'homeassistant' : domain;
    const params = { entity_id: entityId };
    if (domain === 'light' && !isOn) params.brightness = 255;
    this._callService(svcDomain, service, params);
  }

  // Popup xác nhận — CHỈ dùng cho ổ cắm (type=ocam), không dùng cho đèn/quạt
  _toggleWithConfirm(entityId, label) {
    if (!entityId || !this._hass) return;
    const t = this._ct;
    const domain = entityId.split('.')[0];
    const isOn = this._hass.states[entityId]?.state === 'on';
    const action = isOn ? t.confirmActionOff : t.confirmActionOn;
    const actionSvc = isOn ? 'turn_off' : 'turn_on';
    const actionColor = isOn ? 'rgba(255,90,90,1)' : 'rgba(60,220,120,1)';
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.6);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;';
    const sheet = document.createElement('div');
    sheet.style.cssText = 'background:linear-gradient(160deg,#1a2a40 0%,#0d1a2e 100%);border:1px solid rgba(255,255,255,0.12);border-radius:20px;padding:24px 28px 20px;min-width:230px;max-width:290px;box-shadow:0 24px 60px rgba(0,0,0,0.65);text-align:center;animation:hsrcSlUp .18s ease;';
    sheet.innerHTML = '<style>@keyframes hsrcSlUp{from{transform:translateY(18px);opacity:0}to{transform:translateY(0);opacity:1}}</style>'
      + '<div style="font-size:34px;margin-bottom:6px">' + (isOn ? '🔴' : '🟢') + '</div>'
      + '<div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:4px">' + action + ' ' + (label || t.confirmDevFallback) + '?</div>'
      + '<div style="font-size:12px;color:rgba(255,255,255,0.45);margin-bottom:20px">' + (isOn ? t.confirmOff : t.confirmOn) + '</div>'
      + '<div style="display:flex;gap:10px">'
      + '<button id="hsrc-cfm-cancel" style="flex:1;padding:11px 0;border-radius:12px;border:none;cursor:pointer;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.6);font-size:13px;font-weight:700">' + t.confirmCancel + '</button>'
      + '<button id="hsrc-cfm-ok" style="flex:1;padding:11px 0;border-radius:12px;border:1.5px solid ' + actionColor + ';cursor:pointer;background:' + actionColor + '22;color:' + actionColor + ';font-size:13px;font-weight:700">' + action + '</button>'
      + '</div>';
    overlay.appendChild(sheet);
    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    sheet.querySelector('#hsrc-cfm-cancel').addEventListener('click', close);
    sheet.querySelector('#hsrc-cfm-ok').addEventListener('click', () => {
      this._callService(domain, actionSvc, { entity_id: entityId });
      close();
    });
    document.body.appendChild(overlay);
  }

  _setBrightness(entityId, pct) {
    this._callService('light', 'turn_on', { entity_id: entityId, brightness: Math.round(pct * 2.55) });
  }

  _now() {
    return new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  }

  _getRootBg() {
    const cfg = this._config || {};
    const preset = cfg.background_preset || 'default';
    if (!cfg.background_preset && !cfg.bg_alpha && !cfg.bg_blur) return 'background:linear-gradient(160deg,#0e1f38 0%,#081528 55%,#060f1e 100%);--root-c1:#0e1f38;--root-c2:#060f1e;--root-alpha:1;--root-blur:0px';
    const HSRC_BG = {
      default:   ['#0e1f38','#0a4a7a'], night:   ['#0d0d1a','#1a0a3a'],
      deep_neon: ['#020b18','#00d4ff'], sunset:  ['#1a0a00','#ff6b35'],
      forest:    ['#0a1a0a','#1a5c1a'], aurora:  ['#0a0a1a','#00cc88'],
      ocean:     ['#001020','#0055aa'], galaxy:  ['#080818','#6633cc'],
      ice:       ['#0a1828','#88ddff'], cherry:  ['#1a0010','#cc2255'],
      volcano:   ['#1a0500','#dd3300'], rose:    ['#1a0808','#ee6688'],
      teal:      ['#001818','#00aa88'], desert:  ['#1a0e00','#c8860a'],
      slate:     ['#101820','#445566'], olive:   ['#0e1200','#7a9a00'],
    };
    const alpha = cfg.bg_alpha !== undefined ? Math.round(cfg.bg_alpha * 2.55).toString(16).padStart(2,'0') : 'ff';
    let c1, c2;
    if (preset === 'custom') {
      c1 = cfg.bg_color1 || '#0e1f38'; c2 = cfg.bg_color2 || '#0a4a7a';
    } else {
      [c1, c2] = HSRC_BG[preset] || HSRC_BG.default;
    }
    return `background:linear-gradient(160deg,${c1}${alpha} 0%,${c2}${alpha} 100%);--root-c1:${c1};--root-c2:${c2};--root-alpha:${parseInt(alpha,16)/255};--root-blur:${cfg.bg_blur !== undefined ? cfg.bg_blur : 0}px`;
  }

  // ─── Sync root color CSS vars ─────────────────────────────────────────────
  _syncRootColorVars() {
    const root = this.shadowRoot && this.shadowRoot.getElementById('root');
    if (!root) return;
    const cfg = this._config || {};
    const preset = cfg.background_preset || 'default';
    const HSRC_BG = {
      default:   ['#0e1f38','#060f1e'], night:   ['#0d0d1a','#0d052a'],
      deep_neon: ['#020b18','#003040'], sunset:  ['#1a0a00','#3a1a08'],
      forest:    ['#0a1a0a','#0a2a0a'], aurora:  ['#0a0a1a','#051a10'],
      ocean:     ['#001020','#001840'], galaxy:  ['#080818','#180828'],
      ice:       ['#0a1828','#182840'], cherry:  ['#1a0010','#1a0020'],
      volcano:   ['#1a0500','#200500'], rose:    ['#1a0808','#200808'],
      teal:      ['#001818','#001818'], desert:  ['#1a0e00','#1a0e00'],
      slate:     ['#101820','#101820'], olive:   ['#0e1200','#0e1200'],
    };
    let c2hex;
    if (preset === 'custom') c2hex = cfg.bg_color2 || '#060f1e';
    else { const pair = HSRC_BG[preset] || HSRC_BG.default; c2hex = pair[1]; }
    // Parse hex to r,g,b
    const hex = c2hex.replace('#','');
    const r = parseInt(hex.substring(0,2),16)||6;
    const g = parseInt(hex.substring(2,4),16)||15;
    const b = parseInt(hex.substring(4,6),16)||30;
    const alpha = cfg.bg_alpha !== undefined ? cfg.bg_alpha : 1;
    root.style.setProperty('--root-c2-r', r);
    root.style.setProperty('--root-c2-g', g);
    root.style.setProperty('--root-c2-b', b);
    root.style.setProperty('--root-alpha', alpha);
    const blur = cfg.bg_blur !== undefined ? cfg.bg_blur : 0;
    root.style.setProperty('--root-blur', blur + 'px');
  }

  // ─── Render (first time) ───────────────────────────────────────────────────
  async _render() {
    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <div class="root" id="root" style="${this._getRootBg()}">
        ${this._tplHeader()}
        ${this._tplSensorRow()}
        ${this._tplGraph()}
        ${this._tplSmartBar()}
        ${this._tplDevRow()}
        ${this._tplRgbModal()}
      </div>
    `;
    this._bindEvents();
    this._bindExtraCardEvents();
    // Đăng ký phòng với integration sau render đầu
    if (this._useIntegration) {
      await this._registerWithIntegration();
    }
    this._mountOverlaysToHost();
    this._syncRootColorVars();
    this._applyDisplayOptions();
    this._drawGraph();
    this._update();
    // Refresh graph mỗi 5 phút
    if (this._graphTimer) clearInterval(this._graphTimer);
    this._graphTimer = setInterval(() => this._drawGraph(), 5 * 60 * 1000);
  }

  // ─── Incremental update ────────────────────────────────────────────────────
  _update() {
    if (!this._hass || !this.shadowRoot.getElementById('root')) return;
    this._updateCardLabels();
    this._updateHeader();
    this._updateSensors();
    this._updateCards();
    this._applyDisplayOptions();
  }

  // ─── Update i18n labels that are in static HTML ───────────────────────────
  _updateCardLabels() {
    const ct = this._ct;
    const sr = this.shadowRoot;
    if (!sr || !ct) return;
    const $ = id => sr.getElementById(id);

    // Mode buttons
    const btnM = $('btn-manual');   if (btnM) btnM.textContent = ct.btnManual;
    const btnA = $('btn-auto-mode'); if (btnA) btnA.textContent = ct.btnAuto;

    // Fan popup title (all instances)
    sr.querySelectorAll('[id^="spd-popup-title"]').forEach(el => { el.textContent = ct.fanPopupTitle; });
    // Fan level labels
    sr.querySelectorAll('[data-spd-lv]').forEach(el => {
      const lv = parseInt(el.dataset.spdLv);
      if (!isNaN(lv) && ct.fanLvl[lv]) el.textContent = ct.fanLvl[lv];
    });
    // Fan speed open button labels
    sr.querySelectorAll('.spd-open-btn').forEach(btn => {
      // keep the val span, replace only the text node
      const val = btn.querySelector('.spd-open-val');
      if (val) { btn.childNodes.forEach(n => { if (n.nodeType === 3) n.textContent = ct.tvFanSpeed + ' '; }); }
    });

    // RGB modal
    const rgbTitle = $('rgb-modal-title');   if (rgbTitle) rgbTitle.textContent = ct.rgbModalTitle;
    const rgbClrSec = $('rgb-color-sec-lbl'); if (rgbClrSec) rgbClrSec.textContent = ct.rgbColorLabel;
    const rgbCust   = $('rgb-custom-lbl');    if (rgbCust)   rgbCust.textContent   = ct.rgbCustom;

    // Sensor row labels (when no state yet)
    const tempLbl = $('s-temp-lbl'); if (tempLbl && !this._state('temp')) tempLbl.textContent = ct.tempLabel;
    const humiLbl = $('s-humi-lbl'); if (humiLbl && !this._state('humi')) humiLbl.textContent = ct.humiLabel;

    // Graph labels (static ones updated on each render)
    const tlLbl = sr.getElementById('g-tl-label');
    if (tlLbl && tlLbl.firstChild) tlLbl.firstChild.textContent = ct.graphTemp + ' ';
    const trLbl = sr.getElementById('g-tr-label');
    if (trLbl) trLbl.textContent = ct.graphPwr;
    const t4 = $('g-t4'); if (t4) t4.textContent = ct.graphNow;
    const acOnLbl  = $('gs-ac-on-lbl');  if (acOnLbl)  acOnLbl.textContent  = ct.graphAcOn;
    const acOffLbl = $('gs-ac-off-lbl'); if (acOffLbl) acOffLbl.textContent = ct.graphAcOff;
    const motLbl   = $('gs-motion-lbl'); if (motLbl)   motLbl.textContent   = ct.graphMotion;

    // scoring placeholder
    const scLbl = $('h-score-lbl');
    if (scLbl && (scLbl.textContent === '...' || scLbl.textContent === '')) scLbl.textContent = ct.scoring;

    // Initial manual mode hint
    const manInit = $('sp-manual-init');
    if (manInit) manInit.innerHTML = '⚙️ ' + ct.modeManual;
  }



  // ─── Room comfort score ────────────────────────────────────────────────────
  _calcRoomScore() {
    const t   = this._state('temp')  ? parseFloat(this._state('temp').state)  : null;
    const h   = this._state('humi')  ? parseFloat(this._state('humi').state)  : null;
    const acS = this._state('ac');
    const acOn  = acS && acS.state !== 'off' && acS.state !== 'unavailable';
    const fanOn = this._isOn('quat');

    let score = 100;
    let reasons = [];

    // ── Nhiệt độ ────────────────────────────────────────────────────────────
    if (t !== null) {
      if      (t >= 38) { score -= 55; reasons.push(this._ct.scoreReasons.extremeHot); }
      else if (t >= 35) { score -= 40; reasons.push(this._ct.scoreReasons.veryHot); }
      else if (t >= 32) { score -= 25; reasons.push(this._ct.scoreReasons.hot); }
      else if (t >= 30) { score -= 15; reasons.push(this._ct.scoreReasons.slightHot); }
      else if (t >= 28) { score -= 6;  }
      else if (t >= 25) { /* ideal */ }
      else if (t >= 22) { score -= 3;  }
      else if (t >= 18) { score -= 10; reasons.push(this._ct.scoreReasons.slightCold); }
      else              { score -= 25; reasons.push(this._ct.scoreReasons.cold); }
    }

    // ── Độ ẩm ────────────────────────────────────────────────────────────────
    if (h !== null) {
      if      (h >= 90) { score -= 30; reasons.push(this._ct.scoreReasons.humid); }
      else if (h >= 80) { score -= 18; reasons.push(this._ct.scoreReasons.veryHumid); }
      else if (h >= 70) { score -= 8;  }
      else if (h >= 40) { /* ideal */ }
      else if (h >= 30) { score -= 5;  }
      else              { score -= 15; reasons.push(this._ct.scoreReasons.dry); }
    }

    // ── Quạt / điều hòa bù điểm ─────────────────────────────────────────────
    if (t !== null && t >= 28 && !fanOn && !acOn) { score -= 8; reasons.push(this._ct.scoreReasons.noFan); }
    if (acOn  && t !== null && t >= 26) { score += 8;  }
    if (fanOn && t !== null && t >= 27) { score += 4;  }
    if (acOn  && h !== null && h >= 70) { score += 5;  }

    score = Math.max(0, Math.min(100, Math.round(score)));

    // ── Emoji + nhãn ─────────────────────────────────────────────────────────
    let emoji, label, color, ring;
    if      (score >= 92) { emoji='🤩'; label=this._ct.scoreLabels[0]; color='rgba(80,255,160,1)';   ring='rgba(80,255,160,0.35)'; }
    else if (score >= 80) { emoji='😄'; label=this._ct.scoreLabels[1]; color='rgba(100,240,120,1)';  ring='rgba(80,220,120,0.3)'; }
    else if (score >= 70) { emoji='🙂'; label=this._ct.scoreLabels[2]; color='rgba(160,230,80,1)';   ring='rgba(140,220,60,0.28)'; }
    else if (score >= 60) { emoji='😐'; label=this._ct.scoreLabels[3]; color='rgba(230,210,50,1)';   ring='rgba(220,200,40,0.28)'; }
    else if (score >= 50) { emoji='😅'; label=this._ct.scoreLabels[4]; color='rgba(255,180,40,1)';   ring='rgba(255,160,30,0.3)'; }
    else if (score >= 38) { emoji='😓'; label=this._ct.scoreLabels[5]; color='rgba(255,130,40,1)';   ring='rgba(255,110,20,0.3)'; }
    else if (score >= 25) { emoji='🥵'; label=this._ct.scoreLabels[6]; color='rgba(255,80,60,1)';    ring='rgba(255,60,40,0.35)'; }
    else                  { emoji='💀'; label=this._ct.scoreLabels[7]; color='rgba(220,50,50,1)';    ring='rgba(200,30,30,0.4)'; }

    return { score, emoji, label, color, ring, reasons };
  }

  // Áp dụng ẩn/hiện các section theo config show_* — gọi sau mỗi render/update
  _applyDisplayOptions() {
    const cfg = this._config || {};
    const sr  = this.shadowRoot;
    if (!sr) return;

    // Helper: set display của element theo boolean (mặc định = true nếu key không tồn tại)
    const show = (id, key, defaultOn = true) => {
      const el = sr.getElementById(id);
      if (!el) return;
      const visible = cfg[key] !== false; // undefined → hiện, false → ẩn
      el.style.display = visible ? '' : 'none';
    };

    // Ô điểm tiện nghi (score pill)
    show('h-score-pill', 'show_score');

    // Gợi ý nhiệt độ/độ ẩm trong-ngoài
    show('sec-env-hint', 'show_env_hint');

    // Tự động hóa: trạng thái hint + nút bấm
    show('sec-auto-mode', 'show_auto_mode');

    // Biểu đồ nhiệt độ + công suất (toàn bộ section kể cả timeline)
    show('sec-graph', 'show_graph');

    // Timeline (ac bật/tắt, cửa, motion) — bên trong graph, chỉ ẩn riêng nếu graph đang hiện
    if (cfg.show_graph !== false) {
      show('sec-timeline', 'show_timeline');
    }
  }

  _updateHeader() {
    // Chỉ tính các thiết bị là đèn: type === 'den' hoặc type === 'rgb'
    // Bao gồm cả default devices và extra devices
    // Đèn mặc định: den, decor, hien (type=den) và rgb (type=rgb)
    const defLightIds = ['den', 'decor', 'hien', 'rgb'];
    const extraLightIds = ((this._config && this._config.devices_extra) || [])
      .filter(d => d.type === 'den' || d.type === 'rgb')
      .map(d => d.id);
    const onCount = [...defLightIds, ...extraLightIds].filter(id => this._isOn(id)).length;
    const sub = this.shadowRoot.getElementById('h-sub');
    const sub2 = this.shadowRoot.getElementById('h-sub2');
    if (sub) {
      sub.innerHTML = `${this._now()} · <b style="color:rgba(80,220,255,0.95)">${onCount} 💡</b>`;
    }
    if (sub2) {
      const door    = this._state('door');
      const doorOpen = door && door.state === 'on';
      const motionH  = this._isOn('motion');
      const doorIcon = doorOpen
        ? `<span style="color:rgba(255,180,60,0.95)">🚪 ${this._ct.doorOpen}</span>`
        : `<span style="color:rgba(80,220,255,0.6)">🚪 ${this._ct.doorClosed}</span>`;
      const motionIcon = motionH
        ? `<span style="color:rgba(180,120,255,0.95)">🚶 ${this._ct.motionYes}</span>`
        : `<span style="color:rgba(255,255,255,0.3)">🚶 ${this._ct.motionNo}</span>`;
      sub2.innerHTML = `${doorIcon} &nbsp;·&nbsp; ${motionIcon}`;
    }

    const tempIn  = this._state('temp');
    const humiIn  = this._state('humi');
    const tempOut = this._state('tempOut');
    const humiOut = this._state('humiOut');
    const motion  = this._isOn('motion');
    const door    = this._state('door');
    const doorOpen = door && door.state === 'on';
    const acState = this._state('ac');
    const acOn    = acState && acState.state !== 'off' && acState.state !== 'unavailable';
    const isAutoMode = this._autoMode || false;

    const tIn  = tempIn  ? parseFloat(tempIn.state)  : null;
    const hIn  = humiIn  ? parseFloat(humiIn.state)  : null;
    const tOut = tempOut ? parseFloat(tempOut.state) : null;
    const hOut = humiOut ? parseFloat(humiOut.state) : null;

    // ── Hàng 1: So sánh nhiệt độ/độ ẩm trong-ngoài — scroll lên liên tục ──
    const envInner = this.shadowRoot.getElementById('sp-env-inner');
    if (envInner) {
      const envItems = [];
      const ct = this._ct;

      if (tIn !== null && tOut !== null) {
        const dT = tIn - tOut;
        const dH = hIn !== null && hOut !== null ? hIn - hOut : null;

        // ── Nhiệt độ: câu sáng tạo theo ngữ cảnh ──────────────────────────
        const _r = (s, o) => Object.entries(o).reduce((a,[k,v]) => a.replace('{'+k+'}', v), s);
        if (dT > 8) {
          envItems.push(`🌡️ ${_r(ct.envHotRoomHigh, {d: Math.round(dT)})}`);
        } else if (dT > 5) {
          envItems.push(`🌡️ ${_r(ct.envHotRoomMid, {d: Math.round(dT)})}`);
        } else if (dT > 2) {
          envItems.push(`🌡️ ${_r(ct.envHotRoomLow, {d: Math.round(dT)})}`);
        } else if (dT < -8) {
          if (tOut >= 37) {
            envItems.push(`☀️ ${_r(ct.envOutHeatwave, {t: Math.round(tOut)})}`);
          } else {
            envItems.push(`🌤️ ${_r(ct.envOutWarmClose, {d: Math.round(-dT)})}`);
          }
        } else if (dT < -5) {
          if (tOut >= 35) {
            envItems.push(`☀️ ${_r(ct.envOutHot, {t: Math.round(tOut)})}`);
          } else {
            envItems.push(`🌤️ ${_r(ct.envOutWarmClose, {d: Math.round(-dT)})}`);
          }
        } else if (dT < -2) {
          envItems.push(`🌤️ ${_r(ct.envOutWarm, {d: Math.round(-dT)})}`);
        } else {
          envItems.push(`✅ ${_r(ct.envBalanced, {ti: Math.round(tIn), to: Math.round(tOut)})}`);
        }

        // ── Độ ẩm: đoán thời tiết & lời khuyên thực tế ────────────────────
        if (dH !== null) {
          const hiR = Math.round(hIn); const hoR = Math.round(hOut);
          const looksRainy = hOut >= 88;
          const looksHumidOut = hOut >= 78;

          if (looksRainy && dH < 5) {
            envItems.push(`🌧️ ${_r(ct.envRainyUmbrella, {h: hoR})}`);
          } else if (looksRainy) {
            envItems.push(`🌧️ ${_r(ct.envRainyMaybe, {h: hoR})}`);
          } else if (looksHumidOut && dH < -5) {
            envItems.push(`💦 ${_r(ct.envOutHumidSweat, {h: hoR})}`);
          } else if (dH > 12) {
            envItems.push(`💧 ${_r(ct.envInHumiHighClothes, {d: Math.round(dH)})}`);
          } else if (dH > 6) {
            envItems.push(`💧 ${_r(ct.envInHumiMidVent, {d: Math.round(dH)})}`);
          } else if (dH < -10) {
            if (hIn < 35) {
              envItems.push(`🏜️ ${_r(ct.envInDryHumid, {h: hiR})}`);
            } else {
              envItems.push(`💦 ${_r(ct.envOutHumidClose, {d: Math.round(-dH)})}`);
            }
          } else if (dH < -5) {
            envItems.push(`🌤️ ${_r(ct.envOutHumidLow, {d: Math.round(-dH)})}`);
          } else {
            if (hOut >= 70 && tOut !== null && tOut >= 30) {
              envItems.push(`🥵 ${_r(ct.envOutHotHumid, {t: Math.round(tOut), h: hoR})}`);
            } else if (hOut < 30) {
              envItems.push(`🏜️ ${_r(ct.envOutVeryDry, {h: hoR})}`);
            } else {
              envItems.push(`💧 ${_r(ct.envHumiBalance.replace('{hi}',hiR).replace('{ho}',hoR), {})}`);
            }
          }
        }

        // ── Cảnh báo bổ sung theo tình huống nguy hiểm ─────────────────────
        if (tOut !== null && tOut >= 38) {
          envItems.push(`🚨 ${_r(ct.envDangerHeat, {t: Math.round(tOut)})}`);
        } else if (tOut !== null && tOut >= 35 && hOut !== null && hOut >= 70) {
          envItems.push(`⚠️ ${_r(ct.envHotHumidWarn, {t: Math.round(tOut), h: Math.round(hOut)})}`);
        } else if (tOut !== null && tOut <= 13) {
          envItems.push(`🥶 ${_r(ct.envOutVeryCold, {t: Math.round(tOut)})}`);
        } else if (tOut !== null && tOut <= 18) {
          envItems.push(`🧥 ${_r(ct.envOutCold, {t: Math.round(tOut)})}`);
        }

      } else if (tIn !== null) {
        envItems.push(`🌡️ ${ct.envTempIn.replace('{t}',Math.round(tIn))}`);
        if (hIn !== null) {
          if (hIn >= 85) envItems.push(`💧 ${ct.envInVeryHumid.replace('{h}',Math.round(hIn))}`);
          else if (hIn < 30) envItems.push(`🏜️ ${ct.envInVerydry.replace('{h}',Math.round(hIn))}`);
          else envItems.push(`💧 ${ct.envHumiIn.replace('{h}',Math.round(hIn))}`);
        }
      }
      if (envItems.length === 0) envItems.push(ct.envLoading);

      // Chỉ rebuild nếu nội dung thay đổi để tránh reset animation
      const newHtml = envItems.map(t => `<div class="sp-scroll-item">${t}</div>`).join('');
      if (envInner.dataset.last !== newHtml) {
        envInner.dataset.last = newHtml;
        envInner.innerHTML = newHtml;
        // Khởi động scroll liên tục nếu có nhiều hơn 1 dòng
        if (envItems.length > 1 && !this._envScrollTimer) {
          this._envScrollIdx = 0;
          this._envScrollTimer = setInterval(() => {
            const items = envInner.querySelectorAll('.sp-scroll-item');
            if (!items.length) return;
            this._envScrollIdx = (this._envScrollIdx + 1) % items.length;
            const h = items[0].offsetHeight || 20;
            envInner.style.transform = `translateY(-${this._envScrollIdx * h}px)`;
          }, 4000);
        }
      }
    }

    // ── Dòng 2: Chế độ thủ công → trạng thái / Tự động → đề xuất ──────────
    const hintInner = this.shadowRoot.getElementById('sp-hint-inner');
    const offInner = this.shadowRoot.getElementById('sp-off-inner');

    if (!isAutoMode) {
      // Thủ công: chỉ hiện thông báo chế độ, không scroll
      if (hintInner) {
        hintInner.style.transform = 'translateY(0)';
        hintInner.innerHTML = `<div class="sp-scroll-item" style="color:rgba(80,220,255,0.7)">⚙️ ${this._ct.modeManual}</div>`;
        hintInner.dataset.last = '';
      }
      // Dòng 3: trống
      if (offInner) {
        offInner.style.transform = 'translateY(0)';
        offInner.innerHTML = `<div class="sp-scroll-item" style="color:rgba(255,255,255,0.18)">—</div>`;
        offInner.dataset.last = '';
      }
      // Dừng timers
      if (this._hintScrollTimer) { clearInterval(this._hintScrollTimer); this._hintScrollTimer = null; }
      if (this._offScrollTimer)  { clearInterval(this._offScrollTimer);  this._offScrollTimer  = null; }
    } else {
      // Tự động: đề xuất thông minh
      if (hintInner) {
        const hints = [];
        if (!doorOpen && tIn !== null && tIn > 29 && !this._isOn('quat') && !acOn) {
          hints.push('🌀 ' + this._ct.hintFan);
        }
        if (!doorOpen && tIn !== null && tIn > 31 && this._isOn('quat') && !acOn) {
          hints.push('❄️ ' + this._ct.hintAc.replace('{t}', Math.round(tIn)));
        }
        if (doorOpen && acOn) hints.push('⚠️ ' + this._ct.hintDoorAc);
        if (!doorOpen && tOut !== null && tIn !== null && tOut < tIn - 4) {
          hints.push('🚪 ' + this._ct.hintOpenDoor.replace('{d}', Math.round(tIn - tOut)));
        }
        if (!motion) {
          if (this._isOn('den') || this._isOn('decor') || this._isOn('hien')) hints.push('💡 ' + this._ct.hintEmptyLight);
          if (this._isOn('quat')) hints.push('🌀 ' + this._ct.hintEmptyFan);
          if (acOn) hints.push('❄️ ' + this._ct.hintEmptyAc);
        }
        if (hIn !== null && hIn > 80 && !this._isOn('quat')) hints.push('💧 ' + this._ct.hintHumi.replace('{h}', Math.round(hIn)));
        if (doorOpen && tOut !== null && tIn !== null && tOut > tIn + 3) {
          hints.push('🌤️ ' + this._ct.hintHotOut.replace('{d}', Math.round(tOut - tIn)));
        }
        if (!motion && this._isOn('rgb')) hints.push('🌈 ' + this._ct.hintRgb);
        if (hints.length === 0) hints.push('✅ ' + this._ct.modeAutoOptimal);

        const newHtml2 = hints.map(t => `<div class="sp-scroll-item" style="color:rgba(255,200,100,0.85)">${t}</div>`).join('');
        if (hintInner.dataset.last !== newHtml2) {
          hintInner.dataset.last = newHtml2;
          hintInner.innerHTML = newHtml2;
          hintInner.style.transform = 'translateY(0)';
          this._hintScrollIdx = 0;
          if (this._hintScrollTimer) { clearInterval(this._hintScrollTimer); this._hintScrollTimer = null; }
          setTimeout(() => {
            const wrap = this.shadowRoot.getElementById('sp-hint-wrap');
            const items = hintInner.querySelectorAll('.sp-scroll-item');
            if (wrap && items.length) wrap.style.height = items[0].offsetHeight + 'px';
            if (hints.length > 1) {
              this._hintScrollTimer = setInterval(() => {
                const its = hintInner.querySelectorAll('.sp-scroll-item');
                if (!its.length) return;
                this._hintScrollIdx = (this._hintScrollIdx + 1) % its.length;
                let offset = 0;
                for (let i = 0; i < this._hintScrollIdx; i++) offset += its[i].offsetHeight;
                hintInner.style.transform = `translateY(-${offset}px)`;
                const w = this.shadowRoot.getElementById('sp-hint-wrap');
                if (w) w.style.height = its[this._hintScrollIdx].offsetHeight + 'px';
              }, 3500);
            }
          }, 50);
        }
      }

      // Dòng 3: lịch tắt tự động
      if (offInner) {
        // Khi chế độ tự động: engine tự cập nhật offInner mỗi giây (đếm ngược thật)
        // Chỉ xử lý ở đây khi chế độ thủ công hoặc có người
        if (!isAutoMode) {
          const noAutoHtml = `<div class="sp-scroll-item" style="color:rgba(255,255,255,0.18)">—</div>`;
          if (offInner.dataset.last !== noAutoHtml) {
            offInner.dataset.last = noAutoHtml;
            offInner.dataset.cdlast = '';
            offInner.innerHTML = noAutoHtml;
          }
        } else if (motion) {
          // Có người → hiện trạng thái bình thường
          const motionItems = ['✅ ' + this._ct.motionPresent];
          if (acOn && tIn !== null && tIn < 22) motionItems.push('🥶 ' + this._ct.motionCold + ' <b>' + Math.round(tIn) + this._ct.motionColdSuffix + '</b>');
          const newHtml3 = motionItems.map(t => `<div class="sp-scroll-item" style="color:rgba(150,210,255,0.8)">${t}</div>`).join('');
          if (offInner.dataset.last !== newHtml3) {
            offInner.dataset.last = newHtml3;
            offInner.dataset.cdlast = '';
            offInner.innerHTML = newHtml3;
            offInner.style.transform = 'translateY(0)';
          }
          // Reset rotation khi quay lại có người
          if (this._autoCountdownRotate) { clearInterval(this._autoCountdownRotate); this._autoCountdownRotate = null; }
        }
        // Khi auto + không có người: _autoEngineTick() cập nhật trực tiếp qua _updateAutoCountdown()
      }
    }

    // ── Room comfort score ───────────────────────────────────────────────────
    const sc = this._calcRoomScore();
    const pill   = this.shadowRoot.getElementById('h-score-pill');
    const scEmoji = this.shadowRoot.getElementById('h-score-emoji');
    const scNum  = this.shadowRoot.getElementById('h-score-num');
    const scLbl  = this.shadowRoot.getElementById('h-score-lbl');
    if (pill) {
      pill.style.setProperty('--sc-color', sc.color);
      pill.style.setProperty('--sc-ring', sc.ring);
    }
    if (scEmoji) scEmoji.textContent = sc.emoji;
    if (scLbl)   { scLbl.textContent = sc.label; scLbl.style.color = sc.color; }
    // Animate gauge arc: full arc length = π*r = π*32 ≈ 100.53
    const gaugeArc = this.shadowRoot.getElementById('h-gauge-arc');
    if (gaugeArc) {
      const total = 75.4;
      const offset = total * (1 - sc.score / 100);
      gaugeArc.style.strokeDashoffset = offset;
    }

  }

  _updateSensors() {
    const temp = this._state('temp');
    const humi = this._state('humi');
    const door = this._state('door');
    const motion = this._state('motion');

    const $ = id => this.shadowRoot.getElementById(id);

    if (temp) {
      const t = Math.round(parseFloat(temp.state));
      if ($('s-temp')) $('s-temp').textContent = `${t}°C`;

      // ── Temperature icon + label + box style ──────────────────────────────
      let tempSvg, tempLabel, tempClass, boxClass;

      if (t >= 35) {
        // 🔥 Cực nóng — nhiệt kế bốc lửa, glow đỏ rực
        tempClass = 'lbl-danger'; boxClass = 'box-danger';
        tempLabel = this._ct.tempVeryHot;
        tempSvg = `<svg viewBox="0 0 24 24" class="s-ico-svg anim-temp-fire" width="24" height="24">
          <!-- thermometer tube -->
          <rect x="10.5" y="3" width="3" height="10" rx="1.5" fill="currentColor" opacity="0.9"/>
          <!-- bulb -->
          <circle cx="12" cy="16" r="3.2" fill="currentColor"/>
          <!-- mercury fill - full -->
          <rect x="11" y="6" width="2" height="8" rx="1" fill="rgba(255,60,20,0.95)"/>
          <circle cx="12" cy="16" r="2.5" fill="rgba(255,60,20,0.95)"/>
          <!-- tick marks -->
          <line x1="13.5" y1="5.5" x2="15" y2="5.5" stroke="currentColor" stroke-width="0.9" opacity="0.5"/>
          <line x1="13.5" y1="7.5" x2="15" y2="7.5" stroke="currentColor" stroke-width="0.9" opacity="0.5"/>
          <line x1="13.5" y1="9.5" x2="15" y2="9.5" stroke="currentColor" stroke-width="0.9" opacity="0.5"/>
          <!-- flames above -->
          <path d="M9.5 4 Q8 2 10 1.2 Q9 3 10.5 3.5Z" fill="rgba(255,140,20,0.9)"/>
          <path d="M12 3.5 Q10.5 1 12.5 0.5 Q11.5 2.5 12.5 3Z" fill="rgba(255,80,10,0.85)"/>
          <path d="M14 4 Q15.5 2 13.5 1.2 Q14.5 3 13.5 3.5Z" fill="rgba(255,140,20,0.9)"/>
        </svg>`;
      } else if (t >= 32) {
        // 🌡️ Nóng — nhiệt kế đỏ + glow cam
        tempClass = 'lbl-warn'; boxClass = 'box-warn';
        tempLabel = this._ct.tempHot;
        tempSvg = `<svg viewBox="0 0 24 24" class="s-ico-svg anim-temp-hot" width="24" height="24">
          <rect x="10.5" y="3.5" width="3" height="10" rx="1.5" fill="currentColor" opacity="0.85"/>
          <circle cx="12" cy="17" r="3" fill="currentColor"/>
          <rect x="11" y="7" width="2" height="7" rx="1" fill="rgba(255,80,30,0.95)"/>
          <circle cx="12" cy="17" r="2.3" fill="rgba(255,80,30,0.95)"/>
          <line x1="13.5" y1="6" x2="14.8" y2="6" stroke="currentColor" stroke-width="0.9" opacity="0.5"/>
          <line x1="13.5" y1="8" x2="14.8" y2="8" stroke="currentColor" stroke-width="0.9" opacity="0.5"/>
          <line x1="13.5" y1="10" x2="14.8" y2="10" stroke="currentColor" stroke-width="0.9" opacity="0.5"/>
          <!-- wavy heat lines -->
          <path d="M16 8 Q17.5 7 16 6 Q17.5 5 16 4" stroke="rgba(255,120,40,0.7)" stroke-width="1.1" fill="none" stroke-linecap="round"/>
          <path d="M18 9 Q19.5 8 18 7 Q19.5 6 18 5" stroke="rgba(255,120,40,0.5)" stroke-width="0.9" fill="none" stroke-linecap="round"/>
        </svg>`;
      } else if (t >= 29) {
        // Hơi ấm — nhiệt kế vàng cam
        tempClass = 'lbl-caution'; boxClass = 'box-caution';
        tempLabel = this._ct.tempWarm;
        tempSvg = `<svg viewBox="0 0 24 24" class="s-ico-svg anim-temp-warm" width="24" height="24">
          <rect x="10.5" y="4" width="3" height="10" rx="1.5" fill="currentColor" opacity="0.85"/>
          <circle cx="12" cy="17" r="3" fill="currentColor"/>
          <rect x="11" y="8" width="2" height="6.5" rx="1" fill="rgba(255,180,30,0.95)"/>
          <circle cx="12" cy="17" r="2.3" fill="rgba(255,180,30,0.95)"/>
          <line x1="13.5" y1="6.5" x2="14.8" y2="6.5" stroke="currentColor" stroke-width="0.9" opacity="0.5"/>
          <line x1="13.5" y1="9" x2="14.8" y2="9" stroke="currentColor" stroke-width="0.9" opacity="0.5"/>
          <line x1="13.5" y1="11.5" x2="14.8" y2="11.5" stroke="currentColor" stroke-width="0.9" opacity="0.5"/>
        </svg>`;
      } else if (t >= 24) {
        // Dễ chịu — nhiệt kế xanh lá
        tempClass = 'lbl-ok'; boxClass = '';
        tempLabel = this._ct.tempOk;
        tempSvg = `<svg viewBox="0 0 24 24" class="s-ico-svg" width="24" height="24">
          <rect x="10.5" y="4" width="3" height="10" rx="1.5" fill="currentColor" opacity="0.85"/>
          <circle cx="12" cy="17" r="3" fill="currentColor"/>
          <rect x="11" y="10" width="2" height="4.5" rx="1" fill="rgba(80,220,130,0.95)"/>
          <circle cx="12" cy="17" r="2.3" fill="rgba(80,220,130,0.95)"/>
          <line x1="13.5" y1="7" x2="14.8" y2="7" stroke="currentColor" stroke-width="0.9" opacity="0.45"/>
          <line x1="13.5" y1="10" x2="14.8" y2="10" stroke="currentColor" stroke-width="0.9" opacity="0.45"/>
          <line x1="13.5" y1="13" x2="14.8" y2="13" stroke="currentColor" stroke-width="0.9" opacity="0.45"/>
          <!-- checkmark -->
          <path d="M8 12 L10 14.5 L15.5 9" stroke="rgba(80,220,130,0.8)" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
      } else if (t >= 20) {
        // Mát — nhiệt kế xanh dương nhạt
        tempClass = 'lbl-cool'; boxClass = 'box-cool';
        tempLabel = this._ct.tempCool;
        tempSvg = `<svg viewBox="0 0 24 24" class="s-ico-svg anim-temp-cool" width="24" height="24">
          <rect x="10.5" y="4" width="3" height="10" rx="1.5" fill="currentColor" opacity="0.85"/>
          <circle cx="12" cy="17" r="3" fill="currentColor"/>
          <rect x="11" y="11" width="2" height="3.5" rx="1" fill="rgba(80,180,255,0.95)"/>
          <circle cx="12" cy="17" r="2.3" fill="rgba(80,180,255,0.95)"/>
          <line x1="13.5" y1="7" x2="14.8" y2="7" stroke="currentColor" stroke-width="0.9" opacity="0.45"/>
          <line x1="13.5" y1="10" x2="14.8" y2="10" stroke="currentColor" stroke-width="0.9" opacity="0.45"/>
          <line x1="13.5" y1="13" x2="14.8" y2="13" stroke="currentColor" stroke-width="0.9" opacity="0.45"/>
        </svg>`;
      } else {
        // ❄️ Lạnh — bông tuyết, glow xanh băng
        tempClass = 'lbl-cold'; boxClass = 'box-cold';
        tempLabel = t <= 16 ? this._ct.tempVeryCold : this._ct.tempCold;
        tempSvg = `<svg viewBox="0 0 24 24" class="s-ico-svg anim-temp-cold" width="24" height="24">
          <!-- snowflake center cross -->
          <line x1="12" y1="2" x2="12" y2="22" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          <line x1="2" y1="12" x2="22" y2="12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          <!-- diagonal arms -->
          <line x1="5.1" y1="5.1" x2="18.9" y2="18.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
          <line x1="18.9" y1="5.1" x2="5.1" y2="18.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
          <!-- branch tips on vertical -->
          <line x1="12" y1="4" x2="10" y2="6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
          <line x1="12" y1="4" x2="14" y2="6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
          <line x1="12" y1="20" x2="10" y2="18" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
          <line x1="12" y1="20" x2="14" y2="18" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
          <!-- branch tips on horizontal -->
          <line x1="4" y1="12" x2="6" y2="10" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
          <line x1="4" y1="12" x2="6" y2="14" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
          <line x1="20" y1="12" x2="18" y2="10" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
          <line x1="20" y1="12" x2="18" y2="14" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
          <!-- center dot -->
          <circle cx="12" cy="12" r="1.8" fill="currentColor"/>
        </svg>`;
      }

      const icoEl = $('s-ico-temp');
      if (icoEl) icoEl.innerHTML = tempSvg;
      const lbl = $('s-temp-lbl');
      if (lbl) { lbl.textContent = tempLabel; lbl.className = 's-lbl ' + tempClass; }
      const box = $('s-box-temp');
      if (box) box.className = 's-box ' + boxClass;
    }

    if (humi) {
      const h = Math.round(parseFloat(humi.state));
      if ($('s-humi')) $('s-humi').textContent = `${h}%`;

      // ── Humidity icon + label + box style ─────────────────────────────────
      let humiSvg, humiLabel, humiClass, boxClass;

      if (h >= 90) {
        // 🌧️ Cực ẩm — mây mưa, glow xanh tím
        humiClass = 'lbl-danger'; boxClass = 'box-humid-danger';
        humiLabel = this._ct.humiStorm;
        humiSvg = `<svg viewBox="0 0 24 24" class="s-ico-svg anim-humi-storm" width="24" height="24">
          <!-- cloud body -->
          <path d="M6 10.5a3.5 3.5 0 0 1 3.5-3.5 3.5 3.5 0 0 1 1.2.2A4 4 0 0 1 18 10.5a3 3 0 0 1 0 6H6a3 3 0 0 1 0-6z" fill="currentColor" opacity="0.9"/>
          <!-- rain drops heavy -->
          <line x1="7" y1="19" x2="6" y2="22" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.9"/>
          <line x1="10" y1="18.5" x2="9" y2="21.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.9"/>
          <line x1="13" y1="19" x2="12" y2="22" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.9"/>
          <line x1="16" y1="18.5" x2="15" y2="21.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.85"/>
          <!-- lightning bolt -->
          <path d="M12 11 L10.5 14.5 L12 14.5 L10.5 18 L14 13 L12.5 13 L14 11Z" fill="rgba(255,230,60,0.95)"/>
        </svg>`;
      } else if (h >= 80) {
        // Rất ẩm — giọt nước to, glow xanh nước biển
        humiClass = 'lbl-warn'; boxClass = 'box-humid-high';
        humiLabel = this._ct.humiHigh;
        humiSvg = `<svg viewBox="0 0 24 24" class="s-ico-svg anim-humi-high" width="24" height="24">
          <!-- large droplet -->
          <path d="M12 3 C12 3 5.5 10.5 5.5 14.5 A6.5 6.5 0 0 0 18.5 14.5 C18.5 10.5 12 3 12 3Z" fill="currentColor" opacity="0.9"/>
          <!-- shine -->
          <ellipse cx="9.5" cy="13" rx="1.2" ry="2" fill="rgba(255,255,255,0.22)" transform="rotate(-20 9.5 13)"/>
          <!-- inner fill level waves -->
          <path d="M6.5 15 Q9 13.5 12 15 Q15 16.5 17.5 15" stroke="rgba(255,255,255,0.25)" stroke-width="1" fill="none"/>
          <!-- overflow drops -->
          <circle cx="7" cy="20" r="1.2" fill="currentColor" opacity="0.7"/>
          <circle cx="12" cy="21.5" r="1" fill="currentColor" opacity="0.6"/>
          <circle cx="17" cy="20" r="1.2" fill="currentColor" opacity="0.7"/>
        </svg>`;
      } else if (h >= 70) {
        // Hơi ẩm — giọt nước vừa
        humiClass = 'lbl-caution'; boxClass = 'box-caution';
        humiLabel = this._ct.humiMid;
        humiSvg = `<svg viewBox="0 0 24 24" class="s-ico-svg anim-humi-mid" width="24" height="24">
          <path d="M12 4 C12 4 6 11 6 15 A6 6 0 0 0 18 15 C18 11 12 4 12 4Z" fill="currentColor" opacity="0.85"/>
          <ellipse cx="9.5" cy="13.5" rx="1.1" ry="1.8" fill="rgba(255,255,255,0.2)" transform="rotate(-20 9.5 13.5)"/>
          <path d="M7 15.5 Q9.5 14 12 15.5 Q14.5 17 17 15.5" stroke="rgba(255,255,255,0.22)" stroke-width="1" fill="none"/>
        </svg>`;
      } else if (h >= 50) {
        // Dễ chịu — giọt nước xanh nhạt tươi
        humiClass = 'lbl-ok'; boxClass = '';
        humiLabel = this._ct.humiOk;
        humiSvg = `<svg viewBox="0 0 24 24" class="s-ico-svg" width="24" height="24">
          <path d="M12 4 C12 4 6 11 6 15 A6 6 0 0 0 18 15 C18 11 12 4 12 4Z" fill="currentColor" opacity="0.8"/>
          <ellipse cx="9.5" cy="13.5" rx="1" ry="1.7" fill="rgba(255,255,255,0.25)" transform="rotate(-20 9.5 13.5)"/>
          <!-- check inside -->
          <path d="M9 15 L11 17 L15 12" stroke="rgba(255,255,255,0.7)" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
      } else if (h >= 35) {
        // Khô — giọt nhỏ, nứt
        humiClass = 'lbl-dry'; boxClass = 'box-dry';
        humiLabel = this._ct.humiDry;
        humiSvg = `<svg viewBox="0 0 24 24" class="s-ico-svg anim-humi-dry" width="24" height="24">
          <!-- small droplet with crack -->
          <path d="M12 5 C12 5 7 11.5 7 15 A5 5 0 0 0 17 15 C17 11.5 12 5 12 5Z" fill="currentColor" opacity="0.6"/>
          <!-- crack lines -->
          <path d="M11 11 L12.5 14 L11.5 16" stroke="rgba(255,180,60,0.8)" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          <!-- dry particles -->
          <circle cx="8" cy="19" r="0.8" fill="currentColor" opacity="0.4"/>
          <circle cx="16" cy="19.5" r="0.7" fill="currentColor" opacity="0.35"/>
        </svg>`;
      } else {
        // 🏜️ Rất khô — vết nứt đất, glow cam nâu
        humiClass = 'lbl-danger'; boxClass = 'box-very-dry';
        humiLabel = this._ct.humiVeryDry;
        humiSvg = `<svg viewBox="0 0 24 24" class="s-ico-svg anim-humi-vdry" width="24" height="24">
          <!-- cracked earth -->
          <path d="M2 18 L6 14 L9 17 L12 12 L15 16 L18 13 L22 17 L22 22 L2 22Z" fill="currentColor" opacity="0.7"/>
          <!-- crack lines on surface -->
          <path d="M5 14 L7 16 L6 18" stroke="rgba(255,140,20,0.9)" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M12 12 L13 15 L11.5 17" stroke="rgba(255,140,20,0.9)" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M17 13 L16 15.5 L18 17" stroke="rgba(255,140,20,0.8)" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          <!-- empty droplet outline -->
          <path d="M12 2 C12 2 8 7 8 9.5 A4 4 0 0 0 16 9.5 C16 7 12 2 12 2Z" fill="none" stroke="currentColor" stroke-width="1.3" opacity="0.5"/>
        </svg>`;
      }

      const icoEl = $('s-ico-humi');
      if (icoEl) icoEl.innerHTML = humiSvg;
      const lbl = $('s-humi-lbl');
      if (lbl) { lbl.textContent = humiLabel; lbl.className = 's-lbl ' + humiClass; }
      const box = $('s-box-humi');
      if (box) box.className = 's-box ' + boxClass;
    }

    if (door) {
      const open = door.state === 'on';
      const el = $('st-door');
      if (el) { el.textContent = open ? this._ct.doorOpen : this._ct.doorClosed; el.className = open ? 'st-on' : 'st-off'; }
      const badge = $('st-door-badge');
      if (badge) badge.style.display = open ? 'inline-flex' : 'none';
    }

    if (motion) {
      const detected = motion.state === 'on';
      const el = $('st-motion');
      if (el) { el.textContent = detected ? this._ct.motionYes : this._ct.motionNo; el.className = detected ? 'st-on' : 'st-off'; }
    }

    // power sensor → ocam card (ưu tiên ocam_power_entity, fallback về power_entity)
    const pwrEntity = this._state('ocamPower') || this._state('power');
    const pwr = pwrEntity;
    if (pwr) {
      const w = parseFloat(pwr.state) || 0;
      const el = $('pwr-val');
      if (el) el.textContent = `${Math.round(w)}W`;
      const fill = $('pwr-fill');
      if (fill) fill.style.width = Math.min(100, (w / 3000) * 100) + '%';
      const sub2 = this.shadowRoot.getElementById('sb-ocam');
      if (sub2 && this._isOn('ocam')) sub2.textContent = `${Math.round(w)}W · ON`;
    }
  }

  _updateCards() {
    const cfg    = this._config || {};
    const hidden = cfg.devices_hidden || [];
    const labels = cfg.devices_labels || {};
    const extras = cfg.devices_extra  || [];
    const all    = ['den','decor','rgb','hien','quat','ocam','tv','motion'];

    // Default cards
    all.forEach(id => {
      const card = this.shadowRoot.getElementById('cd-' + id);
      if (card) card.style.display = hidden.includes(id) ? 'none' : '';
      if (labels[id]) {
        const nameEl = card ? card.querySelector('.c-name') : null;
        if (nameEl) nameEl.textContent = labels[id];
      }
      if (!hidden.includes(id)) this._renderCard(id);
    });

    // Extra cards — simple on/off toggle + label update
    extras.forEach(d => {
      const id   = d.id;
      const card = this.shadowRoot.getElementById('cd-' + id);
      if (!card) return;
      const E   = this.ENTITIES;
      const eid = E[id];
      if (!eid || !this._hass) return;
      const state = this._hass.states[eid];
      const on    = state && (
        state.state === 'on' ||
        state.state === 'playing' ||
        state.state === 'paused' ||
        state.state === 'idle'
      );
      const col   = { den:'y', rgb:'r', quat:'c', tv:'b', sensor:'gr' }[d.type] || 'c';

      const tp = this.shadowRoot.getElementById('tp-' + id);
      const ir = this.shadowRoot.getElementById('ir-' + id);
      const ba = this.shadowRoot.getElementById('ba-' + id);
      const sb = this.shadowRoot.getElementById('sb-' + id);
      const cn = this.shadowRoot.getElementById('cn-' + id);

      const bgMap   = { y:'bg-y', r:'bg-r', c:'bg-c', b:'bg-b', gr:'bg-gr' };
      const ringMap = { y:'ry',   r:'rr',   c:'rc',   b:'rb',   gr:'rgr'   };
      const baMap   = { y:'ba-y', r:'ba-r', c:'ba-c', b:'ba-b', gr:'ba-gr' };
      const subMap  = { y:'sub-y',r:'sub-r',c:'sub-c',b:'sub-b',gr:'sub-gr'};

      if (tp) tp.className = 'top-h ' + (on ? bgMap[col]  : '');
      if (ir) ir.className = 'i-ring ' + (on ? ringMap[col]: '');
      if (ba) { ba.className = 'on-badge ' + (on ? baMap[col] : 'ba-off'); ba.textContent = on ? 'ON' : 'OFF'; }
      if (sb) { sb.className = 'c-sub '   + (on ? subMap[col]: 'sub-off'); sb.textContent = on ? 'ON' : 'OFF'; }
      if (cn) cn.textContent = labels[id] || d.label;
      if (card) card.className = 'dcard ' + (on ? 'on-' + col : '');

      // ── Type-specific visual updates ──────────────────────────────────────
      if (d.type === 'den') {
        // Brightness slider
        const pct = on ? (state.attributes.brightness != null ? Math.round(state.attributes.brightness / 2.55) : 100) : 0;
        if (!this._dragging || this._dragId !== id) this._setSliderById(id, pct, 'y');
        if (sb) sb.textContent = on ? 'ON' : 'OFF';
      } else if (d.type === 'rgb') {
        const eff = (state && state.attributes.effect) || this._ct.rgbBtnLabel;
        if (sb) { sb.style.display = 'none'; }
        const bot = this.shadowRoot.getElementById('rgb-bot-' + id);
        if (bot) { bot.style.opacity = on ? '1' : '0.3'; bot.style.pointerEvents = on ? 'auto' : 'none'; }
        // Update extra rgb-btn text & state
        const extraRgbBtn = this.shadowRoot.querySelector(`.extra-rgb-btn[data-rgb-id="${id}"]`);
        if (extraRgbBtn) {
          const span = extraRgbBtn.querySelector('.rgb-btn-text');
          if (span) span.textContent = on ? eff : this._ct.rgbBtnLabel;
          extraRgbBtn.classList.toggle('rgb-on', on);
        }
      } else if (d.type === 'quat') {
        const fanSvg = this.shadowRoot.getElementById('fan-svg-' + id);
        if (fanSvg) {
          fanSvg.style.animationPlayState = on ? 'running' : 'paused';
          fanSvg.classList.toggle('spin-a', true);
          fanSvg.style.color = on ? 'rgba(0,225,255,0.95)' : 'rgba(180,180,180,0.45)';
        }
        const spdBtn = this.shadowRoot.getElementById('spd-open-btn-' + id);
        if (spdBtn) { spdBtn.style.opacity = on ? '1' : '0.35'; spdBtn.style.pointerEvents = on ? 'auto' : 'none'; spdBtn.classList.toggle('fan-on', on); }
        if (sb) sb.textContent = on ? this._ct.fanRunning : 'OFF';
      } else if (d.type === 'tv') {
        if (sb) sb.textContent = on ? 'Playing' : 'OFF';
      } else if (d.type === 'ocam') {
        // Cập nhật power sensor cho extra ocam card
        const pwrKey = d.id + '_power_entity';
        const pwrEid = (this._config && this._config[pwrKey]) || null;
        const pwrState = pwrEid ? this._hass?.states[pwrEid] : null;
        if (pwrState) {
          const w = parseFloat(pwrState.state) || 0;
          const valEl  = this.shadowRoot.getElementById('pwr-val-' + id);
          const fillEl = this.shadowRoot.getElementById('pwr-fill-' + id);
          if (valEl)  valEl.textContent = Math.round(w) + 'W';
          if (fillEl) { fillEl.style.width = Math.min(100, (w / 3000) * 100) + '%'; fillEl.style.opacity = on ? '1' : '0.2'; }
          if (sb && on) sb.textContent = Math.round(w) + 'W · ON';
        }
        const bolt = this.shadowRoot.getElementById('ir-' + id)?.querySelector('.socket-bolt');
        if (bolt) bolt.style.opacity = on ? '0.9' : '0';
      }
    });
  }

  // ─── Per-card render ───────────────────────────────────────────────────────
  _renderCard(id) {
    const $ = sel => this.shadowRoot.getElementById(sel);
    const on = this._isOn(id);

    const COL = {
      den:'y', decor:'y', rgb:'r', hien:'or',
      quat:'c', ocam:'gr', tv:'b', motion:'pu'
    };
    const col = COL[id] || 'c';

    const bgMap  = {y:'bg-y',c:'bg-c',r:'bg-r',b:'bg-b',gr:'bg-gr',pu:'bg-pu',or:'bg-or'};
    const ringMap= {y:'ry', c:'rc', r:'rr', b:'rb', gr:'rgr',pu:'rpu',or:'ror'};
    const subMap = {y:'sub-y',c:'sub-c',r:'sub-r',b:'sub-b',gr:'sub-gr',pu:'sub-pu',or:'sub-or'};
    const baMap  = {y:'ba-y', c:'ba-c', r:'ba-r', b:'ba-b', gr:'ba-gr',pu:'ba-pu',or:'ba-or'};

    const tp = $('tp-'+id);
    const ir = $('ir-'+id);
    const ba = $('ba-'+id);
    const cd = $('cd-'+id);
    const sb = $('sb-'+id);

    if (!tp || !ir || !cd) return;

    tp.className = 'top-h ' + (on ? bgMap[col] : '');
    ir.className = 'i-ring ' + (on ? ringMap[col] : '');
    cd.className = 'dcard ' + (on ? 'on-'+col : '');

    // ── per-device logic ─────────────────────────────────────────────────────
    if (id === 'den') {
      const pct = on ? this._brightness('den') : 0;
      if (ba) { ba.className = 'on-badge ' + (on ? 'ba-y' : 'ba-off'); ba.textContent = on ? 'ON' : 'OFF'; }
      if (sb) { sb.className = 'c-sub ' + (on ? 'sub-y' : 'sub-off'); sb.textContent = on ? 'ON' : 'OFF'; }
      if (!this._dragging || this._dragId !== 'den') this._setSlider('den', pct);

      // bulb animation
      const denRing = $('ir-den');
      if (denRing) {
        denRing.classList.toggle('anim-bulb-on', on);
        const rays = denRing.querySelector('.bulb-rays');
        if (rays) rays.style.opacity = on ? '1' : '0';
        const fil = denRing.querySelector('.bulb-filament');
        if (fil) fil.setAttribute('stroke', on ? 'rgba(255,240,120,0.9)' : 'rgba(255,240,120,0.0)');
      }
    } else if (id === 'decor') {
      if (ba) { ba.className = 'on-badge ' + (on ? 'ba-y' : 'ba-off'); ba.textContent = on ? 'ON' : 'OFF'; }
      const sparks = $('ir-decor') && $('ir-decor').querySelector('.decor-sparks');
      if (sparks) sparks.style.opacity = on ? '1' : '0';
      // Nếu là light entity → hiển thị độ sáng; switch → ON/OFF
      const isDecorLight = (this.ENTITIES.decor || '').startsWith('light.');
      const pctDecor = isDecorLight ? this._brightness('decor') : (on ? 100 : 0);
      if (isDecorLight) {
        if (ba) { ba.className = 'on-badge ' + (on ? 'ba-y' : 'ba-off'); ba.textContent = on ? 'ON' : 'OFF'; }
        if (sb) { sb.className = 'c-sub ' + (on ? 'sub-y' : 'sub-off'); sb.textContent = on ? pctDecor + '%' : 'OFF'; }
        if (!this._dragging || this._dragId !== 'decor') this._setSlider('decor', pctDecor);
        const trDecor = $('tr-decor'); const trDummy = $('tr-decor-dummy');
        if (trDecor) { trDecor.style.opacity = ''; trDecor.style.pointerEvents = ''; }
        if (trDummy) trDummy.style.display = 'none';
      } else {
        if (sb) { sb.className = 'c-sub ' + (on ? 'sub-y' : 'sub-off'); sb.textContent = on ? 'ON' : 'OFF'; }
        const vlDecor = $('vl-decor');
        if (vlDecor) vlDecor.textContent = on ? 'ON' : 'OFF';
        const trDecor = $('tr-decor'); const trDummy = $('tr-decor-dummy');
        if (trDecor) trDecor.style.display = 'none';
        if (trDummy) { trDummy.style.display = ''; trDummy.style.opacity = '0.3'; trDummy.style.pointerEvents = 'none'; }
      }

    } else if (id === 'rgb') {
      if (ba) { ba.className = 'on-badge ' + (on ? 'ba-r' : 'ba-off'); ba.textContent = on ? 'ON' : 'OFF'; }
      if (sb) { sb.style.display = 'none'; }
      const bot = $('rgb-bot');
      if (bot) { bot.style.opacity = on ? '1' : '0.3'; bot.style.pointerEvents = on ? 'auto' : 'none'; }
      // Update rgb-btn text & state
      const rgbBtnEl = this.shadowRoot.querySelector('.rgb-btn:not(.extra-rgb-btn)');
      if (rgbBtnEl) {
        const eff2 = this._attr('rgb','effect') || this._ct.rgbBtnLabel;
        const span = rgbBtnEl.querySelector('.rgb-btn-text');
        if (span) span.textContent = on ? eff2 : this._ct.rgbBtnLabel;
        rgbBtnEl.classList.toggle('rgb-on', on);
      }

    } else if (id === 'hien') {
      if (ba) { ba.className = 'on-badge ' + (on ? 'ba-or' : 'ba-off'); ba.textContent = on ? 'ON' : 'OFF'; }
      const hienRing = $('ir-hien');
      if (hienRing) {
        hienRing.classList.toggle('anim-hien-on', on);
        const inner = hienRing.querySelector('.hien-inner');
        if (inner) inner.setAttribute('fill', on ? 'rgba(255,200,80,0.35)' : 'rgba(255,200,80,0.0)');
      }
      // Nếu là light entity → hiển thị độ sáng và slider; switch → ON/OFF
      const isHienLight = (this.ENTITIES.hien || '').startsWith('light.');
      const pctHien = isHienLight ? this._brightness('hien') : (on ? 100 : 0);
      if (isHienLight) {
        if (sb) { sb.className = 'c-sub ' + (on ? 'sub-or' : 'sub-off'); sb.textContent = on ? pctHien + '%' : 'OFF'; }
        if (!this._dragging || this._dragId !== 'hien') this._setSlider('hien', pctHien);
        const trHien = $('tr-hien'); const trDummy = $('tr-hien-dummy');
        if (trHien) { trHien.style.opacity = ''; trHien.style.pointerEvents = ''; }
        if (trDummy) trDummy.style.display = 'none';
      } else {
        if (sb) { sb.className = 'c-sub ' + (on ? 'sub-or' : 'sub-off'); sb.textContent = on ? 'ON' : 'OFF'; }
        const vlHien = $('vl-hien');
        if (vlHien) vlHien.textContent = on ? 'ON' : 'OFF';
        const trHien = $('tr-hien'); const trDummy = $('tr-hien-dummy');
        if (trHien) trHien.style.display = 'none';
        if (trDummy) { trDummy.style.display = ''; trDummy.style.opacity = '0.3'; trDummy.style.pointerEvents = 'none'; }
      }

    } else if (id === 'quat') {
      if (ba) { ba.className = 'on-badge ' + (on ? 'ba-c' : 'ba-off'); ba.textContent = on ? 'ON' : 'OFF'; }
      if (sb) { sb.className = 'c-sub ' + (on ? 'sub-c' : 'sub-off'); sb.textContent = on ? this._ct.fanRunning : 'OFF'; }
      const fanSvg = $('fan-svg');
      if (fanSvg) {
        fanSvg.style.animationPlayState = on ? 'running' : 'paused';
        fanSvg.classList.toggle('spin-a', true); // always has class, playstate controls it
        // color: cyan when on, grey when off
        fanSvg.style.color = on ? 'rgba(0,225,255,0.95)' : 'rgba(180,180,180,0.45)';
      }
      const spdBtn = this.shadowRoot.getElementById('spd-open-btn');
      if (spdBtn) {
        spdBtn.style.opacity = on ? '1' : '0.35';
        spdBtn.style.pointerEvents = on ? 'auto' : 'none';
        spdBtn.classList.toggle('fan-on', on);
      }
      this.shadowRoot.querySelectorAll('.spd-btn').forEach(b => {
        b.style.opacity = on ? '1' : '0.3';
        b.style.pointerEvents = on ? 'auto' : 'none';
      });

    } else if (id === 'ocam') {
      if (ba) { ba.className = 'on-badge ' + (on ? 'ba-gr' : 'ba-off'); ba.textContent = on ? 'ON' : 'OFF'; }
      if (sb) { sb.className = 'c-sub ' + (on ? 'sub-gr' : 'sub-off'); sb.textContent = on ? 'ON' : 'OFF'; }
      const fill = $('pwr-fill');
      if (fill) fill.style.opacity = on ? '1' : '0.2';
      const bolt = $('ir-ocam') && $('ir-ocam').querySelector('.socket-bolt');
      if (bolt) bolt.style.opacity = on ? '0.9' : '0';
    } else if (id === 'tv') {
      if (ba) { ba.className = 'on-badge ' + (on ? 'ba-b' : 'ba-off'); ba.textContent = on ? 'ON' : 'OFF'; }
      if (sb) { sb.className = 'c-sub ' + (on ? 'sub-b' : 'sub-off'); sb.textContent = on ? 'Playing' : 'OFF'; }
      const tvRing = $('ir-tv');
      if (tvRing) {
        const content = tvRing.querySelector('.tv-content');
        if (content) content.style.opacity = on ? '1' : '0';
        const scan = tvRing.querySelector('.tv-scan');
        if (scan) {
          scan.style.fill = on ? 'rgba(120,200,255,0.5)' : 'rgba(120,200,255,0)';
          scan.style.animation = on ? 'tvScan 2.5s linear infinite' : 'none';
        }
        const screenBg = tvRing.querySelector('.tv-screen-bg');
        if (screenBg) screenBg.style.opacity = on ? '0.35' : '0.1';
        const powerDot = tvRing.querySelector('.tv-power-dot');
        if (powerDot) powerDot.style.fill = on ? 'rgba(0,230,120,0.9)' : 'rgba(255,80,80,0.6)';
      }

    } else if (id === 'motion') {
      const detected = this._isOn('motion');
      if (ba) { ba.className = 'on-badge ' + (detected ? 'ba-pu' : 'ba-off'); ba.textContent = detected ? 'ACTIVE' : 'OFF'; }
      if (sb) { sb.className = 'c-sub ' + (detected ? 'sub-pu' : 'sub-off'); sb.textContent = detected ? this._ct.motionYes : this._ct.motionNo; }
      tp.style.cursor = 'default';
      // animate stick figure
      const motionSvg = $('motion-svg');
      if (motionSvg) {
        motionSvg.classList.toggle('anim-motion-walk', detected);
        const arcs = motionSvg.querySelector('.motion-arcs');
        if (arcs) arcs.style.opacity = detected ? '1' : '0';
        // raise arm when detected
        const armR = motionSvg.querySelector('#arm-r');
        if (armR) {
          armR.setAttribute('x2', detected ? '16.5' : '15.5');
          armR.setAttribute('y2', detected ? '6' : '7');
        }
        // color shift: purple/active vs grey
        motionSvg.style.color = detected ? 'rgba(200,120,255,0.95)' : 'rgba(160,160,180,0.45)';

        // Người chào lại (SVG to bên dưới bot-h) — hiện/ẩn theo detected
        const greeter = this.shadowRoot.getElementById('motion-greeter');
        if (greeter) {
          greeter.style.opacity = detected ? '1' : '0';
          const gArmL = greeter.querySelector('#g-arm-l');
          if (gArmL) {
            gArmL.style.animation = detected ? 'greeterWave 0.65s ease-in-out infinite' : '';
          }
        }
      }
      const msEl = this.shadowRoot.getElementById('motion-status');
      if (msEl) msEl.textContent = detected ? this._ct.motionYes : this._ct.motionNo;
    }
  }

  _setSlider(id, pct) {
    const $ = sel => this.shadowRoot.getElementById(sel);
    const fl = $('fl-'+id), th = $('th-'+id), vl = $('vl-'+id);
    if (fl) fl.style.width = pct + '%';
    if (th) th.style.left = pct + '%';
    if (vl) vl.textContent = pct + '%';
    // bright-bar (đèn chính dùng id tr-den→fl-den)
  }

  // Slider cho extra cards — không thay fill class (truyền vào)
  _setSliderById(id, pct, fillCol) {
    const $ = sel => this.shadowRoot.getElementById(sel);
    const fl = $('fl-'+id), th = $('th-'+id), vl = $('vl-'+id);
    if (fl) fl.style.width = pct + '%';
    if (th) th.style.left  = pct + '%';
    if (vl) vl.textContent = pct + '%';
  }

  // Bind click-to-toggle for extra (user-added) device cards
  _bindExtraCardEvents() {
    const extras = (this._config && this._config.devices_extra) || [];
    const E = this.ENTITIES;

    extras.forEach(d => {
      const id  = d.id;
      const tp  = this.shadowRoot.getElementById('tp-' + id);
      if (!tp) return;

      // Clone tp để xóa listener cũ tránh nhân đôi
      const fresh = tp.cloneNode(true);
      tp.parentNode.replaceChild(fresh, tp);
      fresh.style.cursor = 'pointer';
      fresh.addEventListener('click', () => {
        const eid = E[id];
        if (!eid || !this._hass) return;
        const domain = eid.split('.')[0];
        // switch/fan: hiện popup xác nhận tránh ấn nhầm; còn lại toggle thẳng
        if (d.type === 'ocam') {
          this._toggleWithConfirm(eid, d.label || id);
        } else {
          this._toggle(eid);
        }
      });

      // ── Quạt: bind popup tốc độ ─────────────────────────────────────────
      if (d.type === 'quat') {
        const spdBtn    = this.shadowRoot.getElementById('spd-open-btn-' + id);
        const overlay   = this.shadowRoot.getElementById('spd-popup-overlay-' + id);
        const sheet     = this.shadowRoot.getElementById('spd-popup-sheet-' + id);
        if (spdBtn && overlay && sheet) {
          const openPop = () => {
            overlay.style.display = 'flex';
            requestAnimationFrame(() => {
              overlay.classList.add('spd-visible');
              sheet.classList.add('spd-visible');
            });
            this.shadowRoot.querySelectorAll(`[data-fan-id="${id}"].extra-spd-level`).forEach(b => {
              b.classList.toggle('act', b.dataset.s === String(this['_fanSpeed_' + id] || 2));
            });
          };
          const closePop = () => {
            overlay.classList.remove('spd-visible');
            sheet.classList.remove('spd-visible');
            setTimeout(() => { overlay.style.display = 'none'; }, 280);
          };
          // Clone to remove old listeners
          const freshSpd = spdBtn.cloneNode(true);
          spdBtn.parentNode.replaceChild(freshSpd, spdBtn);
          freshSpd.addEventListener('click', e => { e.stopPropagation(); openPop(); });
          overlay.addEventListener('click', e => { if (e.target === overlay) closePop(); });

          this.shadowRoot.querySelectorAll(`[data-fan-id="${id}"].extra-spd-level`).forEach(b => {
            b.addEventListener('click', e => {
              e.stopPropagation();
              const s = parseInt(b.dataset.s);
              this['_fanSpeed_' + id] = s;
              this.shadowRoot.querySelectorAll(`[data-fan-id="${id}"].extra-spd-level`).forEach(x => x.classList.toggle('act', x.dataset.s === String(s)));
              const vl = this.shadowRoot.getElementById('vl-' + id);
              if (vl) vl.textContent = s;
              const eid = E[id];
              if (eid && this._hass) {
                const eDomain = eid.split('.')[0];
                if (eDomain === 'fan') this._hass.callService('fan', 'set_percentage', { entity_id: eid, percentage: s * 20 });
                else this._toggle(eid);
              }
              setTimeout(() => closePop(), 200);
            });
          });
        }
      }

      // ── Đèn light (den): bind brightness slider ──────────────────────────
      if (d.type === 'den') {
        const track = this.shadowRoot.getElementById('tr-' + id);
        if (track) {
          const onDrag = e => {
            const rect = track.getBoundingClientRect();
            const x    = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
            const pct  = Math.max(0, Math.min(100, Math.round((x / rect.width) * 100)));
            this._dragging = true; this._dragId = id;
            this._setSliderById(id, pct, 'y');
          };
          const onUp = e => {
            if (!this._dragging || this._dragId !== id) return;
            const rect = track.getBoundingClientRect();
            const cx   = (e.changedTouches ? e.changedTouches[0].clientX : e.clientX) - rect.left;
            const pct  = Math.max(0, Math.min(100, Math.round((cx / rect.width) * 100)));
            this._dragging = false; this._dragId = null;
            const eid  = E[id];
            if (eid && this._hass) this._hass.callService('light', 'turn_on', { entity_id: eid, brightness: Math.round(pct * 2.55) });
          };
          track.addEventListener('mousedown',  onDrag);
          track.addEventListener('mousemove',  e => { if (this._dragging && this._dragId === id) onDrag(e); });
          track.addEventListener('mouseup',    onUp);
          track.addEventListener('touchstart', onDrag, { passive: true });
          track.addEventListener('touchmove',  e => { if (this._dragging && this._dragId === id) onDrag(e); }, { passive: true });
          track.addEventListener('touchend',   onUp);
        }
      }

      // ── RGB: nút Effect & Màu mở RGB modal chung ────────────────────────
      if (d.type === 'rgb') {
        const rgbBtn = this.shadowRoot.querySelector(`.extra-rgb-btn[data-rgb-id="${id}"]`);
        if (rgbBtn) {
          rgbBtn.addEventListener('click', e => {
            e.stopPropagation();
            // Lưu id để RGB modal biết entity nào đang được điều khiển
            this._activeRgbId = id;
            // Tìm overlay — có thể đã mount ra body
            const overlay = this['_overlay_rgb-modal-overlay']
              || this.shadowRoot.getElementById('rgb-modal-overlay')
              || document.getElementById('rgb-modal-overlay');
            const sheet = overlay ? overlay.querySelector('#rgb-modal-sheet, .rgb-modal-sheet') : null;
            if (overlay) {
              overlay.style.display = 'flex';
              requestAnimationFrame(() => {
                overlay.classList.add('visible');
                if (sheet) sheet.classList.add('visible');
              });
            }
            // Render effect_list từ attributes của entity vừa chọn
            const eid = this.ENTITIES[id];
            this._refreshEffectList(eid);
          });
        }
      }
    });
  }

  // ─── Event binding ─────────────────────────────────────────────────────────
  _scrollActions() {
    const inner = this.shadowRoot.getElementById('auto-actions-inner');
    if (!inner) return;
    const items = inner.querySelectorAll('.auto-action-item');
    if (items.length <= 1) return;
    this._actionScrollIdx = ((this._actionScrollIdx || 0) + 1) % items.length;
    const h = items[0].offsetHeight || 18;
    inner.style.transform = `translateY(-${this._actionScrollIdx * h}px)`;
  }

  _bindEvents() {
    const $ = sel => this._getEl(sel);
    const E = this.ENTITIES;

    // Toggle top-half clicks
    // Light entity: toggle trực tiếp; switch/fan: hiện popup xác nhận tránh ấn nhầm
    const toggleMap = {
      'tp-den':   () => this._toggle(E.den),
      'tp-decor': () => this._toggle(E.decor),
      'tp-rgb':   () => this._toggle(E.rgb),
      'tp-hien':  () => this._toggle(E.hien),
      'tp-quat':  () => this._toggle(E.quat),
      'tp-ocam':  () => this._toggleWithConfirm(E.ocam, this._ct.chipOcam),
      // motion & tv: no toggle
    };
    Object.entries(toggleMap).forEach(([id, fn]) => {
      const el = $(id);
      if (el) el.addEventListener('click', fn);
    });

    // Brightness slider — den
    this._bindSlider('den', pct => this._setBrightness(E.den, pct));
    // Brightness slider — decor & hien (only active when entity is a light)
    this._bindSlider('decor', pct => { if ((E.decor||'').startsWith('light.')) this._setBrightness(E.decor, pct); });
    this._bindSlider('hien',  pct => { if ((E.hien||'').startsWith('light.'))  this._setBrightness(E.hien, pct); });

    // ── Speed popup ───────────────────────────────────────────────────────────
    const spdOpenBtn  = $('spd-open-btn');
    const spdOverlay  = $('spd-popup-overlay');
    const spdSheet    = $('spd-popup-sheet');
    const openSpdPopup = () => {
      if (!spdOverlay) return;
      spdOverlay.style.display = 'flex';
      requestAnimationFrame(() => {
        spdOverlay.classList.add('spd-visible');
        spdSheet.classList.add('spd-visible');
      });
      // Mark active speed
      this.shadowRoot.querySelectorAll('.spd-btn').forEach(b => {
        b.classList.toggle('act', b.dataset.s === String(this._fanSpeed || 2));
      });
    };
    const closeSpdPopup = () => {
      if (!spdOverlay) return;
      spdOverlay.classList.remove('spd-visible');
      spdSheet.classList.remove('spd-visible');
      setTimeout(() => { spdOverlay.style.display = 'none'; }, 280);
    };
    if (spdOpenBtn) spdOpenBtn.addEventListener('click', e => { e.stopPropagation(); openSpdPopup(); });
    if (spdOverlay) spdOverlay.addEventListener('click', e => { if (e.target === spdOverlay) closeSpdPopup(); });
    this.shadowRoot.querySelectorAll('.spd-btn').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        const s = parseInt(b.dataset.s);
        this._fanSpeed = s;
        this.shadowRoot.querySelectorAll('.spd-btn').forEach(x => x.classList.toggle('act', x.dataset.s === String(s)));
        const vl = $('vl-quat');
        if (vl) vl.textContent = s;
        // Call HA service — fan.set_percentage nếu fan entity, không thì toggle switch
        const quatDomain = (E.quat||'').split('.')[0];
        if (quatDomain === 'fan') {
          this._hass.callService('fan', 'set_percentage', { entity_id: E.quat, percentage: s * 20 });
        } else {
          this._toggle(E.quat);
        }
        setTimeout(() => closeSpdPopup(), 200);
      });
    });

    // RGB Modal
    const rgbBtn = this.shadowRoot.querySelector('.rgb-btn');
    const overlay = $('rgb-modal-overlay');
    const sheet   = $('rgb-modal-sheet');
    const openModal = () => {
      if (!overlay) return;
      overlay.style.display = 'flex';
      requestAnimationFrame(() => {
        overlay.classList.add('visible');
        sheet.classList.add('visible');
      });
      // Lấy entity đang active (rgb-btn chính → E.rgb)
      const E = this.ENTITIES;
      const activeEid = (this._activeRgbId && E[this._activeRgbId]) ? E[this._activeRgbId] : E.rgb;
      // Render effect_list từ attributes của entity, bao gồm mark & scroll
      this._refreshEffectList(activeEid);
    };
    const closeModal = () => {
      if (!overlay) return;
      overlay.classList.remove('visible');
      sheet.classList.remove('visible');
      setTimeout(() => { overlay.style.display = 'none'; }, 300);
    };
    if (rgbBtn) rgbBtn.addEventListener('click', e => {
      e.stopPropagation();
      this._activeRgbId = null; // reset về entity rgb mặc định
      openModal();
    });
    const closeBtn = $('rgb-modal-close');
    if (closeBtn) closeBtn.addEventListener('click', e => { e.stopPropagation(); closeModal(); });
    if (overlay) overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

    // Swatches màu
    this.shadowRoot.querySelectorAll('.bsw').forEach(sw => {
      sw.addEventListener('click', () => this._applyColor(sw.dataset.c));
    });
    // Effect list items — binding is handled dynamically by _refreshEffectList()
    const ccp = $('ccp');
    if (ccp) ccp.addEventListener('input', e => { e.stopPropagation(); this._applyColor(ccp.value); });

    // ── TV Remote Modal ────────────────────────────────────────────────────────
    const tvRemoteBtn   = $('tv-remote-btn');
    const tvOverlay     = $('tv-modal-overlay');
    const tvSheet       = $('tv-modal-sheet');
    const openTvModal   = () => {
      if (!tvOverlay) return;
      tvOverlay.style.display = 'flex';
      requestAnimationFrame(() => {
        tvOverlay.classList.add('tv-visible');
        if (tvSheet) tvSheet.classList.add('tv-visible');
      });
      this._updateTvStatus();
    };
    const closeTvModal  = () => {
      if (!tvOverlay) return;
      tvOverlay.classList.remove('tv-visible');
      if (tvSheet) tvSheet.classList.remove('tv-visible');
      setTimeout(() => { tvOverlay.style.display = 'none'; }, 300);
    };
    if (tvRemoteBtn) tvRemoteBtn.addEventListener('click', e => { e.stopPropagation(); openTvModal(); });
    const tvClose = $('tv-modal-close');
    if (tvClose) tvClose.addEventListener('click', e => { e.stopPropagation(); closeTvModal(); });
    if (tvOverlay) tvOverlay.addEventListener('click', e => { if (e.target === tvOverlay) closeTvModal(); });

    // TV remote button bindings
    const tvCmd = (cmd) => {
      const E = this.ENTITIES;
      if (E.tvRemote) this._hass.callService('remote', 'send_command', { entity_id: E.tvRemote, command: cmd });
    };
    const tvSvc = (svc, data) => {
      const E = this.ENTITIES;
      const domain = svc.split('.')[0];
      const service = svc.split('.')[1];
      this._hass.callService(domain, service, { entity_id: E.tvRemote, ...data });
    };
    const tvMap = {
      'tv-btn-power':   () => { const E=this.ENTITIES; if(E.tvRemote) this._hass.callService('remote','toggle',{entity_id:E.tvRemote}); },
      'tv-btn-mute':    () => tvCmd('KEY_MUTE'),
      'tv-btn-vol-down':() => { const E=this.ENTITIES; if(E.tv) this._hass.callService('media_player','volume_down',{entity_id:E.tv}); },
      'tv-btn-vol-up':  () => { const E=this.ENTITIES; if(E.tv) this._hass.callService('media_player','volume_up',{entity_id:E.tv}); },
      'tv-btn-home':    () => tvCmd('KEY_HOME'),
      'tv-btn-menu':    () => tvCmd('KEY_MENU'),
      'tv-btn-back':    () => tvCmd('KEY_RETURN'),
      'tv-btn-input':   () => tvCmd('KEY_SOURCE'),
      'tv-btn-up':      () => tvCmd('KEY_UP'),
      'tv-btn-down':    () => tvCmd('KEY_DOWN'),
      'tv-btn-left':    () => tvCmd('KEY_LEFT'),
      'tv-btn-right':   () => tvCmd('KEY_RIGHT'),
      'tv-btn-ok':      () => tvCmd('KEY_ENTER'),
    };
    Object.entries(tvMap).forEach(([id, fn]) => {
      const el = $(id);
      if (el) el.addEventListener('click', e => { e.stopPropagation(); fn(); });
    });

    // ── Mouse drag-to-scroll for .dev-row (desktop) ──────────────────────────
    const devRow = this.shadowRoot.querySelector('.dev-row');
    if (devRow) {
      let isDown = false;
      let startX = 0;
      let scrollLeft = 0;

      devRow.addEventListener('mousedown', e => {
        // Ignore if clicking on interactive elements
        if (e.target.closest('.track, button, input')) return;
        isDown = true;
        devRow.style.cursor = 'grabbing';
        startX = e.pageX - devRow.offsetLeft;
        scrollLeft = devRow.scrollLeft;
        e.preventDefault();
      });

      window.addEventListener('mouseup', () => {
        if (!isDown) return;
        isDown = false;
        devRow.style.cursor = '';
      });

      window.addEventListener('mousemove', e => {
        if (!isDown) return;
        const x = e.pageX - devRow.offsetLeft;
        const walk = (x - startX) * 1.2;
        devRow.scrollLeft = scrollLeft - walk;
      });

      // Also support mousewheel horizontal scroll on desktop
      devRow.addEventListener('wheel', e => {
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // already horizontal
        e.preventDefault();
        devRow.scrollLeft += e.deltaY;
      }, { passive: false });
    }

    // ── Manual / Auto mode buttons ────────────────────────────────────────────
    const btnManual = $('btn-manual');
    const btnAutoMode = $('btn-auto-mode');
    if (btnManual) btnManual.addEventListener('click', () => {
      this._autoMode = false;
      if (this._useIntegration) {
        // Ghi lên integration switch entity — server tự xử lý
        this._writeAutoModeToIntegration(false);
      } else if (this._useHelpers) {
        this._writeAutoModeToHelper(false);
      } else {
        localStorage.setItem(this._lsKeyMode, '0');
      }
      this._autoEngineStop();
      if (this._autoCountdownRotate) { clearInterval(this._autoCountdownRotate); this._autoCountdownRotate = null; }
      if (this._hintScrollTimer) { clearInterval(this._hintScrollTimer); this._hintScrollTimer = null; }
      if (this._offScrollTimer)  { clearInterval(this._offScrollTimer);  this._offScrollTimer  = null; }
      this._syncModeButtonUI();
      this._updateHeader();
    });
    if (btnAutoMode) btnAutoMode.addEventListener('click', async () => {
      this._autoMode = true;
      if (this._useIntegration) {
        // Set flag TRƯỚC mọi async call để hass setter không reset _autoMode
        this._integrationPending = true;
        this._integrationPendingTarget = true;
        console.log('[HASmartRoom] AUTO btn: pending=true, switch=', this._intAutoSwitchId());
        // Đảm bảo phòng đã đăng ký với integration trước khi ghi switch
        await this._registerWithIntegration();
        console.log('[HASmartRoom] AUTO btn: registered, writing switch ON');
        // Cập nhật delay trước, sau đó bật switch
        const delayMin = (this._config && this._config.auto_delay_min) || 5;
        if (this._hass) {
          this._hass.callService('number', 'set_value', {
            entity_id: this._intDelayNumberId(),
            value: delayMin,
          });
        }
        await this._writeAutoModeToIntegration(true);
        console.log('[HASmartRoom] AUTO btn: switch write done, pending=', this._integrationPending);
      } else if (this._useHelpers) {
        this._writeAutoModeToHelper(true);
      } else {
        localStorage.setItem(this._lsKeyMode, '1');
      }
      this._hintScrollIdx = 0;
      this._offScrollIdx = 0;
      this._autoCountdownIdx = 0;
      this._autoFired = false;
      this._localMotionSince = null;
      this._clearNoMotionSince();
      if (this._autoCountdownRotate) { clearInterval(this._autoCountdownRotate); this._autoCountdownRotate = null; }
      if (this._hintScrollTimer) { clearInterval(this._hintScrollTimer); this._hintScrollTimer = null; }
      if (this._offScrollTimer)  { clearInterval(this._offScrollTimer);  this._offScrollTimer  = null; }
      this._autoEngineStart();
      this._syncModeButtonUI();
      this._updateHeader();
    });
    this._syncModeButtonUI();

    // ── Settings button ───────────────────────────────────────────────────────
    const btnSettings = $('btn-settings');
    if (btnSettings) btnSettings.addEventListener('click', () => {
      const panel = $('auto-settings-panel');
      if (!panel) return;
      const isOpen = panel.style.display !== 'none';
      panel.style.display = isOpen ? 'none' : 'block';
      btnSettings.classList.toggle('asp-open', !isOpen);
      if (!isOpen) this._renderSettingsPanel();
    });

    // ── Settings panel: minus / plus ──────────────────────────────────────────
    const aspMinus = $('asp-minus');
    const aspPlus  = $('asp-plus');
    if (aspMinus) aspMinus.addEventListener('click', () => {
      const cur = parseInt((this._config && this._config.auto_delay_min) || 5, 10);
      const val = Math.max(1, cur - 1);
      this._aspSetDelay(val);
    });
    if (aspPlus) aspPlus.addEventListener('click', () => {
      const cur = parseInt((this._config && this._config.auto_delay_min) || 5, 10);
      const val = Math.min(120, cur + 1);
      this._aspSetDelay(val);
    });
  }

  // ─── Render settings panel chip list ──────────────────────────────────────
  _renderSettingsPanel() {
    const panel = this.shadowRoot && this.shadowRoot.getElementById('auto-settings-panel');
    if (!panel) return;
    const cfg = this._config || {};
    const E   = this.ENTITIES;

    // Cập nhật số phút
    const valEl = this.shadowRoot.getElementById('asp-delay-val');
    if (valEl) valEl.textContent = cfg.auto_delay_min || 5;

    // Build device list trực tiếp từ ENTITIES đã cấu hình
    // (không dùng _getDeviceList vì method đó chỉ có trong editor class)
    const EXCLUDE_TYPES = ['tv', 'sensor'];
    const ALL_DEVS = [
      { id: 'den',    label: '💡 Đèn Chính', type: 'den',    entityKey: 'den_entity'    },
      { id: 'decor',  label: '✨ Đèn Decor',  type: 'den',    entityKey: 'decor_entity'  },
      { id: 'hien',   label: '🏮 Đèn Hiên',  type: 'den',    entityKey: 'hien_entity'   },
      { id: 'rgb',    label: '🌈 Đèn RGB',   type: 'rgb',    entityKey: 'rgb_entity'    },
      { id: 'quat',   label: '🌀 Quạt Trần', type: 'quat',   entityKey: 'quat_entity'   },
      { id: 'ocam',   label: '🔌 Ổ Cắm',    type: 'ocam',   entityKey: 'ocam_entity'   },
      { id: 'ac',     label: '❄️ Điều Hòa',  type: 'climate',entityKey: 'ac_entity'     },
    ];

    // Lấy label tuỳ chỉnh từ config nếu có
    const labels  = cfg.devices_labels || {};
    // Lọc: chỉ hiện thiết bị đã được cấu hình entity (có trong ENTITIES hoặc config)
    // và không thuộc loại bị loại trừ
    const devList = ALL_DEVS.filter(d => {
      if (EXCLUDE_TYPES.includes(d.type)) return false;
      return !!(E[d.id] || cfg[d.entityKey]);
    }).map(d => ({ ...d, label: labels[d.id] || d.label }));

    // Thêm extra devices đã cấu hình (loại trừ tv/sensor)
    const extras = cfg.devices_extra || [];
    extras.forEach(d => {
      if (EXCLUDE_TYPES.includes(d.type)) return;
      if (E[d.id] || cfg[d.entityKey || (d.id + '_entity')]) {
        devList.push({ id: d.id, label: d.label || d.id, type: d.type });
      }
    });

    // Nếu không có thiết bị nào được cấu hình, hiện toàn bộ danh sách mặc định
    const finalList = devList.length > 0 ? devList : ALL_DEVS;
    const defaultIds = finalList.map(d => d.id);
    const autoList   = cfg.auto_off_entities || defaultIds;

    const listEl = this.shadowRoot.getElementById('asp-dev-list');
    if (!listEl) return;
    listEl.innerHTML = finalList.map(d => {
      const on = autoList.includes(d.id) ? 'on' : '';
      return `<div class="asp-dev-chip ${on}" data-id="${d.id}">${d.label}</div>`;
    }).join('');

    // Bind chip click
    listEl.querySelectorAll('.asp-dev-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const id = chip.dataset.id;
        const cur = [...((this._config && this._config.auto_off_entities) || defaultIds)];
        const updated = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
        this._config = { ...this._config, auto_off_entities: updated };
        chip.classList.toggle('on', updated.includes(id));
        this._aspSaveConfig();
      });
    });
  }

  _aspSetDelay(val) {
    this._config = { ...this._config, auto_delay_min: val };
    const valEl = this.shadowRoot && this.shadowRoot.getElementById('asp-delay-val');
    if (valEl) valEl.textContent = val;
    this._aspSaveConfig();
  }

  _aspSaveConfig() {
    // Nếu integration mode: cập nhật số phút lên HA entity + re-register
    if (this._useIntegration && this._hass) {
      const delayMin = parseInt((this._config && this._config.auto_delay_min) || 5, 10);
      // Cập nhật number entity trên HA
      this._hass.callService('number', 'set_value', {
        entity_id: this._intDelayNumberId(),
        value: delayMin,
      }).catch(() => {});
      // Re-register để sync device_entities mới
      this._registerWithIntegration();
    }
    // Lưu cấu hình card (fire config-changed cho HA lưu vào dashboard)
    if (this._rendered) {
      this.dispatchEvent(new CustomEvent('config-changed', {
        detail: { config: this._config }, bubbles: true, composed: true,
      }));
    }
  }

  _bindSlider(id, onCommit) {
    const tr = this.shadowRoot.getElementById('tr-'+id);
    if (!tr) return;

    const move = e => {
      if (!this._dragging || this._dragId !== id) return;
      if (e.cancelable) e.preventDefault();
      const rect = tr.getBoundingClientRect();
      const cx = e.touches ? e.touches[0].clientX : e.clientX;
      const pct = Math.round(Math.min(100, Math.max(0, ((cx - rect.left) / rect.width) * 100)));
      this._setSlider(id, pct);
      this._pendingVal = pct;
    };

    const stop = () => {
      if (!this._dragging || this._dragId !== id) return;
      this._dragging = false;
      this._dragId = null;
      if (this._pendingVal != null) { onCommit(this._pendingVal); this._pendingVal = null; }
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', stop);
    };

    tr.addEventListener('mousedown', e => {
      e.stopPropagation();
      this._dragging = true; this._dragId = id;
      move(e);
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', stop);
    });
    tr.addEventListener('touchstart', e => {
      e.stopPropagation();
      this._dragging = true; this._dragId = id;
      move(e);
      window.addEventListener('touchmove', move, { passive: false });
      window.addEventListener('touchend', stop);
    });
  }

  _applyColor(hex) {
    this._rgbColor = hex;
    const $ = id => this.shadowRoot.getElementById(id);
    if ($('cur-dot'))  $('cur-dot').style.background = hex;
    if ($('hex-lbl'))  $('hex-lbl').textContent = hex;
    if ($('ccp'))      $('ccp').value = hex;
    this.shadowRoot.querySelectorAll('.csw').forEach(s => s.classList.toggle('act', s.dataset.c === hex));
    this.shadowRoot.querySelectorAll('.bsw').forEach(s => s.classList.toggle('act', s.dataset.c === hex));
    const ir = $('ir-rgb');
    if (ir) { ir.style.borderColor = hex + 'aa'; ir.style.background = hex + '28'; }
    // call HA
    const E = this.ENTITIES;
    const rgbEid = (this._activeRgbId && E[this._activeRgbId]) ? E[this._activeRgbId] : E.rgb;
    if (rgbEid) this._callService('light', 'turn_on', { entity_id: rgbEid, rgb_color: this._hexToRgb(hex) });
  }

  _pickEffect(el) {
    // Tìm ef-list trong overlay (có thể đã mount ra body)
    const overlay = this['_overlay_rgb-modal-overlay']
      || this.shadowRoot.getElementById('rgb-modal-overlay')
      || document.getElementById('rgb-modal-overlay');
    const efList = overlay ? overlay.querySelector('#rgb-ef-list') : null;
    if (efList) {
      efList.querySelectorAll('.rgb-ef-item').forEach(b => b.classList.remove('act'));
    } else {
      this.shadowRoot.querySelectorAll('.rgb-ef-item').forEach(b => b.classList.remove('act'));
    }
    el.classList.add('act');
    this._rgbEffect = el.dataset.ef;
    const sub = this.shadowRoot.getElementById('sb-rgb');
    if (sub) sub.textContent = el.dataset.ef === 'None' ? this._ct.rbEffectColor : el.dataset.ef;
    // Update rgb-btn text (truncated span)
    const activeId = this._activeRgbId;
    if (activeId) {
      const extraBtn = this.shadowRoot.querySelector(`.extra-rgb-btn[data-rgb-id="${activeId}"]`);
      if (extraBtn) {
        const span = extraBtn.querySelector('.rgb-btn-text');
        const label = el.dataset.ef === 'None' ? this._ct.rgbBtnLabel : el.dataset.ef;
        if (span) span.textContent = label;
      }
    } else {
      const mainBtn = this.shadowRoot.querySelector('.rgb-btn:not(.extra-rgb-btn)');
      if (mainBtn) {
        const span = mainBtn.querySelector('.rgb-btn-text');
        const label = el.dataset.ef === 'None' ? this._ct.rgbBtnLabel : el.dataset.ef;
        if (span) span.textContent = label;
      }
    }
    const E = this.ENTITIES;
    const rgbEid2 = (this._activeRgbId && E[this._activeRgbId]) ? E[this._activeRgbId] : E.rgb;
    if (rgbEid2 && el.dataset.ef !== 'None') {
      this._callService('light', 'turn_on', { entity_id: rgbEid2, effect: el.dataset.ef });
    }
  }


  // ─── Mount overlays lên host để tránh lỗi position:fixed trong Shadow DOM ──

  // Helper: tìm element trong shadowRoot trước, nếu không có thì tìm trong document (cho overlays)
  _getEl(id) {
    return this.shadowRoot.getElementById(id) || document.getElementById('hsrc-' + id) || document.body.querySelector('#' + id);
  }

  _mountOverlaysToHost() {
    const ids = ['spd-popup-overlay', 'rgb-modal-overlay', 'tv-modal-overlay'];
    ids.forEach(id => {
      const el = this.shadowRoot.getElementById(id);
      if (!el) return;
      // Clone styles vào document head nếu chưa có
      if (!document.getElementById('hsrc-overlay-styles')) {
        const styleEl = document.createElement('style');
        styleEl.id = 'hsrc-overlay-styles';
        // Copy toàn bộ styles từ shadow root
        const shadowStyle = this.shadowRoot.querySelector('style');
        if (shadowStyle) styleEl.textContent = shadowStyle.textContent;
        document.head.appendChild(styleEl);
      }
      // Move overlay ra document.body
      document.body.appendChild(el);
      this['_overlay_' + id] = el;
    });
  }

  _hexToRgb(hex) {
    const r = parseInt(hex.slice(1,3), 16);
    const g = parseInt(hex.slice(3,5), 16);
    const b = parseInt(hex.slice(5,7), 16);
    return [r, g, b];
  }

  // ─── Graph ─────────────────────────────────────────────────────────────────
  _drawGraph() {
    // Fetch 6h history từ HA recorder API
    if (!this._hass) return;
    const token = this._hass.auth?.data?.access_token || '';
    const now = new Date();
    const from = new Date(now.getTime() - 6 * 3600 * 1000).toISOString();
    const E = this.ENTITIES;
    const sensors = [E.power, E.temp, E.ac, E.door, E.motion].filter(Boolean);
    const url = `/api/history/period/${from}?filter_entity_id=${sensors.join(',')}&minimal_response=true&no_attributes=true`;

    fetch(url, { headers: { Authorization: 'Bearer ' + token } })
      .then(r => r.json())
      .then(data => {
        // data = [ [power_states...], [temp_states...], [ac_states...] ]
        const findArr = eid => (data || []).find(arr => arr && arr[0] && arr[0].entity_id === eid) || [];
        const pwrArr  = findArr(E.power);
        const tmpArr  = findArr(E.temp);
        const acArr   = findArr(E.ac);

        // ── Tìm lần bật/tắt cuối của điều hòa ──────────────────────────────
        const fmt = iso => iso ? new Date(iso).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'}) : '--:--';
        let acOnTime = '--:--', acOffTime = '--:--';
        // Duyệt từ mới nhất về cũ nhất
        const acSorted = [...acArr].sort((a,b) => new Date(b.last_changed||b.s||0) - new Date(a.last_changed||a.s||0));
        let foundOff = false, foundOn = false;
        for (const s of acSorted) {
          const st = s.state || s.s;
          if (!foundOff && st === 'off') { acOffTime = fmt(s.last_changed || s.lu); foundOff = true; }
          if (!foundOn  && st !== 'off' && st !== 'unavailable' && st !== 'unknown') { acOnTime = fmt(s.last_changed || s.lu); foundOn = true; }
          if (foundOn && foundOff) break;
        }

        // ── Cửa: lần đổi trạng thái gần nhất ───────────────────────────────
        const doorArr   = findArr(E.door);
        const motionArr = findArr(E.motion);
        let doorTime = '--:--', doorState = null;
        let motionTime = '--:--';
        if (doorArr.length) {
          const d = [...doorArr].sort((a,b) => new Date(b.last_changed||b.lu||0) - new Date(a.last_changed||a.lu||0))[0];
          doorTime  = fmt(d.last_changed || d.lu);
          doorState = (d.state || d.s);
        }
        // Motion: lần on cuối cùng trong 6h
        if (motionArr.length) {
          const onEvents = motionArr.filter(s => (s.state||s.s) === 'on')
            .sort((a,b) => new Date(b.last_changed||b.lu||0) - new Date(a.last_changed||a.lu||0));
          if (onEvents.length) motionTime = fmt(onEvents[0].last_changed || onEvents[0].lu);
        }

        // ── Build time-series mỗi 12 phút (30 điểm cho 6h) ─────────────────
        const N = 30;
        const buckets = Array.from({length: N}, (_,i) => ({
          t: now.getTime() - (N-1-i) * (6*3600*1000/(N-1)),
          temp: null, pwr: null
        }));

        const interpolate = (arr, valKey) => {
          if (!arr.length) return;
          let si = 0;
          buckets.forEach(b => {
            // Tìm state gần nhất trước bucket time
            while (si + 1 < arr.length) {
              const nxt = new Date(arr[si+1].last_changed || arr[si+1].lu || arr[si+1].s).getTime();
              if (nxt <= b.t) si++; else break;
            }
            const v = parseFloat(arr[si].state || arr[si].s);
            if (!isNaN(v)) b[valKey] = v;
          });
        };
        interpolate(tmpArr, 'temp');
        interpolate(pwrArr, 'pwr');

        // Fill gaps với linear interpolation
        const fillGaps = key => {
          let last = null;
          buckets.forEach(b => { if (b[key] !== null) last = b[key]; else if (last !== null) b[key] = last; });
        };
        fillGaps('temp'); fillGaps('pwr');

        const temps = buckets.map(b => b.temp).filter(v => v !== null);
        const pwrs  = buckets.map(b => b.pwr ).filter(v => v !== null);
        if (!temps.length || !pwrs.length) return;

        const maxTemp = Math.max(...temps), minTemp = Math.min(...temps);
        const maxPwr  = Math.max(...pwrs),  minPwr  = Math.min(...pwrs);
        const maxTempIdx = buckets.findIndex(b => b.temp === maxTemp);
        const maxPwrIdx  = buckets.findIndex(b => b.pwr  === maxPwr);
        const minTempIdx = buckets.findIndex(b => b.temp === minTemp);

        // ── Vẽ canvas ───────────────────────────────────────────────────────
        this._drawGraphData(buckets, maxTempIdx, maxPwrIdx, minTempIdx, maxTemp, minTemp, maxPwr, minPwr);

        // ── Cập nhật time labels ─────────────────────────────────────────────
        const $ = id => this.shadowRoot.getElementById(id);
        const tFmt = ms => new Date(ms).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'});
        const step = 6*3600*1000/4;
        for (let i=0; i<4; i++) { const el=$('g-t'+i); if(el) el.textContent = tFmt(buckets[0].t + i*step); }
        const e4 = $('g-t4'); if(e4) e4.textContent = this._ct.graphNow;
        const _tlTl = this.shadowRoot.getElementById('g-tl-label'); if(_tlTl) _tlTl.firstChild.textContent = this._ct.graphTemp + ' ';
        const _tlTr = this.shadowRoot.getElementById('g-tr-label'); if(_tlTr) _tlTr.textContent = this._ct.graphPwr;
        const _acOnLbl = this.shadowRoot.getElementById('gs-ac-on-lbl'); if(_acOnLbl) _acOnLbl.textContent = this._ct.graphAcOn;
        const _acOffLbl = this.shadowRoot.getElementById('gs-ac-off-lbl'); if(_acOffLbl) _acOffLbl.textContent = this._ct.graphAcOff;
        const _motLbl = this.shadowRoot.getElementById('gs-motion-lbl'); if(_motLbl) _motLbl.textContent = this._ct.graphMotion;

        // ── Cập nhật stats ───────────────────────────────────────────────────
        const s = id => { const el=$('gs-'+id); return el; };
        if(s('ac-on'))   s('ac-on').textContent   = acOnTime;
        if(s('ac-off'))  s('ac-off').textContent  = acOffTime;
        if(s('door-time')) {
          s('door-time').textContent = doorTime;
          const lbl = this.shadowRoot.getElementById('gs-door-lbl');
          if (lbl) {
            if (doorState === 'on')       { lbl.textContent = this._ct.graphDoorOpen;  lbl.style.color = 'rgba(255,180,60,0.8)'; }
            else if (doorState === 'off') { lbl.textContent = this._ct.graphDoorClose; lbl.style.color = 'rgba(80,200,255,0.7)'; }
            else                          { lbl.textContent = this._ct.graphDoorChanged; }
          }
        }
        if(s('motion-time')) s('motion-time').textContent = motionTime;
      })
      .catch(() => {
        // Fallback: vẽ graph demo nếu lỗi API
        this._drawGraphDemo();
      });
  }

  _drawGraphDemo() {
    const td = [28,27.5,27,27.2,27.8,28,28.3,28.1,27.9,28.2,29,29.5,29.8,29.6,29.3,29.1,29.4,30,30.5,31,31.5,31.8,31.2,30.8,30.5,30.2,30,29.8,29.5,29.3];
    const pd = [80,60,50,55,70,90,120,100,80,95,140,160,180,170,155,140,160,200,250,280,320,380,280,220,180,160,140,120,100,90];
    const N = 30, now = Date.now();
    const buckets = td.map((t,i) => ({t: now-(N-1-i)*12*60*1000, temp:t, pwr:pd[i]}));
    const maxTemp=Math.max(...td), minTemp=Math.min(...td), maxPwr=Math.max(...pd), minPwr=Math.min(...pd);
    this._drawGraphData(buckets, td.indexOf(maxTemp), pd.indexOf(maxPwr), td.indexOf(minTemp), maxTemp, minTemp, maxPwr, minPwr);
  }

  _drawGraphData(buckets, maxTI, maxPI, minTI, maxTemp, minTemp, maxPwr, minPwr) {
    const cv = this.shadowRoot.getElementById('mg');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.offsetWidth || 500, H = 100, dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr; ctx.scale(dpr, dpr);
    const n = buckets.length;
    const tRange = Math.max(maxTemp - minTemp, 2);
    const pRange = Math.max(maxPwr  - minPwr,  20);
    const PAD = 10;
    const normT = v => PAD + (H - PAD*2) * (1 - (v - (minTemp - tRange*0.08)) / (tRange * 1.16));
    const normP = v => PAD + (H - PAD*2) * (1 - (v - Math.max(0, minPwr - pRange*0.08)) / (pRange * 1.16));
    const xs = W / (n - 1);
    const ty = buckets.map(b => b.temp !== null ? normT(b.temp) : H/2);
    const py = buckets.map(b => b.pwr  !== null ? normP(b.pwr)  : H/2);

    // ── Grid ──────────────────────────────────────────────────────────────────
    ctx.save();
    for (let y = 0; y < H; y += 8) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y);
      ctx.strokeStyle = 'rgba(0,200,255,0.04)'; ctx.lineWidth = 0.5; ctx.stroke();
    }
    for (let x = 0; x < W; x += W/6) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H);
      ctx.strokeStyle = 'rgba(0,200,255,0.035)'; ctx.lineWidth = 0.5; ctx.stroke();
    }
    ctx.restore();



    // ── Catmull-Rom path builder ──────────────────────────────────────────────
    const buildPath = (ys) => {
      ctx.beginPath();
      ctx.moveTo(0, ys[0]);
      for (let i = 0; i < ys.length - 1; i++) {
        const p0 = ys[Math.max(0, i-1)];
        const p1 = ys[i];
        const p2 = ys[i+1];
        const p3 = ys[Math.min(ys.length-1, i+2)];
        const x1 = i*xs, x2 = (i+1)*xs;
        const x0 = (i-1)*xs, x3 = (i+2)*xs;
        ctx.bezierCurveTo(
          x1 + (x2-x0)/6, p1 + (p2-p0)/6,
          x2 - (x3-x1)/6, p2 - (p3-p1)/6,
          x2, p2
        );
      }
    };

    // ── Multi-streak hologram draw (như ảnh: vệt sáng chính + nhiều vệt mờ dần xuống) ──
    const drawHolo = (ys, stroke, glowColor) => {
      // Trích màu RGB từ chuỗi rgba
      const rgbMatch = stroke.match(/rgba\((\d+),(\d+),(\d+)/);
      const [r, g, b] = rgbMatch ? [+rgbMatch[1], +rgbMatch[2], +rgbMatch[3]] : [255,255,255];

      // Hàm build path offset xuống dưới
      const buildPathOffset = (ys, offsetY) => {
        ctx.beginPath();
        ctx.moveTo(0, ys[0] + offsetY);
        for (let i = 0; i < ys.length - 1; i++) {
          const p0 = ys[Math.max(0, i-1)];
          const p1 = ys[i];
          const p2 = ys[i+1];
          const p3 = ys[Math.min(ys.length-1, i+2)];
          const x1 = i*xs, x2 = (i+1)*xs;
          const x0 = (i-1)*xs, x3 = (i+2)*xs;
          ctx.bezierCurveTo(
            x1 + (x2-x0)/6, p1 + (p2-p0)/6 + offsetY,
            x2 - (x3-x1)/6, p2 - (p3-p1)/6 + offsetY,
            x2, p2 + offsetY
          );
        }
      };

      // ── Vệt phụ song song mờ dần về phía trục X ─────────────────────────────
      // Số vệt phụ và khoảng cách giảm dần
      const streaks = [
        { offset: 5,  alpha: 0.22, width: 1.4 },
        { offset: 10, alpha: 0.15, width: 1.1 },
        { offset: 16, alpha: 0.09, width: 0.9 },
        { offset: 23, alpha: 0.055,width: 0.7 },
        { offset: 31, alpha: 0.03, width: 0.6 },
        { offset: 40, alpha: 0.015,width: 0.5 },
      ];
      streaks.forEach(({ offset, alpha, width }) => {
        ctx.save();
        buildPathOffset(ys, offset);
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.lineWidth = width;
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.stroke();
        ctx.restore();
      });

      // ── Fill gradient từ đường chính xuống trục X ────────────────────────────
      ctx.save(); buildPath(ys);
      ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
      const fg = ctx.createLinearGradient(0, 0, 0, H);
      fg.addColorStop(0,   `rgba(${r},${g},${b},0.18)`);
      fg.addColorStop(0.5, `rgba(${r},${g},${b},0.06)`);
      fg.addColorStop(1,   `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = fg; ctx.fill(); ctx.restore();

      // ── Glow ngoài rộng (hào quang) ─────────────────────────────────────────
      ctx.save(); buildPath(ys);
      ctx.strokeStyle = `rgba(${r},${g},${b},0.12)`;
      ctx.lineWidth = 12; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke(); ctx.restore();

      // ── Glow giữa ────────────────────────────────────────────────────────────
      ctx.save(); buildPath(ys);
      ctx.strokeStyle = `rgba(${r},${g},${b},0.28)`;
      ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke(); ctx.restore();

      // ── Đường chính sáng nhất ────────────────────────────────────────────────
      ctx.save(); buildPath(ys);
      const lg = ctx.createLinearGradient(0, 0, W, 0);
      lg.addColorStop(0,   `rgba(${r},${g},${b},0.55)`);
      lg.addColorStop(0.25, stroke);
      lg.addColorStop(0.75, stroke);
      lg.addColorStop(1,   `rgba(${r},${g},${b},0.55)`);
      ctx.strokeStyle = lg; ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke(); ctx.restore();

      // ── Shimmer trắng trên đường chính ───────────────────────────────────────
      ctx.save(); buildPath(ys);
      const sh = ctx.createLinearGradient(0, 0, W, 0);
      sh.addColorStop(0,   'rgba(255,255,255,0)');
      sh.addColorStop(0.35,`rgba(${r},${g},${b},0.55)`);
      sh.addColorStop(0.55,'rgba(255,255,255,0.9)');
      sh.addColorStop(1,   'rgba(255,255,255,0)');
      ctx.strokeStyle = sh; ctx.lineWidth = 0.8; ctx.stroke(); ctx.restore();
    };

    drawHolo(py, 'rgba(0,240,180,1)',  'rgba(0,240,180,1)',  null);
    drawHolo(ty, 'rgba(255,200,50,1)', 'rgba(255,200,50,1)', null);

    // ── Bottom-up fade overlay to blend canvas into card background ──────────
    // Đọc màu nền trực tiếp từ config (không dùng CSS vars vì shadow DOM không đọc được)
    const _cfg = this._config || {};
    const _preset = _cfg.background_preset || 'default';
    const _HSRC_BG = {
      default:'#060f1e', night:'#0d052a', deep_neon:'#003040',
      sunset:'#3a1a08',  forest:'#0a2a0a', aurora:'#051a10',
      ocean:'#001840',   galaxy:'#180828', ice:'#182840',
      cherry:'#1a0020',  volcano:'#200500', rose:'#200808',
      teal:'#001818',    desert:'#1a0e00', slate:'#101820', olive:'#0e1200',
    };
    let _hex = (_preset === 'custom' ? (_cfg.bg_color2 || '#060f1e') : (_HSRC_BG[_preset] || '#060f1e')).replace('#','');
    const bgR = parseInt(_hex.substring(0,2),16)||6;
    const bgG = parseInt(_hex.substring(2,4),16)||15;
    const bgB = parseInt(_hex.substring(4,6),16)||30;
    ctx.save();
    const fadeOverlay = ctx.createLinearGradient(0, 0, 0, H);
    fadeOverlay.addColorStop(0,    `rgba(${bgR},${bgG},${bgB},0)`);
    fadeOverlay.addColorStop(0.45, `rgba(${bgR},${bgG},${bgB},0)`);
    fadeOverlay.addColorStop(0.78, `rgba(${bgR},${bgG},${bgB},0.6)`);
    fadeOverlay.addColorStop(1,    `rgba(${bgR},${bgG},${bgB},1)`);
    ctx.fillStyle = fadeOverlay;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // ── Highlight points with connector lines + side labels ──────────────────
    const pts = [
      { i:maxTI, arr:ty, col:'rgba(255,220,60,1)',  glowCol:'rgba(255,200,50,0.45)', id:'tt-peak-temp', label:`⚡ ${maxTemp.toFixed(1)}°C` },
      { i:maxPI, arr:py, col:'rgba(0,255,180,1)',   glowCol:'rgba(0,240,180,0.45)',  id:'tt-peak-pwr',  label:`⚡ ${Math.round(maxPwr)}W` },
      { i:minTI, arr:ty, col:'rgba(100,210,255,1)', glowCol:'rgba(80,200,255,0.45)', id:'tt-min-temp',  label:`❄ ${minTemp.toFixed(1)}°C` },
    ];
    pts.forEach(({i, arr, col, glowCol, id, label}) => {
      if (i < 0 || i >= n) return;
      const x = i*xs, y = arr[i];

      // Glow dot at peak
      ctx.save(); ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI*2);
      ctx.fillStyle = glowCol; ctx.fill(); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI*2);
      ctx.fillStyle = col; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.restore();

      const tt = this.shadowRoot.getElementById(id);
      if (!tt) return;
      tt.textContent = label; tt.style.display = 'block';

      // Label height ~20px; horizontal gap from dot edge = 14px (line length)
      const DOT_R  = 7;   // dot glow radius
      const LINE_L = 14;  // horizontal connector length
      const labelH = 20;

      // Decide side
      const labelW   = label.length * 6.5 + 18;
      const goRight  = (x + DOT_R + LINE_L + labelW) <= W;
      const lineStartX = goRight ? x + DOT_R : x - DOT_R;
      const lineEndX   = goRight ? x + DOT_R + LINE_L : x - DOT_R - LINE_L;
      const lx         = goRight ? lineEndX : lineEndX - labelW;

      // Align label center vertically with dot
      const ly = Math.max(2, Math.min(H - labelH - 2, y - labelH / 2));

      tt.style.left  = lx + 'px';
      tt.style.right = 'auto';
      tt.style.top   = ly + 'px';

      // Straight horizontal connector line at dot's Y
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(lineStartX, y);
      ctx.lineTo(lineEndX,   y);
      ctx.strokeStyle = col.replace('1)', '0.6)');
      ctx.lineWidth   = 1;
      ctx.setLineDash([3, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    });

    // ── Trend icon ────────────────────────────────────────────────────────────
    const trendEl = this.shadowRoot.getElementById('g-trend');
    if (trendEl && buckets.length >= 4) {
      const recent = buckets.slice(-4).map(b => b.temp).filter(v=>v!==null);
      if (recent.length >= 2) {
        const delta = recent[recent.length-1] - recent[0];
        if (delta > 0.5) {
          trendEl.textContent = '↑'; trendEl.style.color='rgba(255,100,80,1)';
          trendEl.title = `${this._ct.trendUp} +${delta.toFixed(1)}°C`;
        } else if (delta < -0.5) {
          trendEl.textContent = '↓'; trendEl.style.color='rgba(80,220,255,1)';
          trendEl.title = `${this._ct.trendDown} ${delta.toFixed(1)}°C`;
        } else {
          trendEl.textContent = '→'; trendEl.style.color='rgba(180,180,180,0.6)';
          trendEl.title = 'Ổn định';
        }
      }
    }

    // ── Hover crosshair ───────────────────────────────────────────────────────
    // Store graph data on canvas for mousemove handler
    cv._graphData = { buckets, ty, py, xs, W, H, maxTemp, minTemp, normT, normP };
    if (!cv._hoverBound) {
      cv._hoverBound = true;
      const hoverLine = this.shadowRoot.getElementById('g-hover-line');
      const hoverTip  = this.shadowRoot.getElementById('g-hover-tip');

      const onMove = (e) => {
        const d = cv._graphData;
        if (!d) return;
        const rect = cv.getBoundingClientRect();
        const mx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
        const idx = Math.max(0, Math.min(d.buckets.length-1, Math.round(mx / d.xs)));
        const b = d.buckets[idx];
        if (!b) return;
        const x = idx * d.xs;
        const tempVal = b.temp;
        const pwrVal  = b.pwr;
        const timeStr = new Date(b.t).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'});

        // Crosshair line
        if (hoverLine) { hoverLine.style.display='block'; hoverLine.style.left=x+'px'; }

        // Build tooltip content
        let tipHtml = `<div class="g-ht-time">${timeStr}</div>`;
        if (tempVal !== null) {
          const isDanger = tempVal >= 30;
          const col = isDanger ? 'rgba(255,100,80,1)' : 'rgba(255,200,60,0.95)';
          tipHtml += `<div class="g-ht-row" style="color:${col}">🌡️ ${tempVal.toFixed(1)}°C${isDanger?' 🔥':''}</div>`;
        }
        if (pwrVal !== null) tipHtml += `<div class="g-ht-row" style="color:rgba(0,240,180,0.95)">⚡ ${Math.round(pwrVal)}W</div>`;

        if (hoverTip) {
          hoverTip.innerHTML = tipHtml;
          hoverTip.style.display = 'block';
          const tipW = 120;
          hoverTip.style.left = x + tipW > d.W ? (x - tipW - 4)+'px' : (x + 8)+'px';
          hoverTip.style.top  = '4px';
        }
      };
      const onLeave = () => {
        if (hoverLine) hoverLine.style.display='none';
        if (hoverTip)  hoverTip.style.display='none';
      };
      cv.addEventListener('mousemove', onMove);
      cv.addEventListener('touchmove',  onMove, {passive:true});
      cv.addEventListener('mouseleave', onLeave);
      cv.addEventListener('touchend',   onLeave);
    }
  }



    // ─── Templates ─────────────────────────────────────────────────────────────
  _tplHeader() {
    return `
      <div class="header">
        <div class="h-left">
          <div class="h-title-row">
            <div class="h-title">${(this._config && this._config.room_title) || 'Smart Room'}</div>
          </div>
        </div>
        <div class="h-right">
          <div class="h-sub-row1" id="h-sub">--:--</div>
          <div class="h-sub-row2" id="h-sub2"></div>
        </div>
      </div>`;
  }

  _tplSensorRow() {
    return `
      <div class="sensor-row">
        <div class="s-boxes">
          <div class="s-box" id="s-box-temp">
            <div class="s-ico-wrap" id="s-ico-temp">
              <svg viewBox="0 0 24 24" class="s-ico-svg"><path fill="currentColor" d="M15 13V5a3 3 0 0 0-6 0v8a5 5 0 1 0 6 0m-3 7a3 3 0 0 1-3-3 3 3 0 0 1 3-3 3 3 0 0 1 3 3 3 3 0 0 1-3 3z"/></svg>
            </div>
            <div>
              <div class="s-val" id="s-temp">--°C</div>
              <div class="s-lbl lbl-ok" id="s-temp-lbl">--</div>
            </div>
          </div>
          <div class="s-box" id="s-box-humi">
            <div class="s-ico-wrap" id="s-ico-humi">
              <svg viewBox="0 0 24 24" class="s-ico-svg"><path fill="currentColor" d="M12 2c-5.33 4.55-8 8.48-8 11.8a8 8 0 0 0 8 8.2 8 8 0 0 0 8-8.2c0-3.32-2.67-7.25-8-11.8z"/></svg>
            </div>
            <div>
              <div class="s-val" id="s-humi">--%</div>
              <div class="s-lbl lbl-ok" id="s-humi-lbl">--</div>
            </div>
          </div>
          <div class="h-score-pill" id="h-score-pill" style="flex:0 0 auto;width:20%;min-width:0;justify-content:center;flex-direction:column;align-items:center;gap:0;padding:4px 5px 4px;">
            <div class="h-gauge-wrap">
              <svg class="h-gauge-svg" viewBox="0 0 60 35" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <linearGradient id="gauge-grad-rev" x1="100%" y1="0%" x2="0%" y2="0%">
                    <stop offset="0%"   stop-color="#00e5ff"/>
                    <stop offset="35%"  stop-color="#80ff00"/>
                    <stop offset="65%"  stop-color="#ffcc00"/>
                    <stop offset="85%"  stop-color="#ff7700"/>
                    <stop offset="100%" stop-color="#ff2200"/>
                  </linearGradient>
                </defs>
                <path d="M6,32 A24,24 0 0,1 54,32" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="4.5" stroke-linecap="round"/>
                <path id="h-gauge-arc" d="M6,32 A24,24 0 0,1 54,32" fill="none" stroke="url(#gauge-grad-rev)" stroke-width="4.5" stroke-linecap="round"
                  stroke-dasharray="75.4" stroke-dashoffset="75.4"
                  style="transition:stroke-dashoffset 0.8s cubic-bezier(.4,0,.2,1)"/>
                <text id="h-score-emoji" x="30" y="27" text-anchor="middle" font-size="13" dominant-baseline="middle">⏳</text>
              </svg>
            </div>
            <div class="h-score-lbl" id="h-score-lbl" style="margin-top:1px">...</div>
          </div>
        </div>
        <div class="status-panel">
          <!-- Hàng 1: So sánh nhiệt độ/độ ẩm trong-ngoài, scroll lên -->
          <div id="sec-env-hint">
          <div class="sp-scroll-wrap sp-env-wrap" id="sp-env-wrap">
            <div class="sp-scroll-inner" id="sp-env-inner">
              <div class="sp-scroll-item">
                <svg viewBox="0 0 24 24" width="13" height="13" style="flex-shrink:0;color:rgba(255,200,60,0.8)"><path fill="currentColor" d="M15 13V5a3 3 0 0 0-6 0v8a5 5 0 1 0 6 0"/></svg>
                <span id="sp-temp-line">--°C · --°C</span>
              </div>
            </div>
          </div>
          </div><!-- /sec-env-hint -->
          <!-- Hàng 2: Trạng thái/gợi ý + nút chế độ dọc bên phải -->
          <div id="sec-auto-mode">
          <div class="sp-row-with-btns">
            <div class="sp-scroll-col">
              <div class="sp-scroll-wrap" id="sp-hint-wrap">
                <div class="sp-scroll-inner" id="sp-hint-inner">
                  <div class="sp-scroll-item" style="color:rgba(80,220,255,0.7)" id="sp-manual-init">⚙️ --</div>
                </div>
              </div>
              <div class="sp-scroll-wrap" id="sp-off-wrap" style="margin-top:4px">
                <div class="sp-scroll-inner" id="sp-off-inner">
                  <div class="sp-scroll-item" style="color:rgba(150,210,255,0.5)">—</div>
                </div>
              </div>
            </div>
            <div class="sp-mode-btns">
              <button class="btn-manual" id="btn-manual">Manual</button>
              <button class="btn-auto-mode" id="btn-auto-mode">Auto</button>
              <button class="btn-settings" id="btn-settings" title="Cài đặt tự động">⚙️</button>
            </div>
          </div>
          </div><!-- /sec-auto-mode -->

          <!-- ── Settings Panel (inline, ẩn mặc định) ── -->
          <div class="auto-settings-panel" id="auto-settings-panel" style="display:none">
            <div class="asp-title">${this._ct.aspTitle}</div>

            <!-- Số phút -->
            <div class="asp-row">
              <span class="asp-lbl">⏱️ Tắt sau</span>
              <div class="asp-delay-wrap">
                <button class="asp-step" id="asp-minus">−</button>
                <span class="asp-delay-val" id="asp-delay-val">5</span>
                <span class="asp-delay-unit">${this._ct.aspDelayUnit}</span>
                <button class="asp-step" id="asp-plus">＋</button>
              </div>
            </div>

            <!-- Danh sách thiết bị sẽ tắt -->
            <div class="asp-lbl" style="margin-top:8px;margin-bottom:4px;">${this._ct.aspDevTitle}</div>
            <div class="asp-dev-list" id="asp-dev-list"></div>
          </div>
        </div>
      </div>`;
  }

  _tplGraph() {
    return `
      <div id="sec-graph">
      <div class="graph-sec">
        <div class="g-top">
          <span class="g-tl" id="g-tl-label">Nhiệt độ (°C) <span id="g-trend" class="g-trend">→</span></span>
          <span class="g-tr" id="g-tr-label">Công suất (W)</span>
        </div>
        <div id="g-canvas-wrap" style="position:relative">
          <canvas id="mg" height="100"></canvas>
          <div class="tooltip-b tt-peak-temp" id="tt-peak-temp" style="display:none"></div>
          <div class="tooltip-b tt-peak-pwr"  id="tt-peak-pwr"  style="display:none"></div>
          <div class="tooltip-b tt-min-temp"  id="tt-min-temp"  style="display:none"></div>
          <!-- Hover crosshair tooltip -->
          <div id="g-hover-line" style="position:absolute;top:0;width:1px;height:100%;pointer-events:none;display:none;background:rgba(255,255,255,0.15)"></div>
          <div id="g-hover-tip" class="g-hover-tip" style="display:none"></div>
        </div>
        <div class="g-times">
          <span id="g-t0">--:--</span><span id="g-t1">--:--</span>
          <span id="g-t2">--:--</span><span id="g-t3">--:--</span>
          <span id="g-t4">--:--</span>
        </div>
        <div id="sec-timeline">
        <div class="g-stats-row">
          <div class="g-stat">
            <span class="g-stat-lbl" id="gs-ac-on-lbl">❄️ ĐH BẬT lúc</span>
            <span class="g-stat-val" id="gs-ac-on" style="color:rgba(0,220,255,0.9)">--:--</span>
          </div>
          <div class="g-stat-sep"></div>
          <div class="g-stat">
            <span class="g-stat-lbl" id="gs-ac-off-lbl">❄️ ĐH TẮT lúc</span>
            <span class="g-stat-val" id="gs-ac-off" style="color:rgba(255,180,60,0.9)">--:--</span>
          </div>
          <div class="g-stat-sep"></div>
          <div class="g-stat">
            <span class="g-stat-lbl" id="gs-door-lbl" style="color:rgba(80,200,255,0.7)">🚪 --</span>
            <span class="g-stat-val" id="gs-door-time" style="color:rgba(80,220,255,0.9)">--:--</span>
          </div>
          <div class="g-stat-sep"></div>
          <div class="g-stat">
            <span class="g-stat-lbl" id="gs-motion-lbl">🚶 Người lần cuối</span>
            <span class="g-stat-val" id="gs-motion-time" style="color:rgba(190,120,255,0.9)">--:--</span>
          </div>
        </div>
        </div><!-- /sec-timeline -->
      </div>
      </div><!-- /sec-graph -->`;
  }

  _tplRgbModal() {
    return `
      <div class="rgb-modal-overlay" id="rgb-modal-overlay" style="display:none">
        <div class="rgb-modal-sheet" id="rgb-modal-sheet">
          <div class="rgb-modal-handle"></div>
          <div class="rgb-modal-header">
            <span class="rgb-modal-title" id="rgb-modal-title">🌈 --</span>
            <div class="rgb-modal-close" id="rgb-modal-close">✕</div>
          </div>
          <div class="rgb-modal-body">
            <div class="rgb-modal-sec" id="rgb-color-sec-lbl">--</div>
            <div class="rgb-swatch-row" id="rgb-swatch-row">
              <div class="bsw act" style="background:#ff4444" data-c="#ff4444"></div>
              <div class="bsw" style="background:#ff9900" data-c="#ff9900"></div>
              <div class="bsw" style="background:#ffee00" data-c="#ffee00"></div>
              <div class="bsw" style="background:#44ff88" data-c="#44ff88"></div>
              <div class="bsw" style="background:#00ccff" data-c="#00ccff"></div>
              <div class="bsw" style="background:#4488ff" data-c="#4488ff"></div>
              <div class="bsw" style="background:#cc44ff" data-c="#cc44ff"></div>
              <div class="bsw" style="background:#ff44aa" data-c="#ff44aa"></div>
              <div class="bsw" style="background:#ffffff" data-c="#ffffff"></div>
            </div>
            <div class="cc-row" style="margin-bottom:10px">
              <div class="cur-dot" id="cur-dot" style="background:#ff4444"></div>
              <span class="cc-lbl" id="rgb-custom-lbl">--</span>
              <input type="color" id="ccp" value="#ff4444">
              <span class="cc-lbl" id="hex-lbl">#ff4444</span>
            </div>
            <div class="rgb-modal-sec" id="rgb-ef-sec-lbl">EFFECT</div>
            <div class="rgb-ef-list" id="rgb-ef-list"></div>
          </div>
        </div>
      </div>`;
  }

  // Đọc effect_list từ attributes của entity, render vào #rgb-ef-list và bind events
  // Hỗ trợ cả overlay được mount ra document.body (dùng _getEl thay shadowRoot.getElementById)
  _refreshEffectList(entityId) {
    // Tìm container — ưu tiên trong overlay đã mount ra body, rồi mới shadowRoot
    const overlay = this['_overlay_rgb-modal-overlay']
      || this.shadowRoot.getElementById('rgb-modal-overlay')
      || document.getElementById('rgb-modal-overlay');
    const efList = overlay
      ? overlay.querySelector('#rgb-ef-list')
      : (this.shadowRoot.getElementById('rgb-ef-list') || document.getElementById('rgb-ef-list'));
    if (!efList) return;

    const state = entityId && this._hass ? this._hass.states[entityId] : null;
    const effects = (state && Array.isArray(state.attributes.effect_list) && state.attributes.effect_list.length)
      ? state.attributes.effect_list
      : ['None'];

    efList.innerHTML = effects.map(ef =>
      `<div class="rgb-ef-item" data-ef="${ef.replace(/"/g,'&quot;')}">${ef}</div>`
    ).join('');

    // Đánh dấu effect hiện tại (từ HA state, ưu tiên hơn _rgbEffect local)
    const currentEffect = (state && state.attributes.effect) || this._rgbEffect;
    efList.querySelectorAll('.rgb-ef-item').forEach(el => {
      el.classList.toggle('act', el.dataset.ef === currentEffect);
      el.addEventListener('click', () => this._pickEffect(el));
    });

    // Scroll tới effect đang chọn
    const active = efList.querySelector('.rgb-ef-item.act');
    if (active) setTimeout(() => active.scrollIntoView({ block: 'center', behavior: 'smooth' }), 150);
  }

  _tplSmartBar() {
    return ``;
  }

  _tplDevRow() {
    const cfg     = this._config || {};
    const hidden  = cfg.devices_hidden || [];
    const defOrder= cfg.devices_order  || ['den','decor','hien','rgb','quat','ocam','tv','motion'];
    const extras  = cfg.devices_extra  || [];
    const labels  = cfg.devices_labels || {};
    const defIds  = ['den','decor','hien','rgb','quat','ocam','tv','motion'];
    const extraMap= {};
    extras.forEach(d => { extraMap[d.id] = d; });

    const defaultTplMap = {
      den:    () => this._tplDen(),
      decor:  () => this._tplDecor(),
      hien:   () => this._tplHien(),
      rgb:    () => this._tplRgb(),
      quat:   () => this._tplQuat(),
      ocam:   () => this._tplOcam(),
      tv:     () => this._tplTv(),
      motion: () => this._tplMotion(),
    };

    // Check if devices_order has been reordered to include extra ids
    const hasUnifiedOrder = defOrder.some(x => !defIds.includes(x));

    let cards = '';
    if (hasUnifiedOrder) {
      // Unified order: render in devices_order sequence
      cards = defOrder.map(id => {
        if (defIds.includes(id)) {
          return hidden.includes(id) ? '' : (defaultTplMap[id] ? defaultTplMap[id]() : '');
        }
        const d = extraMap[id];
        return d ? this._tplExtraCard(d, labels[d.id] || d.label) : '';
      }).join('');
    } else {
      // Separate: defaults in order, then extras appended
      const defaultCards = defOrder
        .filter(id => !hidden.includes(id))
        .map(id => defaultTplMap[id] ? defaultTplMap[id]() : '')
        .join('');
      const extraCards = extras
        .map(d => this._tplExtraCard(d, labels[d.id] || d.label))
        .join('');
      cards = defaultCards + extraCards;
    }

    return `
      <div class="dev-wrap">
        <div class="dev-row" id="dev-row">
          ${cards}
        </div>
        <div class="scroll-hint"></div>
      </div>`;
  }

  // Generic card for extra user-added devices
  // Render giống hệt built-in card theo type; hỗ trợ mdi_icon override.
  _tplExtraCard(d, label) {
    const id   = d.id;
    const type = d.type || 'sensor';

    // Color mapping theo type
    const colMap  = { den:'y', rgb:'r', quat:'c', tv:'b', sensor:'gr' };
    const col     = colMap[type] || 'c';
    const ringCls = { y:'ry', r:'rr', c:'rc', b:'rb', gr:'rgr' }[col];

    // Helper: render icon — dùng ha-icon nếu có mdi_icon, ngược lại dùng SVG mặc định
    const mdiIcon = d.mdi_icon ? d.mdi_icon.trim() : '';
    const _icon = (svgInner, svgAttrs = '') => {
      if (mdiIcon) {
        return `<ha-icon icon="${mdiIcon}" style="width:28px;height:28px;display:flex;align-items:center;justify-content:center;--mdi-icon-size:26px;"></ha-icon>`;
      }
      return `<svg ${svgAttrs} viewBox="0 0 24 24" width="28" height="28">${svgInner}</svg>`;
    };

    if (type === 'den') {
      const svgInner = `
  <path fill="currentColor" d="M12 3.5a5.5 5.5 0 0 1 5.5 5.5c0 2.1-1.18 3.93-2.92 4.87L14 15.5h-4l-.58-1.63A5.5 5.5 0 0 1 6.5 9 5.5 5.5 0 0 1 12 3.5z"/>
  <rect x="10" y="15.5" width="4" height="1.2" rx="0.6" fill="currentColor" opacity="0.7"/>
  <rect x="10.5" y="17" width="3" height="1.1" rx="0.55" fill="currentColor" opacity="0.5"/>
  <rect x="11" y="18.3" width="2" height="1" rx="0.5" fill="currentColor" opacity="0.35"/>`;
      return `
      <div class="dcard" id="cd-${id}">
        <div class="top-h" id="tp-${id}">
          <div class="i-ring ${ringCls}" id="ir-${id}">${_icon(svgInner)}</div>
          <div class="on-badge ba-off" id="ba-${id}">OFF</div>
        </div>
        <div class="bot-h">
          <div class="c-name" id="cn-${id}">${label}</div>
          <div class="c-sub sub-off" id="sb-${id}">OFF</div>
          <div class="bright-bar-wrap">
            <div class="bright-track" id="tr-${id}">
              <div class="bright-fill fill-y" id="fl-${id}" style="width:0%"></div>
              <div class="bright-thumb" id="th-${id}" style="left:0%"></div>
            </div>
            <span class="bright-val" id="vl-${id}">0%</span>
          </div>
        </div>
      </div>`;
    }

    if (type === 'rgb') {
      const svgInner = `
  <polygon points="12,3 20,18 4,18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
  <line x1="17.5" y1="13" x2="22" y2="11" stroke="#ff4444" stroke-width="1.3" stroke-linecap="round" opacity="0.85"/>
  <line x1="17.5" y1="14.5" x2="22" y2="14" stroke="#ffaa00" stroke-width="1.3" stroke-linecap="round" opacity="0.85"/>
  <line x1="17" y1="16" x2="22" y2="17" stroke="#44ff88" stroke-width="1.3" stroke-linecap="round" opacity="0.85"/>
  <line x1="16" y1="17.5" x2="20.5" y2="20" stroke="#44aaff" stroke-width="1.3" stroke-linecap="round" opacity="0.85"/>
  <line x1="2" y1="11" x2="9" y2="13.5" stroke="rgba(255,255,255,0.85)" stroke-width="1.5" stroke-linecap="round"/>
  <polygon points="12,6 18,17 6,17" fill="currentColor" opacity="0.12"/>`;
      return `
      <div class="dcard" id="cd-${id}" style="overflow:visible">
        <div class="top-h" id="tp-${id}">
          <div class="i-ring ${ringCls}" id="ir-${id}">${_icon(svgInner, 'class="anim-rgb"')}</div>
          <div class="on-badge ba-off" id="ba-${id}">OFF</div>
        </div>
        <div class="bot-h" id="rgb-bot-${id}">
          <div class="c-name" id="cn-${id}">${label}</div>
          <div class="c-sub sub-off" id="sb-${id}">OFF</div>
          <div class="rainbow-bar" style="margin-top:1px"></div>
          <div class="rgb-btn extra-rgb-btn" data-rgb-id="${id}" style="margin-top:2px"><span class="rgb-btn-text">Effect &amp; Color</span></div>
        </div>
      </div>`;
    }

    if (type === 'quat') {
      const svgInner = `
  <path d="M12 11 C10 8, 8 5.5, 10 4 C12 2.5, 13 5, 13 11Z" fill="currentColor" opacity="0.85"/>
  <path d="M13 12 C16 10, 18.5 8, 20 10 C21.5 12, 19 13, 13 13Z" fill="currentColor" opacity="0.75"/>
  <path d="M12 13 C14 16, 16 18.5, 14 20 C12 21.5, 11 19, 11 13Z" fill="currentColor" opacity="0.85"/>
  <path d="M11 12 C8 14, 5.5 16, 4 14 C2.5 12, 5 11, 11 11Z" fill="currentColor" opacity="0.75"/>
  <circle cx="12" cy="12" r="2.2" fill="currentColor"/>
  <circle cx="12" cy="12" r="1" fill="rgba(255,255,255,0.35)"/>`;
      // Nếu có mdi_icon, không dùng fan-svg id (không cần spin)
      const iconHtml = mdiIcon
        ? `<ha-icon icon="${mdiIcon}" id="fan-svg-${id}" style="width:28px;height:28px;display:flex;align-items:center;justify-content:center;--mdi-icon-size:26px;"></ha-icon>`
        : `<svg id="fan-svg-${id}" viewBox="0 0 24 24" width="28" height="28">${svgInner}</svg>`;
      return `
      <div class="dcard" id="cd-${id}">
        <div class="top-h" id="tp-${id}">
          <div class="i-ring ${ringCls}" id="ir-${id}">${iconHtml}</div>
          <div class="on-badge ba-off" id="ba-${id}">OFF</div>
        </div>
        <div class="bot-h">
          <div class="c-name" id="cn-${id}">${label}</div>
          <div class="c-sub sub-off" id="sb-${id}">OFF</div>
          <button class="spd-open-btn extra-spd-btn" id="spd-open-btn-${id}" data-fan-id="${id}">⚡ Tốc độ <span id="vl-${id}" class="spd-open-val">--</span></button>
        </div>
      </div>
      <div class="spd-popup-overlay extra-spd-overlay" id="spd-popup-overlay-${id}" style="display:none">
        <div class="spd-popup-sheet" id="spd-popup-sheet-${id}">
          <div class="spd-popup-handle"></div>
          <div class="spd-popup-title" id="spd-popup-title">⚡ --</div>
          <div class="spd-popup-grid">
            <div class="spd-btn extra-spd-level" data-fan-id="${id}" data-s="1">1<span class="spd-lv-lbl" data-spd-lv="0"></span></div>
            <div class="spd-btn extra-spd-level" data-fan-id="${id}" data-s="2">2<span class="spd-lv-lbl" data-spd-lv="1"></span></div>
            <div class="spd-btn extra-spd-level" data-fan-id="${id}" data-s="3">3<span class="spd-lv-lbl" data-spd-lv="2"></span></div>
            <div class="spd-btn extra-spd-level" data-fan-id="${id}" data-s="4">4<span class="spd-lv-lbl" data-spd-lv="3"></span></div>
            <div class="spd-btn extra-spd-level" data-fan-id="${id}" data-s="5">5<span class="spd-lv-lbl" data-spd-lv="4"></span></div>
          </div>
        </div>
      </div>`;
    }

    if (type === 'tv') {
      const svgInner = `
  <rect x="2" y="4" width="20" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <rect x="3.5" y="5.5" width="17" height="10" rx="1.2" fill="currentColor" opacity="0.18"/>
  <g class="tv-content" opacity="0">
    <path d="M3.5 15.5 L7 10 L10 13 L13 8.5 L17 13.5 L20.5 10.5 L20.5 15.5Z" fill="rgba(80,160,255,0.35)"/>
    <circle cx="17" cy="8.5" r="1.2" fill="rgba(255,230,60,0.7)"/>
  </g>
  <path d="M9 17 L9.5 20 L14.5 20 L15 17" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.7"/>
  <line x1="7" y1="20" x2="17" y2="20" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.7"/>`;
      return `
      <div class="dcard" id="cd-${id}">
        <div class="top-h" id="tp-${id}">
          <div class="i-ring ${ringCls}" id="ir-${id}">${_icon(svgInner)}</div>
          <div class="on-badge ba-off" id="ba-${id}">OFF</div>
        </div>
        <div class="bot-h">
          <div class="c-name" id="cn-${id}">${label}</div>
          <div class="c-sub sub-off" id="sb-${id}">OFF</div>
          <div class="sl-lbl" style="margin-top:2px"><span>ÂM LƯỢNG</span><span id="vl-${id}">--%</span></div>
          <div class="track" id="tr-${id}">
            <div class="fill-c" id="fl-${id}" style="width:0%"></div>
            <div class="thumb" id="th-${id}" style="left:0%"></div>
          </div>
        </div>
      </div>`;
    }

    // ocam — ổ cắm với power stat/bar
    if (type === 'ocam') {
      const svgOcam = `
  <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <rect x="8.5" y="7" width="2" height="3.5" rx="1" fill="currentColor" opacity="0.9"/>
  <rect x="13.5" y="7" width="2" height="3.5" rx="1" fill="currentColor" opacity="0.9"/>
  <path d="M10.5 14 A1.5 1.5 0 0 1 13.5 14 L13.5 15 A1.5 1.5 0 0 1 10.5 15 Z" fill="currentColor" opacity="0.7"/>
  <path d="M12.8 11 L11 14.5 L12.2 14.5 L11.2 17.5 L14 13 L12.7 13 L13.8 11Z" fill="currentColor" opacity="0.0" class="socket-bolt"/>`;
      return `
      <div class="dcard" id="cd-${id}">
        <div class="top-h" id="tp-${id}">
          <div class="i-ring ${ringCls}" id="ir-${id}">${_icon(svgOcam)}</div>
          <div class="on-badge ba-off" id="ba-${id}">OFF</div>
        </div>
        <div class="bot-h">
          <div class="c-name" id="cn-${id}">${label}</div>
          <div class="c-sub sub-off" id="sb-${id}">OFF</div>
          <div class="socket-stat"><span class="socket-stat-lbl">CÔNG SUẤT</span><span class="socket-stat-val" id="pwr-val-${id}">--W</span></div>
          <div class="socket-bar"><div class="socket-fill" id="pwr-fill-${id}"></div></div>
        </div>
      </div>`;
    }

    // sensor / switch — simple toggle card
    const svgSensor = `
  <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <circle cx="12" cy="10" r="3" fill="currentColor" opacity="0.8"/>
  <path d="M7 19 Q7 15 12 15 Q17 15 17 19" fill="currentColor" opacity="0.5"/>`;
    return `
      <div class="dcard" id="cd-${id}">
        <div class="top-h" id="tp-${id}">
          <div class="i-ring ${ringCls}" id="ir-${id}">${_icon(svgSensor)}</div>
          <div class="on-badge ba-off" id="ba-${id}">OFF</div>
        </div>
        <div class="bot-h">
          <div class="c-name" id="cn-${id}">${label}</div>
          <div class="c-sub sub-off" id="sb-${id}">OFF</div>
        </div>
      </div>`;
  }

  // ─── Card templates ────────────────────────────────────────────────────────
  _tplDen() {
    return `
      <div class="dcard on-y" id="cd-den">
        <div class="top-h bg-y" id="tp-den">
          <div class="i-ring ry" id="ir-den">
            <svg id="svg-den" viewBox="0 0 24 24" width="28" height="28">
  <g class="bulb-rays" opacity="0">
    <line x1="12" y1="1" x2="12" y2="3" stroke="rgba(255,230,60,0.9)" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="19.07" y1="3.93" x2="17.66" y2="5.34" stroke="rgba(255,230,60,0.7)" stroke-width="1.3" stroke-linecap="round"/>
    <line x1="21" y1="9.5" x2="19" y2="9.5" stroke="rgba(255,230,60,0.7)" stroke-width="1.3" stroke-linecap="round"/>
    <line x1="4.93" y1="3.93" x2="6.34" y2="5.34" stroke="rgba(255,230,60,0.7)" stroke-width="1.3" stroke-linecap="round"/>
    <line x1="3" y1="9.5" x2="5" y2="9.5" stroke="rgba(255,230,60,0.7)" stroke-width="1.3" stroke-linecap="round"/>
  </g>
  <path fill="currentColor" d="M12 3.5a5.5 5.5 0 0 1 5.5 5.5c0 2.1-1.18 3.93-2.92 4.87L14 15.5h-4l-.58-1.63A5.5 5.5 0 0 1 6.5 9 5.5 5.5 0 0 1 12 3.5z"/>
  <path class="bulb-filament" d="M10.5 10.5 L12 8.5 L13.5 10.5" stroke="rgba(255,240,120,0.0)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <rect x="10" y="15.5" width="4" height="1.2" rx="0.6" fill="currentColor" opacity="0.7"/>
  <rect x="10.5" y="17" width="3" height="1.1" rx="0.55" fill="currentColor" opacity="0.5"/>
  <rect x="11" y="18.3" width="2" height="1" rx="0.5" fill="currentColor" opacity="0.35"/>
</svg>
          </div>
          <div class="on-badge ba-y" id="ba-den">--</div>
        </div>
        <div class="bot-h">
          <div class="c-name">Đèn Chính</div>
          <div class="c-sub sub-y" id="sb-den">ON</div>
          <div class="bright-bar-wrap">
            <div class="bright-track" id="tr-den">
              <div class="bright-fill fill-y" id="fl-den" style="width:0%"></div>
              <div class="bright-thumb" id="th-den" style="left:0%"></div>
            </div>
            <span class="bright-val" id="vl-den">0%</span>
          </div>
        </div>
      </div>`;
  }


  _tplDecor() {
    return `
      <div class="dcard on-y" id="cd-decor">
        <div class="top-h bg-y" id="tp-decor">
          <div class="i-ring ry" id="ir-decor">
            <svg viewBox="0 0 24 24" width="28" height="28">
  <path d="M3 8 Q6 5 9 8 Q12 11 15 8 Q18 5 21 8" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linecap="round" opacity="0.6"/>
  <g fill="currentColor">
    <line x1="5" y1="8" x2="5" y2="10.5" stroke="currentColor" stroke-width="0.9" opacity="0.5"/>
    <ellipse cx="5" cy="12" rx="1.6" ry="2" fill="currentColor" opacity="0.9"/>
    <rect x="4.3" y="9.8" width="1.4" height="0.7" rx="0.35" fill="currentColor" opacity="0.55"/>
    <line x1="9.5" y1="8.5" x2="9.5" y2="11" stroke="currentColor" stroke-width="0.9" opacity="0.5"/>
    <ellipse cx="9.5" cy="12.5" rx="1.6" ry="2" fill="currentColor" opacity="0.9"/>
    <rect x="8.8" y="10.3" width="1.4" height="0.7" rx="0.35" fill="currentColor" opacity="0.55"/>
    <line x1="14" y1="8" x2="14" y2="10.5" stroke="currentColor" stroke-width="0.9" opacity="0.5"/>
    <ellipse cx="14" cy="12" rx="1.6" ry="2" fill="currentColor" opacity="0.9"/>
    <rect x="13.3" y="9.8" width="1.4" height="0.7" rx="0.35" fill="currentColor" opacity="0.55"/>
    <line x1="18.5" y1="8.5" x2="18.5" y2="11" stroke="currentColor" stroke-width="0.9" opacity="0.5"/>
    <ellipse cx="18.5" cy="12.5" rx="1.6" ry="2" fill="currentColor" opacity="0.9"/>
    <rect x="17.8" y="10.3" width="1.4" height="0.7" rx="0.35" fill="currentColor" opacity="0.55"/>
  </g>
  <g class="decor-sparks" opacity="0">
    <circle cx="5" cy="10" r="0.7" fill="rgba(255,245,100,0.9)"/>
    <circle cx="9.5" cy="10.5" r="0.7" fill="rgba(255,180,80,0.9)"/>
    <circle cx="14" cy="10" r="0.7" fill="rgba(255,245,100,0.9)"/>
    <circle cx="18.5" cy="10.5" r="0.7" fill="rgba(255,180,80,0.9)"/>
  </g>
</svg>
          </div>
          <div class="on-badge ba-y" id="ba-decor">--</div>
        </div>
        <div class="bot-h">
          <div class="c-name">Đèn Decor</div>
          <div class="c-sub sub-off" id="sb-decor">OFF</div>
          <div class="bright-bar-wrap">
            <div class="bright-track" id="tr-decor" style="display:none">
              <div class="bright-fill fill-y" id="fl-decor" style="width:0%"></div>
              <div class="bright-thumb" id="th-decor" style="left:0%"></div>
            </div>
            <div class="bright-track" id="tr-decor-dummy" style="opacity:0.3;pointer-events:none">
              <div class="bright-fill fill-y" style="width:100%"></div>
            </div>
            <span class="bright-val" id="vl-decor">--</span>
          </div>
        </div>
      </div>`;
  }


  _tplHien() {
    return `
      <div class="dcard on-or" id="cd-hien">
        <div class="top-h bg-or" id="tp-hien">
          <div class="i-ring ror" id="ir-hien">
            <svg viewBox="0 0 24 24" width="28" height="28">
  <line x1="12" y1="16" x2="12" y2="22" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity="0.7"/>
  <rect x="8.5" y="9" width="7" height="7" rx="1.5" fill="currentColor" opacity="0.85"/>
  <path d="M8 9 L12 5.5 L16 9Z" fill="currentColor" opacity="0.7"/>
  <path d="M8.5 16 L7 18 L17 18 L15.5 16Z" fill="currentColor" opacity="0.5"/>
  <line x1="12" y1="9" x2="12" y2="16" stroke="rgba(0,0,0,0.25)" stroke-width="0.8"/>
  <line x1="8.5" y1="12.5" x2="15.5" y2="12.5" stroke="rgba(0,0,0,0.25)" stroke-width="0.8"/>
  <rect x="9.5" y="10" width="5" height="5" rx="0.8" fill="rgba(255,200,80,0.0)" class="hien-inner"/>
  <circle cx="12" cy="4" r="0.9" fill="currentColor" opacity="0.9" class="hien-star"/>
</svg>
          </div>
          <div class="on-badge ba-or" id="ba-hien">--</div>
        </div>
        <div class="bot-h">
          <div class="c-name">Đèn Hiên</div>
          <div class="c-sub sub-off" id="sb-hien">OFF</div>
          <div class="bright-bar-wrap">
            <div class="bright-track" id="tr-hien" style="display:none">
              <div class="bright-fill fill-or" id="fl-hien" style="width:0%"></div>
              <div class="bright-thumb" id="th-hien" style="left:0%"></div>
            </div>
            <div class="bright-track" id="tr-hien-dummy" style="opacity:0.3;pointer-events:none">
              <div class="bright-fill fill-or" style="width:100%"></div>
            </div>
            <span class="bright-val" id="vl-hien">--</span>
          </div>
        </div>
      </div>`;
  }

  _tplRgb() {
    return `
      <div class="dcard on-r" id="cd-rgb" style="overflow:visible">
        <div class="top-h bg-r" id="tp-rgb">
          <div class="i-ring rr" id="ir-rgb">
            <svg class="anim-rgb" viewBox="0 0 24 24" width="28" height="28">
  <polygon points="12,3 20,18 4,18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
  <line x1="17.5" y1="13" x2="22" y2="11" stroke="#ff4444" stroke-width="1.3" stroke-linecap="round" opacity="0.85"/>
  <line x1="17.5" y1="14.5" x2="22" y2="14" stroke="#ffaa00" stroke-width="1.3" stroke-linecap="round" opacity="0.85"/>
  <line x1="17" y1="16" x2="22" y2="17" stroke="#44ff88" stroke-width="1.3" stroke-linecap="round" opacity="0.85"/>
  <line x1="16" y1="17.5" x2="20.5" y2="20" stroke="#44aaff" stroke-width="1.3" stroke-linecap="round" opacity="0.85"/>
  <line x1="2" y1="11" x2="9" y2="13.5" stroke="rgba(255,255,255,0.85)" stroke-width="1.5" stroke-linecap="round"/>
  <polygon points="12,6 18,17 6,17" fill="currentColor" opacity="0.12"/>
</svg>
          </div>
          <div class="on-badge ba-r" id="ba-rgb">--</div>
        </div>
        <div class="bot-h" id="rgb-bot">
          <div class="c-name">Đèn RGB</div>
          <div class="c-sub sub-r" id="sb-rgb">--</div>
          <div class="rainbow-bar" style="margin-top:1px"></div>
          <div class="rgb-btn" style="margin-top:2px"><span class="rgb-btn-text">${this._ct.rgbBtnLabel}</span></div>
        </div>
      </div>`;
  }


  _tplQuat() {
    return `
      <div class="dcard on-c" id="cd-quat">
        <div class="top-h bg-c" id="tp-quat">
          <div class="i-ring rc" id="ir-quat">
            <svg id="fan-svg" viewBox="0 0 24 24" width="28" height="28">
  <path d="M12 11 C10 8, 8 5.5, 10 4 C12 2.5, 13 5, 13 11Z" fill="currentColor" opacity="0.85"/>
  <path d="M13 12 C16 10, 18.5 8, 20 10 C21.5 12, 19 13, 13 13Z" fill="currentColor" opacity="0.75"/>
  <path d="M12 13 C14 16, 16 18.5, 14 20 C12 21.5, 11 19, 11 13Z" fill="currentColor" opacity="0.85"/>
  <path d="M11 12 C8 14, 5.5 16, 4 14 C2.5 12, 5 11, 11 11Z" fill="currentColor" opacity="0.75"/>
  <circle cx="12" cy="12" r="2.2" fill="currentColor"/>
  <circle cx="12" cy="12" r="1" fill="rgba(255,255,255,0.35)"/>
</svg>
          </div>
          <div class="on-badge ba-c" id="ba-quat">--</div>
        </div>
        <div class="bot-h">
          <div class="c-name">Quạt Trần</div>
          <div class="c-sub sub-c" id="sb-quat">--</div>
          <button class="spd-open-btn" id="spd-open-btn">⚡ Tốc độ <span id="vl-quat" class="spd-open-val">--</span></button>
        </div>
      </div>
      <!-- Speed popup -->
      <div class="spd-popup-overlay" id="spd-popup-overlay" style="display:none">
        <div class="spd-popup-sheet" id="spd-popup-sheet">
          <div class="spd-popup-handle"></div>
          <div class="spd-popup-title">${this._ct.fanPopupTitle}</div>
          <div class="spd-popup-grid">
            <div class="spd-btn" data-s="1">1<span class="spd-lv-lbl">Nhẹ</span></div>
            <div class="spd-btn" data-s="2">2<span class="spd-lv-lbl">Thấp</span></div>
            <div class="spd-btn" data-s="3">3<span class="spd-lv-lbl">Vừa</span></div>
            <div class="spd-btn" data-s="4">4<span class="spd-lv-lbl">Cao</span></div>
            <div class="spd-btn" data-s="5">5<span class="spd-lv-lbl">Tối đa</span></div>
          </div>
        </div>
      </div>`;
  }


  _tplOcam() {
    return `
      <div class="dcard on-gr" id="cd-ocam">
        <div class="top-h bg-gr" id="tp-ocam">
          <div class="i-ring rgr" id="ir-ocam">
            <svg class="anim-socket" viewBox="0 0 24 24" width="28" height="28">
  <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <rect x="8.5" y="7" width="2" height="3.5" rx="1" fill="currentColor" opacity="0.9"/>
  <rect x="13.5" y="7" width="2" height="3.5" rx="1" fill="currentColor" opacity="0.9"/>
  <path d="M10.5 14 A1.5 1.5 0 0 1 13.5 14 L13.5 15 A1.5 1.5 0 0 1 10.5 15 Z" fill="currentColor" opacity="0.7"/>
  <path d="M12.8 11 L11 14.5 L12.2 14.5 L11.2 17.5 L14 13 L12.7 13 L13.8 11Z" fill="currentColor" opacity="0.0" class="socket-bolt"/>
</svg>
          </div>
          <div class="on-badge ba-gr" id="ba-ocam">--</div>
        </div>
        <div class="bot-h">
          <div class="c-name">Ổ Cắm</div>
          <div class="c-sub sub-gr" id="sb-ocam">--</div>
          <div class="socket-stat"><span class="socket-stat-lbl">CÔNG SUẤT</span><span class="socket-stat-val" id="pwr-val">--W</span></div>
          <div class="socket-bar"><div class="socket-fill" id="pwr-fill"></div></div>
        </div>
      </div>`;
  }


  _updateTvStatus() {
    const E = this.ENTITIES;
    const tvState = E.tv ? this._hass?.states[E.tv] : null;
    const st = tvState?.state || 'unknown';
    const isOn = ['on','playing','paused','idle'].includes(st);
    const dot = this.shadowRoot.getElementById('tv-status-dot');
    const lbl = this.shadowRoot.getElementById('tv-status-label');
    const pwrBtn = this.shadowRoot.getElementById('tv-btn-power');
    if (dot) { dot.style.background = isOn ? '#00e090' : 'rgba(255,80,80,0.7)'; dot.style.boxShadow = isOn ? '0 0 8px #00e090' : 'none'; }
    if (lbl) { lbl.textContent = isOn ? 'ĐANG BẬT' : 'STANDBY'; lbl.style.color = isOn ? 'rgba(80,255,160,1)' : 'rgba(255,100,100,0.8)'; }
    if (pwrBtn) { pwrBtn.classList.toggle('tv-btn-power-on', isOn); }
  }

  _tplTv() {
    const t = this._ct;
    return `
      <div class="dcard on-b" id="cd-tv">
        <div class="top-h bg-b" id="tp-tv">
          <div class="i-ring rb" id="ir-tv">
            <svg viewBox="0 0 24 24" width="28" height="28">
  <rect x="2" y="4" width="20" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <rect x="3.5" y="5.5" width="17" height="10" rx="1.2" fill="currentColor" opacity="0.18" class="tv-screen-bg"/>
  <rect x="3.5" y="8" width="17" height="1.5" rx="0.75" fill="rgba(120,200,255,0.0)" class="tv-scan"/>
  <g class="tv-content" opacity="0">
    <path d="M3.5 15.5 L7 10 L10 13 L13 8.5 L17 13.5 L20.5 10.5 L20.5 15.5Z" fill="rgba(80,160,255,0.35)"/>
    <circle cx="17" cy="8.5" r="1.2" fill="rgba(255,230,60,0.7)"/>
  </g>
  <path d="M9 17 L9.5 20 L14.5 20 L15 17" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.7"/>
  <line x1="7" y1="20" x2="17" y2="20" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.7"/>
  <circle cx="19.5" cy="16" r="0.85" fill="currentColor" opacity="0.5" class="tv-power-dot"/>
</svg>
          </div>
          <div class="on-badge ba-b" id="ba-tv">--</div>
        </div>
        <div class="bot-h">
          <div class="c-name">Smart TV</div>
          <div class="c-sub sub-off" id="sb-tv">OFF</div>
          <button class="tv-remote-btn" id="tv-remote-btn">${t.tvControlBtn}</button>
        </div>
      </div>
      <!-- TV Remote Modal -->
      <div class="tv-modal-overlay" id="tv-modal-overlay" style="display:none">
        <div class="tv-modal-sheet" id="tv-modal-sheet">
          <div class="tv-modal-handle"></div>
          <div class="tv-modal-header">
            <div class="tv-modal-title-wrap">
              <span class="tv-modal-title">${t.tvModalTitle}</span>
              <div id="tv-status-dot" class="tv-status-dot"></div>
              <span id="tv-status-label" class="tv-status-label">---</span>
            </div>
            <button class="rgb-modal-close" id="tv-modal-close">✕</button>
          </div>
          <div class="tv-modal-body">
            <!-- Row 1: Power + Vol + Mute -->
            <div class="tv-row">
              <button class="tv-btn tv-btn-power" id="tv-btn-power">
                <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42A6.92 6.92 0 0 1 19 12c0 3.87-3.13 7-7 7A7 7 0 0 1 5 12c0-2.28 1.09-4.3 2.79-5.6L6.38 5A8.97 8.97 0 0 0 3 12a9 9 0 0 0 18 0c0-2.74-1.23-5.18-3.17-6.83z"/></svg>
                <span>${t.tvPower}</span>
              </button>
              <button class="tv-btn tv-btn-mute" id="tv-btn-mute">
                <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06A8.99 8.99 0 0 0 17.73 18L19 19.27 20.27 18 5.27 3 4.27 3zM12 4 9.91 6.09 12 8.18V4z"/></svg>
                <span>${t.tvMute}</span>
              </button>
              <button class="tv-btn tv-btn-vol" id="tv-btn-vol-down">
                <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M18.5 12A4.5 4.5 0 0 0 16 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5zm7-.17v6.34L9.83 13H7v-2h2.83L12 8.83z"/></svg>
                <span>${t.tvVolDown}</span>
              </button>
              <button class="tv-btn tv-btn-vol tv-btn-vol-up" id="tv-btn-vol-up">
                <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
                <span>${t.tvVolUp}</span>
              </button>
            </div>

            <!-- Row 2: Home + Menu + Back -->
            <div class="tv-row">
              <button class="tv-btn" id="tv-btn-home">
                <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
                <span>${t.tvHome}</span>
              </button>
              <button class="tv-btn" id="tv-btn-menu">
                <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
                <span>${t.tvMenu}</span>
              </button>
              <button class="tv-btn" id="tv-btn-back">
                <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
                <span>${t.tvBack}</span>
              </button>
              <button class="tv-btn" id="tv-btn-input">
                <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 3H5C3.9 3 3 3.9 3 5v14c0 1.1.9 2 2 2h15c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h15v14zM7 8h2v2H7zm0 4h2v2H7zm0 4h2v2H7zm10-8h-6v2h6V8zm0 4h-6v2h6v-2zm0 4h-6v2h6v-2z"/></svg>
                <span>${t.tvInput}</span>
              </button>
            </div>

            <!-- D-pad -->
            <div class="tv-dpad-wrap">
              <div class="tv-dpad">
                <div class="tv-dpad-row">
                  <div class="tv-dpad-spacer"></div>
                  <button class="tv-btn tv-btn-dpad" id="tv-btn-up">
                    <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>
                  </button>
                  <div class="tv-dpad-spacer"></div>
                </div>
                <div class="tv-dpad-row">
                  <button class="tv-btn tv-btn-dpad" id="tv-btn-left">
                    <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                  </button>
                  <button class="tv-btn tv-btn-ok" id="tv-btn-ok">OK</button>
                  <button class="tv-btn tv-btn-dpad" id="tv-btn-right">
                    <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                  </button>
                </div>
                <div class="tv-dpad-row">
                  <div class="tv-dpad-spacer"></div>
                  <button class="tv-btn tv-btn-dpad" id="tv-btn-down">
                    <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
                  </button>
                  <div class="tv-dpad-spacer"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }


  _tplMotion() {
    return `
      <div class="dcard on-pu" id="cd-motion">
        <div class="top-h bg-pu" id="tp-motion">
          <div class="i-ring rpu" id="ir-motion" style="position:relative">
            <svg id="motion-svg" viewBox="0 0 24 24" width="28" height="28">
  <circle cx="12" cy="4.5" r="2.2" fill="currentColor"/>
  <line x1="12" y1="6.7" x2="12" y2="13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
  <line id="arm-l" x1="12" y1="9" x2="8.5" y2="11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <line id="arm-r" x1="12" y1="9" x2="15.5" y2="7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <line id="leg-l" x1="12" y1="13" x2="9" y2="17.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <line id="leg-r" x1="12" y1="13" x2="15" y2="17.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <g class="motion-arcs" opacity="0">
    <path d="M5 6 Q3 9 5 12" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" opacity="0.6"/>
    <path d="M3.5 4.5 Q0.5 9 3.5 13.5" stroke="currentColor" stroke-width="1" fill="none" stroke-linecap="round" opacity="0.35"/>
    <path d="M19 6 Q21 9 19 12" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" opacity="0.6"/>
  </g>
</svg>
            <div class="pulse-dot" style="position:absolute;top:1px;right:1px"></div>
          </div>
          <div class="on-badge ba-pu" id="ba-motion">--</div>
        </div>
        <div class="bot-h">
          <div class="c-name">Cảm Biến</div>
          <div class="c-sub sub-pu" id="sb-motion">${this._ct.motionNo}</div>
          <!-- Người chào lại — to hơn, hiện khi detected -->
          <svg id="motion-greeter" viewBox="0 0 40 42" width="36" height="46"
               style="opacity:0;transition:opacity 0.4s;color:rgba(200,120,255,0.85);margin-top:4px;overflow:visible">
            <!-- đầu -->
            <circle cx="20" cy="6" r="4.5" fill="currentColor"/>
            <!-- thân -->
            <line x1="20" y1="10.5" x2="20" y2="26" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
            <!-- tay trái giơ lên chào (vẫy) -->
            <line id="g-arm-l" x1="20" y1="16" x2="8" y2="9"
                  stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
                  style="transform-origin:20px 16px;transform-box:fill-box"/>
            <!-- tay phải thả xuống -->
            <line x1="20" y1="16" x2="32" y2="22" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <!-- chân trái -->
            <line x1="20" y1="26" x2="13" y2="38" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <!-- chân phải -->
            <line x1="20" y1="26" x2="27" y2="38" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <!-- glow hào quang -->
            <circle cx="20" cy="6" r="8" fill="currentColor" opacity="0.07"/>
          </svg>
        </div>
      </div>`;
  }

}

// ─── Styles ─────────────────────────────────────────────────────────────────
const STYLES = `
*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}

/* ── Root: deep navy gradient + glass ── */
.root{
  border-radius:22px;overflow:visible;color:white;width:100%;position:relative;
  border:1px solid rgba(255,255,255,0.09);
  box-shadow:0 12px 48px rgba(0,0,0,0.7),inset 0 1px 0 rgba(255,255,255,0.06);
  backdrop-filter:blur(var(--root-blur,0px));
  -webkit-backdrop-filter:blur(var(--root-blur,0px));
  transition:backdrop-filter 0.3s ease, -webkit-backdrop-filter 0.3s ease;
}

/* ── Header ── */
.header{display:flex;justify-content:space-between;align-items:center;padding:12px 20px 10px;border-bottom:1px solid rgba(255,255,255,0.07);background:linear-gradient(180deg,rgba(255,255,255,0.04) 0%,transparent 100%)}
.h-title{font-size:22px;font-weight:800;color:white;letter-spacing:-0.3px;text-shadow:0 0 20px rgba(0,180,255,0.3)}
.h-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.h-score-pill{
  display:flex;align-items:center;gap:6px;
  background:linear-gradient(135deg,rgba(255,255,255,0.07) 0%,rgba(255,255,255,0.03) 100%);
  border:1px solid var(--sc-ring,rgba(255,255,255,0.15));
  border-radius:12px;
  box-shadow:0 0 12px var(--sc-ring,rgba(255,255,255,0.1)),inset 0 1px 0 rgba(255,255,255,0.08);
  transition:border-color 0.5s,box-shadow 0.5s;cursor:default;
  min-width:90px;
}
.h-gauge-wrap{width:60px;flex-shrink:0}
.h-gauge-svg{width:60px;height:35px;display:block;overflow:visible}
.h-score-lbl{font-size:10px;font-weight:700;letter-spacing:0.2px;opacity:0.9;transition:color 0.5s;white-space:nowrap;text-align:center}
.h-right{display:flex;flex-direction:column;align-items:flex-end;gap:2px}
.h-sub-row1{font-size:13px;color:rgba(255,255,255,0.5);white-space:nowrap;text-align:right}
.h-sub-row1 b{color:rgba(80,220,255,0.95);font-weight:700}
.h-sub-row2{font-size:12px;color:rgba(255,255,255,0.4);white-space:nowrap;text-align:right}
.h-dot{color:rgba(255,255,255,0.2);margin:0 4px}

/* ── Sensor row ── */
.sensor-row{display:flex;flex-direction:column;gap:8px;padding:10px 14px 8px}
.s-boxes{display:flex;flex-direction:row;gap:6px;width:100%}
.s-box{flex:1}
.s-box{
  background:linear-gradient(135deg,rgba(255,255,255,0.07) 0%,rgba(255,255,255,0.03) 100%);
  border-radius:10px;padding:6px 8px;display:flex;align-items:center;gap:6px;width:100%;
  border:1px solid rgba(220,60,60,0.3);
  box-shadow:0 2px 8px rgba(0,0,0,0.3),inset 0 1px 0 rgba(255,255,255,0.06);
  transition:border-color 0.3s,box-shadow 0.3s
}
.s-ico-wrap{width:22px;height:22px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.s-ico-svg{width:20px;height:20px;flex-shrink:0;color:rgba(255,100,80,0.9)}
.s-box:nth-child(2) .s-ico-svg{color:rgba(80,180,255,0.9)}
.s-val{font-size:22px;font-weight:800;color:white;line-height:1;letter-spacing:-0.5px}
.s-lbl{font-size:12px;font-weight:700;margin-top:2px;line-height:1.3}

/* status panel layout */
.sp-row-with-btns{display:flex;align-items:flex-start;gap:6px;min-width:0}
.sp-scroll-col{flex:1;min-width:0;overflow:hidden;display:flex;flex-direction:column}
.sp-mode-btns{display:flex;flex-direction:column;gap:4px;flex-shrink:0;width:68px;margin-top:-4px}
.sp-scroll-wrap{overflow:hidden;position:relative;min-width:0;transition:height 0.45s cubic-bezier(0.25,0.8,0.25,1)}
.sp-env-wrap{height:22px}
.sp-scroll-inner{display:flex;flex-direction:column;transition:transform 0.55s cubic-bezier(0.25,0.8,0.25,1)}
.sp-scroll-item{font-size:12px;line-height:1.5;white-space:normal;word-break:break-word;color:rgba(255,255,255,0.72);padding:3px 0;display:block;box-sizing:border-box}
.sp-env-wrap .sp-scroll-item{font-size:12px;padding:0;line-height:1.83;white-space:nowrap;word-break:normal}

/* sensor box state variants */
.s-box.box-danger{border-color:rgba(255,50,20,0.7);background:linear-gradient(135deg,rgba(255,40,10,0.18) 0%,rgba(255,255,255,0.03) 100%);box-shadow:0 2px 16px rgba(255,50,20,0.35),inset 0 1px 0 rgba(255,255,255,0.06)}
.s-box.box-warn{border-color:rgba(255,100,50,0.6);background:linear-gradient(135deg,rgba(255,80,30,0.12) 0%,rgba(255,255,255,0.03) 100%);box-shadow:0 2px 12px rgba(255,80,30,0.22),inset 0 1px 0 rgba(255,255,255,0.06)}
.s-box.box-caution{border-color:rgba(255,200,40,0.5);background:linear-gradient(135deg,rgba(255,200,30,0.1) 0%,rgba(255,255,255,0.03) 100%);box-shadow:0 2px 10px rgba(255,180,20,0.18),inset 0 1px 0 rgba(255,255,255,0.06)}
.s-box.box-cool{border-color:rgba(80,160,255,0.45);background:linear-gradient(135deg,rgba(80,160,255,0.1) 0%,rgba(255,255,255,0.03) 100%);box-shadow:0 2px 10px rgba(80,160,255,0.18),inset 0 1px 0 rgba(255,255,255,0.06)}
.s-box.box-cold{border-color:rgba(100,200,255,0.55);background:linear-gradient(135deg,rgba(100,200,255,0.14) 0%,rgba(255,255,255,0.03) 100%);box-shadow:0 2px 14px rgba(100,200,255,0.28),inset 0 1px 0 rgba(255,255,255,0.06)}
.s-box.box-humid-danger{border-color:rgba(80,100,255,0.6);background:linear-gradient(135deg,rgba(80,100,255,0.14) 0%,rgba(80,200,255,0.06) 100%);box-shadow:0 2px 16px rgba(60,80,255,0.3),inset 0 1px 0 rgba(255,255,255,0.06)}
.s-box.box-humid-high{border-color:rgba(60,160,255,0.55);background:linear-gradient(135deg,rgba(60,160,255,0.13) 0%,rgba(255,255,255,0.03) 100%);box-shadow:0 2px 14px rgba(40,140,255,0.25),inset 0 1px 0 rgba(255,255,255,0.06)}
.s-box.box-dry{border-color:rgba(255,160,40,0.5);background:linear-gradient(135deg,rgba(255,140,20,0.1) 0%,rgba(255,255,255,0.03) 100%);box-shadow:0 2px 10px rgba(255,140,20,0.2),inset 0 1px 0 rgba(255,255,255,0.06)}
.s-box.box-very-dry{border-color:rgba(200,100,20,0.6);background:linear-gradient(135deg,rgba(200,80,10,0.16) 0%,rgba(255,255,255,0.03) 100%);box-shadow:0 2px 14px rgba(200,80,10,0.28),inset 0 1px 0 rgba(255,255,255,0.06)}

/* label colors */
.lbl-ok{color:rgba(80,255,150,0.85)}
.lbl-caution{color:rgba(255,200,60,0.95)}
.lbl-warn{color:rgba(255,100,60,0.95)}
.lbl-danger{color:rgba(255,50,30,1);font-weight:800}
.lbl-cool{color:rgba(100,190,255,0.9)}
.lbl-cold{color:rgba(140,220,255,0.95)}
.lbl-dry{color:rgba(255,170,60,0.9)}

/* ── Sensor icon animations ── */
/* Fire / very hot */
@keyframes tempFire{
  0%,100%{filter:drop-shadow(0 0 4px rgba(255,80,20,0.6)) drop-shadow(0 0 8px rgba(255,120,0,0.4))}
  50%{filter:drop-shadow(0 0 10px rgba(255,60,0,1)) drop-shadow(0 0 18px rgba(255,100,0,0.6))}
}
.anim-temp-fire{animation:tempFire 1.4s ease-in-out infinite;color:rgba(255,80,20,0.95)}

/* Hot */
@keyframes tempHot{
  0%,100%{filter:drop-shadow(0 0 3px rgba(255,100,40,0.5))}
  50%{filter:drop-shadow(0 0 8px rgba(255,80,20,0.9))}
}
.anim-temp-hot{animation:tempHot 2s ease-in-out infinite;color:rgba(255,100,40,0.95)}

/* Warm */
@keyframes tempWarm{
  0%,100%{filter:drop-shadow(0 0 2px rgba(255,180,40,0.4))}
  50%{filter:drop-shadow(0 0 6px rgba(255,180,40,0.8))}
}
.anim-temp-warm{animation:tempWarm 2.5s ease-in-out infinite;color:rgba(255,185,40,0.95)}

/* Cool */
@keyframes tempCool{
  0%,100%{filter:drop-shadow(0 0 2px rgba(80,160,255,0.4))}
  50%{filter:drop-shadow(0 0 7px rgba(80,180,255,0.8))}
}
.anim-temp-cool{animation:tempCool 2.5s ease-in-out infinite;color:rgba(80,175,255,0.95)}

/* Cold snowflake spin + ice glow */
@keyframes tempCold{
  0%,100%{filter:drop-shadow(0 0 4px rgba(120,220,255,0.55)) drop-shadow(0 0 8px rgba(80,180,255,0.3));transform:rotate(0deg)}
  50%{filter:drop-shadow(0 0 10px rgba(140,240,255,0.9)) drop-shadow(0 0 18px rgba(80,200,255,0.5));transform:rotate(180deg)}
}
.anim-temp-cold{animation:tempCold 4s ease-in-out infinite;transform-origin:center;transform-box:fill-box;color:rgba(140,225,255,0.98)}

/* Humidity high storm */
@keyframes humiStorm{
  0%,100%{filter:drop-shadow(0 0 4px rgba(80,100,255,0.5)) drop-shadow(0 0 8px rgba(60,80,255,0.3))}
  50%{filter:drop-shadow(0 0 10px rgba(100,120,255,0.9)) drop-shadow(0 0 18px rgba(80,100,255,0.5))}
}
.anim-humi-storm{animation:humiStorm 1.6s ease-in-out infinite;color:rgba(100,130,255,0.95)}

/* Humidity high bounce */
@keyframes humiHigh{
  0%,100%{filter:drop-shadow(0 0 3px rgba(60,160,255,0.5));transform:translateY(0)}
  50%{filter:drop-shadow(0 0 8px rgba(60,160,255,0.85));transform:translateY(-1.5px)}
}
.anim-humi-high{animation:humiHigh 2s ease-in-out infinite;color:rgba(60,165,255,0.95)}

/* Humidity mid */
@keyframes humiMid{
  0%,100%{filter:drop-shadow(0 0 2px rgba(100,180,255,0.4))}
  50%{filter:drop-shadow(0 0 6px rgba(100,190,255,0.75))}
}
.anim-humi-mid{animation:humiMid 2.5s ease-in-out infinite;color:rgba(100,185,255,0.9)}

/* Dry - flicker */
@keyframes humiDry{
  0%,100%{filter:drop-shadow(0 0 2px rgba(255,160,40,0.4));opacity:1}
  40%{filter:drop-shadow(0 0 5px rgba(255,150,30,0.7));opacity:0.8}
  60%{opacity:1}
}
.anim-humi-dry{animation:humiDry 2.2s ease-in-out infinite;color:rgba(255,165,50,0.85)}

/* Very dry */
@keyframes humiVDry{
  0%,100%{filter:drop-shadow(0 0 3px rgba(200,100,20,0.5))}
  50%{filter:drop-shadow(0 0 8px rgba(210,90,10,0.9))}
}
.anim-humi-vdry{animation:humiVDry 2s ease-in-out infinite;color:rgba(210,110,30,0.95)}

.s-box.box-warn{border-color:rgba(255,100,50,0.6);background:linear-gradient(135deg,rgba(255,80,30,0.1) 0%,rgba(255,255,255,0.03) 100%);box-shadow:0 2px 12px rgba(255,80,30,0.2),inset 0 1px 0 rgba(255,255,255,0.06)}

/* ── Status panel ── */
.status-panel{
  flex:1;
  background:linear-gradient(135deg,rgba(255,255,255,0.06) 0%,rgba(255,255,255,0.02) 100%);
  border-radius:12px;padding:10px 12px;
  border:1px solid rgba(255,255,255,0.09);
  box-shadow:0 2px 8px rgba(0,0,0,0.25),inset 0 1px 0 rgba(255,255,255,0.06);
  display:flex;flex-direction:column;justify-content:flex-start;gap:4px
}
.st-row{display:flex;align-items:center;gap:5px;font-size:12px}
.st-ico{color:rgba(255,255,255,0.5);flex-shrink:0}
.st-key{color:rgba(255,255,255,0.5);font-size:11px}
.st-on{color:#4ade80;font-weight:800;font-size:13px;text-shadow:0 0 10px rgba(74,222,128,0.5)}
.st-off{color:rgba(80,160,255,0.9);font-weight:800;font-size:13px}
.warn-badge{display:inline-flex;align-items:center;gap:3px;background:rgba(255,150,0,0.15);color:#ffbb44;border-radius:5px;padding:2px 5px;font-size:10px;font-weight:700;border:1px solid rgba(255,150,0,0.2)}

/* Scroll rows inside status panel — defined above in sp-row-with-btns section */

/* Smart bar body */
.sm-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.sm-mode-bar{height:18px;overflow:hidden;position:relative}
.sm-mode-txt{font-size:10px;color:rgba(255,255,255,0.4);white-space:nowrap}
.sm-auto-item{font-size:10px;color:rgba(255,255,255,0.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:18px;line-height:18px}
.sm-auto-item b{color:rgba(0,230,255,0.9)}

/* ── Graph ── */
.graph-sec{padding:4px 6px 0;position:relative}
.g-top{display:flex;justify-content:space-between;margin-bottom:4px;align-items:center}
.g-tl{font-size:12px;font-weight:700;color:rgba(255,210,60,0.85);text-shadow:0 0 8px rgba(255,200,50,0.5);letter-spacing:0.3px}
.g-tr{font-size:11px;font-weight:700;color:rgba(0,240,180,0.8);text-shadow:0 0 8px rgba(0,240,180,0.4);letter-spacing:0.3px}
.g-trend{font-size:13px;font-weight:900;margin-left:4px;transition:color 0.4s;cursor:default}
.g-hover-tip{
  position:absolute;pointer-events:none;
  background:linear-gradient(135deg,rgba(4,14,38,0.97) 0%,rgba(2,8,22,0.98) 100%);
  border:1px solid rgba(0,200,255,0.3);border-radius:9px;
  padding:6px 9px;font-size:10px;min-width:110px;
  box-shadow:0 4px 16px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.07);
  z-index:10;
}
.g-ht-time{font-size:9px;color:rgba(255,255,255,0.35);font-weight:700;margin-bottom:3px;letter-spacing:0.3px}
.g-ht-row{font-size:11px;font-weight:800;line-height:1.5}
.g-ht-reason{font-size:9px;color:rgba(255,160,80,0.75);margin-top:2px;font-style:italic}
canvas#mg{
  width:100%;height:100px;display:block;
  border-radius:8px;
  background:transparent;
  box-shadow:none;
}
.tooltip-b{
  position:absolute;
  background:rgba(0,8,25,0.88);
  border:1px solid rgba(0,220,255,0.3);
  border-radius:7px;
  padding:0 8px;
  font-size:10px;font-weight:800;color:white;
  line-height:20px;height:20px;
  pointer-events:none;white-space:nowrap;
  box-shadow:0 2px 12px rgba(0,0,0,0.45);
  z-index:5;
  backdrop-filter:blur(4px);
}
.tt-peak-temp{border-color:rgba(255,200,50,0.55);color:rgba(255,220,80,1);text-shadow:0 0 8px rgba(255,200,50,0.8)}
.tt-peak-pwr{border-color:rgba(0,240,180,0.55);color:rgba(0,255,190,1);text-shadow:0 0 8px rgba(0,240,180,0.8)}
.tt-min-temp{border-color:rgba(80,200,255,0.55);color:rgba(120,220,255,1);text-shadow:0 0 8px rgba(80,200,255,0.8)}
.tt-t{color:rgba(0,255,200,0.9);font-weight:700}
.g-times{display:flex;justify-content:space-between;font-size:11px;color:rgba(0,200,255,0.3);padding:3px 0 4px;text-shadow:0 0 4px rgba(0,200,255,0.15)}
.g-stats-row{
  display:flex;align-items:center;gap:0;
  background:linear-gradient(135deg,rgba(255,255,255,0.05) 0%,rgba(255,255,255,0.02) 100%);
  border-radius:10px;margin:0 0 6px;
  border:1px solid rgba(255,255,255,0.07);
  box-shadow:inset 0 1px 0 rgba(255,255,255,0.05);
  overflow:hidden
}
.g-stat{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding:7px 4px}
.g-stat-lbl{font-size:10px;color:rgba(255,255,255,0.35);font-weight:600;letter-spacing:0.1px;text-align:center}
.g-stat-val{font-size:15px;font-weight:800;letter-spacing:-0.3px}
.g-stat-sep{width:1px;height:30px;background:rgba(255,255,255,0.07);flex-shrink:0}

/* ── Smart bar ── */
.smart-bar{
  margin:4px 14px 10px;
  background:linear-gradient(135deg,rgba(0,180,255,0.08) 0%,rgba(255,255,255,0.03) 100%);
  border:1px solid rgba(0,200,255,0.15);
  border-radius:14px;padding:8px 10px;
  display:flex;align-items:center;justify-content:space-between;gap:8px;
  box-shadow:0 2px 8px rgba(0,0,0,0.2),inset 0 1px 0 rgba(255,255,255,0.05)
}
.sm-left{display:flex;align-items:flex-start;gap:8px;flex:1;min-width:0;overflow:hidden}
.sm-ico{width:18px;height:18px;flex-shrink:0;color:rgba(0,200,255,0.75);margin-top:1px}
.sm-ticker-wrap{overflow:hidden;height:18px;position:relative}
.sm-ticker{
  font-size:11px;color:rgba(255,255,255,0.7);white-space:nowrap;
  display:inline-block;
  animation:tickerScroll 20s linear infinite;
}
@keyframes tickerScroll{
  0%{transform:translateX(100%)}
  100%{transform:translateX(-100%)}
}
.sm-btns{display:flex;gap:5px;flex-shrink:0}
.btn-manual{
  background:rgba(255,255,255,0.08);
  border:1px solid rgba(255,255,255,0.15);color:rgba(255,255,255,0.55);
  font-size:11px;font-weight:700;border-radius:8px;padding:6px 6px;
  cursor:pointer;white-space:nowrap;width:100%;
  box-shadow:0 3px 0 rgba(0,0,0,0.4),0 4px 8px rgba(0,0,0,0.2),inset 0 1px 0 rgba(255,255,255,0.12);
  transition:all 0.1s;
  transform:perspective(200px) rotateX(0deg) translateY(0px)
}
.btn-manual:active{
  transform:perspective(200px) rotateX(8deg) translateY(3px);
  box-shadow:0 0px 0 rgba(0,0,0,0.4),0 1px 4px rgba(0,0,0,0.2),inset 0 2px 3px rgba(0,0,0,0.25);
}
.btn-manual-active{
  background:linear-gradient(135deg,rgba(0,180,255,0.3) 0%,rgba(0,120,220,0.3) 100%);
  border-color:rgba(0,200,255,0.55);color:rgba(0,235,255,1);
  box-shadow:0 3px 0 rgba(0,80,160,0.5),0 4px 10px rgba(0,150,255,0.2),inset 0 1px 0 rgba(0,255,255,0.15);
}
.btn-manual-active:active{
  box-shadow:0 0px 0 rgba(0,80,160,0.5),0 1px 4px rgba(0,150,255,0.1),inset 0 2px 3px rgba(0,0,0,0.2);
}
.btn-auto-mode{
  background:rgba(255,255,255,0.06);
  border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.45);
  font-size:11px;font-weight:700;border-radius:8px;padding:6px 6px;
  cursor:pointer;white-space:nowrap;width:100%;
  box-shadow:0 3px 0 rgba(0,0,0,0.4),0 4px 8px rgba(0,0,0,0.2),inset 0 1px 0 rgba(255,255,255,0.1);
  transition:all 0.1s;
  transform:perspective(200px) rotateX(0deg) translateY(0px)
}
.btn-auto-mode:active{
  transform:perspective(200px) rotateX(8deg) translateY(3px);
  box-shadow:0 0px 0 rgba(0,0,0,0.4),0 1px 4px rgba(0,0,0,0.2),inset 0 2px 3px rgba(0,0,0,0.25);
}
.btn-auto-active{
  background:linear-gradient(135deg,rgba(80,220,120,0.25) 0%,rgba(20,180,80,0.2) 100%);
  border-color:rgba(60,220,120,0.6);color:rgba(80,250,145,1);
  box-shadow:0 3px 0 rgba(10,100,40,0.55),0 4px 10px rgba(40,200,100,0.2),inset 0 1px 0 rgba(100,255,160,0.15);
}
.btn-auto-active:active{
  box-shadow:0 0px 0 rgba(10,100,40,0.55),0 1px 4px rgba(40,200,100,0.1),inset 0 2px 3px rgba(0,0,0,0.2);
}
.btn-settings{
  background:rgba(255,255,255,0.06);
  border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.5);
  font-size:13px;border-radius:8px;padding:5px 4px;
  cursor:pointer;width:100%;
  box-shadow:0 3px 0 rgba(0,0,0,0.4),0 4px 8px rgba(0,0,0,0.2),inset 0 1px 0 rgba(255,255,255,0.08);
  transition:all 0.1s;
  transform:perspective(200px) rotateX(0deg) translateY(0px)
}
.btn-settings:active{
  transform:perspective(200px) rotateX(8deg) translateY(3px);
  box-shadow:0 0 0 rgba(0,0,0,0.4),inset 0 2px 3px rgba(0,0,0,0.25);
}
.btn-settings.asp-open{
  background:rgba(255,200,60,0.18);
  border-color:rgba(255,200,60,0.5);color:rgba(255,220,80,1);
  box-shadow:0 3px 0 rgba(120,80,0,0.5),0 4px 10px rgba(255,180,0,0.15),inset 0 1px 0 rgba(255,220,60,0.15);
}
/* Settings panel */
.auto-settings-panel{
  margin:6px 0 0 0;
  background:rgba(255,255,255,0.04);
  border:1px solid rgba(255,255,255,0.1);
  border-radius:10px;padding:10px 12px 10px;
  animation:asp-in 0.18s cubic-bezier(.25,.8,.25,1);
}
@keyframes asp-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
.asp-title{font-size:12px;font-weight:700;color:rgba(255,220,80,0.9);margin-bottom:8px;letter-spacing:.3px}
.asp-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.asp-lbl{font-size:11px;color:rgba(255,255,255,0.6);font-weight:600}
.asp-delay-wrap{display:flex;align-items:center;gap:5px}
.asp-step{
  background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.18);
  color:rgba(255,255,255,0.8);font-size:15px;font-weight:700;
  border-radius:6px;width:26px;height:26px;cursor:pointer;padding:0;line-height:1;
  display:flex;align-items:center;justify-content:center;
}
.asp-step:active{background:rgba(255,255,255,0.2)}
.asp-delay-val{font-size:18px;font-weight:800;color:rgba(255,220,80,1);min-width:24px;text-align:center}
.asp-delay-unit{font-size:11px;color:rgba(255,255,255,0.5)}
.asp-dev-list{display:flex;flex-wrap:wrap;gap:5px;margin-top:2px}
.asp-dev-chip{
  display:flex;align-items:center;gap:4px;
  padding:4px 8px;border-radius:20px;font-size:11px;font-weight:600;cursor:pointer;
  border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.07);
  color:rgba(255,255,255,0.5);transition:all 0.15s;user-select:none;
}
.asp-dev-chip.on{
  background:rgba(60,200,120,0.18);border-color:rgba(60,220,120,0.5);
  color:rgba(80,250,145,1);
}
.asp-dev-chip.on::before{content:"✓ ";font-size:10px}

/* ── Device row ── */
.dev-wrap{position:relative;padding:3px 0 14px;overflow:hidden}
.dev-row{display:flex;gap:8px;padding:0 14px;overflow-x:scroll;scrollbar-width:none;scroll-behavior:smooth;-webkit-overflow-scrolling:touch;touch-action:pan-x pan-y;scroll-snap-type:x mandatory}
.dev-row::-webkit-scrollbar{display:none}
.scroll-hint{
  position:absolute;right:0;top:0;bottom:14px;width:56px;
  pointer-events:none;overflow:hidden;
}
.scroll-hint::before{
  content:'';
  position:absolute;inset:0;
  backdrop-filter:blur(8px);
  -webkit-backdrop-filter:blur(8px);
  -webkit-mask-image:linear-gradient(to left,black 0%,black 25%,transparent 100%);
  mask-image:linear-gradient(to left,black 0%,black 25%,transparent 100%);
}

/* ── Device card ── */
.dcard{
  width:96px;flex-shrink:0;border-radius:16px;overflow:visible;display:flex;flex-direction:column;
  border:1px solid rgba(255,255,255,0.1);
  background:linear-gradient(160deg,rgba(255,255,255,0.08) 0%,rgba(255,255,255,0.03) 100%);
  box-shadow:0 6px 0 rgba(0,0,0,0.45),0 8px 20px rgba(0,0,0,0.4),inset 0 1px 0 rgba(255,255,255,0.14);
  transition:border-color 0.25s,box-shadow 0.12s,transform 0.12s;
  user-select:none;position:relative;scroll-snap-align:start;
  transform:perspective(400px) rotateX(0deg) translateY(0px)
}
.dcard:active{
  transform:perspective(400px) rotateX(4deg) translateY(4px);
  box-shadow:0 2px 0 rgba(0,0,0,0.5),0 3px 10px rgba(0,0,0,0.35),inset 0 2px 4px rgba(0,0,0,0.25),inset 0 1px 0 rgba(255,255,255,0.06);
}
.dcard.on-y{border-color:rgba(255,200,50,0.5);background:linear-gradient(160deg,rgba(255,200,50,0.14) 0%,rgba(255,160,20,0.06) 100%);box-shadow:0 4px 20px rgba(255,180,30,0.2),inset 0 1px 0 rgba(255,230,80,0.2)}
.dcard.on-c{border-color:rgba(0,200,255,0.5);background:linear-gradient(160deg,rgba(0,200,255,0.13) 0%,rgba(0,150,255,0.06) 100%);box-shadow:0 4px 20px rgba(0,180,255,0.2),inset 0 1px 0 rgba(0,230,255,0.2)}
.dcard.on-r{border-color:rgba(180,80,255,0.5);background:linear-gradient(160deg,rgba(180,80,255,0.14) 0%,rgba(140,40,255,0.06) 100%);box-shadow:0 4px 20px rgba(160,60,255,0.2),inset 0 1px 0 rgba(200,130,255,0.2)}
.dcard.on-b{border-color:rgba(80,140,255,0.5);background:linear-gradient(160deg,rgba(80,140,255,0.13) 0%,rgba(60,100,255,0.06) 100%);box-shadow:0 4px 20px rgba(80,120,255,0.2),inset 0 1px 0 rgba(120,180,255,0.2)}
.dcard.on-gr{border-color:rgba(60,220,120,0.5);background:linear-gradient(160deg,rgba(60,220,120,0.13) 0%,rgba(20,180,80,0.06) 100%);box-shadow:0 4px 20px rgba(40,200,100,0.2),inset 0 1px 0 rgba(80,255,150,0.2)}
.dcard.on-pu{border-color:rgba(160,80,220,0.5);background:linear-gradient(160deg,rgba(160,80,220,0.14) 0%,rgba(120,40,200,0.06) 100%);box-shadow:0 4px 20px rgba(140,60,220,0.2),inset 0 1px 0 rgba(190,110,255,0.2)}
.dcard.on-or{border-color:rgba(255,130,30,0.5);background:linear-gradient(160deg,rgba(255,130,30,0.14) 0%,rgba(255,90,10,0.06) 100%);box-shadow:0 4px 20px rgba(255,110,20,0.2),inset 0 1px 0 rgba(255,180,80,0.2)}

/* ── Card top ── */
.top-h{
  padding:8px 9px 8px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;
  position:relative;border-bottom:1px solid rgba(255,255,255,0.07);
  transition:background 0.3s,opacity 0.15s;cursor:pointer;border-radius:16px 16px 0 0;
  min-height:62px
}
.top-h:active{filter:brightness(0.88)}
.top-h.bg-y{background:radial-gradient(ellipse at 25% 0%,rgba(255,210,60,0.22) 0%,transparent 65%)}
.top-h.bg-c{background:radial-gradient(ellipse at 25% 0%,rgba(0,200,255,0.18) 0%,transparent 65%)}
.top-h.bg-r{background:radial-gradient(ellipse at 25% 0%,rgba(180,80,255,0.22) 0%,transparent 65%)}
.top-h.bg-b{background:radial-gradient(ellipse at 25% 0%,rgba(80,140,255,0.18) 0%,transparent 65%)}
.top-h.bg-gr{background:radial-gradient(ellipse at 25% 0%,rgba(60,220,120,0.18) 0%,transparent 65%)}
.top-h.bg-pu{background:radial-gradient(ellipse at 25% 0%,rgba(160,80,220,0.22) 0%,transparent 65%)}
.top-h.bg-or{background:radial-gradient(ellipse at 25% 0%,rgba(255,130,30,0.22) 0%,transparent 65%)}

/* ── Icon ring: glass + depth ── */
.i-ring{
  width:46px;height:46px;border-radius:13px;display:flex;align-items:center;justify-content:center;
  border:1px solid rgba(255,255,255,0.12);
  background:linear-gradient(145deg,rgba(255,255,255,0.14) 0%,rgba(255,255,255,0.04) 100%);
  box-shadow:0 4px 0 rgba(0,0,0,0.35),0 5px 12px rgba(0,0,0,0.3),inset 0 1px 0 rgba(255,255,255,0.22);
  transition:all 0.12s;
  transform:translateY(0px)
}
.top-h:active .i-ring{
  transform:translateY(3px);
  box-shadow:0 1px 0 rgba(0,0,0,0.4),0 2px 6px rgba(0,0,0,0.25),inset 0 2px 4px rgba(0,0,0,0.2),inset 0 1px 0 rgba(255,255,255,0.1);
}
.i-ring.ry{background:linear-gradient(145deg,rgba(255,210,60,0.28) 0%,rgba(255,160,20,0.14) 100%);border-color:rgba(255,210,60,0.55);box-shadow:0 3px 14px rgba(255,180,30,0.3),inset 0 1px 0 rgba(255,240,100,0.3);color:rgba(255,225,70,0.98)}
.i-ring.rc{background:linear-gradient(145deg,rgba(0,210,255,0.25) 0%,rgba(0,150,255,0.12) 100%);border-color:rgba(0,200,255,0.55);box-shadow:0 3px 14px rgba(0,180,255,0.3),inset 0 1px 0 rgba(0,240,255,0.3);color:rgba(0,225,255,0.98)}
.i-ring.rr{background:linear-gradient(145deg,rgba(200,80,255,0.25) 0%,rgba(150,40,255,0.12) 100%);border-color:rgba(190,90,255,0.55);box-shadow:0 3px 14px rgba(160,60,255,0.3),inset 0 1px 0 rgba(210,140,255,0.3);color:rgba(210,140,255,0.98)}
.i-ring.rb{background:linear-gradient(145deg,rgba(80,150,255,0.25) 0%,rgba(50,100,255,0.12) 100%);border-color:rgba(80,140,255,0.55);box-shadow:0 3px 14px rgba(80,120,255,0.3),inset 0 1px 0 rgba(130,190,255,0.3);color:rgba(110,185,255,0.98)}
.i-ring.rgr{background:linear-gradient(145deg,rgba(60,230,120,0.22) 0%,rgba(20,180,80,0.1) 100%);border-color:rgba(60,220,120,0.55);box-shadow:0 3px 14px rgba(40,200,100,0.3),inset 0 1px 0 rgba(100,255,160,0.3);color:rgba(80,245,145,0.98)}
.i-ring.rpu{background:linear-gradient(145deg,rgba(170,80,230,0.24) 0%,rgba(120,40,200,0.12) 100%);border-color:rgba(160,80,220,0.55);box-shadow:0 3px 14px rgba(140,60,220,0.3),inset 0 1px 0 rgba(200,120,255,0.3);color:rgba(200,120,255,0.98)}
.i-ring.ror{background:linear-gradient(145deg,rgba(255,140,30,0.26) 0%,rgba(255,90,10,0.12) 100%);border-color:rgba(255,130,30,0.55);box-shadow:0 3px 14px rgba(255,110,20,0.3),inset 0 1px 0 rgba(255,190,90,0.3);color:rgba(255,170,60,0.98)}
.i-ring svg{width:28px;height:28px}
.i-ring:not(.ry):not(.rc):not(.rr):not(.rb):not(.rgr):not(.rpu):not(.ror) svg{color:rgba(255,255,255,0.4)}

.c-name-badge{width:100%;display:flex;align-items:center;justify-content:flex-start}
.c-name{font-size:11px;font-weight:700;color:rgba(255,255,255,0.88);letter-spacing:0px;line-height:1.2;text-align:center;display:block;width:100%}
.tog-wrap{display:none}

/* Brightness bar for lights */
.bright-bar-wrap{width:100%;display:flex;align-items:center;gap:4px;margin-top:2px}
.bright-track{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,0.08);position:relative;box-shadow:inset 0 1px 2px rgba(0,0,0,0.3)}
.bright-fill{height:100%;border-radius:2px;transition:width 0.4s}
.bright-val{font-size:9px;font-weight:700;color:rgba(255,255,255,0.5);flex-shrink:0;min-width:22px;text-align:right}
.bright-thumb{width:11px;height:11px;border-radius:50%;background:white;position:absolute;top:50%;transform:translate(-50%,-50%);pointer-events:none;box-shadow:0 1px 6px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.5)}
.bright-track{cursor:pointer}

/* ON/OFF badge */
.on-badge{font-size:8px;font-weight:800;letter-spacing:0.2px;padding:2px 6px;border-radius:20px;display:inline-flex;align-items:center;gap:2px;position:absolute;top:6px;right:6px;box-shadow:0 1px 4px rgba(0,0,0,0.3)}
.on-badge::before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor;opacity:0.85;flex-shrink:0}
.ba-y{background:rgba(255,200,50,0.22);color:rgba(255,220,70,1);border:1px solid rgba(255,200,50,0.35)}
.ba-c{background:rgba(0,200,255,0.18);color:rgba(0,225,255,1);border:1px solid rgba(0,200,255,0.35)}
.ba-r{background:rgba(180,80,255,0.2);color:rgba(205,135,255,1);border:1px solid rgba(180,80,255,0.35)}
.ba-b{background:rgba(80,140,255,0.18);color:rgba(115,180,255,1);border:1px solid rgba(80,140,255,0.35)}
.ba-gr{background:rgba(60,220,120,0.18);color:rgba(85,245,145,1);border:1px solid rgba(60,220,120,0.35)}
.ba-pu{background:rgba(160,80,220,0.2);color:rgba(195,115,255,1);border:1px solid rgba(160,80,220,0.35)}
.ba-or{background:rgba(255,130,30,0.2);color:rgba(255,165,65,1);border:1px solid rgba(255,130,30,0.35)}
.ba-off{background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.3);border:1px solid rgba(255,255,255,0.1)}

/* Card bottom */
.bot-h{padding:6px 7px 8px;display:flex;flex-direction:column;gap:0;border-radius:0 0 16px 16px;align-items:center;height:60px;justify-content:space-between;overflow:hidden;box-sizing:border-box}
.c-sub{font-weight:600;min-height:12px;font-size:10px;text-align:center;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:none;}
.sub-off{color:rgba(255,255,255,0.25)}
.sub-y{color:rgba(255,215,60,0.95)}.sub-c{color:rgba(0,225,255,0.95)}.sub-r{color:rgba(205,135,255,0.95)}
.sub-b{color:rgba(110,180,255,0.95)}.sub-gr{color:rgba(80,245,145,0.95)}.sub-pu{color:rgba(195,115,255,0.95)}
.sub-or{color:rgba(255,165,65,0.95)}
.sl-lbl{display:flex;justify-content:space-between;align-items:center;margin-top:1px}
.sl-lbl span:first-child{font-size:9px;color:rgba(255,255,255,0.3);font-weight:700;letter-spacing:0.3px}
.sl-lbl span:last-child{font-size:9px;font-weight:700;color:rgba(255,255,255,0.6)}
.track{width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,0.08);position:relative;cursor:pointer;box-shadow:inset 0 1px 2px rgba(0,0,0,0.3)}
.fill-y{height:100%;border-radius:2px;background:linear-gradient(90deg,rgba(255,160,20,0.8),rgba(255,235,60,1))}
.fill-c{height:100%;border-radius:2px;background:linear-gradient(90deg,rgba(0,160,255,0.8),rgba(0,245,220,1))}
.fill-or{height:100%;border-radius:2px;background:linear-gradient(90deg,rgba(255,110,20,0.8),rgba(255,180,50,1))}
.thumb{width:11px;height:11px;border-radius:50%;background:white;position:absolute;top:50%;transform:translate(-50%,-50%);pointer-events:none;box-shadow:0 1px 6px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.5)}
/* Speed open button */
.spd-open-btn{
  width:100%;padding:3px 6px;border-radius:20px;font-size:10px;font-weight:600;
  background:rgba(255,255,255,0.08);
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  border:1px solid rgba(255,255,255,0.14);
  color:rgba(255,255,255,0.82);
  cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px;
  box-shadow:0 1px 0 rgba(255,255,255,0.06) inset, 0 2px 8px rgba(0,0,0,0.25);
  transition:all 0.2s;margin-top:1px;
  white-space:nowrap;overflow:hidden;box-sizing:border-box;
}
.spd-open-btn.fan-on{
  border-color:rgba(0,200,255,0.4);
  box-shadow:0 0 8px rgba(0,180,255,0.2),0 1px 0 rgba(255,255,255,0.1) inset, 0 2px 8px rgba(0,0,0,0.2);
  color:rgba(160,235,255,0.95);
  background:rgba(0,180,255,0.1);
}
.spd-open-btn:active{
  opacity:0.7;
}
.spd-open-val{color:rgba(255,255,255,0.9);font-size:10px;font-weight:700}
/* Speed popup overlay */
.spd-popup-overlay{
  position:fixed;top:0;left:0;right:0;bottom:0;z-index:9998;
  background:rgba(0,0,0,0);
  display:flex;align-items:flex-end;justify-content:center;
  transition:background 0.28s;pointer-events:none
}
.spd-popup-overlay.spd-visible{background:rgba(0,0,15,0.65);pointer-events:all}
.spd-popup-sheet{
  width:100%;max-width:420px;
  background:linear-gradient(170deg,rgba(6,18,42,0.99) 0%,rgba(4,10,28,1) 100%);
  border-radius:20px 20px 0 0;
  border:1px solid rgba(0,200,255,0.2);border-bottom:none;
  padding:0 16px 24px;
  box-shadow:0 -6px 30px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.06);
  transform:translateY(100%);
  transition:transform 0.28s cubic-bezier(0.32,0.72,0,1)
}
.spd-popup-sheet.spd-visible{transform:translateY(0)}
.spd-popup-handle{width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,0.15);margin:10px auto 12px}
.spd-popup-title{font-size:13px;font-weight:800;color:rgba(0,220,255,0.9);text-align:center;margin-bottom:14px;letter-spacing:0.2px}
.spd-popup-grid{display:flex;gap:8px}
.spd-btn{
  flex:1;padding:10px 0 8px;border-radius:10px;font-size:13px;font-weight:800;
  text-align:center;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:2px;
  background:linear-gradient(160deg,rgba(0,200,255,0.1) 0%,rgba(0,150,255,0.05) 100%);
  border:1px solid rgba(0,200,255,0.2);color:rgba(0,200,255,0.5);
  box-shadow:0 4px 0 rgba(0,80,130,0.55),0 5px 10px rgba(0,0,0,0.25),inset 0 1px 0 rgba(255,255,255,0.1);
  transition:all 0.1s;
  transform:perspective(300px) rotateX(0deg) translateY(0px)
}
.spd-btn:active{
  transform:perspective(300px) rotateX(8deg) translateY(4px);
  box-shadow:0 0px 0 rgba(0,80,130,0.55),0 1px 5px rgba(0,0,0,0.2),inset 0 2px 4px rgba(0,0,0,0.2),inset 0 1px 0 rgba(255,255,255,0.06);
}
.spd-lv-lbl{font-size:8px;font-weight:600;color:rgba(0,200,255,0.35);letter-spacing:0.2px}
.spd-btn.act{
  background:linear-gradient(160deg,rgba(0,200,255,0.28) 0%,rgba(0,150,255,0.18) 100%);
  border-color:rgba(0,200,255,0.7);color:rgba(0,245,255,1);
  box-shadow:0 2px 12px rgba(0,180,255,0.3),inset 0 1px 0 rgba(255,255,255,0.15)
}
.spd-btn.act .spd-lv-lbl{color:rgba(0,230,255,0.7)}
.socket-stat{display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,0.04);border-radius:5px;padding:3px 5px;border:1px solid rgba(255,255,255,0.06)}
.socket-stat-lbl{font-size:6px;color:rgba(255,255,255,0.3);font-weight:700;letter-spacing:0.3px}
.socket-stat-val{font-size:9px;font-weight:700;color:rgba(80,240,140,0.9)}
.socket-bar{height:4px;border-radius:2px;background:rgba(255,255,255,0.07);overflow:hidden;box-shadow:inset 0 1px 2px rgba(0,0,0,0.3)}
.socket-fill{height:100%;border-radius:2px;background:linear-gradient(90deg,rgba(60,220,120,0.7),rgba(0,255,180,1));width:0%;transition:width 0.5s}
.m-stat{display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,0.04);border-radius:6px;padding:4px 7px;border:1px solid rgba(255,255,255,0.06)}
.m-stat-lbl{font-size:7px;color:rgba(255,255,255,0.28);font-weight:700;letter-spacing:0.3px}
.m-stat-val{font-size:8px;font-weight:700}
.rainbow-bar{height:3px;border-radius:2px;background:linear-gradient(90deg,#ff4444,#ff9900,#ffee00,#44ff88,#00ccff,#4488ff,#cc44ff,#ff44aa);opacity:0.7}
.rgb-btn{
  width:100%;padding:3px 6px;border-radius:20px;
  background:rgba(255,255,255,0.08);
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  border:1px solid rgba(255,255,255,0.14);
  color:rgba(255,255,255,0.82);
  font-size:10px;font-weight:600;cursor:pointer;text-align:center;
  box-shadow:0 1px 0 rgba(255,255,255,0.06) inset, 0 2px 8px rgba(0,0,0,0.25);
  transition:all 0.2s;
  display:block;
  overflow:hidden;
  box-sizing:border-box;
}
.rgb-btn .rgb-btn-text{
  display:block;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  width:100%;
}
.rgb-btn.rgb-on{
  border-color:rgba(200,130,255,0.45);
  box-shadow:0 0 8px rgba(180,80,255,0.25),0 1px 0 rgba(255,255,255,0.1) inset, 0 2px 8px rgba(0,0,0,0.2);
  color:rgba(220,170,255,0.95);
  background:rgba(180,80,255,0.12);
}

/* ── Animations ── */

/* Pulse dot (motion sensor indicator) */
.pulse-dot{width:8px;height:8px;border-radius:50%;background:rgba(190,110,255,0.9);animation:pdot 2s ease-in-out infinite;flex-shrink:0;box-shadow:0 0 6px rgba(190,110,255,0.6)}
@keyframes pdot{0%,100%{opacity:0.35;transform:scale(0.9)}50%{opacity:1;transform:scale(1.45);box-shadow:0 0 10px rgba(190,110,255,0.8)}}

/* Fan spin — speed controlled by JS animationPlayState */
.spin-a{animation:spinF 2.5s linear infinite;transform-origin:center center;transform-box:fill-box}
@keyframes spinF{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}

/* Bulb ON: warm glow pulse + drop-shadow */
@keyframes bulbPulse{
  0%,100%{filter:drop-shadow(0 0 4px rgba(255,230,60,0.55)) drop-shadow(0 0 1px rgba(255,200,40,0.4))}
  50%{filter:drop-shadow(0 0 10px rgba(255,230,60,1)) drop-shadow(0 0 4px rgba(255,180,20,0.8))}
}
.anim-bulb-on{animation:bulbPulse 2.2s ease-in-out infinite}

/* Bulb rays appear when on */
.bulb-rays{transition:opacity 0.4s}
.bulb-filament{transition:stroke 0.3s}

/* Decor fairy lights sparkle */
@keyframes decorTwinkle{
  0%,100%{opacity:1;filter:drop-shadow(0 0 2px rgba(255,240,80,0.6))}
  30%{opacity:0.4;filter:none}
  60%{opacity:0.9;filter:drop-shadow(0 0 4px rgba(255,200,60,0.9))}
}
.decor-sparks{transition:opacity 0.3s}

/* RGB prism: cycles hue of the stroke + glow */
@keyframes rgbCycle{
  0%  {filter:drop-shadow(0 0 3px rgba(255,60,60,0.8));  color:rgba(255,80,80,0.95)}
  16% {filter:drop-shadow(0 0 3px rgba(255,160,0,0.8));  color:rgba(255,160,0,0.95)}
  33% {filter:drop-shadow(0 0 3px rgba(255,235,0,0.8));  color:rgba(255,235,0,0.95)}
  50% {filter:drop-shadow(0 0 3px rgba(60,255,120,0.8)); color:rgba(60,255,120,0.95)}
  66% {filter:drop-shadow(0 0 3px rgba(0,200,255,0.8));  color:rgba(0,200,255,0.95)}
  83% {filter:drop-shadow(0 0 3px rgba(160,80,255,0.8)); color:rgba(160,80,255,0.95)}
  100%{filter:drop-shadow(0 0 3px rgba(255,60,60,0.8));  color:rgba(255,80,80,0.95)}
}
.anim-rgb{animation:rgbCycle 3s linear infinite}

/* Ổ cắm glow */
@keyframes socketGlow{
  0%,100%{filter:drop-shadow(0 0 2px rgba(80,240,140,0.35))}
  50%{filter:drop-shadow(0 0 7px rgba(80,240,140,0.9))}
}
.anim-socket{animation:socketGlow 2.5s ease-in-out infinite}

/* TV scan line */
@keyframes tvScan{
  0%  {transform:translateY(0px);  opacity:0.6}
  90% {transform:translateY(9px);  opacity:0.3}
  100%{transform:translateY(9px);  opacity:0}
}
.tv-scan{transition:fill 0.3s}
.tv-content{transition:opacity 0.4s}

/* Motion figure walk — bobs up/down, arms swing */
@keyframes motionWalk{
  0%  {transform:translateY(0)    rotate(0deg)}
  25% {transform:translateY(-1px) rotate(1.5deg)}
  50% {transform:translateY(0)    rotate(0deg)}
  75% {transform:translateY(-1px) rotate(-1.5deg)}
  100%{transform:translateY(0)    rotate(0deg)}
}
@keyframes armWave{
  0%,100%{transform:rotate(0deg);transform-origin:12px 9px;transform-box:fill-box}
  40%    {transform:rotate(-25deg);transform-origin:12px 9px;transform-box:fill-box}
  70%    {transform:rotate(10deg);transform-origin:12px 9px;transform-box:fill-box}
}
.anim-motion-walk{animation:motionWalk 0.8s ease-in-out infinite}
.anim-motion-walk #arm-r{animation:armWave 0.8s ease-in-out infinite}

/* Greeter wave — tay trái người dưới vẫy */
@keyframes greeterWave{
  0%,100%{transform:rotate(0deg)}
  30%{transform:rotate(-35deg)}
  65%{transform:rotate(15deg)}
}
.motion-arcs{transition:opacity 0.4s}

/* Hien lantern glow */
@keyframes hienGlow{
  0%,100%{filter:drop-shadow(0 0 3px rgba(255,160,40,0.5))}
  50%{filter:drop-shadow(0 0 8px rgba(255,180,60,0.9))}
}
.anim-hien-on{animation:hienGlow 2.5s ease-in-out infinite}
.hien-inner{transition:fill 0.3s}

/* RGB Modal bottom-sheet */
.rgb-modal-overlay{
  position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;
  background:rgba(0,0,0,0);
  display:flex;align-items:flex-end;justify-content:center;
  transition:background 0.3s;
  pointer-events:none;
}
.rgb-modal-overlay.visible{background:rgba(0,0,10,0.72);pointer-events:all}
.rgb-modal-sheet{
  width:100%;max-width:480px;
  background:linear-gradient(170deg,rgba(14,22,48,0.99) 0%,rgba(8,14,32,1) 100%);
  border-radius:22px 22px 0 0;
  border:1px solid rgba(180,80,255,0.25);
  border-bottom:none;
  box-shadow:0 -8px 40px rgba(0,0,0,0.6),inset 0 1px 0 rgba(255,255,255,0.07);
  display:flex;flex-direction:column;
  max-height:82vh;
  transform:translateY(100%);
  transition:transform 0.32s cubic-bezier(0.32,0.72,0,1);
}
.rgb-modal-sheet.visible{transform:translateY(0)}
.rgb-modal-handle{
  width:40px;height:4px;border-radius:2px;
  background:rgba(255,255,255,0.15);
  margin:10px auto 0;flex-shrink:0;
}
.rgb-modal-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:10px 16px 8px;flex-shrink:0;
  border-bottom:1px solid rgba(180,80,255,0.12);
}
.rgb-modal-title{font-size:15px;font-weight:800;color:rgba(210,150,255,0.98);letter-spacing:0.2px}
.rgb-modal-close{
  width:28px;height:28px;border-radius:50%;
  background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);
  color:rgba(255,255,255,0.5);font-size:14px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  transition:all 0.15s;
}
.rgb-modal-close:hover{background:rgba(255,255,255,0.15);color:white}
.rgb-modal-body{
  flex:1;overflow-y:auto;padding:10px 14px 20px;
  scrollbar-width:thin;scrollbar-color:rgba(180,80,255,0.3) transparent;
}
.rgb-modal-body::-webkit-scrollbar{width:4px}
.rgb-modal-body::-webkit-scrollbar-thumb{background:rgba(180,80,255,0.3);border-radius:2px}
.rgb-modal-sec{
  font-size:10px;color:rgba(255,255,255,0.3);font-weight:700;letter-spacing:0.8px;
  margin:8px 0 8px;
}
.rgb-swatch-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.rgb-ef-list{
  display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px;
}
.rgb-ef-item{
  padding:8px 4px;border-radius:8px;font-size:11px;font-weight:600;text-align:center;
  cursor:pointer;
  background:rgba(180,80,255,0.06);
  border:1px solid rgba(180,80,255,0.14);
  color:rgba(200,140,255,0.65);
  transition:all 0.12s;
  line-height:1.3;
}
.rgb-ef-item:active{transform:scale(0.95)}
.rgb-ef-item.act{
  background:rgba(180,80,255,0.28);
  border-color:rgba(210,140,255,0.7);
  color:rgba(230,170,255,1);
  box-shadow:0 2px 10px rgba(160,60,255,0.3);
  font-weight:800;
}
.big-sw{display:flex;gap:4px;flex-wrap:wrap}
.bsw{width:26px;height:26px;border-radius:50%;cursor:pointer;border:2px solid transparent;transition:all 0.12s}
.bsw:hover{transform:scale(1.15)}.bsw.act{border-color:white;transform:scale(1.08)}
.cc-row{display:flex;align-items:center;gap:4px;margin-top:1px}
.cc-row input[type=color]{width:22px;height:22px;border-radius:50%;border:2px solid rgba(255,255,255,0.18);padding:0;cursor:pointer;background:none}
.cc-lbl{font-size:8px;color:rgba(255,255,255,0.32)}
.cur-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}

/* ── TV Remote button ── */
.tv-remote-btn{
  width:100%;padding:4px 6px;border-radius:8px;font-size:9px;font-weight:800;
  background:linear-gradient(160deg,rgba(80,140,255,0.14) 0%,rgba(50,100,255,0.07) 100%);
  border:1px solid rgba(80,140,255,0.3);color:rgba(140,190,255,0.9);
  cursor:pointer;text-align:center;margin-top:4px;
  box-shadow:0 3px 0 rgba(20,50,160,0.5),0 4px 10px rgba(60,100,255,0.12),inset 0 1px 0 rgba(255,255,255,0.1);
  transition:all 0.1s;transform:perspective(200px) rotateX(0deg) translateY(0px)
}
.tv-remote-btn:active{
  transform:perspective(200px) rotateX(8deg) translateY(3px);
  box-shadow:0 0px 0 rgba(20,50,160,0.5),0 1px 4px rgba(60,100,255,0.1),inset 0 2px 3px rgba(0,0,0,0.2);
}
/* ── TV Modal ── */
.tv-modal-overlay{
  position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:rgba(0,0,0,0);
  display:flex;align-items:flex-end;justify-content:center;
  transition:background 0.3s;pointer-events:none
}
.tv-modal-overlay.tv-visible{background:rgba(0,0,15,0.75);pointer-events:all}
.tv-modal-sheet{
  width:100%;max-width:420px;
  background:linear-gradient(175deg,rgba(5,15,40,0.99) 0%,rgba(3,8,22,1) 100%);
  border-radius:24px 24px 0 0;
  border:1px solid rgba(80,140,255,0.2);border-bottom:none;
  box-shadow:0 -8px 40px rgba(0,0,0,0.6),inset 0 1px 0 rgba(255,255,255,0.06);
  transform:translateY(100%);transition:transform 0.32s cubic-bezier(0.32,0.72,0,1)
}
.tv-modal-sheet.tv-visible{transform:translateY(0)}
.tv-modal-handle{width:40px;height:4px;border-radius:2px;background:rgba(255,255,255,0.15);margin:10px auto 0}
.tv-modal-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:10px 16px 10px;border-bottom:1px solid rgba(80,140,255,0.1)
}
.tv-modal-title-wrap{display:flex;align-items:center;gap:7px}
.tv-modal-title{font-size:15px;font-weight:800;color:rgba(160,200,255,0.95)}
.tv-status-dot{width:7px;height:7px;border-radius:50%;background:rgba(255,80,80,0.7);transition:all 0.3s;flex-shrink:0}
.tv-status-label{font-size:9px;font-weight:700;letter-spacing:0.5px;color:rgba(255,100,100,0.8);transition:color 0.3s}
.tv-modal-body{padding:12px 16px 28px;display:flex;flex-direction:column;gap:10px}
/* TV button rows */
.tv-row{display:flex;gap:8px}
.tv-btn{
  flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;
  padding:10px 4px 8px;border-radius:12px;cursor:pointer;font-size:9px;font-weight:700;
  background:linear-gradient(160deg,rgba(255,255,255,0.07) 0%,rgba(255,255,255,0.03) 100%);
  border:1px solid rgba(255,255,255,0.1);color:rgba(200,220,255,0.85);
  box-shadow:0 4px 0 rgba(0,0,0,0.4),0 5px 10px rgba(0,0,0,0.2),inset 0 1px 0 rgba(255,255,255,0.1);
  transition:all 0.1s;transform:perspective(250px) rotateX(0deg) translateY(0px)
}
.tv-btn:active{
  transform:perspective(250px) rotateX(8deg) translateY(4px);
  box-shadow:0 0px 0 rgba(0,0,0,0.4),0 1px 4px rgba(0,0,0,0.2),inset 0 2px 4px rgba(0,0,0,0.25);
}
.tv-btn-power{
  background:linear-gradient(160deg,rgba(255,60,60,0.15) 0%,rgba(180,20,20,0.08) 100%);
  border-color:rgba(255,80,80,0.3);color:rgba(255,130,130,0.9);
  box-shadow:0 4px 0 rgba(120,0,0,0.5),0 5px 10px rgba(0,0,0,0.2),inset 0 1px 0 rgba(255,150,150,0.1);
}
.tv-btn-power-on{
  background:linear-gradient(160deg,rgba(0,220,120,0.2) 0%,rgba(0,140,70,0.1) 100%) !important;
  border-color:rgba(0,220,120,0.45) !important;color:rgba(80,255,160,1) !important;
  box-shadow:0 4px 0 rgba(0,80,40,0.55),0 0 12px rgba(0,200,100,0.2),inset 0 1px 0 rgba(100,255,160,0.15) !important;
}
.tv-btn-vol-up{
  background:linear-gradient(160deg,rgba(80,140,255,0.18) 0%,rgba(40,80,255,0.1) 100%);
  border-color:rgba(80,140,255,0.4);color:rgba(140,200,255,1);
  box-shadow:0 4px 0 rgba(10,40,160,0.55),0 5px 10px rgba(60,100,255,0.15),inset 0 1px 0 rgba(150,200,255,0.15);
}
/* D-pad */
.tv-dpad-wrap{display:flex;justify-content:center}
.tv-dpad{display:flex;flex-direction:column;gap:6px;width:180px}
.tv-dpad-row{display:flex;gap:6px;align-items:center;justify-content:center}
.tv-dpad-spacer{flex:1}
.tv-btn-dpad{
  width:52px;height:52px;padding:0;border-radius:50%;flex:none;
  display:flex;align-items:center;justify-content:center;
}
.tv-btn-ok{
  width:62px;height:62px;flex:none;border-radius:50%;padding:0;
  font-size:15px;font-weight:900;letter-spacing:-0.3px;
  background:radial-gradient(circle at 40% 35%,rgba(0,160,255,0.5) 0%,rgba(0,80,200,0.3) 60%,rgba(0,40,120,0.4) 100%) !important;
  border:1.5px solid rgba(0,180,255,0.5) !important;color:rgba(180,230,255,1) !important;
  box-shadow:0 5px 0 rgba(0,30,100,0.6),0 0 20px rgba(0,150,255,0.25),inset 0 1px 0 rgba(100,220,255,0.2) !important;
}

/* auto-countdown chip grid */
.acd-wrap{display:flex;flex-direction:column;gap:3px;padding:1px 0}
.acd-timer{font-size:10px;font-weight:700;color:rgba(150,210,255,0.9)}
.acd-timer b{color:rgba(255,210,60,1);font-size:11px}
.acd-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:1px}
.acd-chip{display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:20px;font-size:9px;font-weight:700;background:rgba(255,180,50,0.1);border:1px solid rgba(255,180,50,0.3);color:rgba(255,200,100,0.9);white-space:nowrap}
`

customElements.define('ha-smart-room-card', HASmartRoomCard);

// ═══════════════════════════════════════════════════════════════
//  VISUAL EDITOR — HA Smart Room Card
//  v1.2 · Designed by @doanlong1412 from 🇻🇳 Vietnam
// ═══════════════════════════════════════════════════════════════

// ─── i18n ─────────────────────────────────────────────────────
const HSRC_TRANSLATIONS = {
  vi: {
    lang: 'Tiếng Việt', flag: 'vn',
    edTitle: 'HA Smart Room Card',
    edEntities: '📡 Thực thể (Entity)',
    edBg: '🎨 Màu nền',
    edDisplay: '👁 Hiển thị',
    edLang: '🌐 Ngôn ngữ',
    bgPresets: 'Preset',
    edBgAlpha: '🔆 Độ trong suốt', edBgBlur: '💎 Hiệu ứng Glass Blur', edBgBlurNone: 'Không', edBgBlurMax: 'Tối đa', edBgTransparent: 'Trong suốt', edBgSolid: 'Đặc',
    color1: 'Màu 1 (trên)', color2: 'Màu 2 (dưới)',
    edTemp: '🌡 Cảm biến nhiệt độ (sensor.*)',
    edHumi: '💧 Cảm biến độ ẩm (sensor.*)',
    edPower: '⚡ Cảm biến công suất (sensor.*)',
    edDoor: '🚪 Cảm biến cửa (binary_sensor.*)',
    edMotion: '🚶 Cảm biến chuyển động (binary_sensor.*)',
    edTempOut: '🌤 Nhiệt độ ngoài trời (sensor.*)',
    edHumiOut: '💧 Độ ẩm ngoài trời (sensor.*)',
    edDen: '💡 Đèn chính (light.*)',
    edDecor: '✨ Đèn decor (switch.*)',
    edRgb: '🌈 Đèn RGB (light.*)',
    edHien: '🏮 Đèn hiên (switch.*)',
    edQuat: '🌀 Quạt trần (switch.*)',
    edOcam: '🔌 Ổ cắm (switch.*)',
    edTv: '📺 Smart TV (media_player.*)',
    edTvRemote: '📱 TV Remote (remote.*)',
    edAc: '❄️ Điều hòa (climate.*)',
    edShowScore: 'Điểm phòng', edShowScoreDesc: 'Hiện ô tính điểm tiện nghi',
    edShowGraph: 'Biểu đồ nhiệt độ', edShowGraphDesc: 'Hiện biểu đồ 6h lịch sử',
    edShowSmartBar: 'Thanh gợi ý thông minh', edShowSmartBarDesc: 'Hiện gợi ý tiết kiệm điện',
    edShowAutoMode: 'Chế độ tự động', edShowAutoModeDesc: 'Hiện nút tự động tắt khi vắng người',
    edShowEnvHint: 'Gợi ý nhiệt độ/độ ẩm', edShowEnvHintDesc: 'Hiện dòng so sánh nhiệt độ trong-ngoài',
    edShowTimeline: 'Timeline thiết bị', edShowTimelineDesc: 'Hiện bảng thời gian bật tắt ĐH, cửa, motion',
    colorLabel: 'Màu sắc nâng cao',
    edColorsReset: '↩ Đặt lại màu về mặc định',
    edRoomTitle: '🏷 Tên hiển thị (Smart Home)',
    edRoomTitlePlaceholder: 'vd. Phòng Làm Việc, Phòng Ngủ...',
    edSensorsTitle: 'Cảm biến trong phòng',
    edAcTitle: 'Điều hòa',
    edOutdoorTitle: 'Cảm biến ngoài trời',
    edAcEntity: '❄️ Thực thể điều hòa (climate.*)',
    edDevicesTitle: 'Thiết bị',
    edAddDevPlaceholder: '— Chọn loại thiết bị —',
    edAddDevLight: '💡 Đèn thường (light)',
    edAddDevRgb: '🌈 Đèn RGB (light + effect)',
    edAddDevFan: '🌀 Quạt (switch)',
    edAddDevOutlet: '🔌 Ổ cắm (switch + xác nhận)',
    edAddDevTv: '📺 TV (media_player)',
    edAddDevSensor: '📡 Cảm biến (sensor)',
    edAddBtn: '+ Thêm',
    edNoDevices: 'Chưa có thiết bị nào. Nhấn "+ Thêm" để bắt đầu.',
    edAutoTitle: 'Tự động hóa',
    edSyncTitle: '🔄 Chế độ đồng bộ',
    edSyncLocal: '💾 Local',
    edSyncLocalSimple: 'ĐƠN GIẢN',
    edSyncLocalDesc: 'Lưu trong trình duyệt — đơn giản, không cần cài thêm gì',
    edSyncHelpers: '🔘 HA Helpers',
    edSyncHelpersDesc: 'Đồng bộ giữa nhiều thiết bị qua input_boolean + input_number — cần tạo helpers thủ công',
    edSyncIntegration: '🧠 HA Smart Room Integration',
    edSyncIntRecommended: 'KHUYẾN NGHỊ',
    edSyncIntDesc: 'Chạy server-side — hoạt động kể cả khi đóng browser, đồng bộ hoàn hảo mọi thiết bị',
    edSyncIntSetup: '✅ <b>Cài đặt một lần:</b>',
    edSyncIntStep1: 'HACS → Frontend → ⋮ → Custom repositories',
    edSyncIntStep1b: 'URL: <code>https://github.com/doanlong1412/ha-smart-room-card</code> → Type: <b>Integration</b>',
    edSyncIntStep2: 'Tìm <b>HA Smart Room</b> → Install → Restart HA',
    edSyncIntStep3: 'Settings → Devices & Services → Add Integration → <b>HA Smart Room</b>',
    edSyncIntStep4: 'Quay lại card, nhấn Lưu — card tự đăng ký phòng với integration ✨',
    edSyncHelpersWarn: '⚠️ Cần tạo 2 Helpers trong HA trước khi dùng.',
    edHelperBool: '🔘 input_boolean entity',
    edHelperNum: '🔢 input_number entity',
    edDelayTitle: '⏱️ Thời gian đếm ngược',
    edDelayLabel: 'Tắt sau bao nhiêu phút không có người',
    edDelayUnit: 'phút',
    edAutoDevTitle: '🔌 Thiết bị sẽ tắt tự động',
    edAutoDevDesc: 'Bỏ chọn thiết bị bạn KHÔNG muốn tắt tự động',
    edSensorsSection: '📡 Cảm biến & Thiết bị',
    tvControlBtn: '📺 Điều khiển',
    tvModalTitle: '📺 Điều Khiển TV',
    tvPower: 'Nguồn',
    tvMute: 'Tắt tiếng',
    tvVolDown: 'Âm −',
    tvVolUp: 'Âm +',
    tvHome: 'Trang chủ',
    tvMenu: 'Menu',
    tvBack: 'Quay lại',
    tvInput: 'Nguồn vào',
    tvVolLabel: 'ÂM LƯỢNG',
    devDen: '💡 Đèn Chính',
    devDecor: '✨ Đèn Decor',
    devHien: '🏮 Đèn Hiên',
    devRgb: '🌈 Đèn RGB',
    devQuat: '🌀 Quạt Trần',
    devOcam: '🔌 Ổ Cắm',
    devTv: '📺 Smart TV',
    devTvRemote: '📱 TV Remote',
    devAc: '❄️ Điều Hòa',
    devNamePlaceholder: 'Tên thiết bị (vd: Đèn phòng ngủ)',
    devLabelLight: '💡 Đèn',
    devLabelRgb: '🌈 Đèn RGB',
    devLabelFan: '🌀 Quạt',
    devLabelOutlet: '🔌 Ổ cắm',
    devLabelTv: '📺 TV',
    devLabelSensor: '📡 Cảm biến',
  },
  en: {
    lang: 'English', flag: 'gb',
    edTitle: 'Office Room Card',
    edEntities: '📡 Entities',
    edBg: '🎨 Background',
    edDisplay: '👁 Display options',
    edLang: '🌐 Language',
    bgPresets: 'Preset',
    edBgAlpha: '🔆 Opacity', edBgBlur: '💎 Glass Blur Effect', edBgBlurNone: 'None', edBgBlurMax: 'Max', edBgTransparent: 'Transparent', edBgSolid: 'Solid',
    color1: 'Color 1 (top)', color2: 'Color 2 (bottom)',
    edTemp: '🌡 Temperature sensor (sensor.*)',
    edHumi: '💧 Humidity sensor (sensor.*)',
    edPower: '⚡ Power sensor (sensor.*)',
    edDoor: '🚪 Door sensor (binary_sensor.*)',
    edMotion: '🚶 Motion sensor (binary_sensor.*)',
    edTempOut: '🌤 Outdoor temperature (sensor.*)',
    edHumiOut: '💧 Outdoor humidity (sensor.*)',
    edDen: '💡 Main light (light.*)',
    edDecor: '✨ Decor light (switch.*)',
    edRgb: '🌈 RGB light (light.*)',
    edHien: '🏮 Porch light (switch.*)',
    edQuat: '🌀 Ceiling fan (switch.*)',
    edOcam: '🔌 Power outlet (switch.*)',
    edTv: '📺 Smart TV (media_player.*)',
    edTvRemote: '📱 TV Remote (remote.*)',
    edAc: '❄️ Air conditioner (climate.*)',
    edShowScore: 'Room score', edShowScoreDesc: 'Show comfort score box',
    edShowGraph: 'Temperature graph', edShowGraphDesc: 'Show 6h history chart',
    edShowSmartBar: 'Smart hint bar', edShowSmartBarDesc: 'Show energy saving hints',
    edShowAutoMode: 'Auto mode', edShowAutoModeDesc: 'Show auto-off when room is empty',
    edShowEnvHint: 'Temp/humidity hints', edShowEnvHintDesc: 'Show indoor/outdoor comparison line',
    edShowTimeline: 'Device timeline', edShowTimelineDesc: 'Show AC / door / motion last-event times',
    colorLabel: 'Advanced colors',
    edColorsReset: '↩ Reset colors to default',
    edRoomTitle: '🏷 Room name (Smart Home)',
    edRoomTitlePlaceholder: 'e.g. Office, Bedroom...',
    edSensorsTitle: 'Indoor sensors',
    edAcTitle: 'Air conditioner',
    edOutdoorTitle: 'Outdoor sensors',
    edAcEntity: '❄️ AC entity (climate.*)',
    edDevicesTitle: 'Devices',
    edAddDevPlaceholder: '— Select device type —',
    edAddDevLight: '💡 Light (light)',
    edAddDevRgb: '🌈 RGB light (light + effect)',
    edAddDevFan: '🌀 Fan (switch)',
    edAddDevOutlet: '🔌 Power outlet (switch + confirm)',
    edAddDevTv: '📺 TV (media_player)',
    edAddDevSensor: '📡 Sensor (sensor)',
    edAddBtn: '+ Add',
    edNoDevices: 'No devices yet. Click "+ Add" to start.',
    edAutoTitle: 'Automation',
    edSyncTitle: '🔄 Sync mode',
    edSyncLocal: '💾 Local',
    edSyncLocalSimple: 'SIMPLE',
    edSyncLocalDesc: 'Stored in browser — simple, no extra setup needed',
    edSyncHelpers: '🔘 HA Helpers',
    edSyncHelpersDesc: 'Sync across devices via input_boolean + input_number — requires manual helper creation',
    edSyncIntegration: '🧠 HA Smart Room Integration',
    edSyncIntRecommended: 'RECOMMENDED',
    edSyncIntDesc: 'Runs server-side — works even when browser is closed, perfect sync across all devices',
    edSyncIntSetup: '✅ <b>One-time setup:</b>',
    edSyncIntStep1: 'HACS → Frontend → ⋮ → Custom repositories',
    edSyncIntStep1b: 'URL: <code>https://github.com/doanlong1412/ha-smart-room-card</code> → Type: <b>Integration</b>',
    edSyncIntStep2: 'Find <b>HA Smart Room</b> → Install → Restart HA',
    edSyncIntStep3: 'Settings → Devices & Services → Add Integration → <b>HA Smart Room</b>',
    edSyncIntStep4: 'Back to card, click Save — card auto-registers with integration ✨',
    edSyncHelpersWarn: '⚠️ Create 2 Helpers in HA before using.',
    edHelperBool: '🔘 input_boolean entity',
    edHelperNum: '🔢 input_number entity',
    edDelayTitle: '⏱️ Countdown timer',
    edDelayLabel: 'Turn off after how many minutes with no motion',
    edDelayUnit: 'min',
    edAutoDevTitle: '🔌 Devices to auto-off',
    edAutoDevDesc: 'Uncheck devices you do NOT want turned off automatically',
    edSensorsSection: '📡 Sensors & Devices',
    tvControlBtn: '📺 Remote',
    tvModalTitle: '📺 TV Control',
    tvPower: 'Power',
    tvMute: 'Mute',
    tvVolDown: 'Vol −',
    tvVolUp: 'Vol +',
    tvHome: 'Home',
    tvMenu: 'Menu',
    tvBack: 'Back',
    tvInput: 'Input',
    tvVolLabel: 'VOLUME',
    devDen: '💡 Main Light',
    devDecor: '✨ Decor Light',
    devHien: '🏮 Porch Light',
    devRgb: '🌈 RGB Light',
    devQuat: '🌀 Ceiling Fan',
    devOcam: '🔌 Power Outlet',
    devTv: '📺 Smart TV',
    devTvRemote: '📱 TV Remote',
    devAc: '❄️ Air Conditioner',
    devNamePlaceholder: 'Device name (e.g. Bedroom light)',
    devLabelLight: '💡 Light',
    devLabelRgb: '🌈 RGB Light',
    devLabelFan: '🌀 Fan',
    devLabelOutlet: '🔌 Outlet',
    devLabelTv: '📺 TV',
    devLabelSensor: '📡 Sensor',
  },
  de: {
    lang: 'Deutsch', flag: 'de',
    edTitle: 'Büro Karte',
    edEntities: '📡 Entitäten',
    edBg: '🎨 Hintergrund',
    edDisplay: '👁 Anzeigeoptionen',
    edLang: '🌐 Sprache',
    bgPresets: 'Voreinstellung',
    edBgAlpha: '🔆 Transparenz', edBgBlur: '💎 Glas Blur Effekt', edBgBlurNone: 'Kein', edBgBlurMax: 'Max', edBgTransparent: 'Transparent', edBgSolid: 'Deckend',
    color1: 'Farbe 1 (oben)', color2: 'Farbe 2 (unten)',
    edTemp: '🌡 Temperatursensor (sensor.*)',
    edHumi: '💧 Feuchtigkeitssensor (sensor.*)',
    edPower: '⚡ Leistungssensor (sensor.*)',
    edDoor: '🚪 Türsensor (binary_sensor.*)',
    edMotion: '🚶 Bewegungssensor (binary_sensor.*)',
    edTempOut: '🌤 Außentemperatur (sensor.*)',
    edHumiOut: '💧 Außenluftfeuchtigkeit (sensor.*)',
    edDen: '💡 Hauptlicht (light.*)',
    edDecor: '✨ Dekorlicht (switch.*)',
    edRgb: '🌈 RGB-Licht (light.*)',
    edHien: '🏮 Außenlicht (switch.*)',
    edQuat: '🌀 Deckenventilator (switch.*)',
    edOcam: '🔌 Steckdose (switch.*)',
    edTv: '📺 Smart TV (media_player.*)',
    edTvRemote: '📱 TV Fernbedienung (remote.*)',
    edAc: '❄️ Klimaanlage (climate.*)',
    edShowScore: 'Raumwertung', edShowScoreDesc: 'Komfortwertung anzeigen',
    edShowGraph: 'Temperaturverlauf', edShowGraphDesc: '6h Verlaufsdiagramm anzeigen',
    edShowSmartBar: 'Hinweisleiste', edShowSmartBarDesc: 'Energiespartipps anzeigen',
    edShowAutoMode: 'Automatikmodus', edShowAutoModeDesc: 'Auto-aus bei leerem Raum anzeigen',
    edShowEnvHint: 'Temp/Feuchtigkeitshinweise', edShowEnvHintDesc: 'Innen/Außen-Vergleich anzeigen',
    edShowTimeline: 'Gerätezeitachse', edShowTimelineDesc: 'Zeitachse für Klimaanlage/Tür/Bewegung anzeigen',
    colorLabel: 'Erweiterte Farben',
    edColorsReset: '↩ Farben zurücksetzen',
    edRoomTitle: '🏷 Raumname',
    edRoomTitlePlaceholder: 'z.B. Büro, Schlafzimmer...',
    edSensorsTitle: 'Raumsensoren',
    edAcTitle: 'Klimaanlage',
    edOutdoorTitle: 'Außensensoren',
    edAcEntity: '❄️ Klimaanlage-Entität (climate.*)',
    edDevicesTitle: 'Geräte',
    edAddDevPlaceholder: '— Gerätetyp wählen —',
    edAddDevLight: '💡 Licht (light)',
    edAddDevRgb: '🌈 RGB-Licht (light + Effekt)',
    edAddDevFan: '🌀 Ventilator (switch)',
    edAddDevOutlet: '🔌 Steckdose (switch + Bestätigung)',
    edAddDevTv: '📺 TV (media_player)',
    edAddDevSensor: '📡 Sensor (sensor)',
    edAddBtn: '+ Hinzufügen',
    edNoDevices: 'Keine Geräte. Klicke "+ Hinzufügen" um zu starten.',
    edAutoTitle: 'Automatisierung',
    edSyncTitle: '🔄 Synchronisierungsmodus',
    edSyncLocal: '💾 Lokal',
    edSyncLocalSimple: 'EINFACH',
    edSyncLocalDesc: 'Im Browser gespeichert — einfach, keine zusätzliche Einrichtung',
    edSyncHelpers: '🔘 HA Helpers',
    edSyncHelpersDesc: 'Synchronisierung über input_boolean + input_number — manuelle Erstellung erforderlich',
    edSyncIntegration: '🧠 HA Smart Room Integration',
    edSyncIntRecommended: 'EMPFOHLEN',
    edSyncIntDesc: 'Läuft serverseitig — funktioniert auch bei geschlossenem Browser',
    edSyncIntSetup: '✅ <b>Einmalige Einrichtung:</b>',
    edSyncIntStep1: 'HACS → Frontend → ⋮ → Benutzerdefinierte Repositories',
    edSyncIntStep1b: 'URL: <code>https://github.com/doanlong1412/ha-smart-room-card</code> → Typ: <b>Integration</b>',
    edSyncIntStep2: '<b>HA Smart Room</b> suchen → Installieren → HA neu starten',
    edSyncIntStep3: 'Einstellungen → Geräte & Dienste → Integration hinzufügen → <b>HA Smart Room</b>',
    edSyncIntStep4: 'Zurück zur Karte, Speichern klicken — Karte registriert sich automatisch ✨',
    edSyncHelpersWarn: '⚠️ Bitte zuerst 2 Helpers in HA erstellen.',
    edHelperBool: '🔘 input_boolean Entität',
    edHelperNum: '🔢 input_number Entität',
    edDelayTitle: '⏱️ Countdown-Timer',
    edDelayLabel: 'Nach wie vielen Minuten ohne Bewegung ausschalten',
    edDelayUnit: 'Min',
    edAutoDevTitle: '🔌 Automatisch ausschalten',
    edAutoDevDesc: 'Entfernen Sie Geräte, die NICHT automatisch ausgeschaltet werden sollen',
    edSensorsSection: '📡 Sensoren & Geräte',
    tvControlBtn: '📺 Fernbedienung',
    tvModalTitle: '📺 TV Steuerung',
    tvPower: 'Ein/Aus',
    tvMute: 'Stumm',
    tvVolDown: 'Laut −',
    tvVolUp: 'Laut +',
    tvHome: 'Startseite',
    tvMenu: 'Menü',
    tvBack: 'Zurück',
    tvInput: 'Eingang',
    tvVolLabel: 'LAUTSTÄRKE',
    devDen: '💡 Hauptlicht',
    devDecor: '✨ Dekolicht',
    devHien: '🏮 Außenlicht',
    devRgb: '🌈 RGB-Licht',
    devQuat: '🌀 Deckenventilaror',
    devOcam: '🔌 Steckdose',
    devTv: '📺 Smart TV',
    devTvRemote: '📱 TV Fernbedienung',
    devAc: '❄️ Klimaanlage',
    devNamePlaceholder: 'Gerätename (z.B. Schlafzimmerlicht)',
    devLabelLight: '💡 Licht',
    devLabelRgb: '🌈 RGB-Licht',
    devLabelFan: '🌀 Ventilator',
    devLabelOutlet: '🔌 Steckdose',
    devLabelTv: '📺 TV',
    devLabelSensor: '📡 Sensor',
  },
  fr: {
    lang: 'Français', flag: 'fr',
    edTitle: 'Carte Bureau',
    edEntities: '📡 Entités',
    edBg: '🎨 Arrière-plan',
    edDisplay: '👁 Options d\'affichage',
    edLang: '🌐 Langue',
    bgPresets: 'Préréglage',
    edBgAlpha: '🔆 Opacité', edBgBlur: '💎 Effet Verre Flouté', edBgBlurNone: 'Aucun', edBgBlurMax: 'Max', edBgTransparent: 'Transparent', edBgSolid: 'Solide',
    color1: 'Couleur 1 (haut)', color2: 'Couleur 2 (bas)',
    edTemp: '🌡 Capteur de température (sensor.*)',
    edHumi: '💧 Capteur d\'humidité (sensor.*)',
    edPower: '⚡ Capteur de puissance (sensor.*)',
    edDoor: '🚪 Capteur de porte (binary_sensor.*)',
    edMotion: '🚶 Capteur de mouvement (binary_sensor.*)',
    edTempOut: '🌤 Température extérieure (sensor.*)',
    edHumiOut: '💧 Humidité extérieure (sensor.*)',
    edDen: '💡 Lumière principale (light.*)',
    edDecor: '✨ Lumière décorative (switch.*)',
    edRgb: '🌈 Lumière RGB (light.*)',
    edHien: '🏮 Lumière véranda (switch.*)',
    edQuat: '🌀 Ventilateur plafond (switch.*)',
    edOcam: '🔌 Prise électrique (switch.*)',
    edTv: '📺 Smart TV (media_player.*)',
    edTvRemote: '📱 Télécommande TV (remote.*)',
    edAc: '❄️ Climatiseur (climate.*)',
    edShowScore: 'Score de pièce', edShowScoreDesc: 'Afficher le score de confort',
    edShowGraph: 'Graphique température', edShowGraphDesc: 'Afficher l\'historique 6h',
    edShowSmartBar: 'Barre de conseils', edShowSmartBarDesc: 'Afficher les conseils d\'économie',
    edShowAutoMode: 'Mode automatique', edShowAutoModeDesc: 'Afficher l\'arrêt auto',
    edShowEnvHint: 'Conseils temp/humidité', edShowEnvHintDesc: 'Afficher la comparaison intérieur/extérieur',
    edShowTimeline: 'Chronologie', edShowTimelineDesc: 'Afficher la chronologie climatiseur/porte/mouvement',
    colorLabel: 'Couleurs avancées',
    edColorsReset: '↩ Réinitialiser les couleurs',
    edRoomTitle: '🏷 Nom de la pièce',
    edRoomTitlePlaceholder: 'ex. Bureau, Chambre...',
    edSensorsTitle: 'Capteurs intérieurs',
    edAcTitle: 'Climatiseur',
    edOutdoorTitle: 'Capteurs extérieurs',
    edAcEntity: '❄️ Entité climatiseur (climate.*)',
    edDevicesTitle: 'Appareils',
    edAddDevPlaceholder: '— Choisir le type —',
    edAddDevLight: '💡 Lumière (light)',
    edAddDevRgb: '🌈 Lumière RGB (light + effet)',
    edAddDevFan: '🌀 Ventilateur (switch)',
    edAddDevOutlet: '🔌 Prise électrique (switch + confirm)',
    edAddDevTv: '📺 TV (media_player)',
    edAddDevSensor: '📡 Capteur (sensor)',
    edAddBtn: '+ Ajouter',
    edNoDevices: 'Aucun appareil. Cliquez sur "+ Ajouter" pour commencer.',
    edAutoTitle: 'Automatisation',
    edSyncTitle: '🔄 Mode de synchronisation',
    edSyncLocal: '💾 Local',
    edSyncLocalSimple: 'SIMPLE',
    edSyncLocalDesc: 'Stocké dans le navigateur — simple, aucune configuration supplémentaire',
    edSyncHelpers: '🔘 HA Helpers',
    edSyncHelpersDesc: 'Synchronisation via input_boolean + input_number — création manuelle requise',
    edSyncIntegration: '🧠 HA Smart Room Integration',
    edSyncIntRecommended: 'RECOMMANDÉ',
    edSyncIntDesc: 'Fonctionne côté serveur — même navigateur fermé, sync parfaite',
    edSyncIntSetup: '✅ <b>Configuration unique :</b>',
    edSyncIntStep1: 'HACS → Frontend → ⋮ → Dépôts personnalisés',
    edSyncIntStep1b: 'URL: <code>https://github.com/doanlong1412/ha-smart-room-card</code> → Type: <b>Integration</b>',
    edSyncIntStep2: 'Trouver <b>HA Smart Room</b> → Installer → Redémarrer HA',
    edSyncIntStep3: 'Paramètres → Appareils & Services → Ajouter intégration → <b>HA Smart Room</b>',
    edSyncIntStep4: "Retour à la carte, cliquer Enregistrer — la carte s'enregistre automatiquement ✨",
    edSyncHelpersWarn: "⚠️ Créez 2 Helpers dans HA avant d'utiliser.",
    edHelperBool: '🔘 Entité input_boolean',
    edHelperNum: '🔢 Entité input_number',
    edDelayTitle: '⏱️ Minuterie',
    edDelayLabel: 'Éteindre après combien de minutes sans mouvement',
    edDelayUnit: 'min',
    edAutoDevTitle: '🔌 Appareils à éteindre automatiquement',
    edAutoDevDesc: 'Décochez les appareils que vous ne souhaitez PAS éteindre automatiquement',
    edSensorsSection: '📡 Capteurs & Appareils',
    tvControlBtn: '📺 Télécommande',
    tvModalTitle: '📺 Contrôle TV',
    tvPower: 'Marche/Arrêt',
    tvMute: 'Muet',
    tvVolDown: 'Vol −',
    tvVolUp: 'Vol +',
    tvHome: 'Accueil',
    tvMenu: 'Menu',
    tvBack: 'Retour',
    tvInput: 'Source',
    tvVolLabel: 'VOLUME',
    devDen: '💡 Lumière Principale',
    devDecor: '✨ Lumière Déco',
    devHien: '🏮 Lumière Véranda',
    devRgb: '🌈 Lumière RGB',
    devQuat: '🌀 Ventilateur Plafond',
    devOcam: '🔌 Prise Électrique',
    devTv: '📺 Smart TV',
    devTvRemote: '📱 Télécommande TV',
    devAc: '❄️ Climatisation',
    devNamePlaceholder: 'Nom du dispositif (ex: Lumière chambre)',
    devLabelLight: '💡 Lumière',
    devLabelRgb: '🌈 Lumière RGB',
    devLabelFan: '🌀 Ventilateur',
    devLabelOutlet: '🔌 Prise',
    devLabelTv: '📺 TV',
    devLabelSensor: '📡 Capteur',
  },
  nl: {
    lang: 'Nederlands', flag: 'nl',
    edTitle: 'Kantoorkaart', edEntities: '📡 Entiteiten', edBg: '🎨 Achtergrond',
    edDisplay: '👁 Weergaveopties', edLang: '🌐 Taal', bgPresets: 'Voorinstelling',
    edBgAlpha: '🔆 Transparantie', edBgBlur: '💎 Glas Blur Effect', edBgBlurNone: 'Geen', edBgBlurMax: 'Max', edBgTransparent: 'Transparant', edBgSolid: 'Ondoorzichtig',
    color1: 'Kleur 1 (boven)', color2: 'Kleur 2 (onder)',
    edTemp: '🌡 Temperatuursensor (sensor.*)', edHumi: '💧 Vochtigheidssensor (sensor.*)',
    edPower: '⚡ Vermogenssensor (sensor.*)', edDoor: '🚪 Deursensor (binary_sensor.*)',
    edMotion: '🚶 Bewegingssensor (binary_sensor.*)', edTempOut: '🌤 Buitentemperatuur (sensor.*)',
    edHumiOut: '💧 Buitenvochtigheid (sensor.*)', edDen: '💡 Hoofdlamp (light.*)',
    edDecor: '✨ Decorlamp (switch.*)', edRgb: '🌈 RGB-lamp (light.*)',
    edHien: '🏮 Portieeklamp (switch.*)', edQuat: '🌀 Plafondventilator (switch.*)',
    edOcam: '🔌 Stopcontact (switch.*)', edTv: '📺 Smart TV (media_player.*)',
    edTvRemote: '📱 TV Afstandsbediening (remote.*)', edAc: '❄️ Airconditioning (climate.*)',
    edShowScore: 'Kamerscore', edShowScoreDesc: 'Comfortscore weergeven',
    edShowGraph: 'Temperatuurgrafiek', edShowGraphDesc: '6u historische grafiek weergeven',
    edShowSmartBar: 'Slimme hints', edShowSmartBarDesc: 'Energiebesparingstips weergeven',
    edShowAutoMode: 'Automatische modus', edShowAutoModeDesc: 'Auto-uit bij lege ruimte weergeven',
    edShowEnvHint: 'Temp/vochtigheid hints', edShowEnvHintDesc: 'Binnen/buiten vergelijking weergeven',
    edShowTimeline: 'Apparaattijdlijn', edShowTimelineDesc: 'Tijdlijn AC/deur/beweging weergeven',
    colorLabel: 'Geavanceerde kleuren', edColorsReset: '↩ Kleuren herstellen',
    edRoomTitle: '🏷 Kamernaam', edRoomTitlePlaceholder: 'bijv. Kantoor, Slaapkamer...',
    edSensorsTitle: 'Binnensensoren',
    edAcTitle: 'Airconditioning',
    edOutdoorTitle: 'Buitensensoren',
    edAcEntity: '❄️ Airco entiteit (climate.*)',
    edDevicesTitle: 'Apparaten',
    edAddDevPlaceholder: '— Selecteer type —',
    edAddDevLight: '💡 Lamp (light)',
    edAddDevRgb: '🌈 RGB-lamp (light + effect)',
    edAddDevFan: '🌀 Ventilator (switch)',
    edAddDevOutlet: '🔌 Stopcontact (switch + bevestiging)',
    edAddDevTv: '📺 TV (media_player)',
    edAddDevSensor: '📡 Sensor (sensor)',
    edAddBtn: '+ Toevoegen',
    edNoDevices: 'Geen apparaten. Klik op "+ Toevoegen" om te beginnen.',
    edAutoTitle: 'Automatisering',
    edSyncTitle: '🔄 Synchronisatiemodus',
    edSyncLocal: '💾 Lokaal',
    edSyncLocalSimple: 'EENVOUDIG',
    edSyncLocalDesc: 'Opgeslagen in browser — eenvoudig, geen extra instelling',
    edSyncHelpers: '🔘 HA Helpers',
    edSyncHelpersDesc: 'Synchroniseer via input_boolean + input_number — handmatig aanmaken vereist',
    edSyncIntegration: '🧠 HA Smart Room Integration',
    edSyncIntRecommended: 'AANBEVOLEN',
    edSyncIntDesc: 'Draait server-side — werkt ook bij gesloten browser',
    edSyncIntSetup: '✅ <b>Eenmalige instelling:</b>',
    edSyncIntStep1: 'HACS → Frontend → ⋮ → Aangepaste repositories',
    edSyncIntStep1b: 'URL: <code>https://github.com/doanlong1412/ha-smart-room-card</code> → Type: <b>Integration</b>',
    edSyncIntStep2: '<b>HA Smart Room</b> zoeken → Installeren → HA herstarten',
    edSyncIntStep3: 'Instellingen → Apparaten & Diensten → Integratie toevoegen → <b>HA Smart Room</b>',
    edSyncIntStep4: 'Terug naar kaart, Opslaan klikken — kaart registreert automatisch ✨',
    edSyncHelpersWarn: '⚠️ Maak eerst 2 Helpers aan in HA.',
    edHelperBool: '🔘 input_boolean entiteit',
    edHelperNum: '🔢 input_number entiteit',
    edDelayTitle: '⏱️ Afteltimer',
    edDelayLabel: 'Uitschakelen na hoeveel minuten zonder beweging',
    edDelayUnit: 'min',
    edAutoDevTitle: '🔌 Apparaten automatisch uitschakelen',
    edAutoDevDesc: 'Schakel apparaten uit die u NIET automatisch wilt uitschakelen',
    edSensorsSection: '📡 Sensoren & Apparaten',
    tvControlBtn: '📺 Afstandsbediening',
    tvModalTitle: '📺 TV Bediening',
    tvPower: 'Aan/Uit',
    tvMute: 'Dempen',
    tvVolDown: 'Vol −',
    tvVolUp: 'Vol +',
    tvHome: 'Home',
    tvMenu: 'Menu',
    tvBack: 'Terug',
    tvInput: 'Ingang',
    tvVolLabel: 'VOLUME',
    devDen: '💡 Hoofdlamp',
    devDecor: '✨ Decorlamp',
    devHien: '🏮 Portieeklamp',
    devRgb: '🌈 RGB-lamp',
    devQuat: '🌀 Plafondventilator',
    devOcam: '🔌 Stopcontact',
    devTv: '📺 Smart TV',
    devTvRemote: '📱 TV Afstandsbediening',
    devAc: '❄️ Airconditioning',
    devNamePlaceholder: 'Apparaatnaam (bijv. Slaapkamerlamp)',
    devLabelLight: '💡 Lamp',
    devLabelRgb: '🌈 RGB-lamp',
    devLabelFan: '🌀 Ventilator',
    devLabelOutlet: '🔌 Stopcontact',
    devLabelTv: '📺 TV',
    devLabelSensor: '📡 Sensor',
  },
  pl: {
    lang: 'Polski', flag: 'pl',
    edTitle: 'Karta Biura', edEntities: '📡 Encje', edBg: '🎨 Tło',
    edDisplay: '👁 Opcje wyświetlania', edLang: '🌐 Język', bgPresets: 'Ustawienie wstępne',
    edBgAlpha: '🔆 Przezroczystość', edBgBlur: '💎 Efekt Szkła Blur', edBgBlurNone: 'Brak', edBgBlurMax: 'Max', edBgTransparent: 'Przezroczyste', edBgSolid: 'Pełne',
    color1: 'Kolor 1 (góra)', color2: 'Kolor 2 (dół)',
    edTemp: '🌡 Czujnik temperatury (sensor.*)', edHumi: '💧 Czujnik wilgotności (sensor.*)',
    edPower: '⚡ Czujnik mocy (sensor.*)', edDoor: '🚪 Drzwi (binary_sensor.*)',
    edMotion: '🚶 Czujnik ruchu (binary_sensor.*)', edTempOut: '🌤 Temperatura zewnętrzna (sensor.*)',
    edHumiOut: '💧 Wilgotność zewnętrzna (sensor.*)', edDen: '💡 Główne światło (light.*)',
    edDecor: '✨ Światło dekoracyjne (switch.*)', edRgb: '🌈 Światło RGB (light.*)',
    edHien: '🏮 Światło wejście (switch.*)', edQuat: '🌀 Wentylator sufitowy (switch.*)',
    edOcam: '🔌 Gniazdo elektryczne (switch.*)', edTv: '📺 Smart TV (media_player.*)',
    edTvRemote: '📱 Pilot TV (remote.*)', edAc: '❄️ Klimatyzacja (climate.*)',
    edShowScore: 'Wynik pokoju', edShowScoreDesc: 'Pokaż wskaźnik komfortu',
    edShowGraph: 'Wykres temperatury', edShowGraphDesc: 'Pokaż wykres historii 6h',
    edShowSmartBar: 'Pasek podpowiedzi', edShowSmartBarDesc: 'Pokaż wskazówki oszczędzania',
    edShowAutoMode: 'Tryb automatyczny', edShowAutoModeDesc: 'Pokaż auto-wyłączenie gdy puste',
    edShowEnvHint: 'Wskazówki temp/wilg.', edShowEnvHintDesc: 'Pokaż porównanie wnętrze/zewnętrze',
    edShowTimeline: 'Oś czasu', edShowTimelineDesc: 'Pokaż oś czasu AC/drzwi/ruchu',
    colorLabel: 'Zaawansowane kolory', edColorsReset: '↩ Resetuj kolory',
    edRoomTitle: '🏷 Nazwa pokoju', edRoomTitlePlaceholder: 'np. Biuro, Sypialnia...',
    edSensorsTitle: 'Czujniki wewnętrzne',
    edAcTitle: 'Klimatyzacja',
    edOutdoorTitle: 'Czujniki zewnętrzne',
    edAcEntity: '❄️ Encja klimatyzacji (climate.*)',
    edDevicesTitle: 'Urządzenia',
    edAddDevPlaceholder: '— Wybierz typ urządzenia —',
    edAddDevLight: '💡 Światło (light)',
    edAddDevRgb: '🌈 Światło RGB (light + efekt)',
    edAddDevFan: '🌀 Wentylator (switch)',
    edAddDevOutlet: '🔌 Gniazdo (switch + potwierdzenie)',
    edAddDevTv: '📺 TV (media_player)',
    edAddDevSensor: '📡 Czujnik (sensor)',
    edAddBtn: '+ Dodaj',
    edNoDevices: 'Brak urządzeń. Kliknij "+ Dodaj" aby zacząć.',
    edAutoTitle: 'Automatyzacja',
    edSyncTitle: '🔄 Tryb synchronizacji',
    edSyncLocal: '💾 Lokalny',
    edSyncLocalSimple: 'PROSTY',
    edSyncLocalDesc: 'Zapisane w przeglądarce — proste, bez dodatkowej konfiguracji',
    edSyncHelpers: '🔘 HA Helpers',
    edSyncHelpersDesc: 'Synchronizacja przez input_boolean + input_number — wymaga ręcznego tworzenia',
    edSyncIntegration: '🧠 HA Smart Room Integration',
    edSyncIntRecommended: 'ZALECANE',
    edSyncIntDesc: 'Działa po stronie serwera — działa nawet przy zamkniętej przeglądarce',
    edSyncIntSetup: '✅ <b>Jednorazowa konfiguracja:</b>',
    edSyncIntStep1: 'HACS → Frontend → ⋮ → Niestandardowe repozytoria',
    edSyncIntStep1b: 'URL: <code>https://github.com/doanlong1412/ha-smart-room-card</code> → Typ: <b>Integration</b>',
    edSyncIntStep2: 'Znajdź <b>HA Smart Room</b> → Zainstaluj → Zrestartuj HA',
    edSyncIntStep3: 'Ustawienia → Urządzenia & Usługi → Dodaj integrację → <b>HA Smart Room</b>',
    edSyncIntStep4: 'Wróć do karty, kliknij Zapisz — karta rejestruje się automatycznie ✨',
    edSyncHelpersWarn: '⚠️ Utwórz 2 Helpers w HA przed użyciem.',
    edHelperBool: '🔘 Encja input_boolean',
    edHelperNum: '🔢 Encja input_number',
    edDelayTitle: '⏱️ Licznik',
    edDelayLabel: 'Wyłącz po ilu minutach bez ruchu',
    edDelayUnit: 'min',
    edAutoDevTitle: '🔌 Urządzenia do automatycznego wyłączenia',
    edAutoDevDesc: 'Odznacz urządzenia, których NIE chcesz automatycznie wyłączać',
    edSensorsSection: '📡 Czujniki & Urządzenia',
    tvControlBtn: '📺 Pilot',
    tvModalTitle: '📺 Sterowanie TV',
    tvPower: 'Zasilanie',
    tvMute: 'Wycisz',
    tvVolDown: 'Głos −',
    tvVolUp: 'Głos +',
    tvHome: 'Start',
    tvMenu: 'Menu',
    tvBack: 'Wstecz',
    tvInput: 'Źródło',
    tvVolLabel: 'GŁOŚNOŚĆ',
    devDen: '💡 Światło Główne',
    devDecor: '✨ Światło Dekoracyjne',
    devHien: '🏮 Światło Wejście',
    devRgb: '🌈 Światło RGB',
    devQuat: '🌀 Wentylator Sufitowy',
    devOcam: '🔌 Gniazdo Elektryczne',
    devTv: '📺 Smart TV',
    devTvRemote: '📱 Pilot TV',
    devAc: '❄️ Klimatyzacja',
    devNamePlaceholder: 'Nazwa urządzenia (np. Światło sypialnia)',
    devLabelLight: '💡 Światło',
    devLabelRgb: '🌈 Światło RGB',
    devLabelFan: '🌀 Wentylator',
    devLabelOutlet: '🔌 Gniazdo',
    devLabelTv: '📺 TV',
    devLabelSensor: '📡 Czujnik',
  },
  sv: {
    lang: 'Svenska', flag: 'se',
    edTitle: 'Kontorskort', edEntities: '📡 Entiteter', edBg: '🎨 Bakgrund',
    edDisplay: '👁 Visningsalternativ', edLang: '🌐 Språk', bgPresets: 'Förinställning',
    edBgAlpha: '🔆 Genomskinlighet', edBgBlur: '💎 Glas Blur Effekt', edBgBlurNone: 'Inget', edBgBlurMax: 'Max', edBgTransparent: 'Genomskinlig', edBgSolid: 'Solid',
    color1: 'Färg 1 (övre)', color2: 'Färg 2 (nedre)',
    edTemp: '🌡 Temperatursensor (sensor.*)', edHumi: '💧 Fuktighetssensor (sensor.*)',
    edPower: '⚡ Effektsensor (sensor.*)', edDoor: '🚪 Dörrsensor (binary_sensor.*)',
    edMotion: '🚶 Rörelsesensor (binary_sensor.*)', edTempOut: '🌤 Utomhustemperatur (sensor.*)',
    edHumiOut: '💧 Utomhusfuktighet (sensor.*)', edDen: '💡 Huvudljus (light.*)',
    edDecor: '✨ Dekorationsljus (switch.*)', edRgb: '🌈 RGB-ljus (light.*)',
    edHien: '🏮 Verandaljus (switch.*)', edQuat: '🌀 Takfläkt (switch.*)',
    edOcam: '🔌 Eluttag (switch.*)', edTv: '📺 Smart TV (media_player.*)',
    edTvRemote: '📱 TV Fjärrkontroll (remote.*)', edAc: '❄️ Luftkonditionering (climate.*)',
    edShowScore: 'Rumspoäng', edShowScoreDesc: 'Visa komfortpoäng',
    edShowGraph: 'Temperaturdiagram', edShowGraphDesc: 'Visa 6h historikdiagram',
    edShowSmartBar: 'Tipsrad', edShowSmartBarDesc: 'Visa energispartips',
    edShowAutoMode: 'Automatiskt läge', edShowAutoModeDesc: 'Visa auto-av när rummet är tomt',
    edShowEnvHint: 'Temp/fuktighet tips', edShowEnvHintDesc: 'Visa inne/ute-jämförelse',
    edShowTimeline: 'Enhetstidslinje', edShowTimelineDesc: 'Visa tidslinje AC/dörr/rörelse',
    colorLabel: 'Avancerade färger', edColorsReset: '↩ Återställ färger',
    edRoomTitle: '🏷 Rumsnamn', edRoomTitlePlaceholder: 't.ex. Kontor, Sovrum...',
    edSensorsTitle: 'Inomhussensorer',
    edAcTitle: 'Luftkonditionering',
    edOutdoorTitle: 'Utomhussensorer',
    edAcEntity: '❄️ AC-entitet (climate.*)',
    edDevicesTitle: 'Enheter',
    edAddDevPlaceholder: '— Välj enhetstyp —',
    edAddDevLight: '💡 Lampa (light)',
    edAddDevRgb: '🌈 RGB-lampa (light + effekt)',
    edAddDevFan: '🌀 Fläkt (switch)',
    edAddDevOutlet: '🔌 Eluttag (switch + bekräftelse)',
    edAddDevTv: '📺 TV (media_player)',
    edAddDevSensor: '📡 Sensor (sensor)',
    edAddBtn: '+ Lägg till',
    edNoDevices: 'Inga enheter. Klicka på "+ Lägg till" för att börja.',
    edAutoTitle: 'Automatisering',
    edSyncTitle: '🔄 Synkroniseringsläge',
    edSyncLocal: '💾 Lokalt',
    edSyncLocalSimple: 'ENKELT',
    edSyncLocalDesc: 'Lagras i webbläsaren — enkelt, ingen extra inställning',
    edSyncHelpers: '🔘 HA Helpers',
    edSyncHelpersDesc: 'Synkronisering via input_boolean + input_number — kräver manuellt skapande',
    edSyncIntegration: '🧠 HA Smart Room Integration',
    edSyncIntRecommended: 'REKOMMENDERAS',
    edSyncIntDesc: 'Körs server-side — fungerar även med stängd webbläsare',
    edSyncIntSetup: '✅ <b>Engångsinställning:</b>',
    edSyncIntStep1: 'HACS → Frontend → ⋮ → Anpassade förråd',
    edSyncIntStep1b: 'URL: <code>https://github.com/doanlong1412/ha-smart-room-card</code> → Typ: <b>Integration</b>',
    edSyncIntStep2: 'Hitta <b>HA Smart Room</b> → Installera → Starta om HA',
    edSyncIntStep3: 'Inställningar → Enheter & Tjänster → Lägg till integration → <b>HA Smart Room</b>',
    edSyncIntStep4: 'Tillbaka till kortet, klicka Spara — kortet registrerar sig automatiskt ✨',
    edSyncHelpersWarn: '⚠️ Skapa 2 Helpers i HA innan du använder.',
    edHelperBool: '🔘 input_boolean entitet',
    edHelperNum: '🔢 input_number entitet',
    edDelayTitle: '⏱️ Nedräkningstimer',
    edDelayLabel: 'Stäng av efter hur många minuter utan rörelse',
    edDelayUnit: 'min',
    edAutoDevTitle: '🔌 Enheter att stänga av automatiskt',
    edAutoDevDesc: 'Avmarkera enheter du INTE vill stänga av automatiskt',
    edSensorsSection: '📡 Sensorer & Enheter',
    tvControlBtn: '📺 Fjärrkontroll',
    tvModalTitle: '📺 TV Kontroll',
    tvPower: 'På/Av',
    tvMute: 'Ljud av',
    tvVolDown: 'Vol −',
    tvVolUp: 'Vol +',
    tvHome: 'Hem',
    tvMenu: 'Meny',
    tvBack: 'Tillbaka',
    tvInput: 'Källa',
    tvVolLabel: 'VOLYM',
    devDen: '💡 Huvudlampa',
    devDecor: '✨ Dekorationslampa',
    devHien: '🏮 Verandalampa',
    devRgb: '🌈 RGB-lampa',
    devQuat: '🌀 Takfläkt',
    devOcam: '🔌 Eluttag',
    devTv: '📺 Smart TV',
    devTvRemote: '📱 TV Fjärrkontroll',
    devAc: '❄️ Luftkonditionering',
    devNamePlaceholder: 'Enhetsnamn (t.ex. Sovrumslampa)',
    devLabelLight: '💡 Lampa',
    devLabelRgb: '🌈 RGB-lampa',
    devLabelFan: '🌀 Fläkt',
    devLabelOutlet: '🔌 Eluttag',
    devLabelTv: '📺 TV',
    devLabelSensor: '📡 Sensor',
  },
  hu: {
    lang: 'Magyar', flag: 'hu',
    edTitle: 'Irodakártya', edEntities: '📡 Entitások', edBg: '🎨 Háttér',
    edDisplay: '👁 Megjelenési beállítások', edLang: '🌐 Nyelv', bgPresets: 'Előbeállítás',
    edBgAlpha: '🔆 Átlátszóság', edBgBlur: '💎 Üveg Blur Hatás', edBgBlurNone: 'Nincs', edBgBlurMax: 'Max', edBgTransparent: 'Átlátszó', edBgSolid: 'Tömör',
    color1: 'Szín 1 (felső)', color2: 'Szín 2 (alsó)',
    edTemp: '🌡 Hőmérséklet-érzékelő (sensor.*)', edHumi: '💧 Páratartalom-érzékelő (sensor.*)',
    edPower: '⚡ Teljesítményérzékelő (sensor.*)', edDoor: '🚪 Ajtóérzékelő (binary_sensor.*)',
    edMotion: '🚶 Mozgásérzékelő (binary_sensor.*)', edTempOut: '🌤 Kültéri hőmérséklet (sensor.*)',
    edHumiOut: '💧 Kültéri páratartalom (sensor.*)', edDen: '💡 Fővilágítás (light.*)',
    edDecor: '✨ Dekorvilágítás (switch.*)', edRgb: '🌈 RGB-lámpa (light.*)',
    edHien: '🏮 Tornác lámpa (switch.*)', edQuat: '🌀 Mennyezeti ventilátor (switch.*)',
    edOcam: '🔌 Aljzat (switch.*)', edTv: '📺 Smart TV (media_player.*)',
    edTvRemote: '📱 TV távirányító (remote.*)', edAc: '❄️ Légkondicionáló (climate.*)',
    edShowScore: 'Szobapont', edShowScoreDesc: 'Komfortpontszám megjelenítése',
    edShowGraph: 'Hőmérsékletgrafikon', edShowGraphDesc: '6 órás előzmény megjelenítése',
    edShowSmartBar: 'Tippsor', edShowSmartBarDesc: 'Energiatakarékossági tippek',
    edShowAutoMode: 'Automatikus mód', edShowAutoModeDesc: 'Auto-kikapcsolás üres szobánál',
    edShowEnvHint: 'Hőm./páratartalom tippek', edShowEnvHintDesc: 'Beltéri/kültéri összehasonlítás',
    edShowTimeline: 'Eszköz idősor', edShowTimelineDesc: 'AC/ajtó/mozgás idősor',
    colorLabel: 'Speciális színek', edColorsReset: '↩ Színek visszaállítása',
    edRoomTitle: '🏷 Szoba neve', edRoomTitlePlaceholder: 'pl. Iroda, Hálószoba...',
    edSensorsTitle: 'Beltéri érzékelők',
    edAcTitle: 'Légkondicionáló',
    edOutdoorTitle: 'Kültéri érzékelők',
    edAcEntity: '❄️ Légkondicionáló entitás (climate.*)',
    edDevicesTitle: 'Eszközök',
    edAddDevPlaceholder: '— Eszköztípus kiválasztása —',
    edAddDevLight: '💡 Lámpa (light)',
    edAddDevRgb: '🌈 RGB lámpa (light + effekt)',
    edAddDevFan: '🌀 Ventilátor (switch)',
    edAddDevOutlet: '🔌 Aljzat (switch + megerősítés)',
    edAddDevTv: '📺 TV (media_player)',
    edAddDevSensor: '📡 Érzékelő (sensor)',
    edAddBtn: '+ Hozzáadás',
    edNoDevices: 'Nincsenek eszközök. Kattints a "+ Hozzáadás"-ra.',
    edAutoTitle: 'Automatizálás',
    edSyncTitle: '🔄 Szinkronizálási mód',
    edSyncLocal: '💾 Helyi',
    edSyncLocalSimple: 'EGYSZERŰ',
    edSyncLocalDesc: 'Böngészőben tárolva — egyszerű, nincs extra beállítás',
    edSyncHelpers: '🔘 HA Helpers',
    edSyncHelpersDesc: 'Szinkronizálás input_boolean + input_number segítségével — kézi létrehozás szükséges',
    edSyncIntegration: '🧠 HA Smart Room Integration',
    edSyncIntRecommended: 'AJÁNLOTT',
    edSyncIntDesc: 'Szerver oldalon fut — akkor is működik, ha a böngésző zárva van',
    edSyncIntSetup: '✅ <b>Egyszeri beállítás:</b>',
    edSyncIntStep1: 'HACS → Frontend → ⋮ → Egyéni tárolók',
    edSyncIntStep1b: 'URL: <code>https://github.com/doanlong1412/ha-smart-room-card</code> → Típus: <b>Integration</b>',
    edSyncIntStep2: '<b>HA Smart Room</b> keresése → Telepítés → HA újraindítás',
    edSyncIntStep3: 'Beállítások → Eszközök & Szolgáltatások → Integráció hozzáadása → <b>HA Smart Room</b>',
    edSyncIntStep4: 'Vissza a kártyához, Mentés kattintás — a kártya automatikusan regisztrál ✨',
    edSyncHelpersWarn: '⚠️ Hozz létre 2 Helpers-t a HA-ban használat előtt.',
    edHelperBool: '🔘 input_boolean entitás',
    edHelperNum: '🔢 input_number entitás',
    edDelayTitle: '⏱️ Visszaszámlálás',
    edDelayLabel: 'Kapcsoljon ki ennyi perc mozgás nélkül',
    edDelayUnit: 'perc',
    edAutoDevTitle: '🔌 Automatikusan kikapcsolandó eszközök',
    edAutoDevDesc: 'Törölje a jelölést azon eszközöknél, amelyeket NEM akar automatikusan kikapcsolni',
    edSensorsSection: '📡 Érzékelők & Eszközök',
    tvControlBtn: '📺 Távirányító',
    tvModalTitle: '📺 TV Vezérlés',
    tvPower: 'Be/Ki',
    tvMute: 'Némítás',
    tvVolDown: 'Hangerő −',
    tvVolUp: 'Hangerő +',
    tvHome: 'Főoldal',
    tvMenu: 'Menü',
    tvBack: 'Vissza',
    tvInput: 'Forrás',
    tvVolLabel: 'HANGERŐ',
    devDen: '💡 Fővilágítás',
    devDecor: '✨ Dekor Lámpa',
    devHien: '🏮 Tornác Lámpa',
    devRgb: '🌈 RGB Lámpa',
    devQuat: '🌀 Mennyezeti Ventilátor',
    devOcam: '🔌 Aljzat',
    devTv: '📺 Smart TV',
    devTvRemote: '📱 TV Távirányító',
    devAc: '❄️ Légkondicionáló',
    devNamePlaceholder: 'Eszköz neve (pl. Hálószoba lámpa)',
    devLabelLight: '💡 Lámpa',
    devLabelRgb: '🌈 RGB Lámpa',
    devLabelFan: '🌀 Ventilátor',
    devLabelOutlet: '🔌 Aljzat',
    devLabelTv: '📺 TV',
    devLabelSensor: '📡 Érzékelő',
  },
  cs: {
    lang: 'Čeština', flag: 'cz',
    edTitle: 'Karta kanceláře', edEntities: '📡 Entity', edBg: '🎨 Pozadí',
    edDisplay: '👁 Možnosti zobrazení', edLang: '🌐 Jazyk', bgPresets: 'Přednastavení',
    edBgAlpha: '🔆 Průhlednost', edBgBlur: '💎 Skleněný Blur Efekt', edBgBlurNone: 'Žádný', edBgBlurMax: 'Max', edBgTransparent: 'Průhledné', edBgSolid: 'Plné',
    color1: 'Barva 1 (horní)', color2: 'Barva 2 (dolní)',
    edTemp: '🌡 Teplotní senzor (sensor.*)', edHumi: '💧 Senzor vlhkosti (sensor.*)',
    edPower: '⚡ Senzor výkonu (sensor.*)', edDoor: '🚪 Dveřní senzor (binary_sensor.*)',
    edMotion: '🚶 Pohybový senzor (binary_sensor.*)', edTempOut: '🌤 Venkovní teplota (sensor.*)',
    edHumiOut: '💧 Venkovní vlhkost (sensor.*)', edDen: '💡 Hlavní světlo (light.*)',
    edDecor: '✨ Dekorativní světlo (switch.*)', edRgb: '🌈 RGB světlo (light.*)',
    edHien: '🏮 Světlo u vchodu (switch.*)', edQuat: '🌀 Stropní ventilátor (switch.*)',
    edOcam: '🔌 Elektrická zásuvka (switch.*)', edTv: '📺 Smart TV (media_player.*)',
    edTvRemote: '📱 Dálkové ovládání TV (remote.*)', edAc: '❄️ Klimatizace (climate.*)',
    edShowScore: 'Skóre místnosti', edShowScoreDesc: 'Zobrazit skóre komfortu',
    edShowGraph: 'Graf teploty', edShowGraphDesc: 'Zobrazit 6h historický graf',
    edShowSmartBar: 'Panel tipů', edShowSmartBarDesc: 'Zobrazit tipy pro úsporu energie',
    edShowAutoMode: 'Automatický režim', edShowAutoModeDesc: 'Zobrazit auto-vypnutí',
    edShowEnvHint: 'Tipy teplota/vlhkost', edShowEnvHintDesc: 'Zobrazit srovnání vnitřek/venkovní',
    edShowTimeline: 'Časová osa zařízení', edShowTimelineDesc: 'Zobrazit časovou osu AC/dveře/pohyb',
    colorLabel: 'Pokročilé barvy', edColorsReset: '↩ Obnovit barvy',
    edRoomTitle: '🏷 Název místnosti', edRoomTitlePlaceholder: 'např. Kancelář, Ložnice...',
    edSensorsTitle: 'Vnitřní senzory',
    edAcTitle: 'Klimatizace',
    edOutdoorTitle: 'Venkovní senzory',
    edAcEntity: '❄️ Entita klimatizace (climate.*)',
    edDevicesTitle: 'Zařízení',
    edAddDevPlaceholder: '— Vyberte typ zařízení —',
    edAddDevLight: '💡 Světlo (light)',
    edAddDevRgb: '🌈 RGB světlo (light + efekt)',
    edAddDevFan: '🌀 Ventilátor (switch)',
    edAddDevOutlet: '🔌 Zásuvka (switch + potvrzení)',
    edAddDevTv: '📺 TV (media_player)',
    edAddDevSensor: '📡 Senzor (sensor)',
    edAddBtn: '+ Přidat',
    edNoDevices: 'Žádná zařízení. Klikněte na "+ Přidat" pro začátek.',
    edAutoTitle: 'Automatizace',
    edSyncTitle: '🔄 Režim synchronizace',
    edSyncLocal: '💾 Lokální',
    edSyncLocalSimple: 'JEDNODUCHÉ',
    edSyncLocalDesc: 'Uloženo v prohlížeči — jednoduché, bez další konfigurace',
    edSyncHelpers: '🔘 HA Helpers',
    edSyncHelpersDesc: 'Synchronizace přes input_boolean + input_number — nutné ruční vytvoření',
    edSyncIntegration: '🧠 HA Smart Room Integration',
    edSyncIntRecommended: 'DOPORUČENO',
    edSyncIntDesc: 'Běží na serveru — funguje i při zavřeném prohlížeči',
    edSyncIntSetup: '✅ <b>Jednorázové nastavení:</b>',
    edSyncIntStep1: 'HACS → Frontend → ⋮ → Vlastní repozitáře',
    edSyncIntStep1b: 'URL: <code>https://github.com/doanlong1412/ha-smart-room-card</code> → Typ: <b>Integration</b>',
    edSyncIntStep2: 'Najít <b>HA Smart Room</b> → Instalovat → Restartovat HA',
    edSyncIntStep3: 'Nastavení → Zařízení & Služby → Přidat integraci → <b>HA Smart Room</b>',
    edSyncIntStep4: 'Zpět na kartu, kliknout Uložit — karta se automaticky zaregistruje ✨',
    edSyncHelpersWarn: '⚠️ Nejprve vytvořte 2 Helpers v HA.',
    edHelperBool: '🔘 Entita input_boolean',
    edHelperNum: '🔢 Entita input_number',
    edDelayTitle: '⏱️ Časovač odpočtu',
    edDelayLabel: 'Vypnout po kolika minutách bez pohybu',
    edDelayUnit: 'min',
    edAutoDevTitle: '🔌 Zařízení pro automatické vypnutí',
    edAutoDevDesc: 'Odznačte zařízení, která NECHCETE automaticky vypínat',
    edSensorsSection: '📡 Senzory & Zařízení',
    tvControlBtn: '📺 Dálkové ovládání',
    tvModalTitle: '📺 Ovládání TV',
    tvPower: 'Napájení',
    tvMute: 'Ztlumit',
    tvVolDown: 'Hlasitost −',
    tvVolUp: 'Hlasitost +',
    tvHome: 'Domů',
    tvMenu: 'Nabídka',
    tvBack: 'Zpět',
    tvInput: 'Vstup',
    tvVolLabel: 'HLASITOST',
    devDen: '💡 Hlavní Světlo',
    devDecor: '✨ Dekorativní Světlo',
    devHien: '🏮 Světlo Veranda',
    devRgb: '🌈 RGB Světlo',
    devQuat: '🌀 Stropní Ventilátor',
    devOcam: '🔌 Zásuvka',
    devTv: '📺 Smart TV',
    devTvRemote: '📱 TV Dálkový Ovladač',
    devAc: '❄️ Klimatizace',
    devNamePlaceholder: 'Název zařízení (např. Světlo ložnice)',
    devLabelLight: '💡 Světlo',
    devLabelRgb: '🌈 RGB Světlo',
    devLabelFan: '🌀 Ventilátor',
    devLabelOutlet: '🔌 Zásuvka',
    devLabelTv: '📺 TV',
    devLabelSensor: '📡 Senzor',
  },
  it: {
    lang: 'Italiano', flag: 'it',
    edTitle: 'Scheda Ufficio', edEntities: '📡 Entità', edBg: '🎨 Sfondo',
    edDisplay: '👁 Opzioni di visualizzazione', edLang: '🌐 Lingua', bgPresets: 'Predefinito',
    edBgAlpha: '🔆 Opacità', edBgBlur: '💎 Effetto Vetro Sfocato', edBgBlurNone: 'Nessuno', edBgBlurMax: 'Max', edBgTransparent: 'Trasparente', edBgSolid: 'Solido',
    color1: 'Colore 1 (sopra)', color2: 'Colore 2 (sotto)',
    edTemp: '🌡 Sensore di temperatura (sensor.*)', edHumi: '💧 Sensore di umidità (sensor.*)',
    edPower: '⚡ Sensore di potenza (sensor.*)', edDoor: '🚪 Sensore porta (binary_sensor.*)',
    edMotion: '🚶 Sensore di movimento (binary_sensor.*)', edTempOut: '🌤 Temperatura esterna (sensor.*)',
    edHumiOut: '💧 Umidità esterna (sensor.*)', edDen: '💡 Luce principale (light.*)',
    edDecor: '✨ Luce decorativa (switch.*)', edRgb: '🌈 Luce RGB (light.*)',
    edHien: '🏮 Luce veranda (switch.*)', edQuat: '🌀 Ventilatore da soffitto (switch.*)',
    edOcam: '🔌 Presa elettrica (switch.*)', edTv: '📺 Smart TV (media_player.*)',
    edTvRemote: '📱 Telecomando TV (remote.*)', edAc: '❄️ Condizionatore (climate.*)',
    edShowScore: 'Punteggio stanza', edShowScoreDesc: 'Mostra punteggio comfort',
    edShowGraph: 'Grafico temperatura', edShowGraphDesc: 'Mostra grafico storico 6h',
    edShowSmartBar: 'Barra suggerimenti', edShowSmartBarDesc: 'Mostra suggerimenti risparmio',
    edShowAutoMode: 'Modalità automatica', edShowAutoModeDesc: 'Mostra auto-spegnimento stanza vuota',
    edShowEnvHint: 'Suggerimenti temp/umidità', edShowEnvHintDesc: 'Mostra confronto interno/esterno',
    edShowTimeline: 'Cronologia dispositivi', edShowTimelineDesc: 'Mostra cronologia AC/porta/movimento',
    colorLabel: 'Colori avanzati', edColorsReset: '↩ Ripristina colori',
    edRoomTitle: '🏷 Nome stanza', edRoomTitlePlaceholder: 'es. Ufficio, Camera...',
    edSensorsTitle: 'Sensori interni',
    edAcTitle: 'Condizionatore',
    edOutdoorTitle: 'Sensori esterni',
    edAcEntity: '❄️ Entità condizionatore (climate.*)',
    edDevicesTitle: 'Dispositivi',
    edAddDevPlaceholder: '— Seleziona tipo dispositivo —',
    edAddDevLight: '💡 Luce (light)',
    edAddDevRgb: '🌈 Luce RGB (light + effetto)',
    edAddDevFan: '🌀 Ventilatore (switch)',
    edAddDevOutlet: '🔌 Presa elettrica (switch + conferma)',
    edAddDevTv: '📺 TV (media_player)',
    edAddDevSensor: '📡 Sensore (sensor)',
    edAddBtn: '+ Aggiungi',
    edNoDevices: 'Nessun dispositivo. Clicca "+ Aggiungi" per iniziare.',
    edAutoTitle: 'Automazione',
    edSyncTitle: '🔄 Modalità di sincronizzazione',
    edSyncLocal: '💾 Locale',
    edSyncLocalSimple: 'SEMPLICE',
    edSyncLocalDesc: 'Salvato nel browser — semplice, nessuna configurazione extra',
    edSyncHelpers: '🔘 HA Helpers',
    edSyncHelpersDesc: 'Sincronizzazione tramite input_boolean + input_number — creazione manuale richiesta',
    edSyncIntegration: '🧠 HA Smart Room Integration',
    edSyncIntRecommended: 'CONSIGLIATO',
    edSyncIntDesc: 'Esegue lato server — funziona anche con browser chiuso',
    edSyncIntSetup: '✅ <b>Configurazione una tantum:</b>',
    edSyncIntStep1: 'HACS → Frontend → ⋮ → Repository personalizzati',
    edSyncIntStep1b: 'URL: <code>https://github.com/doanlong1412/ha-smart-room-card</code> → Tipo: <b>Integration</b>',
    edSyncIntStep2: 'Trovare <b>HA Smart Room</b> → Installa → Riavvia HA',
    edSyncIntStep3: 'Impostazioni → Dispositivi & Servizi → Aggiungi integrazione → <b>HA Smart Room</b>',
    edSyncIntStep4: 'Torna alla scheda, clicca Salva — la scheda si registra automaticamente ✨',
    edSyncHelpersWarn: '⚠️ Crea prima 2 Helpers in HA.',
    edHelperBool: '🔘 Entità input_boolean',
    edHelperNum: '🔢 Entità input_number',
    edDelayTitle: '⏱️ Timer conto alla rovescia',
    edDelayLabel: 'Spegnere dopo quanti minuti senza movimento',
    edDelayUnit: 'min',
    edAutoDevTitle: '🔌 Dispositivi da spegnere automaticamente',
    edAutoDevDesc: 'Deseleziona i dispositivi che NON vuoi spegnere automaticamente',
    edSensorsSection: '📡 Sensori & Dispositivi',
    tvControlBtn: '📺 Telecomando',
    tvModalTitle: '📺 Controllo TV',
    tvPower: 'Accensione',
    tvMute: 'Muto',
    tvVolDown: 'Vol −',
    tvVolUp: 'Vol +',
    tvHome: 'Home',
    tvMenu: 'Menu',
    tvBack: 'Indietro',
    tvInput: 'Sorgente',
    tvVolLabel: 'VOLUME',
    devDen: '💡 Luce Principale',
    devDecor: '✨ Luce Decorativa',
    devHien: '🏮 Luce Veranda',
    devRgb: '🌈 Luce RGB',
    devQuat: '🌀 Ventilatore Soffitto',
    devOcam: '🔌 Presa Elettrica',
    devTv: '📺 Smart TV',
    devTvRemote: '📱 Telecomando TV',
    devAc: '❄️ Climatizzatore',
    devNamePlaceholder: 'Nome dispositivo (es. Luce camera da letto)',
    devLabelLight: '💡 Luce',
    devLabelRgb: '🌈 Luce RGB',
    devLabelFan: '🌀 Ventilatore',
    devLabelOutlet: '🔌 Presa',
    devLabelTv: '📺 TV',
    devLabelSensor: '📡 Sensore',
  },
  pt: {
    lang: 'Português', flag: 'pt',
    edTitle: 'Cartão do Escritório', edEntities: '📡 Entidades', edBg: '🎨 Plano de fundo',
    edDisplay: '👁 Opções de exibição', edLang: '🌐 Idioma', bgPresets: 'Predefinição',
    edBgAlpha: '🔆 Opacidade', edBgBlur: '💎 Efeito Vidro Desfocado', edBgBlurNone: 'Nenhum', edBgBlurMax: 'Máx', edBgTransparent: 'Transparente', edBgSolid: 'Sólido',
    color1: 'Cor 1 (cima)', color2: 'Cor 2 (baixo)',
    edTemp: '🌡 Sensor de temperatura (sensor.*)', edHumi: '💧 Sensor de humidade (sensor.*)',
    edPower: '⚡ Sensor de potência (sensor.*)', edDoor: '🚪 Sensor de porta (binary_sensor.*)',
    edMotion: '🚶 Sensor de movimento (binary_sensor.*)', edTempOut: '🌤 Temperatura exterior (sensor.*)',
    edHumiOut: '💧 Humidade exterior (sensor.*)', edDen: '💡 Luz principal (light.*)',
    edDecor: '✨ Luz decorativa (switch.*)', edRgb: '🌈 Luz RGB (light.*)',
    edHien: '🏮 Luz varanda (switch.*)', edQuat: '🌀 Ventilador de teto (switch.*)',
    edOcam: '🔌 Tomada elétrica (switch.*)', edTv: '📺 Smart TV (media_player.*)',
    edTvRemote: '📱 Controlo remoto TV (remote.*)', edAc: '❄️ Ar condicionado (climate.*)',
    edShowScore: 'Pontuação do quarto', edShowScoreDesc: 'Mostrar pontuação de conforto',
    edShowGraph: 'Gráfico de temperatura', edShowGraphDesc: 'Mostrar gráfico histórico de 6h',
    edShowSmartBar: 'Barra de dicas', edShowSmartBarDesc: 'Mostrar dicas de poupança',
    edShowAutoMode: 'Modo automático', edShowAutoModeDesc: 'Mostrar auto-desligamento',
    edShowEnvHint: 'Dicas temp/humidade', edShowEnvHintDesc: 'Mostrar comparação interior/exterior',
    edShowTimeline: 'Linha do tempo', edShowTimelineDesc: 'Mostrar linha do tempo AC/porta/movimento',
    colorLabel: 'Cores avançadas', edColorsReset: '↩ Repor cores',
    edRoomTitle: '🏷 Nome do quarto', edRoomTitlePlaceholder: 'ex. Escritório, Quarto...',
    edSensorsTitle: 'Sensores interiores',
    edAcTitle: 'Ar condicionado',
    edOutdoorTitle: 'Sensores exteriores',
    edAcEntity: '❄️ Entidade AC (climate.*)',
    edDevicesTitle: 'Dispositivos',
    edAddDevPlaceholder: '— Selecionar tipo —',
    edAddDevLight: '💡 Luz (light)',
    edAddDevRgb: '🌈 Luz RGB (light + efeito)',
    edAddDevFan: '🌀 Ventilador (switch)',
    edAddDevOutlet: '🔌 Tomada (switch + confirmação)',
    edAddDevTv: '📺 TV (media_player)',
    edAddDevSensor: '📡 Sensor (sensor)',
    edAddBtn: '+ Adicionar',
    edNoDevices: 'Sem dispositivos. Clique em "+ Adicionar" para começar.',
    edAutoTitle: 'Automação',
    edSyncTitle: '🔄 Modo de sincronização',
    edSyncLocal: '💾 Local',
    edSyncLocalSimple: 'SIMPLES',
    edSyncLocalDesc: 'Guardado no browser — simples, sem configuração extra',
    edSyncHelpers: '🔘 HA Helpers',
    edSyncHelpersDesc: 'Sincronização via input_boolean + input_number — criação manual necessária',
    edSyncIntegration: '🧠 HA Smart Room Integration',
    edSyncIntRecommended: 'RECOMENDADO',
    edSyncIntDesc: 'Corre no servidor — funciona mesmo com browser fechado',
    edSyncIntSetup: '✅ <b>Configuração única:</b>',
    edSyncIntStep1: 'HACS → Frontend → ⋮ → Repositórios personalizados',
    edSyncIntStep1b: 'URL: <code>https://github.com/doanlong1412/ha-smart-room-card</code> → Tipo: <b>Integration</b>',
    edSyncIntStep2: 'Encontrar <b>HA Smart Room</b> → Instalar → Reiniciar HA',
    edSyncIntStep3: 'Configurações → Dispositivos & Serviços → Adicionar integração → <b>HA Smart Room</b>',
    edSyncIntStep4: 'Voltar ao card, clicar Guardar — o card regista-se automaticamente ✨',
    edSyncHelpersWarn: '⚠️ Crie 2 Helpers no HA antes de usar.',
    edHelperBool: '🔘 Entidade input_boolean',
    edHelperNum: '🔢 Entidade input_number',
    edDelayTitle: '⏱️ Temporizador',
    edDelayLabel: 'Desligar após quantos minutos sem movimento',
    edDelayUnit: 'min',
    edAutoDevTitle: '🔌 Dispositivos a desligar automaticamente',
    edAutoDevDesc: 'Desmarque dispositivos que NÃO quer desligar automaticamente',
    edSensorsSection: '📡 Sensores & Dispositivos',
    tvControlBtn: '📺 Controlo Remoto',
    tvModalTitle: '📺 Controlo TV',
    tvPower: 'Liga/Desliga',
    tvMute: 'Mudo',
    tvVolDown: 'Vol −',
    tvVolUp: 'Vol +',
    tvHome: 'Início',
    tvMenu: 'Menu',
    tvBack: 'Voltar',
    tvInput: 'Fonte',
    tvVolLabel: 'VOLUME',
    devDen: '💡 Luz Principal',
    devDecor: '✨ Luz Decorativa',
    devHien: '🏮 Luz Varanda',
    devRgb: '🌈 Luz RGB',
    devQuat: '🌀 Ventilador Teto',
    devOcam: '🔌 Tomada',
    devTv: '📺 Smart TV',
    devTvRemote: '📱 Controle TV',
    devAc: '❄️ Ar Condicionado',
    devNamePlaceholder: 'Nome do dispositivo (ex: Luz quarto)',
    devLabelLight: '💡 Luz',
    devLabelRgb: '🌈 Luz RGB',
    devLabelFan: '🌀 Ventilador',
    devLabelOutlet: '🔌 Tomada',
    devLabelTv: '📺 TV',
    devLabelSensor: '📡 Sensor',
  },
sl: {
    lang: 'Slovenščina', flag: 'si',
    edTitle: 'HA Smart Room Card',
    edEntities: '📡 Entitete (Entity)',
    edBg: '🎨 Ozadje',
    edDisplay: '👁 Prikaz',
    edLang: '🌐 Jezik',
    bgPresets: 'Prednastavitve',
    edBgAlpha: '🔆 Prozornost', edBgBlur: '💎 Hiệu ứng Glass Blur', edBgBlurNone: 'Brez', edBgBlurMax: 'Največ', edBgTransparent: 'Prozorno', edBgSolid: 'Polno',
    color1: 'Barva 1 (zgoraj)', color2: 'Barva 2 (spodaj)',
    edTemp: '🌡 Senzor temperature (sensor.*)',
    edHumi: '💧 Senzor vlažnosti (sensor.*)',
    edPower: '⚡ Senzor moči (sensor.*)',
    edDoor: '🚪 Senzor vrat (binary_sensor.*)',
    edMotion: '🚶 Senzor gibanja (binary_sensor.*)',
    edTempOut: '🌤 Zunanja temperatura (sensor.*)',
    edHumiOut: '💧 Zunanja vlažnost (sensor.*)',
    edDen: '💡 Glavna luč (light.*)',
    edDecor: '✨ Dekorativna luč (switch.*)',
    edRgb: '🌈 RGB luč (light.*)',
    edHien: '🏮 Luč na terasi (switch.*)',
    edQuat: '🌀 Stropni ventilator (switch.*)',
    edOcam: '🔌 Vtičnica (switch.*)',
    edTv: '📺 Smart TV (media_player.*)',
    edTvRemote: '📱 TV Daljinec (remote.*)',
    edAc: '❄️ Klimatska naprava (climate.*)',
    edShowScore: 'Ocena prostora', edShowScoreDesc: 'Prikaži polje za izračun udobja',
    edShowGraph: 'Graf temperature', edShowGraphDesc: 'Prikaži graf za zadnjih 6 ur',
    edShowSmartBar: 'Pametna vrstica s predlogi', edShowSmartBarDesc: 'Prikaži predloge za varčevanje z energijo',
    edShowAutoMode: 'Samodejni način', edShowAutoModeDesc: 'Prikaži gumb za samodejni izklop ob odsotnosti',
    edShowEnvHint: 'Nasveti za okolje', edShowEnvHintDesc: 'Prikaži primerjavo temperature znotraj-zunaj',
    edShowTimeline: 'Časovnica naprav', edShowTimelineDesc: 'Prikaži časovni graf za klimo, vrata, gibanje',
    colorLabel: 'Napredne barve',
    edColorsReset: '↩ Ponastavi barve na privzeto',
    edRoomTitle: '🏷 Prikazano ime (Smart Home)',
    edRoomTitlePlaceholder: 'npr. Delovna soba, Spalnica...',
    edSensorsTitle: 'Senzorji v prostoru',
    edAcTitle: 'Klima',
    edOutdoorTitle: 'Zunanji senzorji',
    edAcEntity: '❄️ Entiteta klime (climate.*)',
    edDevicesTitle: 'Naprave',
    edAddDevPlaceholder: '— Izberi vrsto naprave —',
    edAddDevLight: '💡 Navadna luč (light)',
    edAddDevRgb: '🌈 RGB luč (light + učinki)',
    edAddDevFan: '🌀 Ventilator (switch)',
    edAddDevOutlet: '🔌 Vtičnica (switch + potrditev)',
    edAddDevTv: '📺 TV (media_player)',
    edAddDevSensor: '📡 Senzor (sensor)',
    edAddBtn: '+ Dodaj',
    edNoDevices: 'Ni naprav. Pritisni "+ Dodaj" za začetek.',
    edAutoTitle: 'Avtomatizacija',
    edSyncTitle: '🔄 Način sinhronizacije',
    edSyncLocal: '💾 Lokalno',
    edSyncLocalSimple: 'PREPROSTO',
    edSyncLocalDesc: 'Shranjeno v brskalniku — preprosto, brez dodatne namestitve',
    edSyncHelpers: '🔘 HA Helperji',
    edSyncHelpersDesc: 'Sinhronizacija med napravami prek input_boolean + input_number — zahteva ročno ustvarjanje helperjev',
    edSyncIntegration: '🧠 HA Smart Room Integracija',
    edSyncIntRecommended: 'PRIPOROČENO',
    edSyncIntDesc: 'Deluje na strani strežnika — deluje tudi, ko je brskalnik zaprt, popolna sinhronizacija naprav',
    edSyncIntSetup: '✅ <b>Enkratna nastavitev:</b>',
    edSyncIntStep1: 'HACS → Frontend → ⋮ → Custom repositories',
    edSyncIntStep1b: 'URL: <code>https://github.com/doanlong1412/ha-smart-room-card</code> → Tip: <b>Integration</b>',
    edSyncIntStep2: 'Poišči <b>HA Smart Room</b> → Namesti → Ponovni zagon HA',
    edSyncIntStep3: 'Nastavitve → Naprave in storitve → Dodaj integracijo → <b>HA Smart Room</b>',
    edSyncIntStep4: 'Vrni se na kartico, pritisni Shrani — kartica se samodejno registrira ✨',
    edSyncHelpersWarn: '⚠️ Pred uporabo ustvarite 2 Helperja v HA.',
    edHelperBool: '🔘 entiteta input_boolean',
    edHelperNum: '🔢 entiteta input_number',
    edDelayTitle: '⏱️ Odštevanje časa',
    edDelayLabel: 'Izklop po koliko minutah odsotnosti',
    edDelayUnit: 'min',
    edAutoDevTitle: '🔌 Naprave za samodejni izklop',
    edAutoDevDesc: 'Odznači naprave, ki jih NE želiš samodejno izklopiti',
    edSensorsSection: '📡 Senzorji in naprave',
    tvControlBtn: '📺 Upravljanje',
    tvModalTitle: '📺 Upravljanje TV',
    tvPower: 'Napajanje',
    tvMute: 'Nemo',
    tvVolDown: 'Glasnost −',
    tvVolUp: 'Glasnost +',
    tvHome: 'Domov',
    tvMenu: 'Meni',
    tvBack: 'Nazaj',
    tvInput: 'Vhod',
    tvVolLabel: 'GLASNOST',
    devDen: '💡 Glavna Luč',
    devDecor: '✨ Dekorativna Luč',
    devHien: '🏮 Luč na terasi',
    devRgb: '🌈 RGB Luč',
    devQuat: '🌀 Stropni Ventilator',
    devOcam: '🔌 Vtičnica',
    devTv: '📺 Smart TV',
    devTvRemote: '📱 TV Daljinec',
    devAc: '❄️ Klima',
    devNamePlaceholder: 'Ime naprave (npr. Luč v spalnici)',
    devLabelLight: '💡 Luč',
    devLabelRgb: '🌈 RGB Luč',
    devLabelFan: '🌀 Ventilator',
    devLabelOutlet: '🔌 Vtičnica',
    devLabelTv: '📺 TV',
    devLabelSensor: '📡 Senzor',
  },
};

// ─── Background presets (same palette as multi-ac-card) ──────
const HSRC_BG_PRESETS = [
  { id: 'default',   label: 'Default',   c1: '#0e1f38', c2: '#0a4a7a' },
  { id: 'night',     label: 'Night',     c1: '#0d0d1a', c2: '#1a0a3a' },
  { id: 'deep_neon', label: '🔵 Neon',   c1: '#020b18', c2: '#00d4ff' },
  { id: 'sunset',    label: 'Sunset',    c1: '#1a0a00', c2: '#ff6b35' },
  { id: 'forest',    label: 'Forest',    c1: '#0a1a0a', c2: '#1a5c1a' },
  { id: 'aurora',    label: 'Aurora',    c1: '#0a0a1a', c2: '#00cc88' },
  { id: 'ocean',     label: 'Ocean',     c1: '#001020', c2: '#0055aa' },
  { id: 'galaxy',    label: 'Galaxy',    c1: '#080818', c2: '#6633cc' },
  { id: 'ice',       label: 'Ice',       c1: '#0a1828', c2: '#88ddff' },
  { id: 'cherry',    label: 'Cherry',    c1: '#1a0010', c2: '#cc2255' },
  { id: 'volcano',   label: 'Volcano',   c1: '#1a0500', c2: '#dd3300' },
  { id: 'rose',      label: 'Rose',      c1: '#1a0808', c2: '#ee6688' },
  { id: 'teal',      label: 'Teal',      c1: '#001818', c2: '#00aa88' },
  { id: 'desert',    label: 'Desert',    c1: '#1a0e00', c2: '#c8860a' },
  { id: 'slate',     label: 'Slate',     c1: '#101820', c2: '#445566' },
  { id: 'olive',     label: 'Olive',     c1: '#0e1200', c2: '#7a9a00' },
  { id: 'custom',    label: '✏ Custom',  c1: null,      c2: null      },
];

// ─── Editor class ─────────────────────────────────────────────
class HASmartRoomCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass   = null;
    this._open   = { lang: true, roomtitle: true, sensors: true, devices: true, automation: false, bg: true, display: false, colors: false };
    this._picker = null;
  }

  setConfig(c) {
    this._config = { ...c };
    this._render();
  }

  set hass(h) {
    this._hass = h;
    this._syncPickers();
  }

  get t() {
    const lang = this._config.language || 'vi';
    return HSRC_TRANSLATIONS[lang] || HSRC_TRANSLATIONS.vi;
  }

  _fire() {
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config: this._config }, bubbles: true, composed: true,
    }));
  }

  _syncPickers() {
    if (!this._hass || !this.shadowRoot) return;
    const apply = () => {
      this.shadowRoot.querySelectorAll('ha-entity-picker').forEach(p => {
        p.hass = this._hass;
        const domain = p.dataset.domain;
        if (domain) p.includeDomains = domain.split(',');
        const key = p.dataset.key;
        if (key) {
          const saved = this._config[key] || '';
          if (saved && p.value !== saved) { p.value = saved; p.setAttribute('value', saved); }
        }
      });
    };
    apply();
    requestAnimationFrame(() => requestAnimationFrame(apply));
  }

  _toggleSection(id) {
    this._open[id] = !this._open[id];
    const body  = this.shadowRoot.getElementById('body-' + id);
    const arrow = this.shadowRoot.getElementById('arrow-' + id);
    if (body) {
      body.style.display = this._open[id] ? 'block' : 'none';
      if (arrow) arrow.textContent = this._open[id] ? '▾' : '▸';
      if (this._open[id]) this._syncPickers();
    }
  }

  _colorRow(key, label) {
    const value  = this._config[key] || '#ffffff';
    const isOpen = this._picker === key;
    const swatches = ['#00ffcc','#00dcff','#ff5252','#ffd740','#ff8a65','#2288ee',
                      '#ffffff','#aaaaaa','#ffaa00','#22cc77','#ee4444','#cc44ff'];
    return `
<div class="ci">
  <div class="ci-hdr" data-cp="${key}">
    <div class="ci-swatch" style="background:${value};"></div>
    <span class="ci-label">${label}</span>
    <code class="ci-code">${value}</code>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" class="ci-chv">
      <path d="${isOpen?'M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z':'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z'}"/>
    </svg>
  </div>
  ${isOpen ? `
  <div class="ci-body">
    <input type="color" data-cp-native="${key}" value="${value}" class="ci-native"/>
    <div class="ci-hex-wrap">
      <span class="ci-hash">#</span>
      <input type="text" data-cp-hex="${key}" value="${value.replace('#','')}" maxlength="6" placeholder="rrggbb" class="ci-hex-inp"/>
    </div>
    <div class="ci-swatches">
      ${swatches.map(c=>`<div data-cp-dot="${key}" data-color="${c}" class="ci-dot"
        style="background:${c};outline:${value===c?'2px solid var(--primary-color)':'2px solid transparent'};"></div>`).join('')}
    </div>
  </div>` : ''}
</div>`;
  }

  _entityField(key, label, domain) {
    return `
<div class="row">
  <label>${label}</label>
  <ha-entity-picker data-key="${key}" data-domain="${domain}" allow-custom-entity></ha-entity-picker>
</div>`;
  }

  // ── Default device definitions (language-aware) ──────────────────────────
  _getDefaultDevices(t) {
    t = t || this.t;
    return [
      { id: 'den',      label: t.devDen      || '💡 Main Light',        entityKey: 'den_entity',       domain: 'light',        type: 'den'    },
      { id: 'decor',    label: t.devDecor    || '✨ Decor Light',        entityKey: 'decor_entity',     domain: 'light,switch', type: 'den'    },
      { id: 'hien',     label: t.devHien     || '🏮 Porch Light',        entityKey: 'hien_entity',      domain: 'light,switch', type: 'den'    },
      { id: 'rgb',      label: t.devRgb      || '🌈 RGB Light',          entityKey: 'rgb_entity',       domain: 'light',        type: 'rgb'    },
      { id: 'quat',     label: t.devQuat     || '🌀 Ceiling Fan',        entityKey: 'quat_entity',      domain: 'fan,switch',   type: 'quat'   },
      { id: 'ocam',     label: t.devOcam     || '🔌 Power Outlet',       entityKey: 'ocam_entity',      domain: 'switch',       type: 'sensor' },
      { id: 'tv',       label: t.devTv       || '📺 Smart TV',           entityKey: 'tv_entity',        domain: 'media_player', type: 'tv'     },
      { id: 'tvRemote', label: t.devTvRemote || '📱 TV Remote',          entityKey: 'tv_remote_entity', domain: 'remote',       type: 'tv'     },
      { id: 'ac',       label: t.devAc       || '❄️ Air Conditioner',    entityKey: 'ac_entity',        domain: 'climate',      type: 'sensor' },
    ];
  }

  // Keep static getter for backward compat (returns English labels)
  static get DEFAULT_DEVICES() {
    return [
      { id: 'den',      label: '💡 Main Light',        entityKey: 'den_entity',       domain: 'light',        type: 'den'    },
      { id: 'decor',    label: '✨ Decor Light',        entityKey: 'decor_entity',     domain: 'light,switch', type: 'den'    },
      { id: 'hien',     label: '🏮 Porch Light',        entityKey: 'hien_entity',      domain: 'light,switch', type: 'den'    },
      { id: 'rgb',      label: '🌈 RGB Light',          entityKey: 'rgb_entity',       domain: 'light',        type: 'rgb'    },
      { id: 'quat',     label: '🌀 Ceiling Fan',        entityKey: 'quat_entity',      domain: 'fan,switch',   type: 'quat'   },
      { id: 'ocam',     label: '🔌 Power Outlet',       entityKey: 'ocam_entity',      domain: 'switch',       type: 'sensor' },
      { id: 'tv',       label: '📺 Smart TV',           entityKey: 'tv_entity',        domain: 'media_player', type: 'tv'     },
      { id: 'tvRemote', label: '📱 TV Remote',          entityKey: 'tv_remote_entity', domain: 'remote',       type: 'tv'     },
      { id: 'ac',       label: '❄️ Air Conditioner',    entityKey: 'ac_entity',        domain: 'climate',      type: 'sensor' },
    ];
  }

  // Returns the current device list from config (merges defaults + extras, respects hidden + order)
  _getDeviceList(cfg) {
    const hidden   = cfg.devices_hidden || [];
    const labels   = cfg.devices_labels || {};
    const extras   = cfg.devices_extra  || [];
    const defIds   = ['den','decor','hien','rgb','quat','ocam','tv','motion'];
    const defOrder = cfg.devices_order  || defIds;

    // Build lookup maps
    const defaultMap = {};
    this._getDefaultDevices().forEach(d => { defaultMap[d.id] = d; });
    const extraMap = {};
    extras.forEach(d => { extraMap[d.id] = d; });

    // Unified ordered list: defOrder (visible) + extras in their stored order
    // extras already stored in order via devices_extra array
    const orderedDefIds  = defOrder.filter(id => !hidden.includes(id));
    const extraIds       = extras.map(d => d.id);

    // If devices_order contains extra ids (from reorder), use that unified order
    // Otherwise fall back to defaults first, then extras
    const allKnownIds = [...defIds, ...extraIds];
    const hasReorderedExtras = defOrder.some(id => !defIds.includes(id));

    let finalOrder;
    if (hasReorderedExtras) {
      // devices_order holds the full unified order
      finalOrder = defOrder.filter(id => {
        if (defIds.includes(id)) return !hidden.includes(id);
        return extraIds.includes(id);
      });
    } else {
      finalOrder = [...orderedDefIds, ...extraIds];
    }

    return finalOrder.map(id => {
      if (defaultMap[id]) {
        const customLabel = labels[id];
        return { ...defaultMap[id], label: customLabel || '', _defaultLabel: defaultMap[id].label, isDefault: true };
      }
      if (extraMap[id]) return { ...extraMap[id] };
      return null;
    }).filter(Boolean);
  }

  _renderDeviceList(cfg) {
    const t    = this.t;
    const list = this._getDeviceList(cfg);
    if (!list.length) return `<div style="color:var(--secondary-text-color);font-size:12px;padding:8px 0;">${t.edNoDevices}</div>`;
    return list.map(d => this._deviceRow(d, cfg)).join('');
  }

  _deviceRow(d, cfg) {
    const t = this.t;
    const domainMap = { den: 'light,switch', rgb: 'light', quat: 'fan,switch', tv: 'media_player,remote', sensor: 'sensor,binary_sensor,climate,switch' };
    const domain = d.domain || domainMap[d.type] || '';
    const ek = d.entityKey || (d.id + '_entity');
    const mdiVal = d.mdi_icon || '';
    // Only show MDI row for extra devices (not built-in defaults)
    const isDefault = this._getDefaultDevices().some(x => x.id === d.id);
    const namePlaceholder = t.devNamePlaceholder || 'Device name';
    const mdiRow = !isDefault ? `
  <div class="dv-mdi-row">
    <span class="dv-mdi-lbl">🎨 MDI Icon (optional):</span>
    <input class="dv-mdi-inp" type="text" data-dv-mdi="${d.id}"
      value="${mdiVal}"
      placeholder="e.g. mdi:lightbulb  mdi:fan  mdi:power-plug"/>
    ${mdiVal ? `<ha-icon icon="${mdiVal}" style="width:20px;height:20px;flex-shrink:0;--mdi-icon-size:18px;" class="dv-mdi-preview"></ha-icon>` : ''}
  </div>` : '';
    // For new (unsaved) devices, show empty value with translated placeholder so user knows it's editable
    const labelVal = d.label || '';
    const labelPlaceholder = d._defaultLabel || namePlaceholder;
    return `
<div class="dv-row" data-dv-id="${d.id}">
  <div class="dv-top">
    <div class="dv-arrows">
      <button class="dv-arr-btn" data-dv-up="${d.id}">▲</button>
      <button class="dv-arr-btn" data-dv-dn="${d.id}">▼</button>
    </div>
    <input class="dv-name-inp" type="text" data-dv-label="${d.id}" value="${labelVal}" placeholder="${labelPlaceholder}"/>
    <button class="dv-del-btn" data-dv-del="${d.id}" title="${t.delDevTitle}">✕</button>
  </div>
  <ha-entity-picker class="dv-picker" data-key="${ek}" data-domain="${domain}" allow-custom-entity></ha-entity-picker>${d.id === 'ocam' ? `
  <div class="dv-mdi-row" style="margin-top:6px">
    <span class="dv-mdi-lbl">⚡ Power sensor (optional):</span>
    <ha-entity-picker class="dv-picker" data-key="ocam_power_entity" data-domain="sensor" allow-custom-entity></ha-entity-picker>
  </div>` : ''}${!isDefault && d.type === 'ocam' ? `
  <div class="dv-mdi-row" style="margin-top:6px">
    <span class="dv-mdi-lbl">⚡ Power sensor (optional):</span>
    <ha-entity-picker class="dv-picker" data-key="${d.id}_power_entity" data-domain="sensor" allow-custom-entity></ha-entity-picker>
  </div>` : ''}${mdiRow}
</div>`;
  }

  _toggle(key, label, desc) {
    const checked = this._config[key] !== false;
    return `
<div class="disp-row">
  <div class="disp-info">
    <div class="disp-label">${label}</div>
    <div class="disp-desc">${desc}</div>
  </div>
  <label class="tog-wrap">
    <input type="checkbox" class="disp-tog" data-key="${key}" ${checked?'checked':''}>
    <span class="tog-slider"></span>
  </label>
</div>`;
  }

  _render() {
    const cfg  = this._config;
    const t    = this.t;
    const lang = cfg.language || 'vi';
    const bgP  = cfg.background_preset || 'default';

    this.shadowRoot.innerHTML = `
<style>
  :host { display:block; font-family:var(--primary-font-family,'Roboto',sans-serif); }
  .editor { background:var(--card-background-color,#fff); color:var(--primary-text-color); }

  /* ── Credit bar ── */
  .credit {
    display:flex;align-items:center;gap:8px;padding:12px 16px 6px;
    font-size:12px;color:var(--primary-color);font-weight:500;
    border-bottom:1px solid var(--divider-color);
  }
  .credit strong { font-size:13px; }
  .credit-ver { color:var(--secondary-text-color);font-weight:400;font-size:11px; }

  /* ── TikTok link ── */
  .tiktok-link {
    display:flex;align-items:center;gap:8px;
    margin:6px 12px 10px;padding:8px 14px;
    border-radius:10px;text-decoration:none;cursor:pointer;
    background:linear-gradient(135deg,rgba(0,0,0,0.85) 0%,rgba(30,20,40,0.92) 100%);
    border:1px solid rgba(255,255,255,0.08);
    box-shadow:0 2px 8px rgba(0,0,0,0.3);
    transition:transform .15s,box-shadow .15s;
  }
  .tiktok-link:hover { transform:translateY(-1px);box-shadow:0 4px 16px rgba(0,0,0,0.4); }

  /* ── Accordion ── */
  .acc-wrap { border-bottom:1px solid var(--divider-color); }
  .acc-head {
    display:flex;align-items:center;gap:10px;padding:14px 16px;cursor:pointer;
    user-select:none;font-size:14px;font-weight:500;color:var(--primary-text-color);
    background:var(--secondary-background-color);
  }
  .acc-head:hover { filter:brightness(.96); }
  .acc-head ha-icon { color:var(--secondary-text-color);--mdi-icon-size:18px; }
  .acc-arrow { margin-left:auto;font-size:14px;color:var(--secondary-text-color); }
  .acc-body {
    padding:12px 14px;border-top:1px solid var(--divider-color);
    background:var(--card-background-color,#fff);
  }

  /* ── Fields ── */
  .row { display:flex;flex-direction:column;margin-bottom:12px; }
  .row:last-child { margin-bottom:0; }
  .row label { font-size:12px;color:var(--secondary-text-color);margin-bottom:4px;font-weight:600; }
  ha-entity-picker { display:block;width:100%; }
  .sec-title {
    font-size:10px;font-weight:700;color:var(--secondary-text-color);
    letter-spacing:.5px;text-transform:uppercase;
    margin:14px 0 8px;padding:4px 0;border-bottom:1px solid var(--divider-color);
  }
  .sec-title:first-child { margin-top:0; }

  /* ── Language grid ── */
  .lang-grid { display:flex;flex-wrap:wrap;gap:6px; }
  .lang-btn {
    display:flex;align-items:center;gap:5px;padding:7px 10px;border-radius:8px;
    border:1.5px solid var(--divider-color);background:var(--secondary-background-color);
    cursor:pointer;font-size:12px;color:var(--primary-text-color);transition:all .2s;
  }
  .lang-btn.on {
    border-color:var(--primary-color);background:rgba(3,169,244,.12);
    color:var(--primary-color);font-weight:700;
  }

  /* ── BG presets ── */
  .bg-grid { display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:10px; }
  .bgs {
    border-radius:7px;height:38px;cursor:pointer;border:2px solid transparent;
    display:flex;align-items:flex-end;padding:3px 5px;font-size:9px;
    color:rgba(255,255,255,.85);text-shadow:0 1px 3px rgba(0,0,0,.9);
    transition:border-color .15s;white-space:nowrap;overflow:hidden;
  }
  .bgs.on { border-color:var(--primary-color); }

  /* ── Color picker ── */
  .ci { border:1px solid var(--divider-color);border-radius:8px;overflow:hidden;margin-bottom:8px; }
  .ci:last-child { margin-bottom:0; }
  .ci-hdr { display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer;background:var(--card-background-color,#fff); }
  .ci-swatch { width:24px;height:24px;border-radius:4px;border:1px solid rgba(0,0,0,.1);flex-shrink:0; }
  .ci-label { font-size:13px;flex:1;color:var(--primary-text-color); }
  .ci-code { font-size:11px;color:var(--secondary-text-color);font-family:monospace;background:var(--secondary-background-color);padding:2px 6px;border-radius:3px; }
  .ci-chv { color:var(--secondary-text-color);flex-shrink:0; }
  .ci-body { padding:12px 14px;background:var(--secondary-background-color);border-top:1px solid var(--divider-color);display:flex;flex-direction:column;gap:10px; }
  .ci-native { width:100%;height:44px;border:1px solid var(--divider-color);border-radius:6px;cursor:pointer;padding:2px;background:transparent; }
  .ci-hex-wrap { display:flex;align-items:center;gap:6px;border:1px solid var(--divider-color);border-radius:4px;padding:6px 10px;background:var(--card-background-color,#fff); }
  .ci-hash { color:var(--secondary-text-color);font-size:12px;font-family:monospace; }
  .ci-hex-inp { border:none;outline:none;width:100%;font-size:14px;color:var(--primary-text-color);font-family:monospace;background:transparent; }
  .ci-swatches { display:flex;gap:6px;flex-wrap:wrap; }
  .ci-dot { width:24px;height:24px;border-radius:50%;cursor:pointer;transition:transform .1s;outline-offset:2px; }
  .ci-dot:hover { transform:scale(1.15); }

  /* ── Toggle ── */
  .disp-row { display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--divider-color); }
  .disp-row:last-child { border-bottom:none; }
  .disp-info { flex:1;min-width:0; }
  .disp-label { font-size:13px;font-weight:500;color:var(--primary-text-color); }
  .disp-desc { font-size:11px;color:var(--secondary-text-color);margin-top:2px; }
  .tog-wrap { position:relative;width:40px;height:22px;flex-shrink:0;cursor:pointer; }
  .tog-wrap input { opacity:0;width:0;height:0;position:absolute; }
  .tog-slider {
    position:absolute;inset:0;border-radius:11px;
    background:var(--divider-color);transition:background .25s;
  }
  .tog-slider:before {
    content:'';position:absolute;width:16px;height:16px;border-radius:50%;
    left:3px;top:3px;background:#fff;transition:transform .25s;
    box-shadow:0 1px 3px rgba(0,0,0,.3);
  }
  .tog-wrap input:checked + .tog-slider { background:var(--primary-color); }
  .tog-wrap input:checked + .tog-slider:before { transform:translateX(18px); }

  /* ── Opacity slider ── */
  .slider-row { display:flex;align-items:center;gap:10px;margin-top:8px; }
  .slider-row input[type=range] { flex:1;height:4px;cursor:pointer;accent-color:var(--primary-color); }
  .slider-val { font-weight:700;font-size:13px;color:var(--primary-color);min-width:40px;text-align:right; }

  /* ── Reset btn ── */
  .reset-btn {
    width:100%;padding:8px;border-radius:7px;border:1px solid var(--divider-color);
    background:transparent;color:var(--secondary-text-color);font-size:12px;
    cursor:pointer;font-family:inherit;margin-top:10px;
  }
  .reset-btn:hover { background:var(--secondary-background-color); }

  /* ── Device row (editor) ── */
  .dv-row {
    border:1px solid var(--divider-color);border-radius:8px;
    padding:10px 12px;margin-bottom:8px;
    background:var(--secondary-background-color);
  }
  .dv-row:last-child { margin-bottom:0; }
  .dv-top {
    display:flex;align-items:center;gap:8px;margin-bottom:8px;
  }
  .dv-arrows { display:flex;flex-direction:column;gap:2px;flex-shrink:0; }
  .dv-arr-btn {
    width:22px;height:18px;border:1px solid var(--divider-color);border-radius:3px;
    background:transparent;color:var(--secondary-text-color);font-size:9px;
    cursor:pointer;display:flex;align-items:center;justify-content:center;
    padding:0;transition:background .12s;line-height:1;
  }
  .dv-arr-btn:hover { background:var(--secondary-background-color);color:var(--primary-color); }
  .dv-name-inp {
    flex:1;border:1px solid var(--divider-color);border-radius:5px;
    padding:5px 8px;font-size:12px;color:var(--primary-text-color);
    background:var(--card-background-color,#fff);font-family:inherit;
    outline:none;box-sizing:border-box;
  }
  .dv-name-inp::placeholder { color:var(--secondary-text-color);font-style:italic;opacity:0.8; }
  .dv-name-inp:focus { border-color:var(--primary-color); }
  .dv-del-btn {
    width:28px;height:28px;border:1px solid var(--divider-color);border-radius:5px;
    background:transparent;color:var(--error-color,#f44336);font-size:14px;
    cursor:pointer;display:flex;align-items:center;justify-content:center;
    flex-shrink:0;transition:background .15s;padding:0;
  }
  .dv-del-btn:hover { background:rgba(244,67,54,0.1); }
  .dv-picker { display:block;width:100%; }
  .dv-mdi-row {
    display:flex;align-items:center;gap:6px;margin-top:6px;
    padding:5px 8px;border-radius:6px;
    background:var(--secondary-background-color);
    border:1px solid var(--divider-color);
  }
  .dv-mdi-lbl { font-size:11px;color:var(--secondary-text-color);white-space:nowrap;flex-shrink:0; }
  .dv-mdi-inp {
    flex:1;border:1px solid var(--divider-color);border-radius:4px;
    padding:4px 7px;font-size:11px;color:var(--primary-text-color);
    background:var(--card-background-color,#fff);font-family:monospace;
    outline:none;min-width:0;
  }
  .dv-mdi-inp:focus { border-color:var(--primary-color); }
  .dv-mdi-preview { color:var(--primary-color);flex-shrink:0; }

  /* ── Add device row ── */
  .add-dev-row {
    display:flex;gap:8px;align-items:center;margin-top:12px;
    padding-top:10px;border-top:1px solid var(--divider-color);
  }
  .add-dev-select {
    flex:1;padding:7px 8px;border:1px solid var(--divider-color);border-radius:6px;
    background:var(--card-background-color,#fff);color:var(--primary-text-color);
    font-size:12px;font-family:inherit;outline:none;cursor:pointer;
  }
  .add-dev-btn {
    padding:7px 14px;border-radius:6px;border:none;
    background:var(--primary-color);color:#fff;font-size:12px;font-weight:600;
    cursor:pointer;white-space:nowrap;font-family:inherit;transition:opacity .15s;
  }
  .add-dev-btn:hover { opacity:.85; }
</style>

<div class="editor">

  <!-- ── Credit ── -->
  <div class="credit">
    🏠 <strong>HA Smart Room Card</strong>
    <span class="credit-ver">v1.2 · Designed by @doanlong1412 from 🇻🇳 Vietnam</span>
  </div>

  <!-- ── TikTok link ── -->
  <a class="tiktok-link" href="https://www.tiktok.com/@long.1412" target="_blank" rel="noopener noreferrer">
    <svg width="22" height="22" viewBox="0 0 32 32" fill="none" style="flex-shrink:0;">
      <path d="M27.2 7.2a7.6 7.6 0 0 1-7.6-7.6h-5v21.5a3.6 3.6 0 1 1-3.6-3.6c.33 0 .65.05.96.13V12.5a8.6 8.6 0 1 0 8.24 8.6V11.5a12.6 12.6 0 0 0 7.6 2.5V8.6a7.66 7.66 0 0 1-.54-.01z" fill="white"/>
      <path d="M13 21.1a3.6 3.6 0 1 0 3.6 3.6V3.6h-3v20.95a3.61 3.61 0 0 0-.6-.45z" fill="#EE1D52" fill-opacity="0.6"/>
    </svg>
    <div style="flex:1;min-width:0;">
      <div style="font-size:12px;font-weight:700;color:#fff;letter-spacing:.2px;">TikTok Channel</div>
      <div style="font-size:10.5px;color:rgba(255,255,255,0.6);">Xem thêm &amp; Follow @long.1412</div>
    </div>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="flex-shrink:0;opacity:0.45;">
      <path d="M9 18l6-6-6-6" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </a>

  <!-- ── 0. Language ── -->
  <div class="acc-wrap">
    <div class="acc-head" id="head-lang">
      <ha-icon icon="mdi:translate"></ha-icon> ${t.edLang}
      <span class="acc-arrow" id="arrow-lang">${this._open.lang?'▾':'▸'}</span>
    </div>
    <div class="acc-body" id="body-lang" style="display:${this._open.lang?'block':'none'}">
      <div class="lang-grid">
        ${Object.entries(HSRC_TRANSLATIONS).map(([code,tr])=>`
          <div class="lang-btn ${lang===code?'on':''}" data-lang="${code}">
            <img src="https://flagcdn.com/20x15/${tr.flag}.png" width="20" height="15" alt="${tr.lang}" style="border-radius:2px;flex-shrink:0;">
            ${tr.lang}
          </div>`).join('')}
      </div>
    </div>
  </div>

  <!-- ── 0b. Room Title ── -->
  <div class="acc-wrap">
    <div class="acc-head" id="head-roomtitle">
      <ha-icon icon="mdi:home-edit"></ha-icon> ${t.edRoomTitle || '🏷 Tên phòng'}
      <span class="acc-arrow" id="arrow-roomtitle">${this._open.roomtitle?'▾':'▸'}</span>
    </div>
    <div class="acc-body" id="body-roomtitle" style="display:${this._open.roomtitle?'block':'none'}">
      <div class="row">
        <label>${t.edRoomTitle || '🏷 Tên hiển thị'}</label>
        <input type="text" id="inp-room-title"
          value="${cfg.room_title || ''}"
          placeholder="${t.edRoomTitlePlaceholder || 'vd. Phòng Làm Việc...'}"
          style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--divider-color);border-radius:7px;font-size:13px;font-weight:600;color:var(--primary-text-color);background:var(--secondary-background-color);font-family:inherit;outline:none;"
        />
      </div>
    </div>
  </div>

  <!-- ── 1. Sensors ── -->
  <div class="acc-wrap">
    <div class="acc-head" id="head-sensors">
      <ha-icon icon="mdi:broadcast"></ha-icon> ${t.edSensorsSection}
      <span class="acc-arrow" id="arrow-sensors">${this._open.sensors?'▾':'▸'}</span>
    </div>
    <div class="acc-body" id="body-sensors" style="display:${this._open.sensors?'block':'none'}">
      <div class="sec-title">📍 ${t.edSensorsTitle}</div>
      ${this._entityField('temp_entity',   t.edTemp,   'sensor')}
      ${this._entityField('humi_entity',   t.edHumi,   'sensor')}
      ${this._entityField('power_entity',  t.edPower,  'sensor')}
      ${this._entityField('door_entity',   t.edDoor,   'binary_sensor')}
      ${this._entityField('motion_entity', t.edMotion, 'binary_sensor')}
      <div class="sec-title">❄️ ${t.edAcTitle}</div>
      ${this._entityField('ac_entity', t.edAcEntity, 'climate')}
      <div class="sec-title">🌤 ${t.edOutdoorTitle}</div>
      ${this._entityField('temp_out_entity', t.edTempOut, 'sensor')}
      ${this._entityField('humi_out_entity', t.edHumiOut, 'sensor')}
    </div>
  </div>

  <!-- ── 2. Devices ── -->
  <div class="acc-wrap">
    <div class="acc-head" id="head-devices">
      <ha-icon icon="mdi:devices"></ha-icon> ${t.edEntities} — ${t.edDevicesTitle}
      <span class="acc-arrow" id="arrow-devices">${this._open.devices?'▾':'▸'}</span>
    </div>
    <div class="acc-body" id="body-devices" style="display:${this._open.devices?'block':'none'}">
      <div id="dev-list">
        ${this._renderDeviceList(cfg)}
      </div>
      <!-- Add device row -->
      <div class="add-dev-row">
        <select id="add-dev-type" class="add-dev-select">
          <option value="">${t.edAddDevPlaceholder}</option>
          <option value="den">${t.edAddDevLight}</option>
          <option value="rgb">${t.edAddDevRgb}</option>
          <option value="quat">${t.edAddDevFan}</option>
          <option value="ocam">${t.edAddDevOutlet}</option>
          <option value="tv">${t.edAddDevTv}</option>
          <option value="sensor">${t.edAddDevSensor}</option>
        </select>
        <button class="add-dev-btn" id="btn-add-dev">${t.edAddBtn}</button>
      </div>
    </div>
  </div>

  <!-- ── 2b. Automation ── -->
  <div class="acc-wrap">
    <div class="acc-head" id="head-automation">
      <ha-icon icon="mdi:robot"></ha-icon> ${t.edAutoTitle}
      <span class="acc-arrow" id="arrow-automation">${this._open.automation?'▾':'▸'}</span>
    </div>
    <div class="acc-body" id="body-automation" style="display:${this._open.automation?'block':'none'}">
      <div class="sec-title" style="margin-bottom:6px">${t.edSyncTitle}</div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:4px;">
        <label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:9px;border:1.5px solid ${cfg.sync_mode === 'local' ? 'var(--primary-color)' : 'var(--divider-color)'};cursor:pointer;background:var(--secondary-background-color)">
          <input type="radio" name="sync-mode-radio" value="local" ${cfg.sync_mode === 'local' ? 'checked' : ''} style="margin-top:2px;accent-color:var(--primary-color)">
          <div>
            <div style="font-size:13px;font-weight:600">${t.edSyncLocal} <span style="font-size:10px;background:rgba(100,160,255,0.15);color:rgba(80,140,255,0.9);padding:1px 6px;border-radius:10px;font-weight:700;margin-left:4px">${t.edSyncLocalSimple}</span></div>
            <div style="font-size:11px;color:var(--secondary-text-color);margin-top:2px">${t.edSyncLocalDesc}</div>
          </div>
        </label>
        <label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:9px;border:1.5px solid ${cfg.sync_mode === 'helpers' ? 'var(--primary-color)' : 'var(--divider-color)'};cursor:pointer;background:var(--secondary-background-color)">
          <input type="radio" name="sync-mode-radio" value="helpers" ${cfg.sync_mode === 'helpers' ? 'checked' : ''} style="margin-top:2px;accent-color:var(--primary-color)">
          <div><div style="font-size:13px;font-weight:600">${t.edSyncHelpers}</div><div style="font-size:11px;color:var(--secondary-text-color);margin-top:2px">${t.edSyncHelpersDesc}</div></div>
        </label>
        <label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:9px;border:1.5px solid ${cfg.sync_mode === 'integration' || !cfg.sync_mode ? 'var(--primary-color)' : 'var(--divider-color)'};cursor:pointer;background:${cfg.sync_mode === 'integration' || !cfg.sync_mode ? 'rgba(0,200,100,0.06)' : 'var(--secondary-background-color)'}">
          <input type="radio" name="sync-mode-radio" value="integration" ${cfg.sync_mode === 'integration' || !cfg.sync_mode ? 'checked' : ''} style="margin-top:2px;accent-color:var(--primary-color)">
          <div>
            <div style="font-size:13px;font-weight:600">${t.edSyncIntegration} <span style="font-size:10px;background:rgba(0,200,100,0.15);color:rgba(0,200,100,0.9);padding:1px 6px;border-radius:10px;font-weight:700;margin-left:4px">${t.edSyncIntRecommended}</span></div>
            <div style="font-size:11px;color:var(--secondary-text-color);margin-top:2px">${t.edSyncIntDesc}</div>
          </div>
        </label>
      </div>
      ${cfg.sync_mode === 'integration' ? `
      <div style="margin-top:8px;padding:10px 12px;background:rgba(0,200,100,0.07);border:1px solid rgba(0,200,100,0.2);border-radius:8px;font-size:11px;color:var(--secondary-text-color);line-height:1.8;">
        ${t.edSyncIntSetup}<br>
        1. ${t.edSyncIntStep1}<br>
        &nbsp;&nbsp;&nbsp;${t.edSyncIntStep1b}<br>
        2. ${t.edSyncIntStep2}<br>
        3. ${t.edSyncIntStep3}<br>
        4. ${t.edSyncIntStep4}
      </div>
      ` : ''}
      ${cfg.sync_mode === 'helpers' ? `
      <div style="margin-top:8px;padding:10px 12px;background:rgba(3,169,244,0.08);border:1px solid rgba(3,169,244,0.2);border-radius:8px;font-size:11px;color:var(--secondary-text-color);line-height:1.7;">
        ${t.edSyncHelpersWarn}
      </div>
      <div style="margin-top:10px;">
        ${this._entityField('helper_bool', t.edHelperBool, 'input_boolean')}
        ${this._entityField('helper_num',  t.edHelperNum,  'input_number')}
      </div>` : ''}
      <div class="sec-title">${t.edDelayTitle}</div>
      <div class="row">
        <label>${t.edDelayLabel}</label>
        <div style="display:flex;align-items:center;gap:10px;margin-top:4px;">
          <input type="number" id="inp-auto-delay" min="1" max="120" step="1"
            value="${cfg.auto_delay_min || 5}"
            style="width:80px;padding:7px 10px;border:1px solid var(--divider-color);border-radius:7px;font-size:14px;font-weight:700;color:var(--primary-text-color);background:var(--secondary-background-color);font-family:inherit;">
          <span style="font-size:13px;color:var(--secondary-text-color);">${t.edDelayUnit}</span>
        </div>
      </div>
      <div class="sec-title">${t.edAutoDevTitle}</div>
      <div style="font-size:11px;color:var(--secondary-text-color);margin-bottom:10px;">${t.edAutoDevDesc}</div>
      ${(() => {
        // Loại trừ các thiết bị không hỗ trợ turn_off qua auto
        const excludeTypes = ['tv', 'sensor'];
        // Lấy từ danh sách thiết bị đang cấu hình (giống card)
        const devList = this._getDeviceList(cfg)
          .filter(d => !excludeTypes.includes(d.type));
        // Thêm điều hòa nếu đã cấu hình ac_entity
        if (cfg.ac_entity && !devList.find(d => d.id === 'ac')) {
          devList.push({ id: 'ac', label: '❄️ Điều Hòa', type: 'climate' });
        }
        // Mặc định: tất cả thiết bị trong devList đều được tắt
        const defaultAutoIds = devList.map(d => d.id);
        const autoList = cfg.auto_off_entities || defaultAutoIds;
        return devList.map(item => {
          const checked = autoList.includes(item.id) ? 'checked' : '';
          return `<div class="disp-row">
            <div class="disp-info">
              <div class="disp-label">${item.label}</div>
            </div>
            <label class="tog-wrap">
              <input type="checkbox" class="auto-off-chk" data-id="${item.id}" ${checked}>
              <span class="tog-slider"></span>
            </label>
          </div>`;
        }).join('');
      })()}
    </div>
  </div>

  <!-- ── 3. Background ── -->
  <div class="acc-wrap">
    <div class="acc-head" id="head-bg">
      <ha-icon icon="mdi:palette"></ha-icon> ${t.edBg}
      <span class="acc-arrow" id="arrow-bg">${this._open.bg?'▾':'▸'}</span>
    </div>
    <div class="acc-body" id="body-bg" style="display:${this._open.bg?'block':'none'}">
      <div style="font-size:11px;font-weight:700;color:var(--secondary-text-color);margin-bottom:8px;letter-spacing:.4px;">${t.bgPresets}</div>
      <div class="bg-grid">
        ${HSRC_BG_PRESETS.map(p => {
          const c1 = p.c1||'#888', c2 = p.c2||'#444';
          const isC = p.id === 'custom';
          return `<div class="bgs ${bgP===p.id?'on':''}" data-bg="${p.id}"
            style="${isC?'background:linear-gradient(135deg,#e0e0e0,#bdbdbd);color:#555;text-shadow:none;':'background:linear-gradient(135deg,'+c1+'cc 0%,'+c2+'55 100%);'}">${p.label}</div>`;
        }).join('')}
      </div>
      ${bgP === 'custom' ? `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px;">
        ${this._colorRow('bg_color1', t.color1)}
        ${this._colorRow('bg_color2', t.color2)}
      </div>` : ''}
      <div style="margin-top:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span style="font-size:12px;font-weight:600;color:var(--secondary-text-color);">${t.edBgAlpha}</span>
          <span id="bg-alpha-lbl" style="font-size:13px;font-weight:700;color:var(--primary-color);">${cfg.bg_alpha !== undefined ? cfg.bg_alpha : 100}%</span>
        </div>
        <div class="slider-row">
          <input type="range" id="inp-bg-alpha" min="0" max="100" step="1" value="${cfg.bg_alpha !== undefined ? cfg.bg_alpha : 100}">
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--secondary-text-color);margin-top:3px;">
          <span>0% (${t.edBgTransparent})</span><span>100% (${t.edBgSolid})</span>
        </div>
      </div>
      <div style="margin-top:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span style="font-size:12px;font-weight:600;color:var(--secondary-text-color);">${t.edBgBlur || '💎 Glass Blur'}</span>
          <span id="bg-blur-lbl" style="font-size:13px;font-weight:700;color:var(--primary-color);">${cfg.bg_blur !== undefined ? cfg.bg_blur : 0}px</span>
        </div>
        <div class="slider-row">
          <input type="range" id="inp-bg-blur" min="0" max="20" step="1" value="${cfg.bg_blur !== undefined ? cfg.bg_blur : 0}">
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--secondary-text-color);margin-top:3px;">
          <span>0px (${t.edBgBlurNone || 'None'})</span><span>20px (${t.edBgBlurMax || 'Max'})</span>
        </div>
      </div>
    </div>
  </div>

  <!-- ── 4. Display options ── -->
  <div class="acc-wrap">
    <div class="acc-head" id="head-display">
      <ha-icon icon="mdi:eye"></ha-icon> ${t.edDisplay}
      <span class="acc-arrow" id="arrow-display">${this._open.display?'▾':'▸'}</span>
    </div>
    <div class="acc-body" id="body-display" style="display:${this._open.display?'block':'none'}">
      ${this._toggle('show_score',     t.edShowScore,     t.edShowScoreDesc)}
      ${this._toggle('show_env_hint',  t.edShowEnvHint,   t.edShowEnvHintDesc)}
      ${this._toggle('show_auto_mode', t.edShowAutoMode,  t.edShowAutoModeDesc)}
      ${this._toggle('show_graph',     t.edShowGraph,     t.edShowGraphDesc)}
      ${this._toggle('show_timeline',  t.edShowTimeline,  t.edShowTimelineDesc)}
    </div>
  </div>

  <!-- ── 5. Advanced colors ── -->
  <div class="acc-wrap">
    <div class="acc-head" id="head-colors">
      <ha-icon icon="mdi:palette-swatch"></ha-icon> ${t.colorLabel}
      <span class="acc-arrow" id="arrow-colors">${this._open.colors?'▾':'▸'}</span>
    </div>
    <div class="acc-body" id="body-colors" style="display:${this._open.colors?'block':'none'}">
      <div class="sec-title">${t.colorSensorHdr}</div>
      ${this._colorRow('color_temp',  t.colorTemp)}
      ${this._colorRow('color_humi',  t.colorHumi)}
      ${this._colorRow('color_score', t.colorScore)}
      <div class="sec-title">${t.colorDevHdr}</div>
      ${this._colorRow('color_den',   t.colorDen)}
      ${this._colorRow('color_rgb',   t.colorRgb)}
      ${this._colorRow('color_quat',  t.colorQuat)}
      <button class="reset-btn" id="btn-reset-colors">${t.edColorsReset}</button>
    </div>
  </div>

</div>`;

    this._bindEditorEvents();
    this._syncPickers();
  }

  _bindEditorEvents() {
    const sr = this.shadowRoot;

    // Accordion toggles
    ['lang','roomtitle','sensors','devices','automation','bg','display','colors'].forEach(id => {
      const hdr = sr.getElementById('head-' + id);
      if (hdr) hdr.addEventListener('click', () => this._toggleSection(id));
    });

    // Language buttons
    sr.querySelectorAll('[data-lang]').forEach(btn =>
      btn.addEventListener('click', () => {
        this._config = { ...this._config, language: btn.dataset.lang };
        this._fire(); this._render();
      }));

    // Room title input — dùng 'change' thay vì 'input' để tránh re-render khi đang gõ
    // HA gọi setConfig → _render() sau mỗi _fire() làm mất focus input
    const inpRoomTitle = sr.getElementById('inp-room-title');
    if (inpRoomTitle) {
      const _commitRoomTitle = () => {
        const val = inpRoomTitle.value.trim();
        const c = { ...this._config };
        if (val) c.room_title = val; else delete c.room_title;
        this._config = c;
        this._fire();
      };
      inpRoomTitle.addEventListener('change', _commitRoomTitle);
      inpRoomTitle.addEventListener('blur',   _commitRoomTitle);
    }

    // BG preset tiles
    sr.querySelectorAll('[data-bg]').forEach(tile =>
      tile.addEventListener('click', () => {
        this._config = { ...this._config, background_preset: tile.dataset.bg };
        this._fire(); this._render();
      }));

    // Opacity slider
    const alphaSlider = sr.getElementById('inp-bg-alpha');
    if (alphaSlider) {
      alphaSlider.addEventListener('input', () => {
        const lbl = sr.getElementById('bg-alpha-lbl');
        if (lbl) lbl.textContent = alphaSlider.value + '%';
        this._config = { ...this._config, bg_alpha: parseInt(alphaSlider.value) };
        this._fire();
      });
    }

    // Blur slider
    const blurSlider = sr.getElementById('inp-bg-blur');
    if (blurSlider) {
      blurSlider.addEventListener('input', () => {
        const lbl = sr.getElementById('bg-blur-lbl');
        if (lbl) lbl.textContent = blurSlider.value + 'px';
        const blurVal = parseInt(blurSlider.value);
        this._config = { ...this._config, bg_blur: blurVal };
        // Instant live preview: find the card's root element and update directly
        const cardEl = document.querySelector('ha-smart-room-card') ||
                       (this.getRootNode && this.getRootNode().host);
        if (cardEl && cardEl.shadowRoot) {
          const root = cardEl.shadowRoot.getElementById('root');
          if (root) root.style.setProperty('--root-blur', blurVal + 'px');
        }
        this._fire();
      });
    }

    // Color picker header toggle
    sr.querySelectorAll('[data-cp]').forEach(hdr =>
      hdr.addEventListener('click', () => {
        const k = hdr.dataset.cp;
        this._picker = this._picker === k ? null : k;
        this._render();
      }));

    // Native color input
    sr.querySelectorAll('[data-cp-native]').forEach(inp => {
      inp.addEventListener('input', () => {
        const ci   = inp.closest('.ci');
        const sw   = ci ? ci.querySelector('.ci-swatch') : null;
        const code = ci ? ci.querySelector('.ci-code') : null;
        const hex  = sr.querySelector(`[data-cp-hex="${inp.dataset.cpNative}"]`);
        if (sw)   sw.style.background = inp.value;
        if (code) code.textContent    = inp.value;
        if (hex)  hex.value           = inp.value.replace('#','');
        this._config[inp.dataset.cpNative] = inp.value;
        this._fire();
      });
      inp.addEventListener('change', () => {
        this._config[inp.dataset.cpNative] = inp.value;
        this._fire(); this._render();
      });
    });

    // Hex text input
    sr.querySelectorAll('[data-cp-hex]').forEach(inp =>
      inp.addEventListener('change', () => {
        const val = '#' + inp.value.replace('#','');
        if (/^#[0-9a-fA-F]{6}$/.test(val)) {
          this._config[inp.dataset.cpHex] = val;
          this._fire(); this._render();
        }
      }));

    // Swatch dots
    sr.querySelectorAll('[data-cp-dot]').forEach(dot =>
      dot.addEventListener('click', () => {
        this._config[dot.dataset.cpDot] = dot.dataset.color;
        this._fire(); this._render();
      }));

    // Display option toggles
    sr.querySelectorAll('.disp-tog').forEach(tog =>
      tog.addEventListener('change', () => {
        this._config = { ...this._config, [tog.dataset.key]: tog.checked };
        this._fire();
      }));

    // Entity pickers
    sr.querySelectorAll('ha-entity-picker[data-key]').forEach(picker =>
      picker.addEventListener('value-changed', e => {
        const k = picker.dataset.key;
        const v = e.detail.value;
        const c = { ...this._config };
        if (v) c[k] = v; else delete c[k];
        this._config = c;
        this._fire();
      }));

    // Reset colors
    const btnReset = sr.getElementById('btn-reset-colors');
    if (btnReset) btnReset.addEventListener('click', () => {
      ['color_temp','color_humi','color_score','color_den','color_rgb','color_quat',
       'bg_color1','bg_color2'].forEach(k => delete this._config[k]);
      this._fire(); this._render();
    });

    // ── Automation: sync mode radio ──────────────────────────────────────────
    sr.querySelectorAll('[name="sync-mode-radio"]').forEach(radio => {
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        this._config = { ...this._config, sync_mode: radio.value };
        this._fire();
        this._render();
      });
    });

    // ── Automation: delay input ──────────────────────────────────────────────
    const autoDelayInp = sr.getElementById('inp-auto-delay');
    if (autoDelayInp) {
      autoDelayInp.addEventListener('change', () => {
        const val = parseInt(autoDelayInp.value, 10);
        if (!isNaN(val) && val >= 1) {
          this._config = { ...this._config, auto_delay_min: val };
          this._fire();
        }
      });
    }

    // ── Automation: entity checkboxes ─────────────────────────────────────────
    sr.querySelectorAll('.auto-off-chk').forEach(chk => {
      chk.addEventListener('change', () => {
        const allIds = ['den','decor','rgb','hien','quat','ocam','ac'];
        const current = this._config.auto_off_entities || [...allIds];
        const id = chk.dataset.id;
        let updated;
        if (chk.checked) {
          updated = current.includes(id) ? current : [...current, id];
        } else {
          updated = current.filter(x => x !== id);
        }
        this._config = { ...this._config, auto_off_entities: updated };
        this._fire();
      });
    });

    // ── Device list: delete button ──────────────────────────────────────────
    sr.querySelectorAll('[data-dv-del]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.dvDel;
        const defaults = HASmartRoomCardEditor.DEFAULT_DEVICES;
        const isDefault = defaults.some(d => d.id === id);
        if (isDefault) {
          // Hide it — add to hidden list
          const hidden = [...(this._config.devices_hidden || [])];
          if (!hidden.includes(id)) hidden.push(id);
          this._config = { ...this._config, devices_hidden: hidden };
        } else {
          // Remove from extras
          const extras = (this._config.devices_extra || []).filter(d => d.id !== id);
          this._config = { ...this._config, devices_extra: extras };
        }
        this._fire();
        // Re-render just the device list (no full re-render to keep pickers alive)
        const listEl = sr.getElementById('dev-list');
        if (listEl) {
          listEl.innerHTML = this._renderDeviceList(this._config);
          this._syncPickers();
          this._bindDeviceListEvents();
        }
      });
    });

    // ── Device list: label rename ───────────────────────────────────────────
    sr.querySelectorAll('[data-dv-label]').forEach(inp => {
      inp.addEventListener('change', () => {
        const id  = inp.dataset.dvLabel;
        const val = inp.value.trim();
        const labels = { ...(this._config.devices_labels || {}) };
        // Check if it's an extra device
        const extras  = (this._config.devices_extra || []).map(d =>
          d.id === id ? { ...d, label: val, _isNew: false, _defaultLabel: undefined } : d
        );
        const isExtra = (this._config.devices_extra || []).some(d => d.id === id);
        if (isExtra) {
          this._config = { ...this._config, devices_extra: extras };
        } else {
          if (val) labels[id] = val; else delete labels[id];
          this._config = { ...this._config, devices_labels: labels };
        }
        this._fire();
      });
    });

    // ── Device list: reorder ↑↓ ────────────────────────────────────────────
    const reorderList = (sr, id, dir) => {
      const defIds   = ['den','decor','hien','rgb','quat','ocam','tv','motion'];
      const cfg      = this._config;
      const hidden   = cfg.devices_hidden || [];
      const extras   = cfg.devices_extra  || [];
      const defOrder = cfg.devices_order  || defIds;
      const extraIds = extras.map(d => d.id);
      const hasReorderedExtras = defOrder.some(x => !defIds.includes(x));
      let fullList;
      if (hasReorderedExtras) {
        fullList = defOrder.filter(x => {
          if (defIds.includes(x)) return !hidden.includes(x);
          return extraIds.includes(x);
        });
      } else {
        fullList = [...defOrder.filter(x => !hidden.includes(x)), ...extraIds];
      }
      const idx = fullList.indexOf(id);
      if (idx < 0) return;
      const newIdx = dir === 'up' ? idx - 1 : idx + 1;
      if (newIdx < 0 || newIdx >= fullList.length) return;
      [fullList[idx], fullList[newIdx]] = [fullList[newIdx], fullList[idx]];
      const reorderedExtras = fullList
        .filter(x => !defIds.includes(x))
        .map(eid => extras.find(d => d.id === eid))
        .filter(Boolean);
      this._config = { ...cfg, devices_order: fullList, devices_extra: reorderedExtras };
      this._fire();
      const listEl = sr.getElementById('dev-list');
      if (listEl) { listEl.innerHTML = this._renderDeviceList(this._config); this._syncPickers(); this._bindDeviceListEvents(); }
    };

    sr.querySelectorAll('[data-dv-up]').forEach(btn => {
      btn.addEventListener('click', () => reorderList(sr, btn.dataset.dvUp, 'up'));
    });
    sr.querySelectorAll('[data-dv-dn]').forEach(btn => {
      btn.addEventListener('click', () => reorderList(sr, btn.dataset.dvDn, 'down'));
    });

    // Add button binding handled in _bindDeviceListEvents (called on initial render + re-render)
    this._bindDeviceListEvents();
  }

  // ── Device list event binding (called after partial re-render) ──────────
  _bindDeviceListEvents() {
    const sr = this.shadowRoot;

    // Delete
    sr.querySelectorAll('[data-dv-del]').forEach(btn => {
      const fresh = btn.cloneNode(true);
      btn.replaceWith(fresh);
      fresh.addEventListener('click', () => {
        const id = fresh.dataset.dvDel;
        const isDefault = HASmartRoomCardEditor.DEFAULT_DEVICES.some(d => d.id === id);
        if (isDefault) {
          const hidden = [...(this._config.devices_hidden || [])];
          if (!hidden.includes(id)) hidden.push(id);
          this._config = { ...this._config, devices_hidden: hidden };
        } else {
          const extras = (this._config.devices_extra || []).filter(d => d.id !== id);
          this._config = { ...this._config, devices_extra: extras };
        }
        this._fire();
        const listEl = sr.getElementById('dev-list');
        if (listEl) { listEl.innerHTML = this._renderDeviceList(this._config); this._syncPickers(); this._bindDeviceListEvents(); }
      });
    });

    // Label rename
    sr.querySelectorAll('[data-dv-label]').forEach(inp => {
      const fresh = inp.cloneNode(true);
      inp.replaceWith(fresh);
      fresh.addEventListener('change', () => {
        const id  = fresh.dataset.dvLabel;
        const val = fresh.value.trim();
        const isExtra = (this._config.devices_extra || []).some(d => d.id === id);
        if (isExtra) {
          const extras = (this._config.devices_extra || []).map(d => d.id === id ? { ...d, label: val, _isNew: false, _defaultLabel: undefined } : d);
          this._config = { ...this._config, devices_extra: extras };
        } else {
          const labels = { ...(this._config.devices_labels || {}) };
          if (val) labels[id] = val; else delete labels[id];
          this._config = { ...this._config, devices_labels: labels };
        }
        this._fire();
      });
    });

    // MDI icon input
    sr.querySelectorAll('[data-dv-mdi]').forEach(inp => {
      const fresh = inp.cloneNode(true);
      inp.replaceWith(fresh);
      fresh.addEventListener('change', () => {
        const id  = fresh.dataset.dvMdi;
        const val = fresh.value.trim();
        const extras = (this._config.devices_extra || []).map(d =>
          d.id === id ? { ...d, mdi_icon: val || undefined } : d
        );
        this._config = { ...this._config, devices_extra: extras };
        this._fire();
        // Update preview icon inline without full re-render
        const row = fresh.closest('.dv-row');
        if (row) {
          let preview = row.querySelector('.dv-mdi-preview');
          if (val) {
            if (!preview) {
              preview = document.createElement('ha-icon');
              preview.className = 'dv-mdi-preview';
              preview.style.cssText = 'width:20px;height:20px;flex-shrink:0;--mdi-icon-size:18px;';
              fresh.parentNode.appendChild(preview);
            }
            preview.setAttribute('icon', val);
          } else if (preview) {
            preview.remove();
          }
        }
      });
    });

    // Entity pickers inside device rows
    sr.querySelectorAll('.dv-picker[data-key]').forEach(picker => {
      const fresh = picker.cloneNode(true);
      picker.replaceWith(fresh);
      fresh.hass = this._hass;
      const domain = fresh.dataset.domain;
      if (domain) fresh.includeDomains = domain.split(',');
      const key = fresh.dataset.key;
      if (key) {
        const saved = this._config[key] || '';
        if (saved) { fresh.value = saved; fresh.setAttribute('value', saved); }
      }
      fresh.addEventListener('value-changed', e => {
        const k = fresh.dataset.key;
        const v = e.detail.value;
        const c = { ...this._config };
        if (v) c[k] = v; else delete c[k];
        this._config = c;
        this._fire();
      });
    });

    // Reorder ↑↓
    const reorder = (id, dir) => {
      const defIds   = ['den','decor','hien','rgb','quat','ocam','tv','motion'];
      const cfg      = this._config;
      const hidden   = cfg.devices_hidden || [];
      const extras   = cfg.devices_extra  || [];

      // Build current unified visible list (same logic as _getDeviceList)
      const defOrder  = cfg.devices_order || defIds;
      const extraIds  = extras.map(d => d.id);
      const hasReorderedExtras = defOrder.some(x => !defIds.includes(x));
      let fullList;
      if (hasReorderedExtras) {
        fullList = defOrder.filter(x => {
          if (defIds.includes(x)) return !hidden.includes(x);
          return extraIds.includes(x);
        });
      } else {
        fullList = [...defOrder.filter(x => !hidden.includes(x)), ...extraIds];
      }

      const idx = fullList.indexOf(id);
      if (idx < 0) return;
      const newIdx = dir === 'up' ? idx - 1 : idx + 1;
      if (newIdx < 0 || newIdx >= fullList.length) return;
      [fullList[idx], fullList[newIdx]] = [fullList[newIdx], fullList[idx]];

      // Save full unified order (includes extra ids) into devices_order
      // Also update devices_extra order to match
      const reorderedExtras = fullList
        .filter(x => !defIds.includes(x))
        .map(eid => extras.find(d => d.id === eid))
        .filter(Boolean);

      this._config = { ...cfg, devices_order: fullList, devices_extra: reorderedExtras };
      this._fire();
      const listEl = sr.getElementById('dev-list');
      if (listEl) { listEl.innerHTML = this._renderDeviceList(this._config); this._syncPickers(); this._bindDeviceListEvents(); }
    };
    sr.querySelectorAll('[data-dv-up]').forEach(btn => {
      const f = btn.cloneNode(true); btn.replaceWith(f);
      f.addEventListener('click', () => reorder(f.dataset.dvUp, 'up'));
    });
    sr.querySelectorAll('[data-dv-dn]').forEach(btn => {
      const f = btn.cloneNode(true); btn.replaceWith(f);
      f.addEventListener('click', () => reorder(f.dataset.dvDn, 'down'));
    });

    // Add button
    const btnAdd  = sr.getElementById('btn-add-dev');
    const selType = sr.getElementById('add-dev-type');
    if (btnAdd) {
      const freshBtn = btnAdd.cloneNode(true);
      btnAdd.replaceWith(freshBtn);
      freshBtn.addEventListener('click', () => {
        const selEl = this.shadowRoot.getElementById('add-dev-type');
        const type  = selEl ? selEl.value : '';
        if (!type) return;
        const t = this.t;
        const domainMap = { den: 'light', rgb: 'light', quat: 'fan', ocam: 'switch', tv: 'media_player', sensor: 'sensor' };
        const labelMap  = {
          den:    t.devLabelLight   || '💡 Light',
          rgb:    t.devLabelRgb     || '🌈 RGB Light',
          quat:   t.devLabelFan     || '🌀 Fan',
          ocam:   t.devLabelOutlet  || '🔌 Outlet',
          tv:     t.devLabelTv      || '📺 TV',
          sensor: t.devLabelSensor  || '📡 Sensor',
        };
        const uid = type + '_' + Date.now();
        const defaultLabel = labelMap[type] || '📦 Device';
        // _isNew: label starts empty so the placeholder (default name) is visible as ghost text
        const newDev = { id: uid, label: '', _isNew: true, _defaultLabel: defaultLabel, entityKey: uid + '_entity', domain: domainMap[type] || 'switch', type, isDefault: false };
        const extras = [...(this._config.devices_extra || []), newDev];
        this._config = { ...this._config, devices_extra: extras };
        const listEl = this.shadowRoot.getElementById('dev-list');
        if (listEl) { listEl.innerHTML = this._renderDeviceList(this._config); this._syncPickers(); this._bindDeviceListEvents(); }
        const selAfter = this.shadowRoot.getElementById('add-dev-type');
        if (selAfter) selAfter.value = '';
        this._fire();
      });
    }
  }

  static get DEFAULT_DEVICES() {
    return [
      { id: 'den',      label: '💡 Main Light',        entityKey: 'den_entity',       domain: 'light',        type: 'den'    },
      { id: 'decor',    label: '✨ Decor Light',        entityKey: 'decor_entity',     domain: 'light,switch', type: 'den'    },
      { id: 'hien',     label: '🏮 Porch Light',        entityKey: 'hien_entity',      domain: 'light,switch', type: 'den'    },
      { id: 'rgb',      label: '🌈 RGB Light',          entityKey: 'rgb_entity',       domain: 'light',        type: 'rgb'    },
      { id: 'quat',     label: '🌀 Ceiling Fan',        entityKey: 'quat_entity',      domain: 'fan,switch',   type: 'quat'   },
      { id: 'ocam',     label: '🔌 Power Outlet',       entityKey: 'ocam_entity',      domain: 'switch',       type: 'sensor' },
      { id: 'tv',       label: '📺 Smart TV',           entityKey: 'tv_entity',        domain: 'media_player', type: 'tv'     },
      { id: 'tvRemote', label: '📱 TV Remote',          entityKey: 'tv_remote_entity', domain: 'remote',       type: 'tv'     },
      { id: 'ac',       label: '❄️ Air Conditioner',    entityKey: 'ac_entity',        domain: 'climate',      type: 'sensor' },
    ];
  }
}

customElements.define('ha-smart-room-card-editor', HASmartRoomCardEditor);

// ── Khai báo getConfigElement cho HA ─────────────────────────
HASmartRoomCard.getConfigElement = function() {
  return document.createElement('ha-smart-room-card-editor');
};
HASmartRoomCard.getStubConfig = function() {
  return {
    type: 'custom:ha-smart-room-card',
    language:          'vi',
    background_preset: 'default',
  };
};

window.customCards = window.customCards || [];
const _plvExisting = window.customCards.findIndex(c => c.type === 'ha-smart-room-card');
if (_plvExisting >= 0) window.customCards.splice(_plvExisting, 1);
window.customCards.push({
  type: 'ha-smart-room-card',
  name: 'HA Smart Room Card',
  description: 'HA Smart Room Card — điều khiển phòng thông minh với cảm biến, thiết bị, biểu đồ & tự động hóa. By @doanlong1412',
  preview: true,
  documentationURL: 'https://www.tiktok.com/@long.1412',
});
console.groupCollapsed(
  '%c HA Smart Room Card %c v1.1.1 %c ready! 🚀',
  'background:#1a1a2e;color:#00ebff;font-weight:700;padding:2px 6px;border-radius:4px 0 0 4px;font-size:12px;',
  'background:#00c864;color:#fff;font-weight:700;padding:2px 6px;border-radius:0 4px 4px 0;font-size:12px;',
  'color:#aaa;font-size:11px;font-weight:400;'
);
console.log('%c By @doanlong1412 🇻🇳', 'color:#00ebff;font-weight:600;');
console.log('%c https://github.com/doanlong1412/ha-smart-room-card', 'color:#888;font-size:11px;');
console.groupEnd();
