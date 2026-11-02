/**
 * security_guard.js - Hệ thống bảo mật DMS Hub
 * - Xác thực máy mới qua mật khẩu: 5smaidinh
 * - Lấy Hardware ID (Fingerprint phần cứng: GPU, Canvas, Cores, Màn hình, Timezone)
 * - Lấy IP mạng từ Cloudflare
 * - Khóa 24 tiếng nếu nhập sai 3 lần (Lưu cả LocalStorage và Cloudflare R2)
 */

(function () {
  "use strict";

  const PASSWORD_REQUIRED = "5smaidinh";
  const LOCK_DURATION_MS = 24 * 60 * 60 * 1000; // 24 tiếng (86,400,000 ms)
  const LS_AUTH_KEY = "DMS_AUTH_TOKEN_V2";
  const LS_LOCK_KEY = "DMS_LOCK_UNTIL_V2";
  const LS_ATTEMPTS_KEY = "DMS_FAILED_ATTEMPTS_V2";
  const LS_HWID_KEY = "DMS_DEVICE_HWID_CACHE";

  let currentHwid = "";
  let currentIp = "Đang kiểm tra...";

  // ── 1. Sinh Hardware ID (Device Fingerprint) ─────────────────────────────────
  async function generateHwid() {
    const cached = localStorage.getItem(LS_HWID_KEY);
    if (cached && cached.startsWith("HWID-")) {
      return cached;
    }

    const components = [];

    // Screen
    components.push(`scr:${screen.width}x${screen.height}x${screen.colorDepth}`);
    components.push(`pix:${window.devicePixelRatio || 1}`);

    // Hardware
    components.push(`cores:${navigator.hardwareConcurrency || 4}`);
    components.push(`mem:${navigator.deviceMemory || 4}`);
    components.push(`plat:${navigator.platform || "unknown"}`);
    components.push(`tz:${Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}`);
    components.push(`lang:${navigator.language || "vi"}`);

    // GPU WebGL
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      if (gl) {
        const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
        if (debugInfo) {
          const vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || "";
          const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || "";
          components.push(`gpu:${vendor}~${renderer}`);
        }
      }
    } catch (_) {}

    // Canvas Fingerprint
    try {
      const c = document.createElement("canvas");
      c.width = 200;
      c.height = 50;
      const ctx = c.getContext("2d");
      if (ctx) {
        ctx.textBaseline = "top";
        ctx.font = "14px 'Arial'";
        ctx.fillStyle = "#f60";
        ctx.fillRect(125, 1, 62, 20);
        ctx.fillStyle = "#069";
        ctx.fillText("DMS_5S_SECURE", 2, 15);
        ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
        ctx.fillText("DMS_5S_SECURE", 4, 17);
        components.push(`cnv:${c.toDataURL().slice(-60)}`);
      }
    } catch (_) {}

    // Hash to SHA-256
    const raw = components.join("|||");
    const buf = new TextEncoder().encode(raw);
    const hashBuf = await crypto.subtle.digest("SHA-256", buf);
    const hashHex = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();

    const hwid = `HWID-${hashHex.slice(0, 4)}-${hashHex.slice(4, 8)}-${hashHex.slice(8, 12)}-${hashHex.slice(12, 16)}`;
    try {
      localStorage.setItem(LS_HWID_KEY, hwid);
    } catch (_) {}
    return hwid;
  }

  // ── 2. Helper thời gian ──────────────────────────────────────────────────────
  function formatRemaining(ms) {
    if (ms <= 0) return "00:00:00";
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  function formatDateTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} - ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  }

  // ── 3. Style CSS của Modal & Màn hình Khóa ──────────────────────────────────
  function injectStyles() {
    if (document.getElementById("dms-security-styles")) return;
    const style = document.createElement("style");
    style.id = "dms-security-styles";
    style.textContent = `
      #dms-sec-overlay {
        position: fixed;
        inset: 0;
        z-index: 999999999;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        padding: 16px;
        box-sizing: border-box;
      }

      /* Nền cho màn hình nhập mật khẩu */
      .dms-sec-bg-auth {
        background: radial-gradient(circle at 50% 30%, #1e293b 0%, #0f172a 70%, #020617 100%);
        backdrop-filter: blur(12px);
      }

      /* Nền cho màn hình bị khóa 24h */
      .dms-sec-bg-locked {
        background: radial-gradient(circle at 50% 30%, #450a0a 0%, #180505 60%, #000000 100%);
        backdrop-filter: blur(16px);
      }

      .dms-sec-card {
        background: rgba(15, 23, 42, 0.92);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 20px;
        box-shadow: 0 25px 60px -15px rgba(0, 0, 0, 0.8), 0 0 40px rgba(99, 102, 241, 0.15);
        width: 100%;
        max-width: 480px;
        padding: 36px 32px;
        color: #f8fafc;
        box-sizing: border-box;
        text-align: center;
        position: relative;
        animation: dmsSecPop 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      }

      .dms-sec-card-locked {
        border: 1px solid rgba(239, 68, 68, 0.4);
        box-shadow: 0 25px 70px -10px rgba(220, 38, 38, 0.4), 0 0 60px rgba(239, 68, 68, 0.2);
      }

      @keyframes dmsSecPop {
        from { transform: scale(0.92); opacity: 0; }
        to { transform: scale(1); opacity: 1; }
      }

      @keyframes dmsSecShake {
        0%, 100% { transform: translateX(0); }
        20%, 60% { transform: translateX(-10px); }
        40%, 80% { transform: translateX(10px); }
      }

      .dms-sec-shake {
        animation: dmsSecShake 0.45s ease-in-out !important;
      }

      .dms-sec-icon-wrap {
        width: 72px;
        height: 72px;
        margin: 0 auto 20px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 32px;
        position: relative;
      }

      .dms-sec-icon-auth {
        background: linear-gradient(135deg, rgba(79, 70, 229, 0.25), rgba(99, 102, 241, 0.1));
        border: 1px solid rgba(99, 102, 241, 0.4);
        color: #818cf8;
      }

      .dms-sec-icon-locked {
        background: linear-gradient(135deg, rgba(239, 68, 68, 0.3), rgba(185, 28, 28, 0.15));
        border: 1px solid rgba(239, 68, 68, 0.6);
        color: #f87171;
        animation: dmsPulse 2s infinite ease-in-out;
      }

      @keyframes dmsPulse {
        0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5); }
        50% { transform: scale(1.05); box-shadow: 0 0 25px 5px rgba(239, 68, 68, 0.4); }
      }

      .dms-sec-title {
        font-size: 22px;
        font-weight: 700;
        margin-bottom: 8px;
        letter-spacing: -0.02em;
      }

      .dms-sec-subtitle {
        font-size: 13.5px;
        color: #94a3b8;
        line-height: 1.5;
        margin-bottom: 24px;
      }

      .dms-sec-input-group {
        position: relative;
        margin-bottom: 16px;
        text-align: left;
      }

      .dms-sec-input-wrap {
        position: relative;
        display: flex;
        align-items: center;
      }

      .dms-sec-input {
        width: 100%;
        padding: 13px 44px 13px 16px;
        background: rgba(30, 41, 59, 0.8);
        border: 1.5px solid rgba(255, 255, 255, 0.15);
        border-radius: 12px;
        color: #ffffff;
        font-size: 15px;
        outline: none;
        transition: all 0.2s;
        box-sizing: border-box;
      }

      .dms-sec-input:focus {
        border-color: #6366f1;
        background: rgba(30, 41, 59, 1);
        box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.25);
      }

      .dms-sec-toggle-eye {
        position: absolute;
        right: 14px;
        background: none;
        border: none;
        color: #64748b;
        cursor: pointer;
        font-size: 16px;
        padding: 4px;
      }

      .dms-sec-toggle-eye:hover {
        color: #94a3b8;
      }

      .dms-sec-warn-box {
        background: rgba(245, 158, 11, 0.1);
        border: 1px solid rgba(245, 158, 11, 0.3);
        border-radius: 10px;
        padding: 10px 14px;
        font-size: 12.5px;
        color: #fbbf24;
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 20px;
        text-align: left;
      }

      .dms-sec-btn {
        width: 100%;
        padding: 13px;
        background: linear-gradient(135deg, #4f46e5, #6366f1);
        border: none;
        border-radius: 12px;
        color: #ffffff;
        font-size: 15px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
        box-shadow: 0 4px 15px rgba(79, 70, 229, 0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
      }

      .dms-sec-btn:hover {
        background: linear-gradient(135deg, #4338ca, #4f46e5);
        transform: translateY(-1px);
        box-shadow: 0 6px 20px rgba(79, 70, 229, 0.5);
      }

      .dms-sec-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
        transform: none;
      }

      /* Locked Box Styles */
      .dms-sec-timer-box {
        background: rgba(0, 0, 0, 0.5);
        border: 1px solid rgba(239, 68, 68, 0.3);
        border-radius: 14px;
        padding: 16px;
        margin-bottom: 20px;
      }

      .dms-sec-timer-label {
        font-size: 11.5px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #f87171;
        font-weight: 600;
        margin-bottom: 6px;
      }

      .dms-sec-timer-val {
        font-family: 'JetBrains Mono', monospace;
        font-size: 34px;
        font-weight: 700;
        color: #ef4444;
        letter-spacing: 0.05em;
        text-shadow: 0 0 15px rgba(239, 68, 68, 0.5);
      }

      .dms-sec-details {
        background: rgba(15, 23, 42, 0.6);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        padding: 14px;
        font-size: 12px;
        text-align: left;
        margin-bottom: 20px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .dms-sec-detail-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        padding-bottom: 6px;
      }

      .dms-sec-detail-row:last-child {
        border-bottom: none;
        padding-bottom: 0;
      }

      .dms-sec-detail-label {
        color: #64748b;
      }

      .dms-sec-detail-val {
        color: #cbd5e1;
        font-family: 'JetBrains Mono', monospace;
        font-weight: 500;
      }

      .dms-sec-msg-error {
        color: #f87171;
        font-size: 13px;
        margin-top: 10px;
        min-height: 18px;
      }
    `;
    document.head.appendChild(style);
  }

  // ── 4. Render Màn hình Khóa 24 tiếng ─────────────────────────────────────────
  function showLockedScreen(lockedUntil, hwid, ip, reason) {
    injectStyles();

    let existing = document.getElementById("dms-sec-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "dms-sec-overlay";
    overlay.className = "dms-sec-bg-locked";

    overlay.innerHTML = `
      <div class="dms-sec-card dms-sec-card-locked">
        <div class="dms-sec-icon-wrap dms-sec-icon-locked">
          <i class="fa-solid fa-shield-halved"></i>
        </div>
        <h2 class="dms-sec-title" style="color: #f87171;">THIẾT BỊ ĐÃ BỊ KHÓA</h2>
        <p class="dms-sec-subtitle">
          Nhập sai mật khẩu hệ thống 3 lần liên tiếp.<br/>
          Thiết bị & IP mạng bị tạm đình chỉ truy cập trong <b>24 giờ</b>.
        </p>

        <div class="dms-sec-timer-box">
          <div class="dms-sec-timer-label"><i class="fa-regular fa-clock"></i> Thời gian khóa còn lại</div>
          <div class="dms-sec-timer-val" id="dms-sec-countdown">24:00:00</div>
        </div>

        <div class="dms-sec-details">
          <div class="dms-sec-detail-row">
            <span class="dms-sec-detail-label"><i class="fa-solid fa-microchip"></i> Hardware ID:</span>
            <span class="dms-sec-detail-val" title="${hwid}">${hwid}</span>
          </div>
          <div class="dms-sec-detail-row">
            <span class="dms-sec-detail-label"><i class="fa-solid fa-network-wired"></i> IP Mạng:</span>
            <span class="dms-sec-detail-val">${ip || "Cloudflare IP"}</span>
          </div>
          <div class="dms-sec-detail-row">
            <span class="dms-sec-detail-label"><i class="fa-solid fa-calendar-check"></i> Mở khóa lúc:</span>
            <span class="dms-sec-detail-val" style="color: #fca5a5;">${formatDateTime(lockedUntil)}</span>
          </div>
        </div>

        <div style="font-size: 11.5px; color: #64748b; line-height: 1.5;">
          Hệ thống Cloudflare Security Guard tự động bảo vệ.<br/>
          Nếu đây là sự cố nhầm lẫn, vui lòng liên hệ Admin 5S để hỗ trợ.
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Vô hiệu hóa cuộn
    document.body.style.overflow = "hidden";

    // Countdown loop
    function updateCountdown() {
      const el = document.getElementById("dms-sec-countdown");
      if (!el) return;
      const rem = lockedUntil - Date.now();
      if (rem <= 0) {
        el.textContent = "00:00:00";
        localStorage.removeItem(LS_LOCK_KEY);
        localStorage.removeItem(LS_ATTEMPTS_KEY);
        setTimeout(() => location.reload(), 1500);
        return;
      }
      el.textContent = formatRemaining(rem);
      setTimeout(updateCountdown, 1000);
    }
    updateCountdown();
  }

  // ── 5. Render Màn hình Nhập Mật Khẩu (Máy Mới) ────────────────────────────────
  function showAuthModal(hwid, ip, currentAttempts) {
    injectStyles();

    let existing = document.getElementById("dms-sec-overlay");
    if (existing) existing.remove();

    const attemptsLeft = Math.max(0, 3 - (currentAttempts || 0));

    const overlay = document.createElement("div");
    overlay.id = "dms-sec-overlay";
    overlay.className = "dms-sec-bg-auth";

    overlay.innerHTML = `
      <div class="dms-sec-card" id="dms-sec-card-box">
        <div class="dms-sec-icon-wrap dms-sec-icon-auth">
          <i class="fa-solid fa-fingerprint"></i>
        </div>
        <h2 class="dms-sec-title">Xác Thực Thiết Bị Mới</h2>
        <p class="dms-sec-subtitle">
          Hệ thống DMS Hub yêu cầu xác minh thiết bị nội bộ.<br/>
          Vui lòng nhập mật khẩu xác thực để tiếp tục.
        </p>

        <form id="dms-sec-form">
          <div class="dms-sec-input-group">
            <div class="dms-sec-input-wrap">
              <input type="password" id="dms-sec-pass" class="dms-sec-input" placeholder="Nhập mật khẩu truy cập..." autocomplete="off" autofocus />
              <button type="button" class="dms-sec-toggle-eye" id="dms-sec-eye" title="Hiện/ẩn mật khẩu">
                <i class="fa-regular fa-eye"></i>
              </button>
            </div>
            <div class="dms-sec-msg-error" id="dms-sec-error"></div>
          </div>

          <div class="dms-sec-warn-box">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <span id="dms-sec-attempts-text">
              Bạn còn <b>${attemptsLeft}/3</b> lần thử. Nhập sai 3 lần thiết bị & IP mạng sẽ bị <b>khóa 24 tiếng</b>!
            </span>
          </div>

          <button type="submit" class="dms-sec-btn" id="dms-sec-submit-btn">
            <i class="fa-solid fa-lock-open"></i> Xác Nhận Truy Cập
          </button>
        </form>

        <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.06); font-size: 11.5px; color: #64748b;">
          Thiết bị: <span style="color: #94a3b8; font-family: monospace;">${hwid}</span>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";

    const passInput = document.getElementById("dms-sec-pass");
    const eyeBtn = document.getElementById("dms-sec-eye");
    const errorEl = document.getElementById("dms-sec-error");
    const cardBox = document.getElementById("dms-sec-card-box");
    const form = document.getElementById("dms-sec-form");
    const submitBtn = document.getElementById("dms-sec-submit-btn");
    const attemptsText = document.getElementById("dms-sec-attempts-text");

    if (passInput) passInput.focus();

    // Toggle Eye
    eyeBtn.addEventListener("click", () => {
      const isPass = passInput.type === "password";
      passInput.type = isPass ? "text" : "password";
      eyeBtn.innerHTML = isPass ? '<i class="fa-regular fa-eye-slash"></i>' : '<i class="fa-regular fa-eye"></i>';
    });

    // Submit handler
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const entered = passInput.value.trim();
      if (!entered) {
        errorEl.textContent = "Vui lòng nhập mật khẩu!";
        passInput.focus();
        return;
      }

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang xác thực...';
      errorEl.textContent = "";

      try {
        // Gửi lên Backend kiểm tra và ghi nhận
        const res = await fetch("/api/device-auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "verify",
            password: entered,
            hwid: hwid
          })
        });

        const data = await res.json().catch(() => ({}));

        if (res.status === 200 && data.success) {
          // Thành công
          submitBtn.style.background = "linear-gradient(135deg, #059669, #10b981)";
          submitBtn.innerHTML = '<i class="fa-solid fa-check"></i> Xác thực thành công!';
          localStorage.setItem(LS_AUTH_KEY, data.token || "AUTH_OK_2026");
          localStorage.removeItem(LS_ATTEMPTS_KEY);
          localStorage.removeItem(LS_LOCK_KEY);

          setTimeout(() => {
            overlay.remove();
            document.body.style.overflow = "";
          }, 800);
          return;
        }

        // Bị khóa (do server trả về 403 hoặc đã đạt 3 lần)
        if (data.blocked || res.status === 403) {
          const lockedUntil = data.lockedUntil || (Date.now() + LOCK_DURATION_MS);
          localStorage.setItem(LS_LOCK_KEY, String(lockedUntil));
          showLockedScreen(lockedUntil, hwid, data.ip || ip, data.reason);
          return;
        }

        // Sai mật khẩu nhưng chưa đủ 3 lần
        let fails = (Number(localStorage.getItem(LS_ATTEMPTS_KEY)) || 0) + 1;
        if (data.attemptsLeft !== undefined) {
          fails = 3 - data.attemptsLeft;
        }
        localStorage.setItem(LS_ATTEMPTS_KEY, String(fails));

        if (fails >= 3) {
          // Khóa 24h ngay lập tức
          const lockedUntil = Date.now() + LOCK_DURATION_MS;
          localStorage.setItem(LS_LOCK_KEY, String(lockedUntil));
          // Báo server khóa
          fetch("/api/device-auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "force_lock", hwid: hwid })
          }).catch(() => {});
          showLockedScreen(lockedUntil, hwid, ip, "Sai mật khẩu 3 lần");
          return;
        }

        // Shake animation
        cardBox.classList.remove("dms-sec-shake");
        void cardBox.offsetWidth; // trigger reflow
        cardBox.classList.add("dms-sec-shake");

        const left = 3 - fails;
        errorEl.textContent = `Mật khẩu không đúng! Bạn còn ${left} lần thử.`;
        attemptsText.innerHTML = `Bạn còn <b style="color: #f87171;">${left}/3</b> lần thử. Nhập sai 3 lần thiết bị & IP mạng sẽ bị <b>khóa 24 tiếng</b>!`;
        passInput.value = "";
        passInput.focus();
      } catch (err) {
        // Fallback kiểm tra client nếu API offline
        if (entered === PASSWORD_REQUIRED) {
          localStorage.setItem(LS_AUTH_KEY, "AUTH_OK_CLIENT");
          localStorage.removeItem(LS_ATTEMPTS_KEY);
          overlay.remove();
          document.body.style.overflow = "";
        } else {
          let fails = (Number(localStorage.getItem(LS_ATTEMPTS_KEY)) || 0) + 1;
          localStorage.setItem(LS_ATTEMPTS_KEY, String(fails));
          if (fails >= 3) {
            const lockedUntil = Date.now() + LOCK_DURATION_MS;
            localStorage.setItem(LS_LOCK_KEY, String(lockedUntil));
            showLockedScreen(lockedUntil, hwid, ip, "Sai mật khẩu 3 lần");
          } else {
            cardBox.classList.add("dms-sec-shake");
            errorEl.textContent = `Mật khẩu không đúng! Bạn còn ${3 - fails} lần thử.`;
            passInput.value = "";
            passInput.focus();
          }
        }
      } finally {
        submitBtn.disabled = false;
        if (submitBtn.innerHTML.includes("Đang xác thực")) {
          submitBtn.innerHTML = '<i class="fa-solid fa-lock-open"></i> Xác Nhận Truy Cập';
        }
      }
    });
  }

  // ── 6. Khởi động kiểm tra an ninh (Main Entry) ───────────────────────────────
  async function initSecurityGuard() {
    try {
      // Nếu đang nằm trong iframe (ví dụ note_issue.html trong index.html)
      const isIframe = window.self !== window.top;

      currentHwid = await generateHwid();

      // 1. Kiểm tra khóa cục bộ (LocalStorage) trước
      const localLock = Number(localStorage.getItem(LS_LOCK_KEY)) || 0;
      const now = Date.now();
      if (localLock > now) {
        if (!isIframe) {
          showLockedScreen(localLock, currentHwid, currentIp, "Khóa cục bộ do nhập sai 3 lần");
        } else {
          document.body.innerHTML = "<div style='display:flex;align-items:center;justify-content:center;height:100vh;background:#0f172a;color:#ef4444;font-family:sans-serif;font-weight:bold;'>Thiết bị đã bị khóa 24 giờ do nhập sai mật khẩu 3 lần.</div>";
        }
        return;
      }

      // 2. Kiểm tra Server API xem Hardware ID hoặc IP mạng có bị khóa trên R2 không
      try {
        const checkRes = await fetch(`/api/device-auth?hwid=${encodeURIComponent(currentHwid)}`);
        if (checkRes.ok) {
          const checkData = await checkRes.json();
          currentIp = checkData.ip || currentIp;

          if (checkData.blocked && checkData.lockedUntil > now) {
            localStorage.setItem(LS_LOCK_KEY, String(checkData.lockedUntil));
            if (!isIframe) {
              showLockedScreen(checkData.lockedUntil, currentHwid, currentIp, checkData.reason);
            } else {
              document.body.innerHTML = "<div style='display:flex;align-items:center;justify-content:center;height:100vh;background:#0f172a;color:#ef4444;font-family:sans-serif;font-weight:bold;'>Thiết bị đã bị khóa 24 giờ.</div>";
            }
            return;
          }
        }
      } catch (_) {}

      // 3. Kiểm tra xem thiết bị đã xác thực chưa
      const authToken = localStorage.getItem(LS_AUTH_KEY);
      if (authToken) {
        // Đã xác thực trên máy này -> Cho phép truy cập bình thường
        return;
      }

      // Nếu là iframe và chưa xác thực thì ẩn nội dung để tránh xem trộm
      if (isIframe) {
        document.body.style.display = "none";
        return;
      }

      // 4. Máy mới ở trang chính -> Hiển thị Modal bắt nhập mật khẩu 5smaidinh
      const currentAttempts = Number(localStorage.getItem(LS_ATTEMPTS_KEY)) || 0;
      showAuthModal(currentHwid, currentIp, currentAttempts);
    } catch (e) {
      console.error("[SecurityGuard] Init error:", e);
    }
  }

  // Chạy ngay khi DOM sẵn sàng hoặc ngay tức thì nếu đã nạp
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSecurityGuard);
  } else {
    initSecurityGuard();
  }
})();
