// sync-voip.js - Đồng bộ cuộc gọi từ tổng đài Voip24h lên Cloudflare R2
const handler = require('./api/voip24h-calls.js');

async function sync() {
  console.log("Đang kết nối tổng đài Voip24h để lấy danh sách cuộc gọi mới nhất...");
  const req = { method: 'GET', url: '/api/voip24h-calls?sync=1&_t=' + Date.now() };
  const res = {
    setHeader: () => {},
    status: function() { return this; },
    json: function(data) {
      if (data.status === "success") {
        console.log("\n=======================================================");
        console.log(`✅ ĐỒNG BỘ THÀNH CÔNG LÊN CLOUDFLARE R2!`);
        console.log(`- Tổng số cuộc gọi: ${data.total} cuộc`);
        console.log(`- Nguồn dữ liệu: ${data.source === 'live_voip24h' ? 'Trực tiếp Voip24h (Live)' : 'Cache Cloud R2'}`);
        console.log(`- Cuộc gọi gần nhất: ${data.calls?.[0]?.calldate || 'N/A'}`);
        console.log(`- Số gọi: ${data.calls?.[0]?.src || '—'} -> Số nhận: ${data.calls?.[0]?.dst || '—'}`);
        console.log(`- Thời điểm đồng bộ: ${data.syncedAt}`);
        console.log("=======================================================");
        console.log("Toàn bộ nhân sự mở web trên Vercel đều sẽ thấy dữ liệu này ngay lập tức.\n");
      } else {
        console.error("❌ Lỗi đồng bộ:", data.message);
      }
    }
  };
  await handler(req, res);
}

sync().catch(err => {
  console.error("❌ Lỗi ngoại lệ:", err.message);
});
