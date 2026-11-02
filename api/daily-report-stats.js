/**
 * api/daily-report-stats.js
 * API Chuyên Dụng Dành Cho Extension Colgate All-in-One: Báo Cáo Cuối Ca
 * - Trả về trực tiếp leftTable (Số lượng Issue) & rightTable (Số lượng cuộc gọi)
 * - Tương thích 100% Cloudflare Workers (fetch + crypto.subtle)
 * - Tự động đồng bộ với r2-issue-stats
 */

const issueStatsHandler = require("./r2-issue-stats.js");

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, X-Requested-With",
  "Access-Control-Expose-Headers": "ETag, Last-Modified, Content-Length"
};

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  // Gọi handler thống kê chuẩn
  return issueStatsHandler(req, res);
};

