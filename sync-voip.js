// sync-voip.js - Đồng bộ cuộc gọi từ tổng đài Voip24h & Ticket Chatbox AI lên Cloudflare R2
const handler = require('./api/voip24h-calls.js');
const { syncHelpdeskTickets } = require('./api/helpdesk-tickets.js');

async function sync() {
  console.log("=======================================================");
  console.log("   DMS HUB - BẮT ĐẦU ĐỒNG BỘ DỮ LIỆU LÊN CLOUD R2");
  console.log("=======================================================");
  console.log("1. Đang kết nối tổng đài Voip24h để lấy danh sách cuộc gọi mới nhất...");

  await new Promise((resolve) => {
    const req = { method: 'GET', url: '/api/voip24h-calls?sync=1&did=all&_t=' + Date.now() };
    const res = {
      setHeader: () => {},
      status: function() { return this; },
      json: function(data) {
        if (data.status === "success") {
          console.log(`✅ ĐỒNG BỘ CUỘC GỌI THÀNH CÔNG!`);
          console.log(`- Tổng số cuộc gọi: ${data.total} cuộc`);
          console.log(`- Nguồn dữ liệu: ${data.source === 'live_voip24h' ? 'Trực tiếp Voip24h (Live)' : 'Cache Cloud R2'}`);
          console.log(`- Cuộc gọi gần nhất: ${data.calls?.[0]?.calldate || 'N/A'}`);
          console.log(`- Số gọi: ${data.calls?.[0]?.src || '—'} -> Số nhận: ${data.calls?.[0]?.dst || '—'}`);
          console.log(`- Thời điểm đồng bộ: ${data.syncedAt}`);
        } else {
          console.error("❌ Lỗi đồng bộ cuộc gọi:", data.message);
        }
        resolve();
      }
    };
    handler(req, res).catch(err => {
      console.error("❌ Lỗi gọi API Voip24h:", err.message);
      resolve();
    });
  });

  console.log("\n2. Đang kết nối Helpdesk để lấy danh sách Ticket Chatbox AI mới nhất...");
  try {
    const tResult = await syncHelpdeskTickets(true);
    console.log(`✅ ĐỒNG BỘ TICKET CHATBOX AI THÀNH CÔNG!`);
    console.log(`- Tổng số ticket: ${tResult?.total || 0} ticket`);
    console.log(`- Nguồn dữ liệu: ${tResult?.source === 'live_crawled' ? 'Trực tiếp Helpdesk (Live)' : 'Cache Cloud R2'}`);
    console.log(`- Thời điểm đồng bộ: ${tResult?.syncedAt || new Date().toISOString()}`);
  } catch (err) {
    console.error("❌ Lỗi đồng bộ ticket Chatbox AI:", err.message);
  }

  console.log("\n=======================================================");
  console.log("🎉 HOÀN TẤT ĐỒNG BỘ! Toàn bộ nhân sự mở web đều sẽ thấy dữ liệu này ngay lập tức.");
  console.log("=======================================================\n");
}

sync().catch(err => {
  console.error("❌ Lỗi ngoại lệ:", err.message);
});
