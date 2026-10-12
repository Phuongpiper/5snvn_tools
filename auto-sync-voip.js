// auto-sync-voip.js - Tự động đồng bộ cuộc gọi Voip24h & Ticket Chatbox AI lên Cloudflare R2 theo chu kỳ
try { require("dotenv").config(); } catch (_) {}
try {
  const fs = require("fs");
  const path = require("path");
  const envPath = path.resolve(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx !== -1) {
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[k]) process.env[k] = v;
      }
    }
  }
} catch (_) {}

const voipHandler = require('./api/voip24h-calls.js');
const { syncHelpdeskTickets } = require('./api/helpdesk-tickets.js');

// Chu kỳ mặc định: 60 phút (1 tiếng / lần) để tránh bị coi là spam
let intervalMinutes = parseFloat(process.env.SYNC_INTERVAL_MINUTES || 60);

const args = process.argv.slice(2);
const idxInterval = args.indexOf('--interval');
if (idxInterval !== -1 && args[idxInterval + 1]) {
  const parsed = parseFloat(args[idxInterval + 1]);
  if (!isNaN(parsed) && parsed > 0) intervalMinutes = parsed;
}
const INTERVAL_MS = Math.max(1, intervalMinutes) * 60 * 1000;

let isSyncing = false;
let syncCount = 0;
let syncTimer = null;

function getTimestamp() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
}

function scheduleNext(delayMs) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(runSyncOnce, delayMs);
}

async function runSyncOnce() {
  if (isSyncing) {
    console.log(`[${getTimestamp()}] ⏳ Lần sync trước vẫn đang thực thi, bỏ qua chu kỳ này...`);
    return;
  }

  // Ban đêm (từ 21:30 đến 06:30 sáng) tạm dừng để giữ an toàn tuyệt đối cho IP/tài khoản
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const isNightTime = (currentHour > 21 || (currentHour === 21 && currentMinute >= 30)) || currentHour < 6 || (currentHour === 6 && currentMinute < 30);
  if (isNightTime && process.env.SYNC_SKIP_NIGHT !== "0") {
    console.log(`[${getTimestamp()}] 🌙 Ngoài giờ làm việc (21:30 - 06:30), tạm dừng cào để giữ an toàn tuyệt đối. Hẹn lại vào chu kỳ sau...`);
    scheduleNext(INTERVAL_MS);
    return;
  }

  isSyncing = true;
  syncCount++;
  console.log(`\n-------------------------------------------------------`);
  console.log(`[${getTimestamp()}] 🚀 Bắt đầu đồng bộ lần #${syncCount} (Chu kỳ ${intervalMinutes} phút)...`);

  try {
    // 1. Đồng bộ cuộc gọi Voip24h (Mặc định TẮT tự động để chống spam - Chỉ cào khi người dùng bấm nút trên Web)
    const enableVoipAuto = process.env.SYNC_VOIP_CALLS === "1" || args.includes("--sync-voip");
    if (enableVoipAuto) {
      console.log(`[${getTimestamp()}] 📞 Đang đồng bộ cuộc gọi Voip24h...`);
      await new Promise((resolve, reject) => {
        const req = {
          method: 'GET',
          url: '/api/voip24h-calls?sync=1&_t=' + Date.now()
        };
        const res = {
          setHeader: () => {},
          status: function() { return this; },
          json: function(data) {
            if (data && data.status === "success") {
              const total = data.total || 0;
              const latestCall = data.calls?.[0];
              console.log(`[${getTimestamp()}] ✅ ĐỒNG BỘ CUỘC GỌI THÀNH CÔNG!`);
              console.log(`- Tổng số cuộc gọi trong tháng: ${total} cuộc`);
              if (latestCall) {
                console.log(`- Cuộc gọi gần nhất: ${latestCall.calldate || 'N/A'} (Từ: ${latestCall.src || '—'} ➔ Đến: ${latestCall.dst || '—'})`);
              }
            } else {
              console.warn(`[${getTimestamp()}] ⚠️ Tổng đài phản hồi: ${data?.message || 'Không rõ lỗi'}`);
            }
            resolve();
          }
        };
        voipHandler(req, res).catch(reject);
      });
    } else {
      console.log(`[${getTimestamp()}] 🛡️ Bỏ qua tự động cào cuộc gọi Voip24h (Chỉ cào trực tiếp khi người dùng bấm nút trên web để tránh spam tổng đài).`);
    }

    // 2. Đồng bộ Ticket Helpdesk (Chatbox AI)
    console.log(`[${getTimestamp()}] 🎫 Đang đồng bộ Ticket Chatbox AI...`);
    try {
      const tResult = await syncHelpdeskTickets(true);
      console.log(`[${getTimestamp()}] ✅ ĐỒNG BỘ TICKET THÀNH CÔNG: ${tResult?.total || 0} ticket trên R2!`);
      console.log(`- Nguồn dữ liệu: ${tResult?.source === 'live_crawled' ? 'Trực tiếp Helpdesk (Live)' : 'Bộ nhớ đệm R2'}`);
    } catch (tErr) {
      console.warn(`[${getTimestamp()}] ⚠️ Đồng bộ Ticket Helpdesk gặp lỗi:`, tErr.message);
    }

    console.log(`[${getTimestamp()}] ⏰ Lần đồng bộ tiếp theo sau: ${intervalMinutes} phút (1 tiếng)`);
    scheduleNext(INTERVAL_MS);
  } catch (err) {
    console.error(`[${getTimestamp()}] ❌ Lỗi kết nối trong tiến trình đồng bộ:`, err.message || err);
    console.log(`[${getTimestamp()}] 🔄 Sẽ tự động thử lại sau 2 phút...`);
    scheduleNext(2 * 60 * 1000);
  } finally {
    isSyncing = false;
  }
}

console.log("=======================================================");
console.log("   DMS HUB - DỊCH VỤ TỰ ĐỘNG ĐỒNG BỘ VOIP & TICKET AI");
console.log("=======================================================");
console.log(`- Chu kỳ đồng bộ: MỖI ${intervalMinutes} PHÚT (1 TIẾNG / LẦN)`);
console.log(`- Dữ liệu đồng bộ: Ticket Chatbox AI (Cuộc gọi Voip24h chỉ đồng bộ khi bấm nút trên Web để chống Spam)`);
console.log(`- Khung giờ hoạt động: 06:30 - 21:30 (Ban đêm tự động nghỉ)`);
console.log(`- Máy chủ đang chạy liên tục trong nền.`);
console.log(`- Nhấn Ctrl + C để dừng dịch vụ.`);
console.log("=======================================================");

// Chạy ngay lần đầu tiên khi bật máy
runSyncOnce();
