// auto-sync-voip.js - Tự động đồng bộ cuộc gọi Voip24h lên Cloudflare R2 theo chu kỳ
const handler = require('./api/voip24h-calls.js');

// Chu kỳ mặc định: 60 phút (1 tiếng / lần) để tránh bị tổng đài hiểu lầm là spam
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

function getTimestamp() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
}

async function runSyncOnce() {
  if (isSyncing) {
    console.log(`[${getTimestamp()}] ⏳ Lần sync trước vẫn đang thực thi, bỏ qua chu kỳ này...`);
    return;
  }

  // Tùy chọn an toàn: Ban đêm (từ 21:30 đến 06:30 sáng) không có cuộc gọi, bỏ qua để tránh gọi tổng đài
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const isNightTime = (currentHour > 21 || (currentHour === 21 && currentMinute >= 30)) || currentHour < 6 || (currentHour === 6 && currentMinute < 30);
  if (isNightTime && process.env.SYNC_SKIP_NIGHT !== "0") {
    console.log(`[${getTimestamp()}] 🌙 Ngoài giờ làm việc (21:30 - 06:30), tạm dừng cào để giữ an toàn tuyệt đối cho IP. Hẹn lại vào chu kỳ sau...`);
    return;
  }

  isSyncing = true;
  syncCount++;
  console.log(`\n-------------------------------------------------------`);
  console.log(`[${getTimestamp()}] 🚀 Bắt đầu đồng bộ lần #${syncCount} (Chu kỳ ${intervalMinutes} phút)...`);

  return new Promise((resolve) => {
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
          console.log(`[${getTimestamp()}] ✅ ĐỒNG BỘ THÀNH CÔNG LÊN CLOUDFLARE R2!`);
          console.log(`- Tổng số cuộc gọi trong tháng: ${total} cuộc`);
          if (latestCall) {
            console.log(`- Cuộc gọi gần nhất: ${latestCall.calldate || 'N/A'} (Từ: ${latestCall.src || '—'} ➔ Đến: ${latestCall.dst || '—'}) [${latestCall.statusText || latestCall.disposition || '—'}]`);
          }
          console.log(`- Nguồn dữ liệu: ${data.source === 'live_voip24h' ? 'Live Voip24h' : 'Cloud Cache'}`);
          console.log(`- Lần đồng bộ tiếp theo sau: ${intervalMinutes} phút (1 tiếng)`);
        } else {
          console.warn(`[${getTimestamp()}] ⚠️ Tổng đài phản hồi không thành công: ${data?.message || 'Không rõ lỗi'}`);
        }
        isSyncing = false;
        resolve();
      }
    };

    handler(req, res).catch(err => {
      console.error(`[${getTimestamp()}] ❌ Lỗi kết nối tổng đài:`, err.message || err);
      isSyncing = false;
      resolve();
    });
  });
}

console.log("=======================================================");
console.log("   DMS HUB - DỊCH VỤ TỰ ĐỘNG SYNC VOIP24H LÊN R2");
console.log("=======================================================");
console.log(`- Chu kỳ đồng bộ: MỖI ${intervalMinutes} PHÚT (1 TIẾNG / LẦN)`);
console.log(`- Khung giờ hoạt động: 06:30 - 21:30 (Ban đêm tự động nghỉ)`);
console.log(`- Máy chủ đang chạy liên tục trong nền.`);
console.log(`- Nhấn Ctrl + C để dừng dịch vụ.`);
console.log("=======================================================");

// Chạy ngay lần đầu tiên khi bật máy
runSyncOnce();

// Lặp lại định kỳ mỗi 60 phút
setInterval(runSyncOnce, INTERVAL_MS);
